// db/repos/conversations.ts (WP1) — conversations + epochs. Every epoch has its own DEK 'e:<conv>:<n>', created with
// crypto.ensureDek(…, owner) so that destroyOwner(userId | 'grp:<chatId>' | 'guest') covers it (contracts/storage.ts).
import type { TaintSource, UserId } from '../../contracts/common.ts';
import type { ConversationRow, ConversationsRepo, EpochRow, SqlValue } from '../../contracts/storage.ts';
import { newId } from '../../kernel/ids.ts';
import { isShredded } from '../crypto.ts';
import { b2i, convDekOwner, epochDek, has, i2b, num, numOrNull, parseJson, strOrNull, type RepoCtx } from './common.ts';

type Raw = Record<string, SqlValue>;
const aadHandoff = (conv: string, epoch: number) => `epochs|handoff_summary_enc|${conv}:${epoch}`;

export function toConversation(r: Raw): ConversationRow {
  return {
    id: String(r['id']),
    scopeKey: String(r['scope_key']),
    kind: r['kind'] as ConversationRow['kind'],
    userId: strOrNull(r['user_id']),
    tgChatId: numOrNull(r['tg_chat_id']),
    threadId: numOrNull(r['thread_id']),
    businessConnectionId: strOrNull(r['business_connection_id']),
    route: r['route'] as ConversationRow['route'],
    model: String(r['model']),
    effort: r['effort'] as ConversationRow['effort'],
    toolset: r['toolset'] as ConversationRow['toolset'],
    toolsHash: String(r['tools_hash']),
    systemVersion: String(r['system_version']),
    betas: parseJson<string[]>(r['betas_json'], []),
    contextMode: r['context_mode'] as ConversationRow['contextMode'],
    epoch: num(r['epoch']),
    rotatePending: strOrNull(r['rotate_pending']),
    activeRunId: strOrNull(r['active_run_id']),
    singleShot: i2b(r['single_shot']),
    status: r['status'] as ConversationRow['status'],
    createdAt: num(r['created_at']),
    lastActivityAt: num(r['last_activity_at']),
  };
}

