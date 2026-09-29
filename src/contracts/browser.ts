// ── contracts/browser.ts (s07 foundation, spec 07 §A) — "Gora in the browser": the BrowserCapability seam.
// Implementations: src/browser/playwright.ts `PlaywrightBrowser` (real, headless Chromium via playwright 1.63.0, the
// only runtime importer of 'playwright' — importRules 'playwright-runtime-import') and test/harness/fakeBrowser.ts
// `FakeBrowser` (scripted sites). A hosted provider (Browserbase / Steel over CDP) later implements the same interface.
//
// The capability is deliberately DUMB: it opens one ephemeral context per task, performs raw actions by ref, and returns
// the RAW page state (aria nodes + DOM field facts). Everything with policy in it lives in src/browser/ (owned by the BR
// set): the compact snapshot builder (token caps, deterministic truncation, password/payment masking), the network
// guard (a NetworkPolicy handed to openSession), submit/payment/login detection and the Sentinel classification.
import type { Ms, UserId } from './common.ts';

/**
 * One node of Playwright's AI aria snapshot (`page.ariaSnapshotJSON({mode:'ai', boxes:true})`, verified on 1.63.0):
 * `ref` ('e1', 'e2', …) is stable across snapshots of the same page and addresses the element for actions
 * (`page.locator('aria-ref=e5')`). A textbox's current value arrives as `text` (normalised to `value` here).
 * WARNING (verified): a password input's value appears IN CLEAR in the aria tree; `fields[ref].type === 'password'`
 * (from the DOM pass) is how the snapshot builder knows to mask it.
 */
export interface AriaNode {
  role: string;
  name?: string;
  ref?: string;
  /** Static text, or a textbox's current value. */
  text?: string;
  value?: string;
  url?: string;
  placeholder?: string;
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean | 'mixed';
  active?: boolean;
  cursor?: 'pointer';
  /** Viewport-relative CSS px (boxes:true). Absent for nodes without layout. */
  box?: { x: number; y: number; width: number; height: number };
  children?: Array<AriaNode | string>;
}

/** DOM facts the aria tree does not carry, keyed by aria ref (collected by one page.evaluate per snapshot). */
export interface FieldInfo {
  tag: 'input' | 'textarea' | 'select' | 'button' | 'a' | 'other';
  /** input type attribute ('text', 'password', 'email', 'tel', 'submit', 'search', 'number', 'file', …). */
  type?: string;
  /** autocomplete attribute ('cc-number', 'cc-csc', 'current-password', 'email', …). */
  autocomplete?: string;
  /** name attribute of the control. */
  inputName?: string;
  /** A stable id of the enclosing <form> ('f1', 'f2', … per page), null when outside a form. */
  formId?: string | null;
  /** True for <button type=submit|default-in-form>, <input type=submit|image>. */
  submit?: boolean;
  /** Link target host when tag === 'a'. */
  hrefHost?: string;
}

/** The raw page state returned by BrowserSession.state(); input to the BR snapshot builder. */
export interface RawPageState {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** Scroll offset of the main frame (CSS px). */
  scroll: { x: number; y: number };
  nodes: AriaNode[];
  fields: Record<string, FieldInfo>;
  /** Hosts of iframes on the page (payment widgets are often iframes: stripe.com, checkout.*, …). */
  frameHosts: string[];
  at: Ms;
}

/** Result of every action. `navigated`: the main frame's URL changed (or a popup was adopted into the task). */
export type BrowserActionResult =
  | { ok: true; url: string; navigated: boolean; status?: number }
  | { ok: false; error: BrowserActionError; detail?: string; url?: string };
export type BrowserActionError =
  | 'stale_ref' // no element for the ref (take a new snapshot)
  | 'not_interactable'
  | 'blocked' // the NetworkPolicy refused the navigation
  | 'timeout'
  | 'navigation_failed'
  | 'download_denied'
  | 'upload_denied'
  | 'needs_approval' // s07 lead: the action tried to submit a form (non-GET navigation) without the owner's approval; refused
  | 'closed'; // the session was closed (Stop, finish, crash recovery)

export type BrowserKey = 'Enter' | 'Tab' | 'Escape' | 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'PageDown' | 'PageUp' | 'Home' | 'End' | 'Backspace' | 'Space';
export const BROWSER_KEYS: readonly BrowserKey[] = ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', 'Backspace', 'Space'];

/**
 * A04 network guard, provided by BR (src/browser/netGuard.ts) and enforced by the capability on EVERY request of the
 * context (Playwright `context.route('**\/*')`; FakeBrowser on every scripted navigation and subresource): http(s) only,
 * no private / loopback / link-local / metadata IPs after DNS resolution, not Gora's own host, standard ports only, no
 * file:/data:/chrome: schemes. A refused request is aborted ('blockedbyclient'); a refused main-frame navigation
 * makes the action resolve {ok:false, error:'blocked'}.
 */
export interface NetworkPolicy {
  check(url: string, kind: 'document' | 'subresource'): Promise<{ allow: true } | { allow: false; reason: string }>;
  /**
   * s07 lead addition (red-team B-NET-1/2, DNS rebinding): the address a connection to `host:port` must use. The
   * Playwright capability routes ALL of Chromium's traffic through a local egress proxy (browser/egress.ts) that calls
   * `check` for every request and redirect hop and then connects ONLY to the address returned here (resolved once and
   * vetted: no private / loopback / link-local / metadata address), so a rebinding host cannot switch to an internal
   * address between the check and the connection. Optional: without it the proxy resolves the name itself (tests).
   */
  connectAddress?(host: string, port: number): Promise<{ allow: true; address: string; family: 4 | 6 } | { allow: false; reason: string }>;
}

