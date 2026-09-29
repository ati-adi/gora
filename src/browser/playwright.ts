// browser/playwright.ts (s07 BR, spec 07 A1) — PlaywrightBrowser: the real BrowserCapability over headless Chromium
// (playwright 1.63.0, `npx playwright install chromium` into the default Playwright cache, never the repo).
// The ONLY runtime importer of 'playwright' (importRules 'playwright-runtime-import'): the module is loaded lazily with a
// dynamic import on the first openSession, never at boot.
//
// One shared Browser; one ephemeral BrowserContext per task (acceptDownloads:false, serviceWorkers:'block', the owner's
// locale and time zone): no persistent cookies or logins in v1. Network boundary (s07 lead fix, red-team B-NET-1/2):
//  - every connection of the context goes through a per-context egress proxy (egress.ts, `bypass: '<-loopback>'`): each
//    request AND each redirect hop is checked by the task's NetworkPolicy, and the socket goes only to the vetted
//    address (no DNS rebinding); WebRTC is limited to proxied TCP (launch flag) and RTCPeerConnection / WebTransport are
//    removed from every frame (init script);
//  - context.route still checks each chain's first URL (full path and scheme) and refuses any non-GET document
//    navigation unless the running action was approved by the owner (the POST backstop under the commit detection);
//  - non-http(s) top-level URLs (data:, file:, chrome:, javascript:, …) are refused before navigating.
// Chromium runs with its OS sandbox (BROWSER_SANDBOX, default on) and a scrubbed environment (PATH/HOME/TMPDIR/LANG
// only): no Gora secret from process.env ever reaches the browser process.
// Popups become the task's current page (counted); downloads are cancelled and file choosers are left unanswered
// (uploads denied). Actions address elements by aria ref (`aria-ref=eN`) with a short timeout, so a stale ref fails fast.
//
// Seam for a hosted provider later (Browserbase / Steel: `chromium.connectOverCDP(wsEndpoint)` instead of `launch`,
// the rest of this class unchanged) — deliberately not implemented in v1.
import type { Browser, BrowserContext, Page } from 'playwright';
import { startEgressProxy, type EgressProxy } from './egress.ts';
import type {
  AriaNode, BrowserActionResult, BrowserCapability, BrowserKey, BrowserSession, BrowserSessionStats, Clock, FieldInfo, Logger, NetworkPolicy, RawPageState, UserId,
} from '../contracts/index.ts';

export interface PlaywrightOptions {
  headless: boolean;
  /** Chromium's OS sandbox (default true). */
  sandbox?: boolean;
  executablePath?: string;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  /** After a failed launch, available() is false for this long, then one retry is allowed. */
  relaunchAfterMs?: number;
}

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'tab']);
const FIELD_INFO_MAX = 200;
const LAUNCH_HINT = 'browser: Chromium failed to launch — run `npx playwright install chromium` (or set BROWSER_EXECUTABLE_PATH; in a container without user namespaces BROWSER_SANDBOX=false)';
/** Launch flags: WebRTC may use only proxied TCP (no UDP to anywhere: STUN/TURN-UDP bypass the proxy), no QUIC. */
export const CHROMIUM_ARGS: readonly string[] = [
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-quic',
  '--disable-background-networking',
  '--no-pings',
];
/** Removes the page-reachable transports that do not go through HTTP interception (every frame, before page scripts). */
export const INIT_SCRIPT = `(() => {
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCSctpTransport', 'WebTransport']) {
    try { Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false }); } catch {}
  }
  try { if (navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: false }); } catch {}
})();`;