export function createConversationsRepo(x: RepoCtx): ConversationsRepo {
  const { db, crypto, clock } = x;

  const toEpoch = (r: Raw): EpochRow => {
    const conv = String(r['conversation_id']);
    const epoch = num(r['epoch']);
    let handoffSummary: string | null = null;
    const hs = r['handoff_summary_enc'];
    if (hs instanceof Uint8Array) {
      try {
        handoffSummary = crypto.openText(hs, aadHandoff(conv, epoch));
      } catch (e) {
        if (!isShredded(e)) throw e;
      }
    }
    return {
      conversationId: conv,
      epoch,
      dekId: String(r['dek_id']),
      reason: r['reason'] as EpochRow['reason'],
      seedKind: r['seed_kind'] as EpochRow['seedKind'],
      handoffSummary,
      handoffMadeAt: numOrNull(r['handoff_made_at']),
      taint: parseJson<TaintSource[]>(r['taint_json'], []),
      inputTokensLast: num(r['input_tokens_last']),
      lastRequestAt: numOrNull(r['last_request_at']),
      nextSeq: num(r['next_seq']),
      startedAt: num(r['started_at']),
      closedAt: numOrNull(r['closed_at']),
      shreddedAt: numOrNull(r['shredded_at']),
    };
  };

  const get = (id: string) => {
    const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get<Raw>(id);
    return r ? toConversation(r) : undefined;
  };
  const need = (id: string) => {
    const c = get(id);
    if (!c) throw new Error(`conversations: no conversation ${id}`);
    return c;
  };
  const getEpoch = (id: string, epoch: number) => {
    const r = db.prepare('SELECT * FROM epochs WHERE conversation_id = ? AND epoch = ?').get<Raw>(id, epoch);
    return r ? toEpoch(r) : undefined;
  };
  const insertEpoch = (conv: string, epoch: number, reason: EpochRow['reason'], seedKind: EpochRow['seedKind'], taint: TaintSource[], now: number) => {
    db.prepare('INSERT INTO epochs(conversation_id, epoch, dek_id, reason, seed_kind, taint_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      conv, epoch, epochDek(conv, epoch), reason, seedKind, JSON.stringify([...new Set(taint)]), now,
    );
  };

  const repo: ConversationsRepo = {
    get,
    byScopeKey(scopeKey) {
      const r = db.prepare('SELECT * FROM conversations WHERE scope_key = ?').get<Raw>(scopeKey);
      return r ? toConversation(r) : undefined;
    },
    create(c) {
      const now = clock.now();
      const id = newId('c', now);
      // keys.db first (outside the gora.db transaction; an orphan DEK after a failed insert is harmless)
      crypto.ensureDek(epochDek(id, 1), convDekOwner(c), 'epoch');
      db.tx(() => {
        db.prepare(
          `INSERT INTO conversations(id, scope_key, kind, user_id, tg_chat_id, thread_id, business_connection_id, route, model, effort, toolset,
             tools_hash, system_version, betas_json, context_mode, epoch, single_shot, status, created_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', ?, ?)`,
        ).run(
          id, c.scopeKey, c.kind, c.userId, c.tgChatId, c.threadId, c.businessConnectionId, c.route, c.model, c.effort, c.toolset,
          c.toolsHash, c.systemVersion, JSON.stringify(c.betas), c.contextMode, b2i(c.singleShot), now, now,
        );
        insertEpoch(id, 1, 'initial', 'none', [], now);
      });
      return need(id);
    },
    update(id, patch) {
      const p: Array<[string, SqlValue]> = [];
      if (Object.prototype.hasOwnProperty.call(patch, 'rotatePending')) p.push(['rotate_pending', patch.rotatePending ?? null]);
      if (has(patch, 'status')) p.push(['status', patch.status!]);
      if (has(patch, 'lastActivityAt')) p.push(['last_activity_at', patch.lastActivityAt!]);
      if (has(patch, 'contextMode')) p.push(['context_mode', patch.contextMode!]);
      if (has(patch, 'model')) p.push(['model', patch.model!]);
      if (has(patch, 'effort')) p.push(['effort', patch.effort!]);
      if (has(patch, 'toolset')) p.push(['toolset', patch.toolset!]);
      if (has(patch, 'toolsHash')) p.push(['tools_hash', patch.toolsHash!]);
      if (has(patch, 'systemVersion')) p.push(['system_version', patch.systemVersion!]);
      if (has(patch, 'betas')) p.push(['betas_json', JSON.stringify(patch.betas)]);
      if (!p.length) return;
      const r = db.prepare(`UPDATE conversations SET ${p.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...p.map(([, v]) => v), id);
      if (Number(r.changes) === 0) throw new Error(`conversations.update: no conversation ${id}`);
    },
    casActiveRun(id, expected, next) {
      const r = db.prepare('UPDATE conversations SET active_run_id = ? WHERE id = ? AND active_run_id IS ?').run(next, id, expected);
      return Number(r.changes) === 1;
    },
    currentEpoch(id) {
      const r = db.prepare('SELECT e.* FROM epochs e JOIN conversations c ON c.id = e.conversation_id AND c.epoch = e.epoch WHERE c.id = ?').get<Raw>(id);
      if (!r) throw new Error(`conversations: no current epoch for ${id}`);
      return toEpoch(r);
    },
    getEpoch,
    startEpoch(id, reason, seedKind, taint) {
      const c = need(id);
      const next = c.epoch + 1;
      crypto.ensureDek(epochDek(id, next), convDekOwner(c), 'epoch');
      db.tx(() => {
        const now = clock.now();
        // CAS on the epoch number: a concurrent rotation fails loudly instead of forking two epochs
        const u = db.prepare('UPDATE conversations SET epoch = ? WHERE id = ? AND epoch = ?').run(next, id, c.epoch);
        if (Number(u.changes) !== 1) throw new Error(`conversations.startEpoch: epoch of ${id} changed concurrently`);
        db.prepare('UPDATE epochs SET closed_at = ? WHERE conversation_id = ? AND epoch = ? AND closed_at IS NULL').run(now, id, c.epoch);
        insertEpoch(id, next, reason, seedKind, taint, now);
      });
      return getEpoch(id, next)!;
    },
    updateEpoch(id, epoch, patch) {
      const p: Array<[string, SqlValue]> = [];
      if (Object.prototype.hasOwnProperty.call(patch, 'handoffSummary')) {
        p.push(['handoff_summary_enc', patch.handoffSummary == null ? null : crypto.seal(epochDek(id, epoch), patch.handoffSummary, aadHandoff(id, epoch))]);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'handoffMadeAt')) p.push(['handoff_made_at', patch.handoffMadeAt ?? null]);
      if (has(patch, 'taint')) p.push(['taint_json', JSON.stringify([...new Set(patch.taint)])]);
      if (has(patch, 'inputTokensLast')) p.push(['input_tokens_last', patch.inputTokensLast!]);
      if (Object.prototype.hasOwnProperty.call(patch, 'lastRequestAt')) p.push(['last_request_at', patch.lastRequestAt ?? null]);
      if (!p.length) return;
      const r = db.prepare(`UPDATE epochs SET ${p.map(([c]) => `${c} = ?`).join(', ')} WHERE conversation_id = ? AND epoch = ?`).run(...p.map(([, v]) => v), id, epoch);
      if (Number(r.changes) === 0) throw new Error(`conversations.updateEpoch: no epoch ${id}:${epoch}`);
    },
    /** `ms` is a cutoff instant: epochs closed at or before it and not yet shredded (the retention sweep passes now − 90 d). */
    closedEpochsOlderThan(ms) {
      return db
        .prepare('SELECT conversation_id, epoch FROM epochs WHERE closed_at IS NOT NULL AND closed_at <= ? AND shredded_at IS NULL ORDER BY closed_at, conversation_id, epoch')
        .all<{ conversation_id: string; epoch: number }>(ms)
        .map((r) => ({ conversationId: r.conversation_id, epoch: num(r.epoch) }));
    },
    listByUser(userId: UserId, o) {
      const params: SqlValue[] = [userId];
      let sql = 'SELECT * FROM conversations WHERE user_id = ?';
      if (o?.status) {
        sql += ' AND status = ?';
        params.push(o.status);
      }
      sql += ' ORDER BY last_activity_at DESC, id DESC LIMIT ?';
      params.push(o?.limit ?? 50);
      return db.prepare(sql).all<Raw>(...params).map(toConversation);
    },
  };
  return repo;
}
