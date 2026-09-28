// surfaces/business/triage.ts (WP7b) — the business_triage job (01 §10.2 step 3). Runs 45 s after the last message of
// a CONSENTED chat: side.triage over the last 20 stored messages (peer lines wrapped as <untrusted
// source="business_peer">), commitments to CommitmentService, then either single-shot drafting (urgency ≥ 2,
// needs_reply, mode 'draft') or a line in the 📥 Inbox digest. At most 60 triage calls per connection per day.
import type { JobResult, Triage } from '../../contracts/index.ts';
import { chatRef, clip, DAY_MS, errName, hhmm, ledger, localStamp, ownerOf, TRANSCRIPT_MESSAGES, TRIAGE_PER_DAY, type Biz } from './core.ts';
import { addDigestItem } from './digest.ts';
import { connectionLive, startDraft } from './drafting.ts';
import type { MsgRow } from './repo.ts';
import { bt } from './text.ts';

/** Owner lines stay plain; each run of consecutive peer lines goes through the untrusted wrapper (WP4). */
export async function triageTranscript(b: Biz, userId: string, msgs: MsgRow[], tz: string): Promise<string> {
  const out: string[] = [];
  let peerRun: string[] = [];
  const flush = async () => {
    if (!peerRun.length) return;
    const w = await b.s.untrusted.wrap({ source: 'business_peer', label: 'chat participant', text: peerRun.join('\n'), userId, priority: 'background' });
    out.push(w.text);
    peerRun = [];
  };
  for (const m of msgs) {
    const body = `${m.mediaKind ? `[${m.mediaKind}] ` : ''}${m.text.trim()}`.trim();
    const line = `#${m.messageId} [${hhmm(m.date, tz)}] ${body}`;
    if (m.fromOwner) {
      await flush();
      out.push(`#${m.messageId} [${hhmm(m.date, tz)}] Owner${m.viaBot ? ' (sent via Gora)' : ''}: ${body}`);
    } else peerRun.push(line);
  }
  await flush();
  return out.join('\n');
}

const words = (t: string): Set<string> => new Set((t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3));

/**
 * The message a detected commitment came from, so deleted_business_messages of that message deletes the commitment
 * (01 F12). Among the owing side's messages, the one sharing the most words with the commitment text (ties → the latest);
 * the owing side's last message only when nothing overlaps.
 */
export function commitmentSource(msgs: MsgRow[], mine: boolean, text: string): MsgRow {
  const want = words(text);
  let best: MsgRow | undefined;
  let bestScore = 0;
  for (const m of msgs) {
    if (m.fromOwner !== mine) continue;
    let score = 0;
    for (const w of words(m.text)) if (want.has(w)) score++;
    if (score > 0 && score >= bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best ?? [...msgs].reverse().find((m) => m.fromOwner === mine) ?? msgs[msgs.length - 1]!;
}

export async function runTriage(b: Biz, connectionId: string, chatId: number): Promise<JobResult> {
  const { s, repo } = b;
  const conn = repo.getConnection(connectionId);
  if (!conn || !connectionLive(conn)) return { status: 'done' };
  const chat = repo.getChat(connectionId, chatId);
  if (!chat?.aiEnabled) return { status: 'done' }; // never an LLM call for a chat without consent
  const user = ownerOf(b, conn.userId);
  if (!user || user.status !== 'active') return { status: 'done' };
  const msgs = repo.lastMessages(connectionId, chatId, TRANSCRIPT_MESSAGES);
  if (!msgs.length) return { status: 'done' };
  if (!s.quotas.rate(`biz_triage:${connectionId}`, TRIAGE_PER_DAY, DAY_MS)) {
    b.log.info({ chat: chatId }, 'business: daily triage limit reached');
    return { status: 'done' };
  }
  const lang = user.languageCode ?? 'en';
  const ref = chatRef(connectionId, chatId);
  const peerName = repo.title(connectionId, chatId) ?? bt('peer', lang);
  const now = s.clock.now();
  let tri: Triage | null = null;
  try {
    const transcript = await triageTranscript(b, user.id, msgs, user.tz);
    tri = await s.side.triage({ transcript, peerName: clip(peerName, 80), nowLocal: localStamp(now, user.tz), lang }, { userId: user.id, priority: 'background' });
  } catch (e) {
    b.log.warn({ err: errName(e) }, 'business: triage call failed');
    tri = null;
  }
  // Consent may have been revoked (or the connection closed) while the side call ran: discard the result.
  const fresh = repo.getChat(connectionId, chatId);
  const connNow = repo.getConnection(connectionId);
  if (!fresh?.aiEnabled || !connNow || !connectionLive(connNow)) return { status: 'done' };
  const peerWaiting = fresh.unansweredSince !== null;
  repo.noteTriage(connectionId, chatId, s.clock.now(), tri ? (peerWaiting ? tri.urgency : 0) : null);
  ledger(b, { userId: user.id, actor: 'system', kind: 'business_event', summary: 'Secretary triaged a chat', detail: { chat: ref, messages: msgs.length, ok: !!tri } });
  if (!tri) return { status: 'done' };

  if (tri.commitment && tri.commitment.text.trim()) {
    const mine = tri.commitment.direction === 'i_owe';
    // Prefer the model's own attribution when it names a transcript message of the owing side (F5); else the heuristic.
    const cited = tri.commitment.source_message_id ?? null;
    const src = (cited !== null ? msgs.find((m) => m.messageId === cited && m.fromOwner === mine) : undefined) ?? commitmentSource(msgs, mine, tri.commitment.text);
    // Only commitments from messages that arrived since the previous triage (a re-triage must not re-add old ones).
    const isNew = chat.lastTriageAt === null || src.date >= chat.lastTriageAt - 1000;
    if (isNew) {
      try {
        s.commitments.add({
          userId: user.id, source: 'business', direction: tri.commitment.direction, text: clip(tri.commitment.text, 300), counterpart: clip(peerName, 80),
          dueLocal: tri.commitment.due_local, businessConnectionId: connectionId, chatId, sourceMessageId: src.messageId,
        });
      } catch (e) {
        b.log.warn({ err: errName(e) }, 'business: commitment add failed');
      }
    }
  }

  if (!peerWaiting || !tri.needs_reply) return { status: 'done' }; // owner messages: commitment detection only
  const item = { summary: clip(tri.summary, 200), urgency: tri.urgency, at: now };
  if (tri.urgency >= 2 && fresh.mode === 'draft') {
    try {
      const runId = await startDraft(b, { conn: connNow, chat: fresh, user, reason: 'triage' });
      if (runId) {
        // kept hidden; shown with "no reply suggested" if the drafting run ends without a draft (noteNoDraft)
        addDigestItem(b, { connectionId, userId: user.id, chatId, item: { ...item, drafted: true } });
        return { status: 'done' };
      }
    } catch (e) {
      b.log.warn({ err: errName(e) }, 'business: drafting failed to start');
    }
  }
  addDigestItem(b, { connectionId, userId: user.id, chatId, item: { ...item, noDraft: false, drafted: false } });
  return { status: 'done' };
}
