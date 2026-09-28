// db/repos/messages.ts (WP1) — the append-only transcript (messages) and encrypted blobs.
// content_enc is the exact BetaMessageParam JSON sealed under the epoch DEK, AAD 'messages|content_enc|<conv>:<epoch>:<seq>';
// content_hmac = hmac('content', canonicalJson(content)). The DDL triggers forbid UPDATE and DELETE without a shred token.
import type { BetaMessageParam } from '../../contracts/llm.ts';
import type { MessageKind, MessageRow, MessagesRepo, SqlValue } from '../../contracts/storage.ts';
import { canonicalJson } from '../../kernel/canonicalJson.ts';
import { newId } from '../../kernel/ids.ts';
import { isShredded } from '../crypto.ts';
import { b2i, epochDek, i2b, num, strOrNull, type RepoCtx } from './common.ts';

type Raw = Record<string, SqlValue>;
type Validator = (existing: MessageRow[], added: Array<{ role: string; kind: MessageKind; content: BetaMessageParam }>) => void;

const aadMsg = (conv: string, epoch: number, seq: number) => `messages|content_enc|${conv}:${epoch}:${seq}`;
const aadBlob = (id: string) => `blobs|bytes_enc|${id}`;

export function createMessagesRepo(x: RepoCtx): MessagesRepo {
  const { db, crypto, clock } = x;
  let validator: Validator | null = null;

  const toRow = (r: Raw): MessageRow => {
    const conv = String(r['conversation_id']);
    const epoch = num(r['epoch']);
    const seq = num(r['seq']);
    return {
      conversationId: conv,
      epoch,
      seq,
      role: r['role'] as MessageRow['role'],
      kind: r['kind'] as MessageKind,
      content: crypto.openJson<BetaMessageParam>(r['content_enc'] as Uint8Array, aadMsg(conv, epoch, seq)),
      runId: strOrNull(r['run_id']),
      stopReason: strOrNull(r['stop_reason']),
      hasClientToolUse: i2b(r['has_client_tool_use']),
      createdAt: num(r['created_at']),
    };
  };
  const load = (conversationId: string, epoch: number) =>
    db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND epoch = ? ORDER BY seq').all<Raw>(conversationId, epoch).map(toRow);

  return {
    append(conversationId, epoch, rows) {
      if (!rows.length) return [];
      return db.tx(() => {
        const e = db.prepare('SELECT next_seq, shredded_at FROM epochs WHERE conversation_id = ? AND epoch = ?').get<{ next_seq: number; shredded_at: number | null }>(conversationId, epoch);
        if (!e) throw new Error(`messages.append: no epoch ${conversationId}:${epoch}`);
        if (e.shredded_at !== null) throw new Error(`messages.append: epoch ${conversationId}:${epoch} is shredded`);
        if (validator) {
          validator(load(conversationId, epoch), rows.map((r) => ({ role: r.role, kind: r.kind, content: structuredClone(r.content) })));
        }
        const now = clock.now();
        const dek = epochDek(conversationId, epoch);
        const ins = db.prepare(
          'INSERT INTO messages(conversation_id, epoch, seq, role, kind, content_enc, content_hmac, run_id, stop_reason, has_client_tool_use, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        const seqs: number[] = [];
        let seq = num(e.next_seq);
        for (const r of rows) {
          ins.run(
            conversationId, epoch, seq, r.role, r.kind, crypto.sealJson(dek, r.content, aadMsg(conversationId, epoch, seq)), crypto.hmac('content', canonicalJson(r.content)),
            r.runId ?? null, r.stopReason ?? null, b2i(r.hasClientToolUse), now,
          );
          seqs.push(seq);
          seq++;
        }
        db.prepare('UPDATE epochs SET next_seq = ? WHERE conversation_id = ? AND epoch = ?').run(seq, conversationId, epoch);
        return seqs;
      });
    },
    load,
    last(conversationId, epoch) {
      const r = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND epoch = ? ORDER BY seq DESC LIMIT 1').get<Raw>(conversationId, epoch);
      return r ? toRow(r) : undefined;
    },
    setValidator(v) {
      validator = v;
    },
    putBlob(b) {
      const now = clock.now();
      const id = newId('b', now);
      db.prepare('INSERT INTO blobs(id, owner_user_id, dek_id, mime, size, bytes_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, b.ownerUserId, b.dek, b.mime, b.bytes.length, crypto.seal(b.dek, b.bytes, aadBlob(id)), now,
      );
      return id;
    },
    getBlob(id) {
      const r = db.prepare('SELECT mime, bytes_enc FROM blobs WHERE id = ?').get<{ mime: string; bytes_enc: Uint8Array }>(id);
      if (!r) return undefined;
      try {
        return { mime: r.mime, bytes: crypto.open(r.bytes_enc, aadBlob(id)) };
      } catch (e) {
        if (isShredded(e)) return undefined;
        throw e;
      }
    },
    refBlobs(conversationId, epoch, blobIds) {
      if (!blobIds.length) return;
      db.tx(() => {
        const st = db.prepare('INSERT OR IGNORE INTO blob_refs(blob_id, conversation_id, epoch) SELECT id, ?, ? FROM blobs WHERE id = ?');
        for (const id of new Set(blobIds)) st.run(conversationId, epoch, id);
      });
    },
  };
}
