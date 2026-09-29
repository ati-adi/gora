// browser/tools.ts (s07 BR, spec 07 A2–A4) — the browser toolkit (contracts/tools.ts TOOL_OWNERS 'BR'):
//  - browse_task {goal, start_url?, constraints?} (surfaces dm/topic, class control): starts a browse MISSION; it never
//    opens the browser itself;
//  - the in-mission tools (surface 'mission' only; Sentinel S02 refuses them elsewhere): browser_open, browser_snapshot,
//    browser_click, browser_type, browser_select, browser_press, browser_scroll, browser_back, browser_show, browser_done.
//
// Safety (A4), in depth:
//  1. classify (classify.ts) makes every commit send_external/spend (never grantable; S14 asks in a web-tainted run,
//     S05 refuses spend) and typing third-party personal data send_external;
//  2. execute re-checks against a FRESH snapshot: an unapproved call that would commit (the page changed since the
//     classification, or a ref the model never saw) is refused with RECHECK instead of being performed;
//  3. passwords and payment data are never typed (NO_CREDENTIALS / the payment handover), whatever the classification;
//  4. every request goes through the task's NetworkPolicy (netGuard.ts), enforced by the capability;
//  5. page text reaches the model only as ToolOutput.untrusted {source:'web'} (the executor wraps and guard-screens it).
import { z } from 'zod';
import type { ApprovalDiff, BrowserActionResult, BrowserKey, BrowserSession, Classification, ToolCtx, ToolOutput, ToolSpec } from '../contracts/index.ts';
import { BROWSER_KEYS, uiLang } from '../contracts/index.ts';
import { classifyBrowserTool, openTarget, type ClassifyEnv } from './classify.ts';
import { isSubmitAction, submitsForm } from './detect.ts';
import { browserInternals } from './internal.ts';
import { MASK, type BrowserSnapshot, type RefInfo } from './snapshot.ts';
import { brStrings, type BrowserStrings } from './strings.ts';
import { ACTIVE, BROWSER_APPROVAL_TTL_MS, type TaskCore, type TaskRow } from './tasks.ts';

const MISSION = ['mission'] as const;
const REF = z.string().regex(/^(f\d{1,4})?e\d{1,6}$/).max(16);
const APPROVED_EXTENSION_MS = 5 * 60_000;
const DONE_CACHE = 50;

type Act = 'open' | 'snapshot' | 'click' | 'type' | 'select' | 'press' | 'scroll' | 'back' | 'show' | 'done';

const err = (code: string, message: string, extra: Record<string, unknown> = {}): ToolOutput => ({ content: JSON.stringify({ error: code, message, ...extra }), isError: true });
const ru = (lang: string) => uiLang(lang) === 'ru';

interface Step {
  core: TaskCore;
  task: TaskRow;
  steps: number;
  approved: boolean;
  L: BrowserStrings;
}

function pageOut(snap: BrowserSnapshot, head: string): ToolOutput {
  return { content: `${head}\n${snap.text}`, untrusted: { source: 'web', label: snap.host || 'page' } };
}

/** The trusted result of a park (no page text in it). */
function parkedOut(t: TaskRow, reason: string): ToolOutput {
  const note =
    reason === 'payment'
      ? 'The payment step is the owner\'s: they got the link. Do not type card data or press pay. Call browser_done now with a one-line summary.'
      : 'The owner was told in one short line. Call task_wait with on:["user_input"] and timeout_hours 24, then continue from the owner\'s reply.';
  return { content: JSON.stringify({ status: 'parked', reason, task: t.id, note }) };
}

