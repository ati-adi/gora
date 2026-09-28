// trust/undo.ts (WP4) — F7 "reversible actions in my own space run immediately with [↩ Undo] for 10 min".
// Tokens live in undo_tokens (payload sealed under 'u:<userId>'). The spec.undo call itself happens in executor.ts
// (the only caller of execute/undo); this service only guards ownership, expiry and exactly-once.
import type { Services, UndoService, UserId } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';
import { newId } from '../kernel/ids.ts';

export type RunUndo = (p: { userId: UserId; toolName: string; toolUseId: string; payload: unknown }) => Promise<void>;

interface UndoRow { id: string; user_id: string; tool_use_id: string; tool_name: string; payload_enc: Uint8Array; status: string; expires_at: number }

export function createUndo(s: Services, runUndo: () => RunUndo): UndoService {
  const aad = (id: string) => `undo_tokens|payload_enc|${id}`;
  const str = (key: 'undone' | 'undo_expired', userId: string | undefined): string => {
    try {
      return s.strings.t(key, uiLang(userId ? s.repos.users.getById(userId)?.languageCode : null));
    } catch {
      return key === 'undone' ? 'Undone ✓' : 'Too late to undo.';
    }
  };
  return {
    issue(p) {
      const now = s.clock.now();
      const id = newId('ud', now);
      s.db
        .prepare("INSERT INTO undo_tokens (id, user_id, tool_use_id, tool_name, payload_enc, status, expires_at, created_at) VALUES (?,?,?,?,?,'available',?,?)")
        .run(id, p.userId, p.toolUseId, p.toolName, s.crypto.sealJson(`u:${p.userId}`, p.payload ?? null, aad(id)), now + p.ttlMs, now);
      return id;
    },
    async undo(id, byTgId) {
      const row = s.db.prepare('SELECT * FROM undo_tokens WHERE id = ?').get<UndoRow>(id);
      if (!row) return { ok: false, message: str('undo_expired', undefined) };
      const owner = s.repos.users.getById(row.user_id);
      if (!owner || owner.tgUserId !== byTgId) return { ok: false, message: 'Not yours.' };
      const now = s.clock.now();
      if (row.status === 'undone') return { ok: true, message: str('undone', row.user_id) };
      if (row.status !== 'available' || row.expires_at <= now) {
        if (row.status === 'available') s.db.prepare("UPDATE undo_tokens SET status = 'expired' WHERE id = ? AND status = 'available'").run(id);
        return { ok: false, message: str('undo_expired', row.user_id) };
      }
      // Exactly once: claim the token before running the undo.
      const claimed = Number(s.db.prepare("UPDATE undo_tokens SET status = 'undone' WHERE id = ? AND status = 'available' AND expires_at > ?").run(id, now).changes) === 1;
      if (!claimed) return { ok: true, message: str('undone', row.user_id) };
      let payload: unknown;
      try {
        payload = s.crypto.openJson<unknown>(row.payload_enc, aad(id));
      } catch {
        s.db.prepare("UPDATE undo_tokens SET status = 'failed' WHERE id = ?").run(id);
        return { ok: false, message: str('undo_expired', row.user_id) };
      }
      try {
        await runUndo()({ userId: row.user_id, toolName: row.tool_name, toolUseId: row.tool_use_id, payload });
      } catch (e) {
        s.db.prepare("UPDATE undo_tokens SET status = 'failed' WHERE id = ?").run(id);
        s.log.warn({ err: e instanceof Error ? e.name : 'error', tool: row.tool_name }, 'undo failed');
        return { ok: false, message: uiLang(owner.languageCode) === 'ru' ? 'Не удалось отменить.' : 'Could not undo that.' };
      }
      try {
        s.ledger.append({ userId: row.user_id, actor: 'user', kind: 'undo', summary: `Undid ${row.tool_name}`, toolUseId: row.tool_use_id });
      } catch {
        /* ledger best effort */
      }
      return { ok: true, message: str('undone', row.user_id) };
    },
  };
}