/** The environment handed to Chromium: nothing from Gora's own environment (bot token, API keys) except the basics. */
export function browserEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'FONTCONFIG_PATH', 'SYSTEMROOT']) {
    const v = env[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

type PlaywrightModule = typeof import('playwright');

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

function normalizeNodes(v: unknown): AriaNode[] {
  const conv = (n: unknown): AriaNode | string | null => {
    if (typeof n === 'string') return n;
    if (!n || typeof n !== 'object') return null;
    const o = n as Record<string, unknown>;
    const out: AriaNode = { role: String(o['role'] ?? 'generic') };
    for (const k of ['name', 'ref', 'text', 'value', 'url', 'placeholder'] as const) if (typeof o[k] === 'string') out[k] = o[k] as string;
    if (typeof o['level'] === 'number') out.level = o['level'] as number;
    for (const k of ['disabled', 'selected', 'expanded', 'active'] as const) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
    if (typeof o['checked'] === 'boolean' || o['checked'] === 'mixed') out.checked = o['checked'] as boolean | 'mixed';
    if (typeof o['pressed'] === 'boolean' || o['pressed'] === 'mixed') out.pressed = o['pressed'] as boolean | 'mixed';
    if (o['cursor'] === 'pointer') out.cursor = 'pointer';
    const b = o['box'] as Record<string, unknown> | undefined;
    if (b && typeof b['x'] === 'number') out.box = { x: Number(b['x']), y: Number(b['y']), width: Number(b['width']), height: Number(b['height']) };
    if (Array.isArray(o['children'])) out.children = o['children'].map(conv).filter((x): x is AriaNode | string => x !== null);
    return out;
  };
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(conv).filter((x): x is AriaNode => !!x && typeof x !== 'string');
}

function refsOf(nodes: Array<AriaNode | string>, out: string[] = []): string[] {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.ref && INTERACTIVE_ROLES.has(n.role)) out.push(n.ref);
    if (n.children) refsOf(n.children, out);
  }
  return out;
}

/** Runs in the page (main world): DOM facts the aria tree lacks (input type, autocomplete, name, form, submit, link host). */
function fieldInfoInPage(el: Element): FieldInfo {
  const tagName = el.tagName.toLowerCase();
  const tag = (['input', 'textarea', 'select', 'button', 'a'].includes(tagName) ? tagName : 'other') as FieldInfo['tag'];
  const inp = el as HTMLInputElement;
  const form = (inp as { form?: HTMLFormElement | null }).form ?? el.closest('form');
  const forms = Array.from(document.forms);
  const type = tagName === 'input' ? (inp.type || 'text').toLowerCase() : tagName === 'button' ? ((el as HTMLButtonElement).type || 'submit').toLowerCase() : undefined;
  const submit = (tagName === 'button' && type === 'submit' && !!form) || (tagName === 'input' && (type === 'submit' || type === 'image'));
  const out: FieldInfo = { tag, formId: form ? `f${forms.indexOf(form) + 1}` : null, submit };
  if (type) out.type = type;
  const ac = el.getAttribute('autocomplete');
  if (ac) out.autocomplete = ac;
  const nm = el.getAttribute('name');
  if (nm) out.inputName = nm;
  if (tagName === 'a') {
    try {
      out.hrefHost = new URL((el as HTMLAnchorElement).href).host;
    } catch {
      /* no href */
    }
  }
  return out;
}

class PlaywrightSession implements BrowserSession {
  closed = false;
  readonly taskId: string;
  readonly userId: UserId;
  private page: Page;
  private readonly ctx: BrowserContext;
  private readonly timeout: number;
  private readonly navTimeout: number;
  private readonly clock: Clock;
  private readonly onClose: () => void;
  private last: RawPageState | null = null;
  private blockedDocs = 0;
  /** Non-GET document navigations refused because the running action was not approved (the POST backstop). */
  private submitsBlocked = 0;
  /** True while an owner-approved action runs (its form submit may POST). */
  approvedAction = false;
  private readonly policy: NetworkPolicy;
  private readonly egress: EgressProxy | null;
  private readonly st: BrowserSessionStats = { actions: 0, popups: 0, blockedRequests: 0, downloadsDenied: 0, uploadsDenied: 0, hosts: [] };

  constructor(p: { taskId: string; userId: UserId; ctx: BrowserContext; page: Page; timeout: number; navTimeout: number; clock: Clock; onClose: () => void; policy: NetworkPolicy; egress: EgressProxy | null }) {
    this.policy = p.policy;
    this.egress = p.egress;
    this.taskId = p.taskId;
    this.userId = p.userId;
    this.ctx = p.ctx;
    this.page = p.page;
    this.timeout = p.timeout;
    this.navTimeout = p.navTimeout;
    this.clock = p.clock;
    this.onClose = p.onClose;
    this.watch(p.page);
    p.ctx.on('page', (pg) => {
      if (this.closed) return;
      this.st.popups++;
      this.page = pg; // popups open in the same context and become the task's page
      this.watch(pg);
    });
  }