export interface BrowserSessionStats {
  /** Main-frame navigations + actions performed (BR counts model steps itself; this is the capability's view). */
  actions: number;
  popups: number;
  blockedRequests: number;
  downloadsDenied: number;
  uploadsDenied: number;
  /** Hosts the main frame visited, in order, de-duplicated. */
  hosts: string[];
}

/**
 * One ephemeral browser context (no persistent cookies or logins in v1). Popups open in the same context and become
 * the current page (counted in stats.popups). Downloads and file choosers are denied. Actions time out after
 * `actionTimeoutMs` (default 5 s) — a stale ref therefore fails fast.
 */
export interface BrowserSession {
  readonly taskId: string;
  readonly userId: UserId;
  open(url: string, o?: { signal?: AbortSignal }): Promise<BrowserActionResult>;
  /** The raw state of the current page (aria nodes with refs + DOM field facts). Cheap (~1 ms on a small page). */
  state(o?: { signal?: AbortSignal }): Promise<RawPageState>;
  /** The last state() result, synchronously (Sentinel classify() is synchronous): null before the first state(). */
  lastState(): RawPageState | null;
  /**
   * s07 lead addition (red-team B-COMMIT): `approved` = the owner approved this very action. Without it the capability
   * refuses every non-GET document navigation (a POST form submit, however it was triggered: Enter on an autofocused
   * button, Tab+Space, a scripted `form.submit()`, a select's onchange) while the action runs — a network backstop under
   * the name-based commit detection. GET navigations (links, search forms) are unaffected.
   */
  click(ref: string, o?: { signal?: AbortSignal; approved?: boolean }): Promise<BrowserActionResult>;
  /** Fills (replaces) the field's value; `submit` presses Enter afterwards. */
  type(ref: string, text: string, o?: { submit?: boolean; signal?: AbortSignal; approved?: boolean }): Promise<BrowserActionResult>;
  select(ref: string, value: string, o?: { signal?: AbortSignal; approved?: boolean }): Promise<BrowserActionResult>;
  press(key: BrowserKey, o?: { signal?: AbortSignal; approved?: boolean }): Promise<BrowserActionResult>;
  scroll(direction: 'up' | 'down', o?: { signal?: AbortSignal }): Promise<BrowserActionResult>;
  back(o?: { signal?: AbortSignal }): Promise<BrowserActionResult>;
  /** Viewport screenshot, JPEG (quality ~70; ~20–80 KB). */
  screenshot(o?: { signal?: AbortSignal }): Promise<{ bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' }>;
  stats(): BrowserSessionStats;
  readonly closed: boolean;
  /** Idempotent. */
  close(): Promise<void>;
}

/**
 * Spec 07 A1. `Capabilities.browser` (built by createCapabilities through src/browser/capability.ts
 * createBrowserCapability; tests inject a FakeBrowser via AppOptions.browser / createTestApp({browser})).
 * name 'none' = unavailable (BROWSER_PROVIDER=none, Chromium missing, feature off): available() is false and
 * openSession rejects — browse_task then answers without starting a mission.
 */
export interface BrowserCapability {
  readonly name: 'playwright' | 'fake' | 'none';
  available(): boolean;
  openSession(o: {
    taskId: string;
    userId: UserId;
    policy: NetworkPolicy;
    viewport?: { width: number; height: number };
    locale?: string;
    timezoneId?: string;
    actionTimeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<BrowserSession>;
  /** The live session of a task (in this process), if any. */
  session(taskId: string): BrowserSession | undefined;
  /** Live sessions (for the sweep: close those whose task/mission ended). */
  sessions(): readonly BrowserSession[];
  /** App shutdown. Idempotent. */
  closeAll(): Promise<void>;
}

/** Browser task lifecycle (browser_tasks.status). 'starting'|'running'|'parked' occupy the user's single slot (A4). */
export type BrowserTaskStatus = 'starting' | 'running' | 'parked' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export const BROWSER_TASK_ACTIVE: readonly BrowserTaskStatus[] = ['starting', 'running', 'parked'];
export type BrowserParkReason = 'login' | 'payment' | 'time_limit' | 'step_limit' | 'approval' | 'captcha' | 'user';

/** A browse task as other modules may see it (Mini App Tasks, /why, the status card). No goal text, no field values. */
export interface BrowserTaskView {
  id: string;
  userId: UserId;
  missionId: string | null;
  conversationId: string | null;
  status: BrowserTaskStatus;
  parkReason: BrowserParkReason | null;
  host: string | null;
  steps: number;
  startedAt: Ms | null;
  deadlineAt: Ms | null;
  finishedAt: Ms | null;
  createdAt: Ms;
}

/**
 * `s.browserTasks` (src/browser/index.ts createBrowserModule, the BR set; table browser_tasks). The browser tools reach
 * their own internals through the module (like missions/internal.ts); other modules only read through this view.
 */
export interface BrowserTaskService {
  /** The user's task occupying the single slot ('starting' | 'running' | 'parked'), if any. */
  active(userId: UserId): BrowserTaskView | null;
  forMission(missionId: string): BrowserTaskView | null;
  /**
   * s07 lead addition: the browse task of a mission conversation (any status). agent/context.ts uses it to keep the
   * owner's memory, profile card and location out of browse missions (a web page must have nothing to exfiltrate).
   */
  forConversation(conversationId: string): BrowserTaskView | null;
  list(userId: UserId, o?: { limit?: number }): BrowserTaskView[];
}
export interface BrowserModule { tasks: BrowserTaskService }
