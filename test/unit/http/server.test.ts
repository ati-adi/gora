// WP8: server composition — Mini App hosting (static + SPA fallback, never hash routing), security headers and the
// frame-ancestors CSP (⚠U16), /healthz, the webhook/dev routes, API hardening (body limit, JSON errors).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { buildServer } from '../../../src/http/server.ts';
import { DEFAULT_FRAME_ANCESTORS, miniAppCsp, sanitizeFrameAncestors } from '../../../src/http/security.ts';
import { createFakeScheduler } from '../../harness/fakes.ts';
import { makeTmpDir, removeDir } from '../../harness/tmpDb.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';

let t: TestApp | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const d of dirs.splice(0)) removeDir(d);
});

function webappFixture(): string {
  const d = makeTmpDir();
  dirs.push(d);
  mkdirSync(join(d, 'assets'), { recursive: true });
  writeFileSync(join(d, 'index.html'), '<!doctype html><html><head><script src="https://telegram.org/js/telegram-web-app.js?63"></script></head><body><div id="root"></div><script type="module" src="/app/assets/index-abc123.js"></script></body></html>');
  writeFileSync(join(d, 'assets', 'index-abc123.js'), 'console.log("gora")');
  return d;
}

async function server(o: { frameAncestors?: string } = {}): Promise<Hono> {
  t = await createTestApp({ factories: { createScheduler: (s) => createFakeScheduler(() => s.clock) }, ...(o.frameAncestors ? { config: { frameAncestors: o.frameAncestors } } : {}) });
  return buildServer(t.s, t.app.tg, { webappDir: webappFixture() });
}

describe('security headers (01 §12, ⚠U16)', () => {
  it('builds the exact CSP with frame-ancestors from MINIAPP_FRAME_ANCESTORS', () => {
    expect(miniAppCsp(DEFAULT_FRAME_ANCESTORS)).toBe(
      "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors https://web.telegram.org https://*.telegram.org",
    );
  });
  it('never lets the env value inject directives', () => {
    expect(sanitizeFrameAncestors('https://web.telegram.org; script-src *')).toBe(DEFAULT_FRAME_ANCESTORS);
    expect(sanitizeFrameAncestors('https://a.example.com https://*.telegram.org javascript:alert(1)')).toBe('https://a.example.com https://*.telegram.org');
    expect(sanitizeFrameAncestors('')).toBe(DEFAULT_FRAME_ANCESTORS);
    expect(sanitizeFrameAncestors("'none'")).toBe("'none'");
  });
  it('/app/* carries CSP, nosniff and no-referrer; /api/* is no-store', async () => {
    const app = await server({ frameAncestors: 'https://web.telegram.org https://k.telegram.org' });
    const r = await app.request('/app/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain('frame-ancestors https://web.telegram.org https://k.telegram.org');
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self' https://telegram.org");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const api = await t!.app.http.request('/api/me');
    expect(api.status).toBe(401);
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('Mini App hosting (01 §12)', () => {
  it('serves index.html, hashed assets, and falls back to index.html for app paths (no hash routing)', async () => {
    const app = await server();
    const index = await app.request('/app/?screen=approval&id=A7K2QX');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('telegram-web-app.js?63');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const deep = await app.request('/app/tasks');
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('<div id="root">');
    expect(deep.headers.get('content-security-policy')).toContain('frame-ancestors');
    const js = await app.request('/app/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await app.request('/app/assets/missing-000.js')).status).toBe(404);
    expect((await app.request('/app/../package.json')).status).not.toBe(200);
  });
  it('/app redirects to /app/ keeping the query', async () => {
    const app = await server();
    const r = await app.request('/app?screen=tz');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/app/?screen=tz');
  });
  it('without a build, /app/ serves a 503 placeholder (still with the CSP)', async () => {
    t = await createTestApp();
    const empty = makeTmpDir();
    dirs.push(empty);
    const app = buildServer(t.s, t.app.tg, { webappDir: empty });
    const r = await app.request('/app/');
    expect(r.status).toBe(503);
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

describe('/healthz and other routes', () => {
  it('reports db, last scheduler tick within 10 s and inbox lag', async () => {
    const app = await server();
    // boot grace: no tick yet, just started → healthy; 11 s later without a tick → unhealthy
    expect((await app.request('/healthz')).status).toBe(200);
    await t!.clock.advance(11_000);
    expect((await app.request('/healthz')).status).toBe(503);
    await t!.s.scheduler.tick();
    const ok = await app.request('/healthz');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, db: true, scheduler: true, inbox: true });
    await t!.s.scheduler.stop();
    await t!.clock.advance(11_000);
    const stale = await app.request('/healthz');
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ ok: false, scheduler: false });
  });
  it('mounts the webhook (secret checked by WP2) and the dev fake-connect route outside production', async () => {
    const app = await server();
    const wh = await app.request('/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(wh.status).toBe(401);
    const dev = await app.request('/dev/fake-connect?state=nope');
    expect(dev.status).not.toBe(200);
  });
  it('API errors are JSON; oversize bodies are refused', async () => {
    const app = await server();
    const nf = await app.request('/api/nope', { headers: { authorization: 'tma x' } });
    expect(nf.status).toBe(401);
    const big = await t!.api('POST', '/api/memory/import', { text: 'x'.repeat(300 * 1024) });
    expect(big.status).toBe(413);
    const badJson = await t!.app.http.request('/api/settings', { method: 'PATCH', headers: { authorization: `tma ${new URLSearchParams({}).toString()}` }, body: '{' });
    expect(badJson.status).toBe(401);
    const unknownKey = await t!.api('PATCH', '/api/settings', { evil: 1 });
    expect(unknownKey.status).toBe(400);
    expect(await unknownKey.json()).toMatchObject({ error: 'invalid_body' });
  });
});
