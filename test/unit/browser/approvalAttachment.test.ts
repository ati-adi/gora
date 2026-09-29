// s07 BR — trust/executor.ts ToolSpec.approvalAttachment (spec 07 A4): the picture beside an approval card is sent into
// the card's chat right BEFORE the card, from a user-owned blob; a failing attachment never blocks the card.
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolSpec } from '../../../src/contracts/index.ts';
import { fakeJpeg } from '../../harness/fakeBrowser.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { boot, dm, gmailLikeTool, newWorld, owner, sig, tu } from '../trust/world.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('executor approvalAttachment (A4)', () => {
  it('sends the photo (caption, blob) before the card, idempotent per tool call', async () => {
    const w = newWorld();
    const spec: ToolSpec = { ...gmailLikeTool(w), approvalAttachment: async () => ({ kind: 'photo', bytes: fakeJpeg('page'), caption: 'tables.example' }) };
    t = await boot(w, [spec]);
    const u = owner(t, w);
    const c = dm(w, u);
    const out = await t.s.executor.processRound(c.run, c.conv, 1, tu('toolu_1', 'gmail_send_draft', { to: 'anna@x.com', subject: 'S', body: 'B' }), null as never, sig());
    expect(JSON.parse(String(out.results[0]!.content)).status).toBe('pending_approval');
    await t.settle();
    const photo = t.tg.calls.findIndex((x) => x.method === 'sendPhoto');
    const card = t.tg.calls.findIndex((x) => x.method === 'sendRichMessage' && String(x.payload?.rich_message?.markdown ?? '').includes('🔐'));
    expect(photo).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(photo);
    expect(t.tg.calls[photo]!.payload.caption).toBe('tables.example');
    expect(t.tg.calls[photo]!.payload.chat_id).toBe(t.tg.calls[card]!.payload.chat_id);
    expect(w.calls).toHaveLength(0);
  });

  it('a failing attachment is logged and the card still goes out', async () => {
    const w = newWorld();
    const spec: ToolSpec = { ...gmailLikeTool(w), approvalAttachment: async () => { throw new Error('screenshot failed'); } };
    t = await boot(w, [spec]);
    const u = owner(t, w);
    const c = dm(w, u);
    await t.s.executor.processRound(c.run, c.conv, 1, tu('toolu_1', 'gmail_send_draft', { to: 'anna@x.com', subject: 'S', body: 'B' }), null as never, sig());
    await t.settle();
    expect(t.tg.calls.some((x) => x.method === 'sendPhoto')).toBe(false);
    expect(t.lastCard().markdown).toContain('🔐');
  });

  it('a superseded card (the page changed before the tap) is sent with a fresh photo too (s07 lead fix)', async () => {
    const w = newWorld();
    let n = 0;
    const spec: ToolSpec = { ...gmailLikeTool(w), approvalAttachment: async () => ({ kind: 'photo', bytes: fakeJpeg(`page-${++n}`), caption: `shot ${n}` }) };
    t = await boot(w, [spec]);
    const u = owner(t, w);
    const c = dm(w, u);
    const out = await t.s.executor.processRound(c.run, c.conv, 1, tu('toolu_1', 'gmail_send_draft', { to: 'anna@x.com', subject: 'S', body: 'B' }), null as never, sig());
    const id = JSON.parse(String(out.results[0]!.content)).approval_id as string;
    await t.settle();
    w.subject.override = 'Changed on the page';
    const r = await t.s.approvals.resolve(id, { decision: 'approve', scope: 'once', byTgId: u.tgUserId, via: 'callback' });
    expect(r.status).toBe('superseded');
    await t.settle();
    const photos = t.tg.calls.filter((x) => x.method === 'sendPhoto');
    expect(photos.map((p) => p.payload.caption)).toEqual(['shot 1', 'shot 2']);
    const lastPhoto = t.tg.calls.lastIndexOf(photos[1]!);
    const lastCard = t.tg.calls.map((x, i) => (x.method === 'sendRichMessage' && String(x.payload?.rich_message?.markdown ?? '').includes('🔐') ? i : -1)).filter((i) => i >= 0).at(-1)!;
    expect(lastCard).toBeGreaterThan(lastPhoto);
    expect(w.calls).toHaveLength(0);
  });

  it('tools without an attachment behave exactly as before (no photo)', async () => {
    const w = newWorld();
    t = await boot(w, [gmailLikeTool(w)]);
    const u = owner(t, w);
    const c = dm(w, u);
    await t.s.executor.processRound(c.run, c.conv, 1, tu('toolu_1', 'gmail_send_draft', { to: 'anna@x.com', subject: 'S', body: 'B' }), null as never, sig());
    await t.settle();
    expect(t.tg.calls.some((x) => x.method === 'sendPhoto')).toBe(false);
  });
});
