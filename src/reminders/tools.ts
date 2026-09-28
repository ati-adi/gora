// reminders/tools.ts (WP6a) — reminder_create, reminder_list, reminder_manage, todo_manage (01 §6, F6).
// app.ts passes this array to createToolRegistry(profile, external); names match TOOL_OWNERS.
import { z } from 'zod';
import type { Scope } from '../contracts/common.ts';
import { parseScopeKey, scopeKey } from '../contracts/common.ts';
import type { Classification, ToolCtx, ToolOutput, ToolSpec } from '../contracts/tools.ts';
import { isValidTz } from '../kernel/timeMath.ts';
import { implsOf, type ReminderImpls } from './impl.ts';
import { ReminderError, type ReminderSnapshot } from './service.ts';

const SURFACES = ['dm', 'topic', 'mission', 'group'] as const;
const WRITE_SELF: Classification = Object.freeze({ actionClass: 'write_self', risk: 1 });
const READ_PRIVATE: Classification = Object.freeze({ actionClass: 'read_private', risk: 0 });
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** spec 05 A5 reminder ack (a Telegram-allowed reaction; see reminder_create). */
export const REMINDER_ACK_EMOJI = '🫡';

const ru = (lang: string) => /^(ru|uk|kk|be)/i.test(lang);
const err = (code: string, message: string): ToolOutput<never> => ({ content: JSON.stringify({ error: code, message }), isError: true });
const need = (ctx: ToolCtx): ReminderImpls => {
  const i = implsOf(ctx.services);
  if (!i) throw new Error('reminders module is not initialised');
  return i;
};
const fail = (e: unknown): ToolOutput<never> => {
  if (e instanceof ReminderError) return err(e.code.toUpperCase(), e.message);
  throw e;
};
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The scope of the run (from the surface, never from input): group scope in groups, the owner's scope elsewhere. */
function runScope(ctx: ToolCtx): Scope | null {
  if (ctx.scope) return ctx.scope;
  return ctx.userId ? { kind: 'user', userId: ctx.userId } : null;
}

// ── reminder_create
const createInput = z.object({
  text: z.string().min(1).max(300).describe('in the user’s words'),
  kind: z.enum(['reminder', 'checkin']).default('reminder').describe('checkin: asks, follows up'),
  at_local: z.string().regex(LOCAL_RE).optional().describe('YYYY-MM-DDTHH:mm, local'),
  cron: z.string().max(100).optional().describe('5-field, repeats'),
  tz: z.string().max(64).optional(),
  target: z.enum(['me', 'this_group']).default('me'),
});
type CreateIn = z.infer<typeof createInput>;

type UndoPayload = { op: 'cancel'; id: string; scope: string } | { op: 'restore'; id: string; scope: string; snap: ReminderSnapshot };

async function undoReminder(payload: unknown, ctx: ToolCtx): Promise<void> {
  const p = payload as UndoPayload;
  const scope = parseScopeKey(p.scope);
  if (!scope) return;
  const { reminders } = need(ctx);
  if (p.op === 'cancel') reminders.manage(p.id, scope, 'cancel');
  else reminders.restore(p.id, scope, p.snap);
}

