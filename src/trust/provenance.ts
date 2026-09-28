// trust/provenance.ts (WP4) — 01 §11.2 provenance: the trusted_targets table and target resolution.
// A target found in trusted_targets takes its provenance from the row's source. Otherwise: a value written by the owner
// in this epoch → 'user' (and it is recorded with source 'user_message'); a value that appears in any untrusted block of
// the current epoch → 'untrusted'; anything else → 'unknown'. Target HMACs are always recomputed here.
import type { Crypto, Db, Ms, Services, Target, TrustedTargetService, TrustedTargetSource, UserId } from '../contracts/index.ts';

export type TargetKind = Target['kind'];
const KINDS: readonly TargetKind[] = ['email', 'gcal_attendee', 'tg_chat', 'biz_chat'];

export function normalizeTarget(kind: TargetKind, value: string): string {
  const v = (value ?? '').trim();
  if (kind === 'email' || kind === 'gcal_attendee') return v.toLowerCase();
  if (kind === 'tg_chat' && v.startsWith('@')) return v.toLowerCase();
  return v;
}

export function targetHmac(crypto: Crypto, kind: TargetKind, value: string): string {
  // Email-like kinds share one namespace so a trusted email also covers the same address as a calendar attendee.
  const ns = kind === 'gcal_attendee' ? 'email' : kind;
  return crypto.hmac('target', `${ns}:${normalizeTarget(kind, value)}`);
}

const PROVENANCE_OF: Record<TrustedTargetSource, Target['provenance']> = {
  user_message: 'user',
  miniapp: 'user',
  memory: 'memory',
  approved_action: 'approved',
  business_chat: 'business_chat',
};

// ── owner text: emails, @handles and phone numbers (01 §11.2)
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HANDLE_RE = /(?<![\w@.])@[A-Za-z][A-Za-z0-9_]{4,31}\b/g;
const PHONE_RE = /(?<![\w+])\+?\d[\d ()-]{7,}\d(?!\w)/g;

