// missions/missions.ts (WP6b) — MissionService (01 F10, §5.5 notify status labels, §5.6 task_wait park/wake, §5.7 Stop):
// a private topic per mission (or the main DM with an `[M…]` prefix), a live status card edited at most every 3 s,
// status prefixes on the topic name, budgets (park on budget → [➕ Budget] [⏹ Stop]) and Stop.
import type { InlineKeyboardButton } from 'grammy/types';
import type { MissionService, MissionView, Ms, RunRow, Services, UserId, UserRow } from '../contracts/index.ts';
import { shortId } from '../kernel/ids.ts';
import { formatDisplay, parseLocal, zonedToInstant } from '../kernel/timeMath.ts';
import { cbButton, clipText, dmChatOf, HOUR, langOf, planOf } from '../proactive/util.ts';
import type { MissionInternals } from './internal.ts';
import { OPEN_MISSION_STATUSES, type ChecklistItem, type MissionRow, type MissionRepo, type MissionStatus } from './repo.ts';

export const CARD_EDIT_MIN_MS = 3_000;
export const REPORT_POST_MIN_MS = HOUR;
export const DEFAULT_BUDGET_SHARE = 0.5;
export const BUDGET_STEP_SHARE = 0.25;
const LIVE_RUN: ReadonlySet<RunRow['state']> = new Set(['queued', 'running', 'retry_wait']);

const TX = {
  en: {
    working: '⏳ Working', waiting: '⏸ Waiting', waitingOn: (w: string) => `⏸ Waiting on ${w}`, idle: '⏸ Waiting for you — reply here to continue', idleNoTopic: '⏸ Idle',
    budgetOut: '⏸ Paused: budget used up', done: '✅ Done', failed: '⛔ Failed', cancelled: '⛔ Cancelled',
    budget: (sp: string, b: string) => `💰 Budget: ${sp} of ${b}`, deadline: (d: string) => `⏰ Deadline: ${d}`, note: 'Latest',
    addBudget: '➕ Budget', finishedDm: (t: string, st: string) => `🎯 Mission “${t}”: ${st}`, stoppedBy: 'Mission cancelled by the owner.',
    report: 'Update', summary: 'Summary', budgetAtMax: 'The budget is already at your plan’s maximum.',
  },
  ru: {
    working: '⏳ В работе', waiting: '⏸ Ожидание', waitingOn: (w: string) => `⏸ Ждёт: ${w}`, idle: '⏸ Жду вас — ответьте здесь, чтобы продолжить', idleNoTopic: '⏸ Ожидание',
    budgetOut: '⏸ Пауза: бюджет исчерпан', done: '✅ Готово', failed: '⛔ Не удалось', cancelled: '⛔ Отменено',
    budget: (sp: string, b: string) => `💰 Бюджет: ${sp} из ${b}`, deadline: (d: string) => `⏰ Срок: ${d}`, note: 'Последнее',
    addBudget: '➕ Бюджет', finishedDm: (t: string, st: string) => `🎯 Миссия «${t}»: ${st}`, stoppedBy: 'Миссия отменена владельцем.',
    report: 'Обновление', summary: 'Итог', budgetAtMax: 'Бюджет уже на максимуме вашего тарифа.',
  },
} as const;

export const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

export interface Effective { status: MissionStatus; run: RunRow | undefined; waitingOn: string[] | null; live: boolean }
type TopicStatus = 'working' | 'waiting' | 'done' | 'failed' | 'none';

export interface MissionCore {
  service: MissionService;
  internals: Pick<MissionInternals, 'startWithId' | 'ownerOf' | 'budgetCapUsd'>;
  effective(m: MissionRow): Effective;
  refresh(missionId: string): void;
  /** RunHook: a mission run ended (done / refused / failed) without being parked. */
  onRunEnded(conversationId: string): void;
  budgetStepUsd(userId: UserId): number;
  txt(u: UserRow | undefined): (typeof TX)['en'] | (typeof TX)['ru'];
  /** Cancels pending card refreshes of these missions (owner deletion). */
  stopTimers(missionIds: readonly string[]): void;
}