const reminderCreate: ToolSpec<CreateIn> = {
  name: 'reminder_create',
  description: 'Create a reminder or check-in. One of at_local or cron.',
  input: createInput,
  surfaces: SURFACES,
  parallelSafe: false,
  classify: () => WRITE_SELF,
  statusLabel: (_i, lang) => (ru(lang) ? 'Ставлю напоминание…' : 'Setting a reminder…'),
  async execute(i, ctx) {
    const s = ctx.services;
    const { reminders } = need(ctx);
    if (!!i.at_local === !!i.cron) return err('BAD_INPUT', 'give exactly one of at_local or cron');
    let scope: Scope;
    let chatId: number;
    let threadId: number | undefined;
    const author = ctx.userId ? s.repos.users.getById(ctx.userId) : undefined;
    if (i.target === 'this_group') {
      if (ctx.surface !== 'group' || ctx.scope?.kind !== 'group') return err('NOT_IN_GROUP', "target 'this_group' works only in a group");
      scope = ctx.scope;
      chatId = ctx.chat.chatId;
      threadId = ctx.chat.threadId;
    } else {
      if (!author) return err('NO_OWNER', 'reminders need a known user');
      scope = { kind: 'user', userId: author.id };
      if (ctx.surface === 'group') {
        if (!author.dmChatId) return err('NO_DM', 'the user has not started a private chat with Gora yet');
        chatId = author.dmChatId;
      } else {
        chatId = ctx.chat.chatId;
        threadId = ctx.chat.threadId;
      }
    }
    // spec 05 A6: an unconfirmed zone no longer blocks — users.tz holds the best guess and the reply carries one lazy
    // "set my time zone" button (trust/executor.ts).
    const tz = i.tz ?? author?.tz ?? ctx.tz;
    if (!isValidTz(tz)) return err('BAD_TZ', `unknown time zone "${tz}"`);
    try {
      const r = reminders.create({
        scope, userId: author?.id ?? ctx.userId, kind: i.kind, text: i.text, tz, chatId, sourceToolUseId: ctx.idemKey,
        ...(i.at_local ? { atLocal: i.at_local } : {}), ...(i.cron ? { cron: i.cron } : {}), ...(threadId ? { threadId } : {}),
      });
      const R = s.telegram.render;
      const when = R.tgTime(r.unixSec, 'wDT', r.display);
      const icon = i.kind === 'checkin' ? '💬' : '⏰';
      const repeat = i.cron ? (ru(ctx.lang) ? ` · повтор (${R.escape(i.cron)})` : ` · repeats (${R.escape(i.cron)})`) : '';
      const note =
        r.adjusted === 'gap_shifted'
          ? 'That local time does not exist (DST gap); it was moved forward. Tell the user the exact time.'
          : r.adjusted === 'overlap_earlier'
            ? 'That local time happens twice (DST overlap); the earlier one was used.'
            : undefined;
      // spec 05 A5: a reaction on the owner's message acknowledges it (idempotent per tool use); the model's reply
      // carries the one-line confirmation. ⏰ is not in Telegram's allowed reaction set (REACTION_INVALID), so the ack is
      // 🫡 ("on it"); the ⏰ stays on the reminder's Undo line.
      if (ctx.chat.triggerMessageId && ctx.surface !== 'group') {
        try {
          s.telegram.outbox.enqueue({
            idempotencyKey: `remrx:${ctx.toolUseId}`, ...(ctx.userId ? { userId: ctx.userId } : {}), chatId: ctx.chat.chatId, method: 'setMessageReaction', priority: 1,
            payload: { message_id: ctx.chat.triggerMessageId, reaction: [{ type: 'emoji', emoji: REMINDER_ACK_EMOJI }] },
          });
        } catch (e) {
          ctx.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'reminder_create: reaction failed');
        }
      }
      return {
        content: JSON.stringify({ id: r.id, kind: i.kind, first_at: r.display, unix: r.unixSec, repeats: i.cron ?? null, adjusted: r.adjusted, ...(note ? { note } : {}), ...(author?.tzSource === 'default' && !i.tz ? { tz_note: `time zone ${tz} is a best guess; Gora shows a button to set it — no need to ask` } : {}) }),
        data: r,
        undo: { payload: { op: 'cancel', id: r.id, scope: scopeKey(scope) } satisfies UndoPayload, line: `${icon} ${R.escape(clip(i.text, 60))} — ${when}${repeat}` },
      };
    } catch (e) {
      return fail(e);
    }
  },
  undo: undoReminder,
};

// ── reminder_list
const listInput = z.object({ include_done: z.boolean().optional(), limit: z.number().int().min(1).max(30).default(10) });
type ListIn = z.infer<typeof listInput>;

const reminderList: ToolSpec<ListIn> = {
  name: 'reminder_list',
  description: 'List reminders and check-ins here.',
  input: listInput,
  surfaces: SURFACES,
  parallelSafe: true,
  classify: () => READ_PRIVATE,
  statusLabel: (_i, lang) => (ru(lang) ? 'Смотрю напоминания…' : 'Checking reminders…'),
  async execute(i, ctx) {
    const scope = runScope(ctx);
    if (!scope) return err('NO_SCOPE', 'no reminder list in this chat');
    const items = need(ctx).reminders.list(scope, i.include_done ?? false).slice(0, i.limit);
    return { content: JSON.stringify({ reminders: items.map((r) => ({ id: r.id, kind: r.kind, text: r.text, when: r.display, status: r.status })) }), data: items };
  },
};