export function extractOwnerTargets(text: string): Array<{ kind: TargetKind; value: string }> {
  const out: Array<{ kind: TargetKind; value: string }> = [];
  const seen = new Set<string>();
  const push = (kind: TargetKind, value: string) => {
    const k = `${kind}:${normalizeTarget(kind, value)}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ kind, value });
    }
  };
  for (const m of text.matchAll(EMAIL_RE)) push('email', m[0]);
  const withoutEmails = text.replace(EMAIL_RE, ' ');
  for (const m of withoutEmails.matchAll(HANDLE_RE)) push('tg_chat', m[0]);
  for (const m of withoutEmails.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/[^\d+]/g, '');
    if (digits.replace('+', '').length >= 9) push('tg_chat', digits);
  }
  return out;
}

/** Plain text of content blocks (text blocks and tool_result string/text content). */
export function blocksText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const b of blocks as Array<Record<string, unknown>>) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_result') parts.push(blocksText(b.content));
  }
  return parts.join('\n');
}

const UNTRUSTED_BLOCK_RE = /<untrusted\b[^>]*>([\s\S]*?)<\/untrusted>/g;

export function untrustedSegments(text: string): string[] {
  return [...text.matchAll(UNTRUSTED_BLOCK_RE)].map((m) => m[1] ?? '');
}

function containsValue(hay: string, kind: TargetKind, value: string): boolean {
  const n = normalizeTarget(kind, value);
  if (!n) return false;
  return hay.toLowerCase().includes(n.toLowerCase());
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Owner-text match (01 §11.2): the value must be a WHOLE target the owner wrote, found by the same regex extraction
 * (emails, @handles, phone numbers), never a substring of a longer one ("anna@acme.co" inside "anna@acme.co.uk").
 * Kinds the extractor does not cover (numeric chat ids, business refs) need a token-bounded match.
 */
export function ownerWroteTarget(ownerText: string, kind: TargetKind, value: string): boolean {
  const n = normalizeTarget(kind, value);
  if (!n || !ownerText) return false;
  const owned = new Set<string>();
  for (const t of extractOwnerTargets(ownerText)) {
    if (t.kind === 'email') owned.add(`email:${normalizeTarget('email', t.value)}`);
    else owned.add(`tg:${normalizeTarget('tg_chat', t.value)}`);
  }
  if (kind === 'email' || kind === 'gcal_attendee') return owned.has(`email:${n}`);
  if (kind === 'tg_chat') {
    if (n.startsWith('@')) return owned.has(`tg:${n}`);
    const digits = n.replace(/[^\d+]/g, '');
    if (/^\+?\d{9,}$/.test(digits) && owned.has(`tg:${digits}`)) return true;
  }
  // Token-bounded: no word/address character directly before or after the value.
  return new RegExp(`(?<![\\w@.+-])${escapeRe(n)}(?![\\w@-]|\\.[\\w])`, 'i').test(ownerText);
}

interface TtRow { target_hmac: string; target_enc: Uint8Array; source: TrustedTargetSource; created_at: number }

export function createTrustedTargets(s: Services): TrustedTargetService & {
  sourceOf(userId: UserId, hmac: string): TrustedTargetSource | undefined;
  addApproved(userId: UserId, t: { kind: TargetKind; value: string }, pendingActionId: string): void;
} {
  const db = (): Db => s.db;
  const aad = (userId: UserId, hmac: string) => `trusted_targets|target_enc|${userId}:${hmac}`;
  const insert = (userId: UserId, kind: TargetKind, value: string, source: TrustedTargetSource, sourceRef: string | null) => {
    if (!KINDS.includes(kind)) throw new Error('bad target kind');
    const v = normalizeTarget(kind, value);
    if (!v) return;
    const hmac = targetHmac(s.crypto, kind, v);
    const enc = s.crypto.sealJson(`u:${userId}`, { kind, value: v }, aad(userId, hmac));
    db().prepare('INSERT OR IGNORE INTO trusted_targets (user_id, target_hmac, target_enc, source, source_ref, created_at) VALUES (?,?,?,?,?,?)').run(userId, hmac, enc, source, sourceRef, s.clock.now());
  };
  return {
    list(userId) {
      const rows = db().prepare('SELECT target_hmac, target_enc, source, created_at FROM trusted_targets WHERE user_id = ? ORDER BY created_at DESC').all<TtRow>(userId);
      const out: Array<{ hmac: string; kind: TargetKind; value: string; source: TrustedTargetSource; createdAt: Ms }> = [];
      for (const r of rows) {
        try {
          const v = s.crypto.openJson<{ kind: TargetKind; value: string }>(r.target_enc, aad(userId, r.target_hmac));
          out.push({ hmac: r.target_hmac, kind: v.kind, value: v.value, source: r.source, createdAt: r.created_at });
        } catch {
          /* DEK destroyed (user deleting): skip */
        }
      }
      return out;
    },
    add(userId, t) {
      insert(userId, t.kind, t.value, t.source, t.sourceRef ?? null);
    },
    addApproved(userId, t, pendingActionId) {
      insert(userId, t.kind, t.value, 'approved_action', `pa:${pendingActionId}`);
    },
    remove(userId, hmac) {
      return Number(db().prepare('DELETE FROM trusted_targets WHERE user_id = ? AND target_hmac = ?').run(userId, hmac).changes) > 0;
    },
    isTrusted(userId, kind, value) {
      const hmac = targetHmac(s.crypto, kind, value);
      return !!db().prepare('SELECT 1 AS x FROM trusted_targets WHERE user_id = ? AND target_hmac = ?').get(userId, hmac);
    },
    sourceOf(userId, hmac) {
      return db().prepare('SELECT source FROM trusted_targets WHERE user_id = ? AND target_hmac = ?').get<{ source: TrustedTargetSource }>(userId, hmac)?.source;
    },
  };
}

export type TrustedTargetsImpl = ReturnType<typeof createTrustedTargets>;

/**
 * Resolves provenance for the targets a tool declared. Never trusts the tool's own hmac/provenance: both are recomputed.
 * `ownerText` = text the owner wrote in this conversation's current epoch; `untrustedText` = the epoch's untrusted blocks.
 */
export function resolveTargets(
  s: Services,
  tt: TrustedTargetsImpl,
  userId: UserId | null,
  raw: readonly Target[],
  corpus: () => { ownerText: string; untrustedText: string },
): Target[] {
  let c: { ownerText: string; untrustedText: string } | null = null;
  const get = () => (c ??= corpus());
  return raw.map((t) => {
    const kind = KINDS.includes(t.kind) ? t.kind : 'email';
    const value = normalizeTarget(kind, t.value);
    const hmac = targetHmac(s.crypto, kind, value);
    const base: Target = { kind, value, hmac, provenance: 'unknown', ...(t.sourceLabel ? { sourceLabel: t.sourceLabel } : {}) };
    if (!userId) return { ...base, provenance: 'unknown' };
    const src = tt.sourceOf(userId, hmac);
    if (src) return { ...base, provenance: PROVENANCE_OF[src] };
    const { ownerText, untrustedText } = get();
    if (ownerWroteTarget(ownerText, kind, value)) {
      try {
        tt.add(userId, { kind, value, source: 'user_message' });
      } catch {
        /* best effort */
      }
      return { ...base, provenance: 'user' };
    }
    if (containsValue(untrustedText, kind, value)) return { ...base, provenance: 'untrusted' };
    return { ...base, provenance: 'unknown' };
  });
}

/** Builds the owner/untrusted corpora of a conversation's epoch (owner inputs; untrusted blocks of stored rows and raw untrusted inputs). */
export function epochCorpus(s: Services, conversationId: string, epoch: number): { ownerText: string; untrustedText: string; untrustedSources: Map<string, string> } {
  const owner: string[] = [];
  const untrusted: string[] = [];
  const sources = new Map<string, string>();
  try {
    const ep = s.repos.conversations.getEpoch(conversationId, epoch);
    const since = ep?.startedAt ?? 0;
    for (const i of s.repos.inputs.ownerAuthoredSince(conversationId, since)) owner.push(blocksText(i.content));
  } catch {
    /* ignore */
  }
  try {
    for (const i of s.repos.inputs.pending(conversationId)) if (i.untrusted) untrusted.push(blocksText(i.content));
  } catch {
    /* ignore */
  }
  try {
    for (const m of s.repos.messages.load(conversationId, epoch)) {
      const text = blocksText((m.content as { content?: unknown }).content);
      for (const mm of text.matchAll(/<untrusted\b([^>]*)>([\s\S]*?)<\/untrusted>/g)) {
        untrusted.push(mm[2] ?? '');
        const src = /source="([^"]*)"/.exec(mm[1] ?? '')?.[1];
        if (src) sources.set(mm[2] ?? '', src);
      }
    }
  } catch {
    /* ignore */
  }
  return { ownerText: owner.join('\n'), untrustedText: untrusted.join('\n'), untrustedSources: sources };
}

const SOURCE_LABELS: Record<string, { en: string; ru: string }> = {
  email: { en: 'an email', ru: 'письма' },
  web: { en: 'a web page', ru: 'веб-страницы' },
  calendar: { en: 'a calendar event', ru: 'события календаря' },
  business_peer: { en: 'a business chat', ru: 'бизнес-чата' },
  forward: { en: 'a forwarded message', ru: 'пересланного сообщения' },
  group_member: { en: 'a group member', ru: 'участника группы' },
  guest: { en: 'a guest', ru: 'гостя' },
  guest_reply: { en: 'a guest', ru: 'гостя' },
  file: { en: 'a file', ru: 'файла' },
  import: { en: 'imported text', ru: 'импорта' },
};

/** The display label for an untrusted source (never the content). */
export function labelForSource(source: string | undefined, lang: 'en' | 'ru'): string | undefined {
  if (!source) return undefined;
  return SOURCE_LABELS[source]?.[lang];
}

/** Resolves and, for untrusted targets, names the source the value came from. */
export function resolveTargetsInEpoch(s: Services, tt: TrustedTargetsImpl, userId: UserId | null, conversationId: string, epoch: number, raw: readonly Target[], lang: 'en' | 'ru', extraOwnerText?: string): Target[] {
  let corpus: ReturnType<typeof epochCorpus> | null = null;
  const get = () => {
    if (!corpus) {
      corpus = epochCorpus(s, conversationId, epoch);
      if (extraOwnerText) corpus.ownerText = `${corpus.ownerText}\n${extraOwnerText}`;
    }
    return corpus;
  };
  const resolved = resolveTargets(s, tt, userId, raw, () => get());
  return resolved.map((t) => {
    if (t.provenance !== 'untrusted' || t.sourceLabel) return t;
    for (const [seg, src] of get().untrustedSources) {
      if (containsValue(seg, t.kind, t.value)) {
        const label = labelForSource(src, lang);
        return label ? { ...t, sourceLabel: label } : t;
      }
    }
    return t;
  });
}