function actionFailed(r: Extract<BrowserActionResult, { ok: false }>): ToolOutput {
  const msg: Record<string, string> = {
    stale_ref: 'No element with that ref on the current page. Take browser_snapshot and use a ref from it.',
    not_interactable: 'That element cannot be used that way (disabled, not a field, or not an option).',
    blocked: 'That address is not allowed (private network, local or blocked host, non-standard port or scheme). Do not retry it.',
    timeout: 'The page did not respond in time. Try again once or take a new snapshot.',
    navigation_failed: 'The page could not be opened.',
    download_denied: 'Downloads are not allowed. Tell the owner the link instead.',
    upload_denied: 'File uploads are not allowed.',
    needs_approval: 'That action tried to submit the form, which needs the owner\'s approval, so nothing was sent. To submit, click the form\'s submit button with browser_click (it will ask the owner).',
    closed: 'The browser task has ended.',
  };
  return err(r.error, msg[r.error] ?? 'The action failed.');
}

/** The task of this mission run, its limits and its step accounting; `run` does the action. */
async function inTask(ctx: ToolCtx, act: Act, run: (st: Step) => Promise<ToolOutput>, o: { count?: boolean } = {}): Promise<ToolOutput> {
  const s = ctx.services;
  const core = browserInternals(s);
  if (!core) return err('UNAVAILABLE', 'The browser is not available.');
  if (ctx.surface !== 'mission') return err('NO_TASK', 'Browser tools work only inside a browse task. Use browse_task.');
  let task = core.forMission(ctx.missionId, ctx.userId);
  if (!task || task.userId !== ctx.userId) return err('NO_TASK', 'This mission has no browser task. Browser tools work only inside a browse task started with browse_task.');
  const r = core.rt(task.id);
  const prev = r.done.get(ctx.idemKey);
  if (prev) return { ...prev };
  if (!ACTIVE.includes(task.status)) return err('TASK_ENDED', `The browser task has ended (${task.status}). Do not continue; end with one short line.`);
  const approved = ctx.approvedAction !== undefined;
  if (approved && task.currentHost) r.approvedHosts.add(task.currentHost.toLowerCase());
  if (task.status === 'parked' && !approved) {
    if (act === 'done' || act === 'show') {
      /* finishing / showing is always fine */
    } else if (core.tryResume(task)) {
      task = core.repo.get(task.id) ?? task;
    } else {
      return parkedOut(task, task.parkReason ?? 'user');
    }
  }
  const lim = s.config.limits;
  const now = s.clock.now();
  if (o.count !== false && !approved && task.status === 'running') {
    if (task.steps >= lim.browserMaxSteps) {
      core.park(task, { reason: 'step_limit' });
      await core.closeSession(task.id);
      return parkedOut(task, 'step_limit');
    }
    if (task.deadlineAt !== null && now > task.deadlineAt) {
      core.park(task, { reason: 'time_limit' });
      await core.closeSession(task.id);
      return parkedOut(task, 'time_limit');
    }
  }
  if (approved && (task.deadlineAt ?? 0) < now + APPROVED_EXTENSION_MS) core.repo.setDeadline(task.id, now + APPROVED_EXTENSION_MS);
  const steps = o.count === false ? task.steps : core.repo.bumpStep(task.id, now);
  const u = s.repos.users.getById(task.userId);
  const L = brStrings(u?.languageCode ?? ctx.lang);
  if (task.missionId && o.count !== false) void s.missions.setStatusLine(task.missionId, L.step(steps, L[`act_${act}` as const])).catch(() => undefined);
  let out: ToolOutput;
  try {
    out = await run({ core, task, steps, approved, L });
  } catch (e) {
    const closed = /closed/i.test(e instanceof Error ? e.message : '');
    out = err(closed ? 'closed' : 'FAILED', closed ? 'The browser session was closed.' : 'The browser action failed.');
  }
  const fresh = core.repo.get(task.id) ?? task;
  try {
    s.ledger.append({
      userId: task.userId, actor: 'agent', kind: 'browser_action', summary: `Browser ${act}${out.isError ? ' (failed)' : ''}`,
      detail: { taskId: task.id, host: fresh.currentHost, action: act, step: steps, ...(r.lastRef ? { refRole: r.lastRef.role, refName: r.lastRef.name.slice(0, 60) } : {}), ...(approved ? { approved: true } : {}) },
      toolUseId: ctx.toolUseId, ...(ctx.runId ? { runId: ctx.runId } : {}),
    });
  } catch {
    /* ledger best effort */
  }
  r.lastRef = null;
  r.done.set(ctx.idemKey, out);
  if (r.done.size > DONE_CACHE) r.done.delete(r.done.keys().next().value!);
  return out;
}