// ── reminder_manage
const manageInput = z.object({
  id: z.string().min(2).max(16),
  action: z.enum(['cancel', 'snooze', 'reschedule', 'pause', 'resume']),
  snooze_min: z.number().int().min(1).max(10_080).optional(),
  at_local: z.string().regex(LOCAL_RE).optional(),
  cron: z.string().max(100).optional(),
});
type ManageIn = z.infer<typeof manageInput>;

const reminderManage: ToolSpec<ManageIn> = {
  name: 'reminder_manage',
  description: 'Change a reminder by id.',
  input: manageInput,
  surfaces: SURFACES,
  parallelSafe: false,
  classify: () => WRITE_SELF,
  statusLabel: (_i, lang) => (ru(lang) ? 'Меняю напоминание…' : 'Updating the reminder…'),
  async execute(i, ctx) {
    const { reminders } = need(ctx);
    const primary = runScope(ctx);
    if (!primary) return err('NO_SCOPE', 'no reminders in this chat');
    // In a group, a member may also manage their own personal reminders.
    const scopes: Scope[] = [primary];
    if (primary.kind === 'group' && ctx.userId) scopes.push({ kind: 'user', userId: ctx.userId });
    const scope = scopes.find((sc) => reminders.get(i.id, sc));
    const row = scope ? reminders.get(i.id, scope) : undefined;
    if (!scope || !row) return err('NOT_FOUND', `no reminder ${i.id} here`);
    const snap = reminders.snapshot(row);
    try {
      const v = reminders.manage(row.id, scope, i.action, {
        ...(i.snooze_min !== undefined ? { snoozeMin: i.snooze_min } : {}), ...(i.at_local ? { atLocal: i.at_local } : {}), ...(i.cron ? { cron: i.cron } : {}),
      });
      const R = ctx.services.telegram.render;
      const verb: Record<ManageIn['action'], [string, string]> = {
        cancel: ['Cancelled', 'Отменено'], snooze: ['Snoozed', 'Отложено'], reschedule: ['Rescheduled', 'Перенесено'], pause: ['Paused', 'На паузе'], resume: ['Resumed', 'Возобновлено'],
      };
      const label = verb[i.action][ru(ctx.lang) ? 1 : 0];
      return {
        content: JSON.stringify({ id: v.id, status: v.status, when: v.display }),
        data: v,
        undo: { payload: { op: 'restore', id: row.id, scope: scopeKey(scope), snap } satisfies UndoPayload, line: `⏰ ${label}: ${R.escape(clip(row.text, 60))}${v.display && i.action !== 'cancel' && i.action !== 'pause' ? ` — ${R.escape(v.display)}` : ''}` },
      };
    } catch (e) {
      return fail(e);
    }
  },
  undo: undoReminder,
};

// ── todo_manage
const todoInput = z.object({
  action: z.enum(['add', 'complete', 'reopen', 'remove', 'list']),
  text: z.string().max(200).optional(),
  id: z.string().max(16).optional().describe('item id or list number'),
});
type TodoIn = z.infer<typeof todoInput>;

const todoManage: ToolSpec<TodoIn> = {
  name: 'todo_manage',
  description: 'Manage to-dos (the group list in groups).',
  input: todoInput,
  surfaces: SURFACES,
  parallelSafe: false,
  classify: (i) => (i.action === 'list' ? READ_PRIVATE : WRITE_SELF),
  statusLabel: (_i, lang) => (ru(lang) ? 'Обновляю список…' : 'Updating the list…'),
  async execute(i, ctx) {
    const scope = runScope(ctx);
    if (!scope) return err('NO_SCOPE', 'no to-do list in this chat');
    try {
      const items = need(ctx).todos.apply(scope, ctx.userId, { action: i.action, ...(i.text !== undefined ? { text: i.text } : {}), ...(i.id !== undefined ? { id: i.id } : {}) });
      return {
        content: JSON.stringify({ items: items.map((t) => ({ n: t.position, id: t.id, text: t.text, done: t.done })) }),
        data: items,
        effects: [{ kind: 'todo_list', scope }],
      };
    } catch (e) {
      return fail(e);
    }
  },
};

export const TOOLS: readonly ToolSpec[] = Object.freeze([reminderCreate, reminderList, reminderManage, todoManage] as ToolSpec[]);
