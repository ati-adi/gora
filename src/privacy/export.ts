// privacy/export.ts (WP1) — /export JSON (01 §11.9). WP1 writes its own part (profile, settings, consents, permissions,
// usage, ledger summaries, the visible text of each conversation's current epoch); every privacy hook adds its part
// under `hook.name` (WP5 connections without tokens; WP6 memory with provenance, reminders, to-dos, missions and
// watchers; WP7 business metadata + stored messages, payments). A hook error is logged and recorded under
// `unavailable`, never failing the export. Tokens, secrets and ciphertexts never appear.
import type { Services, UserId } from '../contracts/index.ts';
import type { BetaContentBlockParam, BetaMessageParam } from '../contracts/llm.ts';
import { errorMessage } from '../kernel/errors.ts';
import { isShredded } from '../db/crypto.ts';

export const EXPORT_FORMAT = 'gora-export';
export const EXPORT_VERSION = 1;
const LEDGER_PAGE = 500;
const USAGE_DAYS = 90;

export class ExportUserMissingError extends Error {
  constructor() {
    super('exportUser: no such user');
    this.name = 'ExportUserMissingError';
  }
}

const iso = (ms: number | null | undefined): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Text parts only: never thinking, tool inputs or tool results. */
function textOf(content: BetaMessageParam['content']): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content as BetaContentBlockParam[]) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string' && t.trim()) parts.push(t);
    }
  }
  return parts.join('\n');
}

export async function buildExport(s: Services, userId: UserId): Promise<Record<string, unknown>> {
  const user = s.repos.users.getById(userId);
  if (!user) throw new ExportUserMissingError();
  const db = s.db;

  const profile = {
    telegramUserId: user.tgUserId,
    firstName: user.firstName,
    username: user.username,
    languageCode: user.languageCode,
    timeZone: user.tz,
    timeZoneSource: user.tzSource,
    personaName: user.personaName,
    personaStyle: user.personaStyle,
    plan: user.plan,
    status: user.status,
    memoryConsent: user.memoryConsent,
    voiceReplies: user.voiceReplies,
    onboardingStep: user.onboardingStep,
    createdAt: iso(user.createdAt),
  };

  const consents = db
    .prepare('SELECT kind, subject, text_version, via, granted_at, revoked_at FROM consents WHERE user_id = ? ORDER BY granted_at')
    .all<{ kind: string; subject: string | null; text_version: string; via: string; granted_at: number; revoked_at: number | null }>(userId)
    .map((r) => ({ kind: r.kind, subject: r.subject, textVersion: r.text_version, via: r.via, grantedAt: iso(Number(r.granted_at)), revokedAt: iso(r.revoked_at === null ? null : Number(r.revoked_at)) }));

  const usage = db
    .prepare('SELECT day, turns, web_searches, stt_seconds, files, guest_answers, nudges_sent FROM usage_daily WHERE user_id = ? ORDER BY day DESC LIMIT ?')
    .all<Record<string, string | number>>(userId, USAGE_DAYS)
    .map((r) => ({ day: r.day, turns: Number(r.turns), webSearches: Number(r.web_searches), sttSeconds: Number(r.stt_seconds), files: Number(r.files), guestAnswers: Number(r.guest_answers), nudgesSent: Number(r.nudges_sent) }));

  // Ledger summaries, oldest first (detail is internal bookkeeping and may name other ids; the summary is the record).
  const ledger: Array<Record<string, unknown>> = [];
  let cursor: number | undefined;
  for (;;) {
    const page = s.ledger.list(userId, { limit: LEDGER_PAGE, ...(cursor !== undefined ? { cursor } : {}) });
    if (!page.length) break;
    for (const e of page) ledger.push({ seq: e.seq, at: iso(e.ts), actor: e.actor, kind: e.kind, summary: e.summary });
    cursor = page[page.length - 1]!.seq;
    if (cursor <= 1) break;
  }
  ledger.reverse();

  const conversations: Array<Record<string, unknown>> = [];
  for (const c of s.repos.conversations.listByUser(userId, { limit: 10_000 })) {
    if (c.status === 'purged') continue;
    const messages: Array<{ role: string; at: string | null; text: string }> = [];
    try {
      for (const m of s.repos.messages.load(c.id, c.epoch)) {
        if (m.kind !== 'user_input' && m.kind !== 'assistant') continue;
        const text = textOf(m.content.content);
        if (text) messages.push({ role: m.role, at: iso(m.createdAt), text });
      }
    } catch (e) {
      if (!isShredded(e)) throw e;
    }
    conversations.push({ id: c.id, kind: c.kind, status: c.status, createdAt: iso(c.createdAt), lastActivityAt: iso(c.lastActivityAt), currentEpoch: c.epoch, messages });
  }

  const out: Record<string, unknown> = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: iso(s.clock.now()),
    profile,
    settings: s.repos.users.settings(userId),
    consents,
    permissions: s.repos.users.permissions(userId),
    usage,
    ledger,
    conversations,
  };

  const unavailable: string[] = [];
  for (const h of s.privacyHooks) {
    if (!h.exportUser) continue;
    try {
      const part = await h.exportUser(userId, user.tgUserId);
      if (part && typeof part === 'object') out[Object.hasOwn(out, h.name) ? `hook_${h.name}` : h.name] = part;
    } catch (e) {
      unavailable.push(h.name);
      s.log.error({ hook: h.name, userId, err: errorMessage(e) }, 'privacy hook exportUser failed');
    }
  }
  if (unavailable.length) out.unavailable = unavailable;
  return out;
}

export async function exportUserBytes(s: Services, userId: UserId): Promise<Uint8Array> {
  const data = await buildExport(s, userId);
  try {
    s.ledger.append({ userId, actor: 'user', kind: 'export', summary: 'Data export created' });
  } catch (e) {
    s.log.warn({ userId, err: errorMessage(e) }, 'export: ledger append failed');
  }
  return new TextEncoder().encode(JSON.stringify(data, null, 2));
}