/** After a navigation (or when looking at a page): park on payment / login / captcha once per URL, else the snapshot. */
async function lookAt(st: Step, session: BrowserSession, ctx: ToolCtx, head: string): Promise<ToolOutput> {
  const snap = await st.core.snapshot(st.task, session, ctx.signal);
  const r = st.core.rt(st.task.id);
  const reason = snap.flags.payment ? 'payment' : snap.flags.login ? 'login' : snap.flags.captcha ? 'captcha' : null;
  if (reason) {
    const key = `${reason}|${snap.url}`;
    if (!r.handled.has(key)) {
      r.handled.add(key);
      const t = st.core.repo.get(st.task.id) ?? st.task;
      if (st.core.park(t, { reason, url: snap.url, host: snap.host })) return parkedOut(t, reason);
    }
  }
  return pageOut(snap, head);
}

async function session(st: Step, ctx: ToolCtx): Promise<{ session: BrowserSession; restarted: boolean }> {
  const t = st.core.repo.get(st.task.id) ?? st.task;
  return st.core.sessionFor(t, ctx.signal);
}

const RESTARTED = 'Note: the browser was restarted (a fresh session at the last page). Re-check the page before acting.';

/** The classification environment of a task (snapshot, focus, owner text, owner-side and visited hosts). */
function envOf(core: TaskCore, task: TaskRow, snap: BrowserSnapshot | null): ClassifyEnv {
  const r = core.rt(task.id);
  return { snap, focus: r.focus, ownerText: core.ownerText(task), ownerHosts: core.ownerHosts(task), visitedHosts: core.visitedHosts(task) };
}

/** Execute-time re-check (A4): an unapproved call that would commit (or type third-party personal data) is refused. */
function recheck(st: Step, ctx: ToolCtx, tool: string, input: Record<string, unknown>, snap: BrowserSnapshot): ToolOutput | null {
  if (st.approved) return null;
  const cls = classifyBrowserTool(tool, input, envOf(st.core, st.core.repo.get(st.task.id) ?? st.task, snap));
  if (cls.actionClass === 'send_external' || cls.actionClass === 'spend') {
    return err('RECHECK', 'The page changed since your last snapshot: this action submits or shares data, so it needs the owner\'s approval. Call the same tool again (it will ask the owner).');
  }
  void ctx;
  return null;
}

function refOf(st: Step, ref: string): RefInfo | undefined {
  return st.core.rt(st.task.id).snap?.refs.get(ref);
}

// ───────────────────────── approval card (A4): host, action, the form's fields and values (secrets masked), next step

