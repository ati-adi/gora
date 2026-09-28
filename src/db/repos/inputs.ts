// db/repos/inputs.ts (WP1) — conversation_inputs and conv_events.
// Content is sealed under the conversation owner's DEK (u:/g:/b:, see convScopedDek) with AAD
// 'conversation_inputs|content_enc|<id>' / 'conv_events|text_enc|<id>'. Consumed inputs are deleted with their epoch.
import type { BetaContentBlockParam } from '../../contracts/llm.ts';
import type { ConversationRow, InputRow, InputsRepo, SqlValue } from '../../contracts/storage.ts';
import { newId } from '../../kernel/ids.ts';
import { isShredded } from '../crypto.ts';
import { b2i, convScopedDek, i2b, num, numOrNull, strOrNull, type RepoCtx } from './common.ts';

type Raw = Record<string, SqlValue>;
const aadInput = (id: string) => `conversation_inputs|content_enc|${id}`;
const aadEvent = (id: string) => `conv_events|text_enc|${id}`;

export function createInputsRepo(x: RepoCtx): InputsRepo {
  const { db, crypto, clock } = x;

  const convFor = (conversationId: string) => {
    const r = db.prepare('SELECT id, user_id, kind, tg_chat_id, business_connection_id, epoch FROM conversations WHERE id = ?').get<Raw>(conversationId);
    if (!r) throw new Error(`inputs: no conversation ${conversationId}`);
    const c: Pick<ConversationRow, 'id' | 'userId' | 'kind' | 'tgChatId' | 'businessConnectionId' | 'epoch'> = {
      id: String(r['id']), userId: strOrNull(r['user_id']), kind: r['kind'] as ConversationRow['kind'], tgChatId: numOrNull(r['tg_chat_id']),
      businessConnectionId: strOrNull(r['business_connection_id']), epoch: num(r['epoch']),
    };
    return c;
  };

  /** undefined when the row's DEK was shredded (the input is gone for good). */
  const toRow = (r: Raw): InputRow | undefined => {
    const id = String(r['id']);
    let content: BetaContentBlockParam[];
    try {
      content = crypto.openJson<BetaContentBlockParam[]>(r['content_enc'] as Uint8Array, aadInput(id));
    } catch (e) {
      if (isShredded(e)) return undefined;
      throw e;
    }
    return {
      id,
      conversationId: String(r['conversation_id']),
      kind: r['kind'] as InputRow['kind'],
      author: r['author'] as InputRow['author'],
      untrusted: i2b(r['untrusted']),
      content,
      tgUpdateId: numOrNull(r['tg_update_id']),
      tgChatId: numOrNull(r['tg_chat_id']),
      tgMessageId: numOrNull(r['tg_message_id']),
      fromTgUserId: numOrNull(r['from_tg_user_id']),
      replyToCardId: strOrNull(r['reply_to_card_id']),
      createdAt: num(r['created_at']),
      consumedRunId: strOrNull(r['consumed_run_id']),
      consumedEpoch: numOrNull(r['consumed_epoch']),
    };
  };
  const rows = (sql: string, ...p: SqlValue[]) => db.prepare(sql).all<Raw>(...p).map(toRow).filter((r): r is InputRow => r !== undefined);

  return {
    add(i) {
      return db.tx(() => {
        if (i.tgUpdateId !== null && i.tgUpdateId !== undefined) {
          const dup = db
            .prepare('SELECT id FROM conversation_inputs WHERE conversation_id = ? AND tg_update_id = ? AND untrusted = ?')
            .get<{ id: string }>(i.conversationId, i.tgUpdateId, b2i(i.untrusted));
          if (dup) return dup.id;
        }
        const now = clock.now();
        const id = newId('in', now);
        const dek = convScopedDek(convFor(i.conversationId));
        db.prepare(
          `INSERT INTO conversation_inputs(id, conversation_id, tg_update_id, tg_chat_id, tg_message_id, from_tg_user_id, kind, author, content_enc, untrusted, reply_to_card_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, i.conversationId, i.tgUpdateId ?? null, i.tgChatId, i.tgMessageId, i.fromTgUserId, i.kind, i.author, crypto.sealJson(dek, i.content, aadInput(id)),
          b2i(i.untrusted), i.replyToCardId, now,
        );
        return id;
      });
    },
    pending(conversationId) {
      return rows('SELECT * FROM conversation_inputs WHERE conversation_id = ? AND consumed_run_id IS NULL ORDER BY created_at, id', conversationId);
    },
    get(id) {
      const r = db.prepare('SELECT * FROM conversation_inputs WHERE id = ?').get<Raw>(id);
      return r ? toRow(r) : undefined;
    },
    byTgMessage(conversationId, tgChatId, tgMessageId) {
      return rows('SELECT * FROM conversation_inputs WHERE conversation_id = ? AND tg_chat_id = ? AND tg_message_id = ? ORDER BY untrusted, created_at, id', conversationId, tgChatId, tgMessageId)[0];
    },
    replaceUnconsumed(id, content) {
      const r = db.prepare('SELECT id, conversation_id, consumed_run_id FROM conversation_inputs WHERE id = ?').get<{ id: string; conversation_id: string; consumed_run_id: string | null }>(id);
      if (!r || r.consumed_run_id !== null) return false;
      const dek = convScopedDek(convFor(r.conversation_id));
      const u = db.prepare('UPDATE conversation_inputs SET content_enc = ? WHERE id = ? AND consumed_run_id IS NULL').run(crypto.sealJson(dek, content, aadInput(id)), id);
      return Number(u.changes) === 1;
    },
    delete(id) {
      db.prepare('DELETE FROM conversation_inputs WHERE id = ?').run(id);
    },
    consumedBy(runId) {
      return rows('SELECT * FROM conversation_inputs WHERE consumed_run_id = ? ORDER BY created_at, id', runId);
    },
    markConsumed(ids, runId, epoch) {
      if (!ids.length) return;
      db.tx(() => {
        const st = db.prepare('UPDATE conversation_inputs SET consumed_run_id = ?, consumed_epoch = ? WHERE id = ?');
        for (const id of ids) st.run(runId, epoch, id);
      });
    },
    ownerAuthoredSince(conversationId, sinceMs) {
      return rows(
        `SELECT * FROM conversation_inputs WHERE conversation_id = ? AND author = 'owner' AND untrusted = 0 AND created_at > ? ORDER BY created_at, id`,
        conversationId, sinceMs,
      );
    },
    deleteConsumedInEpoch(conversationId, epoch) {
      return Number(db.prepare('DELETE FROM conversation_inputs WHERE conversation_id = ? AND consumed_epoch = ?').run(conversationId, epoch).changes);
    },
    addEvent(conversationId, text) {
      const now = clock.now();
      const id = newId('ev', now);
      const dek = convScopedDek(convFor(conversationId));
      db.prepare('INSERT INTO conv_events(id, conversation_id, text_enc, created_at) VALUES (?, ?, ?, ?)').run(id, conversationId, crypto.seal(dek, text, aadEvent(id)), now);
    },
    takeEvents(conversationId, runId) {
      return db.tx(() => {
        const evs = db.prepare('SELECT id, text_enc FROM conv_events WHERE conversation_id = ? AND delivered_run_id IS NULL ORDER BY created_at, id').all<{ id: string; text_enc: Uint8Array }>(conversationId);
        const mark = db.prepare('UPDATE conv_events SET delivered_run_id = ? WHERE id = ?');
        const out: string[] = [];
        for (const e of evs) {
          mark.run(runId, e.id);
          try {
            out.push(crypto.openText(e.text_enc, aadEvent(e.id)));
          } catch (err) {
            if (!isShredded(err)) throw err;
          }
        }
        return out;
      });
    },
  };
}