  private watch(pg: Page): void {
    pg.on('download', (d) => {
      this.st.downloadsDenied++;
      void d.cancel().catch(() => undefined);
    });
    pg.on('filechooser', () => {
      this.st.uploadsDenied++; // intercepted and never answered: no file ever leaves the host
    });
    // a main-frame document the egress proxy refused (a redirect hop to a private address, …) → the action is 'blocked'
    pg.on('response', (r) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === pg.mainFrame() && r.headers()['x-gora-blocked']) this.blockedDocs++;
      } catch {
        /* detached */
      }
    });
  }

  /** Called by the route handler for every refused request. */
  blocked(kind: 'document' | 'subresource'): void {
    this.st.blockedRequests++;
    if (kind === 'document') this.blockedDocs++;
  }

  /** Called by the route handler when an unapproved action tried to submit a form (non-GET document navigation). */
  submitBlocked(): void {
    this.st.blockedRequests++;
    this.submitsBlocked++;
  }

  /** Called by the egress proxy for every refused connection. */
  egressBlocked(): void {
    this.st.blockedRequests++;
  }

  private visited(url: string): void {
    const h = hostOf(url);
    if (h && !this.st.hosts.includes(h)) this.st.hosts.push(h);
  }

  private mapError(e: unknown, blockedBefore: number): BrowserActionResult {
    const msg = e instanceof Error ? e.message : String(e);
    const url = this.page.url();
    if (this.closed || /closed|Target page, context or browser has been closed/i.test(msg)) return { ok: false, error: 'closed' };
    if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg) || this.blockedDocs > blockedBefore) return { ok: false, error: 'blocked', url };
    if (/Download is starting|download/i.test(msg)) return { ok: false, error: 'download_denied', url };
    if (/Timeout/i.test(msg)) return { ok: false, error: 'timeout', url };
    return { ok: false, error: 'navigation_failed', url };
  }

  private async settle(before: string, popupsBefore: number, blockedBefore: number, submitsBefore: number): Promise<BrowserActionResult> {
    // a navigation an action triggers (a scripted form.submit(), an onchange) starts a moment after the action resolves
    await this.page.waitForTimeout(150).catch(() => undefined);
    await this.page.waitForLoadState('domcontentloaded', { timeout: Math.min(this.navTimeout, 5_000) }).catch(() => undefined);
    const url = this.page.url();
    this.last = null;
    if (this.submitsBlocked > submitsBefore) return { ok: false, error: 'needs_approval', url };
    if (this.blockedDocs > blockedBefore) return { ok: false, error: 'blocked', url };
    this.visited(url);
    return { ok: true, url, navigated: url !== before || this.st.popups > popupsBefore };
  }

  private async act(fn: () => Promise<unknown>, approved = false): Promise<BrowserActionResult> {
    if (this.closed) return { ok: false, error: 'closed' };
    const before = this.page.url();
    const popups = this.st.popups;
    const blocked = this.blockedDocs;
    const submits = this.submitsBlocked;
    this.approvedAction = approved;
    try {
      try {
        await fn();
        this.st.actions++;
      } catch (e) {
        if (this.submitsBlocked > submits) return { ok: false, error: 'needs_approval', url: this.page.url() };
        return this.mapError(e, blocked);
      }
      return await this.settle(before, popups, blocked, submits);
    } finally {
      this.approvedAction = false;
    }
  }

  private loc(ref: string) {
    return this.page.locator(`aria-ref=${ref}`);
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      return (await this.loc(ref).count()) > 0;
    } catch {
      return false;
    }
  }

  async open(url: string): Promise<BrowserActionResult> {
    if (this.closed) return { ok: false, error: 'closed' };
    // the top-level URL is checked here first: data:, file:, chrome:, javascript: … never reach page.goto
    let verdict: { allow: boolean };
    try {
      verdict = await this.policy.check(url, 'document');
    } catch {
      verdict = { allow: false };
    }
    if (!verdict.allow) {
      this.blocked('document');
      return { ok: false, error: 'blocked', url: this.page.url() };
    }
    const blocked = this.blockedDocs;
    try {
      const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navTimeout });
      this.st.actions++;
      this.last = null;
      if (this.blockedDocs > blocked || resp?.headers()['x-gora-blocked']) return { ok: false, error: 'blocked', url: this.page.url() };
      this.visited(this.page.url());
      return { ok: true, url: this.page.url(), navigated: true, ...(resp ? { status: resp.status() } : {}) };
    } catch (e) {
      return this.mapError(e, blocked);
    }
  }

  async state(): Promise<RawPageState> {
    if (this.closed) throw new Error('session closed');
    const page = this.page;
    const json = await page.ariaSnapshotJSON({ mode: 'ai', boxes: true, timeout: this.timeout });
    const nodes = normalizeNodes(json);
    const fields: Record<string, FieldInfo> = {};
    const refs = refsOf(nodes).slice(0, FIELD_INFO_MAX);
    await Promise.all(
      refs.map(async (ref) => {
        try {
          fields[ref] = await this.loc(ref).evaluate(fieldInfoInPage, undefined, { timeout: 1_000 });
        } catch {
          /* detached: no DOM facts for this ref */
        }
      }),
    );
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => ({ x: 0, y: 0 }));
    const main = hostOf(page.url());
    const frameHosts = [...new Set(page.frames().map((f) => hostOf(f.url())).filter((h) => h && h !== main))];
    this.last = {
      url: page.url(), title: await page.title().catch(() => ''), viewport: page.viewportSize() ?? { width: 1280, height: 800 }, scroll, nodes, fields, frameHosts, at: this.clock.now(),
    };
    return this.last;
  }

  lastState(): RawPageState | null {
    return this.last;
  }

  async click(ref: string, o: { approved?: boolean } = {}): Promise<BrowserActionResult> {
    if (!(await this.refExists(ref))) return { ok: false, error: 'stale_ref' };
    return this.act(() => this.loc(ref).click({ timeout: this.timeout }), o.approved === true);
  }

  async type(ref: string, text: string, o: { submit?: boolean; approved?: boolean } = {}): Promise<BrowserActionResult> {
    if (!(await this.refExists(ref))) return { ok: false, error: 'stale_ref' };
    const isFile = await this.loc(ref).evaluate((el) => el instanceof HTMLInputElement && el.type === 'file', undefined, { timeout: 1_000 }).catch(() => false);
    if (isFile) {
      this.st.uploadsDenied++;
      return { ok: false, error: 'upload_denied' };
    }
    return this.act(async () => {
      await this.loc(ref).fill(text, { timeout: this.timeout });
      if (o.submit) await this.loc(ref).press('Enter', { timeout: this.timeout });
    }, o.approved === true);
  }

  async select(ref: string, value: string, o: { approved?: boolean } = {}): Promise<BrowserActionResult> {
    if (!(await this.refExists(ref))) return { ok: false, error: 'stale_ref' };
    return this.act(async () => {
      try {
        await this.loc(ref).selectOption({ label: value }, { timeout: this.timeout });
      } catch {
        await this.loc(ref).selectOption(value, { timeout: this.timeout });
      }
    }, o.approved === true);
  }

  press(key: BrowserKey, o: { approved?: boolean } = {}): Promise<BrowserActionResult> {
    return this.act(() => this.page.keyboard.press(key === 'Space' ? ' ' : key), o.approved === true);
  }

  scroll(direction: 'up' | 'down'): Promise<BrowserActionResult> {
    const h = (this.page.viewportSize()?.height ?? 800) * 0.8;
    return this.act(async () => {
      await this.page.mouse.wheel(0, direction === 'down' ? h : -h);
      await this.page.waitForTimeout(150);
    });
  }

  async back(): Promise<BrowserActionResult> {
    if (this.closed) return { ok: false, error: 'closed' };
    const blocked = this.blockedDocs;
    try {
      const resp = await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.navTimeout });
      if (!resp && this.page.url() === 'about:blank') return { ok: false, error: 'navigation_failed' };
      this.st.actions++;
      this.last = null;
      this.visited(this.page.url());
      return { ok: true, url: this.page.url(), navigated: true, ...(resp ? { status: resp.status() } : {}) };
    } catch (e) {
      return this.mapError(e, blocked);
    }
  }

  async screenshot(): Promise<{ bytes: Uint8Array; mime: 'image/jpeg' }> {
    if (this.closed) throw new Error('session closed');
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 70, timeout: this.navTimeout });
    return { bytes: new Uint8Array(buf), mime: 'image/jpeg' };
  }

  stats(): BrowserSessionStats {
    return { ...this.st, hosts: [...this.st.hosts] };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    await this.ctx.close().catch(() => undefined);
    await this.egress?.close().catch(() => undefined);
  }
}