async function approvalDiff(tool: 'browser_click' | 'browser_type' | 'browser_press' | 'browser_open', input: Record<string, unknown>, ctx: ToolCtx): Promise<ApprovalDiff> {
  const s = ctx.services;
  const core = browserInternals(s);
  const task = core?.forMission(ctx.missionId, ctx.userId);
  if (!core || !task) throw new Error('no browser task');
  const L = brStrings(ctx.lang);
  if (tool === 'browser_open') {
    // a new site the owner did not name: the card shows exactly where the browser would go (the URL can carry data)
    const url = openTarget(String(input['url'] ?? ''));
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* shown raw */
    }
    const action = L.action_open(host);
    return { title: L.approval_title_open, summary: `${action}`, rows: [[L.row_site, host], [L.row_action, action], ['URL', url.slice(0, 300)], [L.row_next, L.approval_next_open]], warnings: [], targets: [] };
  }
  const live = s.caps.browser.session(task.id);
  if (!live || live.closed) throw new Error('the browser session is gone; reopen the page');
  const snap = await core.snapshot(task, live, ctx.signal);
  const r = core.rt(task.id);
  const realFocus = [...snap.refs.values()].find((x) => x.focused)?.ref ?? null;
  const targetRef = tool === 'browser_press' ? (realFocus ?? r.focus) : String(input['ref'] ?? '');
  const target = targetRef ? snap.refs.get(targetRef) : undefined;
  const rows: Array<[string, string]> = [[L.row_site, snap.host || '—']];
  const name = target?.name?.replace(/\s+/g, ' ').trim().slice(0, 60) || target?.ref || '?';
  const action = tool === 'browser_click' ? L.action_click(name) : tool === 'browser_press' ? L.action_press : L.action_type(name);
  rows.push([L.row_action, action]);
  if (tool === 'browser_type') rows.push([L.row_value, target?.secret ? MASK : String(input['text'] ?? '').slice(0, 200)]);
  const formId = target?.formId ?? null;
  const members = formId ? [...snap.refs.values()].filter((x) => x.formId === formId && !x.submit && x.role !== 'button' && x.ref !== (tool === 'browser_type' ? targetRef : '')) : [];
  for (const f of members.slice(0, 10)) {
    const label = (f.name || f.inputName || f.ref).replace(/\s+/g, ' ').trim().slice(0, 40);
    rows.push([label, f.secret ? (f.rawValue ? MASK : '—') : (f.rawValue ?? '—').replace(/\s+/g, ' ').slice(0, 120)]);
  }
  const pay = target ? /spend/.test(classifyBrowserTool(tool, input, { snap, focus: r.focus, ownerText: '' }).actionClass) : snap.flags.payment;
  rows.push([L.row_next, pay ? L.approval_next_pay : L.approval_next]);
  const title = tool === 'browser_click' ? L.approval_title_click : tool === 'browser_press' ? L.approval_title_press : L.approval_title_type;
  return { title, summary: `${action} — ${snap.host}`, rows, warnings: [], targets: [] };
}

async function approvalPhoto(ctx: ToolCtx): Promise<{ kind: 'photo'; bytes: Uint8Array; caption?: string } | null> {
  const s = ctx.services;
  const core = browserInternals(s);
  const task = core?.forMission(ctx.missionId, ctx.userId);
  const live = task ? s.caps.browser.session(task.id) : undefined;
  if (!task || !live || live.closed) return null;
  const shot = await live.screenshot(ctx.signal ? { signal: ctx.signal } : undefined);
  return { kind: 'photo', bytes: shot.bytes, ...(task.currentHost ? { caption: task.currentHost } : {}) };
}

const approvalMeta = async (_i: unknown, ctx: ToolCtx) => ({
  card: { chatId: ctx.chat.chatId, ...(ctx.chat.threadId !== undefined ? { threadId: ctx.chat.threadId } : {}) },
  expiresAt: ctx.services.clock.now() + BROWSER_APPROVAL_TTL_MS,
});

function classifyWith(tool: string) {
  return (input: Record<string, unknown>, ctx: ToolCtx): Classification => {
    const core = browserInternals(ctx.services);
    const task = core?.forMission(ctx.missionId, ctx.userId);
    if (!core || !task) return classifyBrowserTool(tool, input, { snap: null, focus: null, ownerText: '' });
    return classifyBrowserTool(tool, input, envOf(core, task, core.rt(task.id).snap));
  };
}

// ───────────────────────── browse_task (dm/topic)

const browseInput = z.object({
  goal: z.string().min(1).max(1000),
  start_url: z.string().url().max(2000).optional(),
  constraints: z.string().min(1).max(500).optional(),
});

