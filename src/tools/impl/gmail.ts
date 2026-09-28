// tools/impl/gmail.ts (WP5) — gmail_* (01 §6, F9). Two-phase email: drafts are write_self with Undo (level draft);
// sending a draft is send_external (level act) and always asks. renderDiff fetches the draft, so the executor's
// recomputation at execution (TOCTOU) detects any change; reconcile() looks in Sent and never re-sends.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApprovalDiff, DraftInput, MailApi, Target, ToolCtx, ToolOutput, ToolSpec, UserId } from '../../contracts/index.ts';
import { AbortedError, errorMessage } from '../../kernel/errors.ts';
import { formatDisplay } from '../../kernel/timeMath.ts';
import { zEmail } from '../schema.ts';
import { FULL_SURFACES, isAmbiguousProviderError, L, OutcomeUnknownError, ownerOf, toolError, truncate } from './common.ts';


function mailOf(ctx: ToolCtx): { userId: UserId; api: MailApi } | null {
  const userId = ownerOf(ctx);
  if (!userId) return null;
  const api = ctx.services.integrations.mail(userId);
  return api ? { userId, api } : null;
}
function emailTargets(emails: readonly string[]): Target[] {
  return [...new Set(emails.map((e) => e.toLowerCase()))].map((value) => ({ kind: 'email', value, hmac: '', provenance: 'unknown' }));
}
async function withMail<T>(ctx: ToolCtx, tool: string, f: (c: { userId: UserId; api: MailApi }) => Promise<ToolOutput<T>>): Promise<ToolOutput<T>> {
  const c = mailOf(ctx);
  if (!c) return toolError('NOT_CONNECTED', 'Gmail is not connected; call integration_connect');
  try {
    return await f(c);
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    const msg = errorMessage(e);
    ctx.log.warn({ tool, err: msg }, 'gmail call failed');
    if (e instanceof OutcomeUnknownError) throw e; // the executor reconciles; never a definite "failed"
    if (/not supported by provider/i.test(msg)) return toolError('NOT_SUPPORTED', 'not supported by provider');
    if (/not found/i.test(msg)) return toolError('NOT_FOUND', 'not found');
    return toolError('GMAIL_FAILED', 'the Gmail call failed; tell the user');
  }
}
/** Stable hash of a draft's visible content (To, Cc, Subject, body). */
export function draftHash(d: DraftInput): string {
  const norm = { to: [...d.to].map((x) => x.toLowerCase()).sort(), cc: [...d.cc].map((x) => x.toLowerCase()).sort(), subject: d.subject, body: d.body };
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

// ── gmail_search
const searchInput = z.object({ query: z.string().min(1).max(200), max_results: z.number().int().min(1).max(20).default(10), newer_than_days: z.number().int().min(1).max(365).optional() });
type SearchIn = z.input<typeof searchInput>;
const searchTool: ToolSpec<SearchIn> = {
  name: 'gmail_search',
  description: 'Search the owner Gmail (Gmail query syntax) and get thread summaries. Call for questions about emails received or sent.',
  input: searchInput,
  surfaces: FULL_SURFACES,
  parallelSafe: true,
  outputTaint: 'email',
  classify: () => ({ actionClass: 'read_private', risk: 0, integration: 'gmail', requiredLevel: 'read' }),
  statusLabel: (_i, lang) => L(lang, '📧 Searching mail…', '📧 Ищу в почте…'),
  execute: (i, ctx) =>
    withMail(ctx, 'gmail_search', async ({ api }) => {
      const rows = await api.search({ query: i.query, maxResults: i.max_results ?? 10, ...(i.newer_than_days ? { newerThanDays: i.newer_than_days } : {}) });
      const threads = rows.map((t) => ({ thread_id: t.threadId, from: t.from, subject: t.subject, snippet: truncate(t.snippet, 200), date: formatDisplay(t.date, ctx.tz, ctx.lang), unread: t.unread }));
      return { content: JSON.stringify({ threads }), data: { count: threads.length }, untrusted: { source: 'email', label: 'gmail search results' } };
    }),
};

// ── gmail_read_thread
const readInput = z.object({ thread_id: z.string().min(1).max(256) });
type ReadIn = z.infer<typeof readInput>;
const readTool: ToolSpec<ReadIn> = {
  name: 'gmail_read_thread',
  description: 'Read one email thread in full. Call after gmail_search when the content of a specific thread is needed.',
  input: readInput,
  surfaces: FULL_SURFACES,
  parallelSafe: true,
  outputTaint: 'email',
  classify: () => ({ actionClass: 'read_private', risk: 0, integration: 'gmail', requiredLevel: 'read' }),
  statusLabel: (_i, lang) => L(lang, '📧 Reading the thread…', '📧 Читаю переписку…'),
  execute: (i, ctx) =>
    withMail(ctx, 'gmail_read_thread', async ({ api }) => {
      const t = await api.readThread(i.thread_id);
      const messages = t.messages.slice(-10).map((m) => ({ from: m.from, to: m.to, cc: m.cc, subject: m.subject, date: formatDisplay(m.date, ctx.tz, ctx.lang), text: truncate(m.text, 6000) }));
      return { content: JSON.stringify({ thread_id: t.threadId, messages }), data: { messages: messages.length }, untrusted: { source: 'email', label: truncate(messages[0]?.subject ?? 'email thread', 80) } };
    }),
};

// ── gmail_create_draft
const draftInput = z.object({
  to: z.array(zEmail).min(1).max(10),
  cc: z.array(zEmail).max(10).optional(),
  subject: z.string().max(200),
  body: z.string().min(1).max(20000),
  reply_to_thread_id: z.string().max(256).optional(),
});
type DraftIn = z.infer<typeof draftInput>;
const draftTool: ToolSpec<DraftIn> = {
  name: 'gmail_create_draft',
  description: 'Save an email draft in the owner Gmail (nothing is sent). Call when asked to write, reply to or prepare an email.',
  input: draftInput,
  surfaces: FULL_SURFACES,
  eagerInput: true,
  parallelSafe: false,
  classify: () => ({ actionClass: 'write_self', risk: 1, integration: 'gmail', requiredLevel: 'draft' }),
  targets: async (i) => emailTargets([...i.to, ...(i.cc ?? [])]),
  statusLabel: (_i, lang) => L(lang, '✍️ Writing the draft…', '✍️ Пишу черновик…'),
  execute: (i, ctx) =>
    withMail(ctx, 'gmail_create_draft', async ({ userId, api }) => {
      const d: DraftInput = { to: i.to, cc: i.cc ?? [], subject: i.subject, body: i.body, ...(i.reply_to_thread_id ? { replyToThreadId: i.reply_to_thread_id } : {}) };
      const { draftId } = await api.createDraft(d, ctx.idemKey);
      return {
        content: JSON.stringify({ draft_id: draftId, to: d.to, cc: d.cc, subject: d.subject, note: 'saved as a draft; nothing was sent. Use gmail_send_draft only if the owner asks to send.' }),
        data: { draftId },
        undo: { payload: { userId, draftId }, line: `✍️ Draft to ${truncate(d.to.join(', '), 60)}: ${truncate(d.subject || '(no subject)', 60)}` },
        ledger: [{ kind: 'draft_created', summary: `email draft created (${d.to.length + d.cc.length} recipient(s))`, runId: ctx.runId, toolUseId: ctx.toolUseId }],
      };
    }),
  async undo(payload, ctx) {
    const p = payload as { userId: UserId; draftId: string };
    const api = ctx.services.integrations.mail(p.userId);
    if (!api) throw new Error('gmail is no longer connected');
    await api.deleteDraft(p.draftId);
  },
};

// ── gmail_send_draft
/** Sealed (u:<userId>) note of what is about to be sent, keyed by the idempotency key, for reconcile() after a crash. */
function rememberSend(ctx: ToolCtx, d: DraftInput): void {
  const userId = ownerOf(ctx);
  if (!userId) return;
  const s = ctx.services;
  const key = `gsend:${ctx.idemKey}`;
  const ct = s.crypto.sealJson(`u:${userId}`, { to: d.to, cc: d.cc, subject: d.subject }, `kv|value|${key}`);
  s.repos.kv.set(key, { ct: Buffer.from(ct).toString('base64'), at: Math.max(ctx.now, s.clock.now()) });
}
function recallSend(ctx: ToolCtx): (Pick<DraftInput, 'to' | 'cc' | 'subject'> & { at: number }) | null {
  const key = `gsend:${ctx.idemKey}`;
  const v = ctx.services.repos.kv.get<{ ct: string; at?: number }>(key);
  if (!v || typeof v.at !== 'number') return null;
  try {
    const d = ctx.services.crypto.openJson<Pick<DraftInput, 'to' | 'cc' | 'subject'>>(new Uint8Array(Buffer.from(v.ct, 'base64')), `kv|value|${key}`);
    return { ...d, at: v.at };
  } catch {
    return null;
  }
}
const sendInput = z.object({ draft_id: z.string().min(1).max(256) });
type SendIn = z.infer<typeof sendInput>;
/** Clock skew allowed between our note and Gmail's Sent timestamp (Gmail `after:` has second granularity). */
const SEND_SKEW_MS = 2 * 60_000;
const sendTool: ToolSpec<SendIn> = {
  name: 'gmail_send_draft',
  description: 'Send an existing Gmail draft (always asks the owner first). Call only when the owner explicitly asks to send that draft.',
  input: sendInput,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'send_external', risk: 2, integration: 'gmail', requiredLevel: 'act' }),
  async targets(i, ctx) {
    const c = mailOf(ctx);
    if (!c) return [];
    const d = await c.api.getDraft(i.draft_id).catch(() => null);
    return d ? emailTargets([...d.to, ...d.cc]) : [];
  },
  async renderDiff(i, ctx): Promise<ApprovalDiff> {
    const c = mailOf(ctx);
    const d = c ? await c.api.getDraft(i.draft_id).catch(() => null) : null;
    if (!d) return { title: '📧 Send email', summary: 'draft not found', rows: [['Draft', i.draft_id]], warnings: ['This draft no longer exists.'], targets: [] };
    const n = d.to.length + d.cc.length;
    return {
      title: '📧 Send email',
      summary: `To ${truncate(d.to.join(', '), 80)} — ${truncate(d.subject || '(no subject)', 80)}`,
      rows: [['To', d.to.join(', ')], ...(d.cc.length ? ([['Cc', d.cc.join(', ')]] as Array<[string, string]>) : []), ['Subject', d.subject || '(no subject)'], ['Hash', draftHash(d)]],
      body: { label: 'Body', text: d.body },
      warnings: n > 5 ? [`Bulk send: ${n} recipients.`] : [],
      targets: emailTargets([...d.to, ...d.cc]),
    };
  },
  statusLabel: (_i, lang) => L(lang, '📤 Sending the email…', '📤 Отправляю письмо…'),
  execute: (i, ctx) =>
    withMail(ctx, 'gmail_send_draft', async ({ api }) => {
      let d: (DraftInput & { draftId: string }) | null = null;
      try {
        d = await api.getDraft(i.draft_id);
      } catch (e) {
        if (!/not found/i.test(errorMessage(e))) throw e;
      }
      if (!d) return toolError('NOT_FOUND', 'the draft no longer exists (it may have been sent or deleted); check Sent before retrying');
      const n = d.to.length + d.cc.length;
      rememberSend(ctx, d);
      let messageId: string;
      try {
        ({ messageId } = await api.sendDraft(i.draft_id));
      } catch (err) {
        // A lost response after Gmail sent the mail must reach reconcile(), not become a definite failure + a re-send.
        if (isAmbiguousProviderError(err)) throw new OutcomeUnknownError('gmail_send_draft', err);
        throw err;
      }
      return {
        content: JSON.stringify({ sent: true, message_id: messageId, to: d.to, subject: d.subject }),
        data: { messageId },
        ledger: [{ kind: 'email_sent', summary: `email sent to ${n} recipient(s)`, runId: ctx.runId, toolUseId: ctx.toolUseId }],
      };
    }),
  async reconcile(i, ctx) {
    const c = mailOf(ctx);
    if (!c) return 'unknown';
    try {
      // Gmail removes a draft once it is sent: a draft that still exists was not sent.
      try {
        await c.api.getDraft(i.draft_id);
        return 'not_done';
      } catch (e) {
        if (!/not found/i.test(errorMessage(e))) return 'unknown';
      }
      // The draft is gone. Only a Sent mail matching the sealed note written just before sendDraft, and sent no earlier
      // than that moment (minus clock skew), proves this send happened — never an older mail with the same To+Subject.
      const d = recallSend(ctx);
      const to = d?.to[0];
      if (!d || !to) return 'unknown';
      const hit = await c.api.findSent({ to, subject: d.subject, afterMs: d.at - SEND_SKEW_MS });
      return hit ? 'done' : 'unknown';
    } catch {
      return 'unknown';
    }
  },
};

export const GMAIL_TOOLS: readonly ToolSpec[] = [draftTool, readTool, searchTool, sendTool];