export function createMissionCore(s: Services, repo: MissionRepo, hooks: { onFinished(missionId: string, status: 'done' | 'failed' | 'cancelled'): void }): MissionCore {
  const statusLines = new Map<string, string>();
  const timers = new Map<string, unknown>();
  const lastEditAt = new Map<string, Ms>();
  const topicState = new Map<string, TopicStatus>();
  let editSeq = 0;
  const now = () => s.clock.now();
  const txt = (u: UserRow | undefined) => TX[langOf(u)];
  const planMax = (u: UserRow) => planOf(s, u).missionBudgetMicros;

  function effective(m: MissionRow): Effective {
    if (m.status !== 'active' && m.status !== 'parked') return { status: m.status, run: undefined, waitingOn: null, live: false };
    const conv = s.repos.conversations.get(m.conversationId);
    const run = conv?.activeRunId ? s.repos.runs.get(conv.activeRunId) : undefined;
    if (run?.state === 'parked') return { status: 'parked', run, waitingOn: run.wakeOn, live: false };
    return { status: 'active', run, waitingOn: null, live: !!run && LIVE_RUN.has(run.state) };
  }

  function topicStatusOf(e: Effective): TopicStatus {
    switch (e.status) {
      case 'active': return e.live ? 'working' : 'waiting';
      case 'parked': case 'budget_exhausted': return 'waiting';
      case 'done': return 'done';
      default: return 'failed';
    }
  }

  async function setTopic(m: MissionRow, u: UserRow, st: TopicStatus): Promise<void> {
    if (m.threadId === null || topicState.get(m.id) === st) return;
    topicState.set(m.id, st);
    try {
      await s.telegram.topics.setStatus(u.tgUserId, m.threadId, st);
    } catch (e) {
      topicState.delete(m.id);
      s.log.warn({ missionId: m.id, err: e instanceof Error ? e.name : 'error' }, 'mission: topic status failed');
    }
  }

  const prefix = (m: MissionRow) => (m.threadId === null ? `[${m.id}] ` : '');

  function renderCard(m: MissionRow, e: Effective, u: UserRow): { markdown: string; buttons: InlineKeyboardButton[][] } {
    const L = txt(u);
    const r = s.telegram.render;
    const lang = langOf(u);
    let head: string;
    switch (e.status) {
      // Without a topic the owner's replies land in the main DM conversation, not here: never invite a reply (F8).
      case 'active': head = e.live ? L.working : m.threadId === null ? L.idleNoTopic : L.idle; break;
      case 'parked': head = e.waitingOn && e.waitingOn.length ? L.waitingOn(e.waitingOn.join(', ')) : L.waiting; break;
      case 'budget_exhausted': head = L.budgetOut; break;
      case 'done': head = L.done; break;
      case 'failed': head = L.failed; break;
      default: head = L.cancelled;
    }
    const lines = [`🎯 **${r.escape(prefix(m) + m.title)}**`, head];
    const label = statusLines.get(m.id);
    if (label && e.status === 'active' && e.live) lines.push(`_${r.escape(clipText(label, 120))}_`);
    if (m.checklist.length) lines.push('', ...m.checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${r.escape(clipText(c.text, 100))}`));
    if (m.note) lines.push('', `**${r.escape(L.note)}:** ${r.escape(clipText(m.note, 500))}`);
    lines.push('', L.budget(usd(m.spentMicros), usd(m.budgetMicros)));
    if (e.status === 'budget_exhausted') lines.push(s.strings.t('mission_budget_exhausted', lang, { spent: usd(m.spentMicros), budget: usd(m.budgetMicros) }));
    if (m.deadlineAt !== null) lines.push(L.deadline(formatDisplay(m.deadlineAt, u.tz, lang)));
    const open = OPEN_MISSION_STATUSES.includes(e.status);
    const stop = cbButton(s, s.strings.t('mission_stop_button', lang), 'ms', [m.id, 'stop'], u.tgUserId);
    const buttons: InlineKeyboardButton[][] = !open ? [] : e.status === 'budget_exhausted' && m.budgetMicros < planMax(u)
      ? [[cbButton(s, L.addBudget, 'ms', [m.id, 'budget'], u.tgUserId), stop]]
      : [[stop]];
    return { markdown: lines.join('\n'), buttons };
  }

  function target(m: MissionRow, u: UserRow) {
    return { userId: u.id, chatId: dmChatOf(u), ...(m.threadId !== null ? { threadId: m.threadId } : {}) };
  }

  async function sendCard(m: MissionRow, u: UserRow): Promise<void> {
    const { markdown, buttons } = renderCard(m, effective(m), u);
    try {
      const sent = await s.telegram.outbox.sendNow({
        idempotencyKey: `mcard:${m.id}`, ...target(m, u), method: 'sendRichMessage', markdown,
        payload: { reply_markup: { inline_keyboard: buttons } }, priority: 1, disableNotification: true,
      });
      const first = sent[0];
      if (first) {
        repo.setStatusMessage(m.id, first.messageId);
        s.telegram.links.record({ chatId: first.chatId, messageId: first.messageId, kind: 'status', userId: u.id, conversationId: m.conversationId });
      }
      lastEditAt.set(m.id, now());
    } catch (e) {
      s.log.warn({ missionId: m.id, err: e instanceof Error ? e.name : 'error' }, 'mission: status card send failed');
    }
  }

  /** Re-derives the state, persists parked/active flips, renames the topic and edits the card (now). */
  async function sync(missionId: string): Promise<void> {
    const h = timers.get(missionId);
    if (h !== undefined) {
      s.clock.clearTimeout(h);
      timers.delete(missionId);
    }
    let m = repo.getMission(missionId);
    if (!m) return;
    const u = s.repos.users.getById(m.userId);
    if (!u) return;
    const e = effective(m);
    if (e.status !== m.status && (e.status === 'parked' || e.status === 'active')) {
      repo.setMissionStatus(m.id, e.status, ['active', 'parked'], now());
      m = { ...m, status: e.status };
    }
    await setTopic(m, u, topicStatusOf(e));
    if (m.statusMessageId === null) { await sendCard(m, u); return; }
    const { markdown, buttons } = renderCard(m, e, u);
    lastEditAt.set(m.id, now());
    s.telegram.outbox.enqueue({
      idempotencyKey: `mcard:${m.id}:e${++editSeq}:${now()}`, userId: u.id, chatId: dmChatOf(u), method: 'editMessageText', markdown,
      payload: { message_id: m.statusMessageId, rich_message: { markdown, skip_entity_detection: true }, reply_markup: { inline_keyboard: buttons } }, priority: 1,
    });
  }

  /** Coalesced refresh: at most one card edit per CARD_EDIT_MIN_MS per mission. */
  function refresh(missionId: string): void {
    if (timers.has(missionId)) return;
    const wait = Math.max(0, (lastEditAt.get(missionId) ?? -Infinity) + CARD_EDIT_MIN_MS - now());
    const h = s.clock.setTimeout(() => {
      void sync(missionId).catch((e: unknown) => s.log.warn({ missionId, err: e instanceof Error ? e.name : 'error' }, 'mission: card refresh failed'));
    }, wait);
    timers.set(missionId, h);
  }

  function post(m: MissionRow, u: UserRow, key: string, markdown: string, o: { silent?: boolean; buttons?: InlineKeyboardButton[][]; dm?: boolean } = {}): void {
    const t = o.dm ? { userId: u.id, chatId: dmChatOf(u) } : target(m, u);
    s.telegram.outbox.enqueue({
      idempotencyKey: key, ...t, method: 'sendRichMessage', markdown, payload: o.buttons ? { reply_markup: { inline_keyboard: o.buttons } } : {},
      priority: 5, ...(o.silent ? { disableNotification: true } : {}),
    });
  }

  async function startWithId(id: string, p: Parameters<MissionInternals['startWithId']>[1]) {
    const existing = repo.getMission(id);
    if (existing) {
      if (existing.userId !== p.userId) throw new Error('mission id collision');
      return { missionId: id, threadId: existing.threadId, conversationId: existing.conversationId, created: false };
    }
    const u = s.repos.users.getById(p.userId);
    if (!u) throw new Error('mission start: unknown user');
    const q = s.quotas.check(u.id, 'mission');
    if (!q.ok) throw new Error(`mission quota reached (${q.used}/${q.limit})`);
    const cap = planMax(u);
    const budgetMicros = p.budgetUsd !== undefined && p.budgetUsd > 0 ? Math.min(Math.round(p.budgetUsd * 1_000_000), cap) : Math.round(cap * DEFAULT_BUDGET_SHARE);
    const w = p.deadlineLocal ? parseLocal(p.deadlineLocal) : null;
    const deadlineAt = w ? zonedToInstant(w, u.tz).instant : null;
    const title = clipText(p.title, 60);
    let threadId: number | null = null;
    try {
      threadId = await s.telegram.topics.createMission(u.id, u.tgUserId, id, title);
    } catch (e) {
      s.log.warn({ missionId: id, err: e instanceof Error ? e.name : 'error' }, 'mission: topic creation failed; using the DM');
    }
    const chatId = dmChatOf(u);
    const conv = s.conversations.resolve({ kind: 'mission', missionId: id }, { userId: u.id, tgChatId: chatId, ...(threadId !== null ? { threadId } : {}) });
    const t = now();
    try {
      repo.insertMission({ id, userId: u.id, conversationId: conv.id, title, goal: p.goal, criteria: p.criteria, threadId, budgetMicros, deadlineAt, taint: [...new Set(p.taint)], createdAt: t });
    } catch (e) {
      const again = repo.getMission(id);
      if (again && again.userId === u.id) return { missionId: id, threadId: again.threadId, conversationId: again.conversationId, created: false };
      throw e;
    }
    s.ledger.append({ userId: u.id, actor: 'agent', kind: 'mission', summary: `Mission ${id} started`, detail: { missionId: id, budgetMicros, topic: threadId !== null } });
    const m = repo.getMission(id)!;
    await sendCard(m, u);
    await setTopic(m, u, 'working');
    const body = [
      `Mission ${id}: ${title}`,
      `Goal: ${p.goal}`,
      'Success criteria:',
      ...p.criteria.map((c) => `- ${c}`),
      ...(deadlineAt !== null ? [`Deadline: ${formatDisplay(deadlineAt, u.tz, langOf(u))}`] : []),
      `Budget: ${usd(budgetMicros)}`,
      'Work step by step. Report progress with mission_report, wait with task_wait (never poll), and end with mission_finish.',
      ...(threadId === null
        ? ['This mission has no topic (it runs in the main chat): only the owner\'s replies to this mission\'s own messages (its status card or your posts) reach it. If you need the owner, ask in mission_report and tell them to reply to that message before task_wait on user_input.']
        : []),
    ].join('\n');
    s.runner.startEventRun(conv.id, { type: 'mission_start', ref: id, body }, {
      channel: 'notify', priority: 'background', taint: [...new Set(p.taint)],
      replyRef: { chatId, ...(threadId !== null ? { threadId } : {}), missionId: id },
    });
    return { missionId: id, threadId, conversationId: conv.id, created: true };
  }

  function view(m: MissionRow): MissionView {
    const e = effective(m);
    return {
      id: m.id, title: m.title, status: e.status, threadId: m.threadId, conversationId: m.conversationId,
      budgetUsd: m.budgetMicros / 1_000_000, spentUsd: m.spentMicros / 1_000_000, deadlineAt: m.deadlineAt, checklist: m.checklist, createdAt: m.createdAt,
    };
  }

  async function wakeOrContinue(m: MissionRow, u: UserRow): Promise<void> {
    const n = await s.runner.wake(`budget:${m.id}`, { reason: 'budget', spentUsd: m.spentMicros / 1_000_000, budgetUsd: m.budgetMicros / 1_000_000 });
    if (n > 0) return;
    const conv = s.repos.conversations.get(m.conversationId);
    if (conv?.activeRunId) {
      const run = s.repos.runs.get(conv.activeRunId);
      if (run && run.state !== 'done' && run.state !== 'failed' && run.state !== 'cancelled' && run.state !== 'refused') return;
    }
    s.runner.startEventRun(m.conversationId, { type: 'continue', ref: m.id, body: `The owner raised the budget of mission ${m.id} to ${usd(m.budgetMicros)} (spent ${usd(m.spentMicros)}). Continue the mission.` }, {
      channel: 'notify', priority: 'background', taint: m.taint, replyRef: { chatId: dmChatOf(u), ...(m.threadId !== null ? { threadId: m.threadId } : {}), missionId: m.id },
    });
  }

  const service: MissionService = {
    async start(p) {
      let id = `M${shortId(6)}`;
      while (repo.getMission(id)) id = `M${shortId(6)}`;
      const r = await startWithId(id, p);
      return { missionId: r.missionId, threadId: r.threadId, conversationId: r.conversationId };
    },

    async report(missionId, note, checklist) {
      const m = repo.getMission(missionId);
      if (!m || !OPEN_MISSION_STATUSES.includes(m.status)) return;
      const u = s.repos.users.getById(m.userId);
      if (!u) return;
      const items: ChecklistItem[] = checklist ? checklist.slice(0, 15).map((c) => ({ text: clipText(c.text, 100), done: !!c.done })) : m.checklist;
      const clean = clipText(note, 500);
      repo.setChecklist(m, items, clean || m.note);
      const t = now();
      if (clean && (m.lastReportAt === null || t - m.lastReportAt >= REPORT_POST_MIN_MS)) {
        repo.setLastReport(m.id, t);
        post(m, u, `mrep:${m.id}:${t}`, `📝 **${s.telegram.render.escape(prefix(m) + txt(u).report)}:** ${s.telegram.render.escape(clean)}`);
      }
      refresh(m.id);
    },

    async finish(missionId, outcome, summary) {
      const m = repo.getMission(missionId);
      if (!m) return;
      if (!repo.setMissionStatus(m.id, outcome, OPEN_MISSION_STATUSES, now())) return;
      const u = s.repos.users.getById(m.userId);
      hooks.onFinished(m.id, outcome);
      statusLines.delete(m.id);
      s.ledger.append({ userId: m.userId, actor: 'agent', kind: 'mission', summary: `Mission ${m.id} ${outcome}`, detail: { missionId: m.id, outcome, spentMicros: m.spentMicros } });
      if (!u) return;
      const L = txt(u);
      const st = outcome === 'done' ? L.done : outcome === 'failed' ? L.failed : L.cancelled;
      const r = s.telegram.render;
      post(m, u, `mfin:${m.id}`, `${st} — **${r.escape(prefix(m) + m.title)}**\n\n${r.escape(clipText(summary, 2000))}`);
      if (m.threadId !== null) post(m, u, `mfin-dm:${m.id}`, r.escape(L.finishedDm(m.title, st)), { dm: true, silent: true });
      const fin = { ...m, status: outcome as MissionStatus };
      await setTopic(fin, u, outcome === 'done' ? 'done' : 'failed');
      await sync(m.id);
    },

    async stop(missionId, byTgId) {
      const m = repo.getMission(missionId);
      if (!m) return;
      const u = s.repos.users.getById(m.userId);
      if (!u || u.tgUserId !== byTgId) throw new Error('not the mission owner');
      // The run is read from the conversation whatever the mission status is: a 'budget_exhausted' mission can still
      // have a run parked by task_wait (same round as the last paid call) or a tool round in flight (§5.7).
      const conv = s.repos.conversations.get(m.conversationId);
      const run = conv?.activeRunId ? s.repos.runs.get(conv.activeRunId) : undefined;
      if (!repo.setMissionStatus(m.id, 'cancelled', OPEN_MISSION_STATUSES, now())) return;
      hooks.onFinished(m.id, 'cancelled');
      statusLines.delete(m.id);
      if (run?.state === 'parked') {
        for (const token of run.wakeOn) {
          if ((await s.runner.wake(token, { reason: 'cancelled' })) > 0) break;
        }
      } else if (run && LIVE_RUN.has(run.state)) {
        await s.runner.stopRun(run.id, 'user');
      }
      s.ledger.append({ userId: u.id, actor: 'user', kind: 'mission', summary: `Mission ${m.id} cancelled`, detail: { missionId: m.id } });
      post(m, u, `mstop:${m.id}`, `⛔ ${s.telegram.render.escape(prefix(m) + txt(u).stoppedBy)}`, { silent: true });
      await setTopic({ ...m, status: 'cancelled' }, u, 'failed');
      await sync(m.id);
    },

    async addBudget(missionId, addUsd) {
      const m = repo.getMission(missionId);
      if (!m || !OPEN_MISSION_STATUSES.includes(m.status) || !(addUsd > 0)) return;
      const u = s.repos.users.getById(m.userId);
      if (!u) return;
      const next = Math.min(planMax(u), m.budgetMicros + Math.round(addUsd * 1_000_000));
      if (next <= m.budgetMicros) return;
      repo.setBudget(m.id, next);
      s.ledger.append({ userId: u.id, actor: 'user', kind: 'mission', summary: `Mission ${m.id} budget raised`, detail: { missionId: m.id, budgetMicros: next } });
      const upd = { ...m, budgetMicros: next };
      if (m.status === 'budget_exhausted' && m.spentMicros < next && repo.setMissionStatus(m.id, 'active', ['budget_exhausted'], now())) {
        await wakeOrContinue(upd, u);
      }
      refresh(m.id);
    },

    chargeCost(missionId, micros) {
      const r = repo.addSpent(missionId, micros);
      if (!r) return { exhausted: false };
      const exhausted = r.spent >= r.budget;
      if (exhausted && (r.status === 'active' || r.status === 'parked') && repo.setMissionStatus(missionId, 'budget_exhausted', ['active', 'parked'], now())) {
        const m = repo.getMission(missionId);
        const u = m ? s.repos.users.getById(m.userId) : undefined;
        if (m && u) {
          s.ledger.append({ userId: u.id, actor: 'system', kind: 'mission', summary: `Mission ${m.id} budget used up`, detail: { missionId: m.id, spentMicros: r.spent, budgetMicros: r.budget } });
          const lang = langOf(u);
          const L = txt(u);
          const buttons = [[
            ...(r.budget < planMax(u) ? [cbButton(s, L.addBudget, 'ms', [m.id, 'budget'], u.tgUserId)] : []),
            cbButton(s, s.strings.t('mission_stop_button', lang), 'ms', [m.id, 'stop'], u.tgUserId),
          ]];
          post(m, u, `mbud:${m.id}:${r.budget}`, `⏸ ${s.telegram.render.escape(prefix(m) + s.strings.t('mission_budget_exhausted', lang, { spent: usd(r.spent), budget: usd(r.budget) }))}`, { buttons });
          void setTopic(m, u, 'waiting');
        }
      }
      if (r.status === 'active' || r.status === 'parked' || exhausted) refresh(missionId);
      return { exhausted };
    },

    get(missionId) {
      const m = repo.getMission(missionId);
      return m ? view(m) : undefined;
    },
    list(userId, o) {
      return repo.listMissions(userId, { ...(o?.active ? { open: true } : {}), limit: 100 }).map(view);
    },
    async setStatusLine(missionId, label) {
      if (label === null) statusLines.delete(missionId);
      else statusLines.set(missionId, label);
      refresh(missionId);
    },
  };

  return {
    service,
    internals: {
      startWithId,
      ownerOf: (id) => repo.getMission(id)?.userId ?? null,
      budgetCapUsd(userId) {
        const u = s.repos.users.getById(userId);
        return u ? planMax(u) / 1_000_000 : 0;
      },
    },
    effective,
    refresh,
    onRunEnded(conversationId) {
      const m = repo.missionByConversation(conversationId);
      if (m && OPEN_MISSION_STATUSES.includes(m.status)) {
        statusLines.delete(m.id);
        refresh(m.id);
      }
    },
    budgetStepUsd(userId) {
      const u = s.repos.users.getById(userId);
      return u ? (planMax(u) * BUDGET_STEP_SHARE) / 1_000_000 : 0;
    },
    txt,
    stopTimers(missionIds) {
      for (const id of missionIds) {
        const h = timers.get(id);
        if (h !== undefined) s.clock.clearTimeout(h);
        timers.delete(id);
        statusLines.delete(id);
      }
    },
  };
}