export const browseTask: ToolSpec<z.infer<typeof browseInput>> = {
  name: 'browse_task',
  description: 'Call when the owner wants something done on a website (book, reserve, fill a form). Starts a background browser mission; it asks before any submit.',
  input: browseInput,
  surfaces: ['dm', 'topic'],
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0, quotaKind: 'browser' }),
  statusLabel: (_i, lang) => (ru(lang) ? '🌐 Запускаю браузер…' : '🌐 Starting the browser…'),
  async execute(input, ctx) {
    const s = ctx.services;
    const core = browserInternals(s);
    if (!core || !ctx.userId || !ctx.tgUserId) return err('UNAVAILABLE', 'Browser tasks are available only in a private chat with the owner.');
    let ownerMessages = '';
    try {
      ownerMessages = s.repos.inputs
        .consumedBy(ctx.runId)
        .filter((i) => i.author === 'owner' && !i.untrusted)
        .flatMap((i) => i.content.map((b) => ((b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')))
        .join('\n');
    } catch {
      ownerMessages = '';
    }
    const r = await core.start({
      userId: ctx.userId, tgUserId: ctx.tgUserId, idemKey: ctx.idemKey, goal: input.goal, ...(input.start_url ? { startUrl: input.start_url } : {}),
      ...(input.constraints ? { constraints: input.constraints } : {}), ownerMessages, taint: [...ctx.taint], lang: ctx.lang,
    });
    if (!r.ok) {
      if (r.code === 'QUOTA') {
        try {
          await s.notices.quotaExceeded(ctx.userId, s.quotas.check(ctx.userId, 'browser').ok ? 'mission' : 'browser', ctx.chat);
        } catch {
          /* the model still says one line */
        }
      }
      return err(r.code, r.message, { note: 'Tell the owner in one short line.' });
    }
    return {
      content: JSON.stringify({
        status: r.created ? 'started' : 'already_started', task_id: r.taskId, mission_id: r.missionId, where: r.threadId !== null ? 'private topic' : `main chat, prefixed [${r.missionId}]`,
        note: 'The browser works in the background and asks the owner before any submit. Tell the owner in ONE short line; do not do the site work here.',
      }),
    };
  },
};

// ───────────────────────── in-mission tools

const openInput = z.object({ url: z.string().min(1).max(2000) });
export const browserOpen: ToolSpec<z.infer<typeof openInput>> = {
  name: 'browser_open',
  description: 'Call to open a URL in the task browser (http/https only). Returns a snapshot of the page. A new site after pages were read asks the owner.',
  input: openInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: classifyWith('browser_open'),
  renderDiff: (input, ctx) => approvalDiff('browser_open', input, ctx),
  approvalMeta,
  statusLabel: (_i, lang) => (ru(lang) ? 'Открываю сайт' : 'Opening the site'),
  execute: (input, ctx) =>
    inTask(ctx, 'open', async (st) => {
      const url = openTarget(input.url);
      if (!/^https?:\/\//i.test(url)) return err('blocked', 'Only http and https addresses can be opened.');
      if (!st.approved) {
        const cls = classifyBrowserTool('browser_open', input, envOf(st.core, st.core.repo.get(st.task.id) ?? st.task, st.core.rt(st.task.id).snap));
        if (cls.actionClass !== 'read_public') return err('RECHECK', 'Opening a new site needs the owner\'s approval. Call browser_open again (it will ask the owner).');
      } else {
        try {
          st.core.rt(st.task.id).approvedHosts.add(new URL(url).host.toLowerCase());
        } catch {
          /* invalid → refused below */
        }
      }
      const { session: sess } = await session(st, ctx);
      const res = await sess.open(url, { signal: ctx.signal });
      if (!res.ok) return actionFailed(res);
      return lookAt(st, sess, ctx, `ok: opened (status ${res.status ?? 200})`);
    }),
};

const emptyInput = z.object({}).strict();
export const browserSnapshot: ToolSpec<z.infer<typeof emptyInput>> = {
  name: 'browser_snapshot',
  description: 'Call to read the current page: title, URL, interactive elements with refs (e1…), forms and short text.',
  input: emptyInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: () => ({ actionClass: 'read_public', risk: 0 }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Смотрю страницу' : 'Reading the page'),
  execute: (_input, ctx) =>
    inTask(ctx, 'snapshot', async (st) => {
      const { session: sess, restarted } = await session(st, ctx);
      return lookAt(st, sess, ctx, restarted ? RESTARTED : 'ok');
    }),
};

const clickInput = z.object({ ref: REF });
export const browserClick: ToolSpec<z.infer<typeof clickInput>> = {
  name: 'browser_click',
  description: 'Call to click an element by its ref from the last snapshot. Submitting (book, send, order…) asks the owner first.',
  input: clickInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: classifyWith('browser_click'),
  renderDiff: (input, ctx) => approvalDiff('browser_click', input, ctx),
  approvalMeta,
  approvalAttachment: (_i, ctx) => approvalPhoto(ctx),
  statusLabel: (_i, lang) => (ru(lang) ? 'Нажимаю' : 'Clicking'),
  execute: (input, ctx) =>
    inTask(ctx, 'click', async (st) => {
      const { session: sess, restarted } = await session(st, ctx);
      if (restarted) return lookAt(st, sess, ctx, RESTARTED);
      const cached = st.core.rt(st.task.id).snap;
      const fresh = st.approved && cached ? cached : await st.core.snapshot(st.task, sess, ctx.signal);
      const target = fresh.refs.get(input.ref);
      const r = st.core.rt(st.task.id);
      if (target) r.lastRef = { role: target.role, name: target.name };
      const refused = recheck(st, ctx, 'browser_click', input, fresh);
      if (refused) return refused;
      if (target && isSubmitAction(target, fresh) && fresh.flags.payment && !st.approved) return parkedOut(st.task, 'payment');
      const res = await sess.click(input.ref, { signal: ctx.signal, ...(st.approved ? { approved: true } : {}) });
      r.focus = input.ref;
      if (!res.ok) return actionFailed(res);
      return lookAt(st, sess, ctx, res.navigated ? 'ok: clicked; the page changed' : 'ok: clicked');
    }),
};

const typeInput = z.object({ ref: REF, text: z.string().max(500), submit: z.boolean().optional() });
export const browserType: ToolSpec<z.infer<typeof typeInput>> = {
  name: 'browser_type',
  description: 'Call to fill a field (by ref) with text; submit:true presses Enter after. Never for passwords or card data.',
  input: typeInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: classifyWith('browser_type'),
  renderDiff: (input, ctx) => approvalDiff('browser_type', input, ctx),
  approvalMeta,
  approvalAttachment: (_i, ctx) => approvalPhoto(ctx),
  statusLabel: (_i, lang) => (ru(lang) ? 'Заполняю форму' : 'Filling in the form'),
  execute: (input, ctx) =>
    inTask(ctx, 'type', async (st) => {
      const { session: sess, restarted } = await session(st, ctx);
      if (restarted) return lookAt(st, sess, ctx, RESTARTED);
      const fresh = await st.core.snapshot(st.task, sess, ctx.signal);
      const target = fresh.refs.get(input.ref);
      const r = st.core.rt(st.task.id);
      if (target) r.lastRef = { role: target.role, name: target.name };
      if (target?.password) return err('NO_CREDENTIALS', 'I never type passwords or log in. Continue without a login, or tell the owner the site needs one.');
      if (target?.payment || (fresh.flags.payment && target && /card|cvc|cvv|expir|карт/i.test(`${target.name} ${target.inputName ?? ''}`))) {
        const key = `payment|${fresh.url}`;
        if (!r.handled.has(key)) {
          r.handled.add(key);
          st.core.park(st.core.repo.get(st.task.id) ?? st.task, { reason: 'payment', url: fresh.url, host: fresh.host });
        }
        return parkedOut(st.task, 'payment');
      }
      const refused = recheck(st, ctx, 'browser_type', input, fresh);
      if (refused) return refused;
      const res = await sess.type(input.ref, input.text, { ...(input.submit ? { submit: true } : {}), signal: ctx.signal, ...(st.approved ? { approved: true } : {}) });
      r.focus = input.ref;
      if (!res.ok) return actionFailed(res);
      if (input.submit || res.navigated) return lookAt(st, sess, ctx, res.navigated ? 'ok: typed and submitted; the page changed' : 'ok: typed and pressed Enter');
      await st.core.snapshot(st.task, sess, ctx.signal);
      return { content: `ok: typed into ${input.ref}${target ? ` (${target.role} "${target.name.slice(0, 60)}")` : ''}`, untrusted: { source: 'web', label: fresh.host || 'page' } };
    }),
};

const selectInput = z.object({ ref: REF, value: z.string().min(1).max(200) });
export const browserSelect: ToolSpec<z.infer<typeof selectInput>> = {
  name: 'browser_select',
  description: 'Call to pick an option (by its text) in a select/combobox by ref.',
  input: selectInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: classifyWith('browser_select'),
  statusLabel: (_i, lang) => (ru(lang) ? 'Выбираю вариант' : 'Picking an option'),
  execute: (input, ctx) =>
    inTask(ctx, 'select', async (st) => {
      const { session: sess, restarted } = await session(st, ctx);
      if (restarted) return lookAt(st, sess, ctx, RESTARTED);
      const target = refOf(st, input.ref);
      const r = st.core.rt(st.task.id);
      if (target) r.lastRef = { role: target.role, name: target.name };
      const res = await sess.select(input.ref, input.value, { signal: ctx.signal, ...(st.approved ? { approved: true } : {}) });
      if (!res.ok) return actionFailed(res);
      r.focus = input.ref;
      const snap = await st.core.snapshot(st.task, sess, ctx.signal);
      return { content: `ok: selected in ${input.ref}`, untrusted: { source: 'web', label: snap.host || 'page' } };
    }),
};

const pressInput = z.object({ key: z.enum(BROWSER_KEYS as unknown as [BrowserKey, ...BrowserKey[]]) });
export const browserPress: ToolSpec<z.infer<typeof pressInput>> = {
  name: 'browser_press',
  description: 'Call to press a key (Enter, Tab, Escape, arrows, PageDown…) in the focused element. Enter in a form asks first.',
  input: pressInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: classifyWith('browser_press'),
  renderDiff: (input, ctx) => approvalDiff('browser_press', input, ctx),
  approvalMeta,
  approvalAttachment: (_i, ctx) => approvalPhoto(ctx),
  statusLabel: (_i, lang) => (ru(lang) ? 'Нажимаю клавишу' : 'Pressing a key'),
  execute: (input, ctx) =>
    inTask(ctx, 'press', async (st) => {
      const { session: sess, restarted } = await session(st, ctx);
      if (restarted) return lookAt(st, sess, ctx, RESTARTED);
      const fresh = await st.core.snapshot(st.task, sess, ctx.signal);
      const r = st.core.rt(st.task.id);
      const focused = [...fresh.refs.values()].find((x) => x.focused) ?? (r.focus ? fresh.refs.get(r.focus) : undefined);
      if (focused) r.lastRef = { role: focused.role, name: focused.name };
      const refused = recheck(st, ctx, 'browser_press', input, fresh);
      if (refused) return refused;
      if ((input.key === 'Enter' || input.key === 'Space') && focused && fresh.flags.payment && !st.approved && (isSubmitAction(focused, fresh) || submitsForm(fresh, focused))) return parkedOut(st.task, 'payment');
      const res = await sess.press(input.key, { signal: ctx.signal, ...(st.approved ? { approved: true } : {}) });
      if (!res.ok) return actionFailed(res);
      return lookAt(st, sess, ctx, res.navigated ? `ok: pressed ${input.key}; the page changed` : `ok: pressed ${input.key}`);
    }),
};

const scrollInput = z.object({ direction: z.enum(['up', 'down']) });
export const browserScroll: ToolSpec<z.infer<typeof scrollInput>> = {
  name: 'browser_scroll',
  description: 'Call to scroll the page up or down one screen; returns the new snapshot.',
  input: scrollInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: () => ({ actionClass: 'read_public', risk: 0 }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Листаю страницу' : 'Scrolling'),
  execute: (input, ctx) =>
    inTask(ctx, 'scroll', async (st) => {
      const { session: sess, restarted } = await session(st, ctx);
      if (restarted) return lookAt(st, sess, ctx, RESTARTED);
      const res = await sess.scroll(input.direction, { signal: ctx.signal });
      if (!res.ok) return actionFailed(res);
      return lookAt(st, sess, ctx, `ok: scrolled ${input.direction}`);
    }),
};

export const browserBack: ToolSpec<z.infer<typeof emptyInput>> = {
  name: 'browser_back',
  description: 'Call to go back to the previous page; returns its snapshot.',
  input: emptyInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: () => ({ actionClass: 'read_public', risk: 0 }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Возвращаюсь назад' : 'Going back'),
  execute: (_input, ctx) =>
    inTask(ctx, 'back', async (st) => {
      const { session: sess, restarted } = await session(st, ctx);
      if (restarted) return lookAt(st, sess, ctx, RESTARTED);
      const res = await sess.back({ signal: ctx.signal });
      if (!res.ok) return actionFailed(res);
      return lookAt(st, sess, ctx, 'ok: went back');
    }),
};

const showInput = z.object({ caption: z.string().min(1).max(200) });
export const browserShow: ToolSpec<z.infer<typeof showInput>> = {
  name: 'browser_show',
  description: 'Call to send the owner a screenshot of the current page in the mission thread, with a short caption.',
  input: showInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: () => ({ actionClass: 'ui', risk: 0 }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Показываю страницу' : 'Showing the page'),
  execute: (input, ctx) =>
    inTask(ctx, 'show', async (st) => {
      const s = ctx.services;
      const live = s.caps.browser.session(st.task.id);
      if (!live || live.closed) return err('NO_PAGE', 'There is no open page to show. Open one first.');
      const shot = await live.screenshot({ signal: ctx.signal });
      const c = st.core.chatOf(st.task);
      if (!c) return err('FAILED', 'No chat to show it in.');
      const blobId = s.repos.messages.putBlob({ ownerUserId: st.task.userId, dek: `u:${st.task.userId}`, mime: shot.mime, bytes: shot.bytes });
      await s.telegram.outbox.sendNow({
        idempotencyKey: `br:show:${st.task.id}:${ctx.idemKey}`, userId: c.userId, chatId: c.chatId, ...(c.threadId !== undefined ? { threadId: c.threadId } : {}),
        method: 'sendPhoto', payload: { blob_id: blobId, filename: shot.mime === 'image/png' ? 'page.png' : 'page.jpg', caption: input.caption.slice(0, 200) }, priority: 5,
      });
      st.core.repo.setShowStep(st.task.id, st.steps);
      return { content: JSON.stringify({ ok: true, note: 'The owner got the screenshot.' }) };
    }),
};

const doneInput = z.object({ summary: z.string().min(1).max(1000), result_url: z.string().url().max(2000).optional() });
export const browserDone: ToolSpec<z.infer<typeof doneInput>> = {
  name: 'browser_done',
  description: 'Call once when the browser task is finished, handed to the owner, or declined: posts the summary and closes the browser.',
  input: doneInput,
  surfaces: MISSION,
  parallelSafe: false,
  classify: () => ({ actionClass: 'control', risk: 0 }),
  statusLabel: (_i, lang) => (ru(lang) ? 'Завершаю' : 'Finishing'),
  execute: (input, ctx) =>
    inTask(
      ctx,
      'done',
      async (st) => {
        const s = ctx.services;
        const t = st.core.repo.get(st.task.id) ?? st.task;
        st.core.repo.setResult(t, input.summary, input.result_url ?? null, s.clock.now());
        await st.core.end(t.id, 'done');
        if (t.missionId) {
          const m = s.missions.get(t.missionId);
          if (m && (m.status === 'active' || m.status === 'parked' || m.status === 'budget_exhausted')) {
            await s.missions.finish(t.missionId, 'done', input.result_url ? `${input.summary}\n${input.result_url}` : input.summary);
          }
        }
        return { content: JSON.stringify({ ok: true, note: 'The summary was posted and the browser closed. The task is over.' }) };
      },
      { count: false },
    ),
};

export const TOOLS: readonly ToolSpec[] = Object.freeze([
  browseTask, browserOpen, browserSnapshot, browserClick, browserType, browserSelect, browserPress, browserScroll, browserBack, browserShow, browserDone,
]);