export class PlaywrightBrowser implements BrowserCapability {
  readonly name = 'playwright' as const;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private failedAt: number | null = null;
  private hinted = false;
  private readonly live = new Map<string, PlaywrightSession>();
  private readonly o: PlaywrightOptions;
  private readonly clock: Clock;
  private readonly log: Logger;
  /** Tests (live only): a pre-loaded playwright module. */
  private readonly loader: () => Promise<PlaywrightModule>;

  constructor(o: PlaywrightOptions, deps: { clock: Clock; log: Logger; loader?: () => Promise<PlaywrightModule> }) {
    this.o = o;
    this.clock = deps.clock;
    this.log = deps.log;
    this.loader = deps.loader ?? (() => import('playwright'));
  }

  /** True until a launch fails; then false for `relaunchAfterMs` (default 10 min), after which one retry is allowed. */
  available(): boolean {
    if (this.failedAt === null) return true;
    return this.clock.now() - this.failedAt > (this.o.relaunchAfterMs ?? 10 * 60_000);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = (async () => {
        try {
          const pw = await this.loader();
          const b = await pw.chromium.launch({
            headless: this.o.headless, chromiumSandbox: this.o.sandbox !== false, env: browserEnv(process.env), args: [...CHROMIUM_ARGS],
            ...(this.o.executablePath ? { executablePath: this.o.executablePath } : {}),
          });
          b.on('disconnected', () => {
            if (this.browser === b) this.browser = null;
          });
          this.browser = b;
          this.failedAt = null;
          return b;
        } catch (e) {
          this.failedAt = this.clock.now();
          if (!this.hinted) {
            this.hinted = true;
            this.log.warn({ err: e instanceof Error ? e.name : 'error' }, LAUNCH_HINT);
          }
          throw e;
        } finally {
          this.launching = null;
        }
      })();
    }
    return this.launching;
  }

  async openSession(o: { taskId: string; userId: UserId; policy: NetworkPolicy; viewport?: { width: number; height: number }; locale?: string; timezoneId?: string; actionTimeoutMs?: number }): Promise<BrowserSession> {
    const prev = this.live.get(o.taskId);
    if (prev && !prev.closed) return prev;
    const browser = await this.ensureBrowser();
    let sess: PlaywrightSession | null = null;
    const egress = await startEgressProxy(o.policy, { onBlocked: () => sess?.egressBlocked() });
    let ctx: BrowserContext;
    try {
      ctx = await browser.newContext({
        viewport: o.viewport ?? { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block',
        proxy: { server: egress.server, bypass: '<-loopback>', username: egress.username, password: egress.password },
        ...(o.locale ? { locale: o.locale } : {}), ...(o.timezoneId ? { timezoneId: o.timezoneId } : {}),
      });
    } catch (e) {
      await egress.close();
      throw e;
    }
    await ctx.addInitScript(INIT_SCRIPT);
    await ctx.route('**/*', async (route, request) => {
      const kind = request.isNavigationRequest() ? 'document' : 'subresource';
      // POST backstop (red-team B-COMMIT): a form submit that did not come from an owner-approved action never leaves
      const method = request.method().toUpperCase();
      if (kind === 'document' && method !== 'GET' && method !== 'HEAD' && !sess?.approvedAction) {
        sess?.submitBlocked();
        // 204 No Content cancels a navigation and keeps the current document (the form and what was typed stay)
        await route.fulfill({ status: 204, body: '' }).catch(() => undefined);
        return;
      }
      let allow = false;
      try {
        allow = (await o.policy.check(request.url(), kind)).allow;
      } catch {
        allow = false;
      }
      if (!allow) {
        sess?.blocked(kind);
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });
    await ctx.routeWebSocket(/.*/, async (ws) => {
      const httpUrl = ws.url().replace(/^ws(s?):/i, 'http$1:');
      let allow = false;
      try {
        allow = (await o.policy.check(httpUrl, 'subresource')).allow;
      } catch {
        allow = false;
      }
      if (!allow) {
        sess?.blocked('subresource');
        await ws.close().catch(() => undefined);
        return;
      }
      ws.connectToServer();
    });
    const page = await ctx.newPage();
    sess = new PlaywrightSession({
      taskId: o.taskId, userId: o.userId, ctx, page, timeout: o.actionTimeoutMs ?? this.o.actionTimeoutMs, navTimeout: this.o.navigationTimeoutMs, clock: this.clock,
      policy: o.policy, egress,
      onClose: () => {
        if (this.live.get(o.taskId) === sess) this.live.delete(o.taskId);
      },
    });
    this.live.set(o.taskId, sess);
    return sess;
  }

  session(taskId: string): BrowserSession | undefined {
    return this.live.get(taskId);
  }

  sessions(): readonly BrowserSession[] {
    return [...this.live.values()];
  }

  async closeAll(): Promise<void> {
    for (const s of [...this.live.values()]) await s.close();
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => undefined);
  }
}
