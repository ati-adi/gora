// memory/importer.ts (WP6a; gate = memoryEnabled, spec 05 B1) — /import and POST /api/memory/import (01 §9 "Import", F5): side.importFacts
// proposes facts, each stored as pending_confirm (source 'import'); the owner ticks them on a ✓/✗ checklist card
// (mm:ic:<id>:y|n) or in the Mini App list. Only ✓ facts are activated.
import type { InlineKeyboardButton } from 'grammy/types';
import type { UserId } from '../contracts/common.ts';
import { scopeKey } from '../contracts/common.ts';
import type { FactKind } from '../contracts/memory.ts';
import { memoryEnabled } from '../contracts/memory.ts';
import type { Services } from '../contracts/services.ts';
import { uiLang } from '../contracts/i18n.ts';
import type { MemoryStore } from './store.ts';

export const MAX_IMPORT_CHARS = 20_000;
export const MAX_IMPORT_FACTS = 40;
const CARD_ROWS = 15;
const KINDS: ReadonlySet<FactKind> = new Set(['profile', 'preference', 'person', 'relationship', 'goal', 'routine', 'date', 'fact']);

export function createImporter(s: Services, store: MemoryStore) {
  /** The checklist card for one import batch (all rows share created_at); re-rendered on each tap. */
  const renderCard = (userId: UserId, createdAt: number): { markdown: string; buttons: InlineKeyboardButton[][] } | null => {
    const u = s.repos.users.getById(userId);
    if (!u) return null;
    const ru = uiLang(u.languageCode) === 'ru';
    const scope = { kind: 'user' as const, userId };
    const rows = store.repo().importBatch(scopeKey(scope), createdAt);
    const facts = store.load(scope).facts;
    const R = s.telegram.render;
    const lines: string[] = [];
    const buttons: InlineKeyboardButton[][] = [];
    rows.forEach((row, i) => {
      const n = i + 1;
      const f = facts.find((x) => x.row.id === row.id);
      if (row.status === 'pending_confirm' && f) {
        lines.push(`${n}. ${R.escape(f.text)}`);
        if (buttons.length < CARD_ROWS) {
          buttons.push([
            { text: `✓ ${n}`, callback_data: s.telegram.codec.encode('mm', ['ic', row.id, 'y'], u.tgUserId) },
            { text: `✗ ${n}`, callback_data: s.telegram.codec.encode('mm', ['ic', row.id, 'n'], u.tgUserId) },
          ]);
        }
      } else if (row.status === 'active' && f) lines.push(`${n}. ✓ ${R.escape(f.text)}`);
      else lines.push(`${n}. ✗ ${ru ? '_не сохранено_' : '_not saved_'}`);
    });
    if (!rows.length) return null;
    const title = ru ? '🧠 **Импорт памяти** — отметьте, что сохранить:' : '🧠 **Memory import** — tick what I should keep:';
    return { markdown: `${title}\n${lines.join('\n')}`, buttons };
  };

  const importText = async (userId: UserId, text: string): Promise<Array<{ id: string; text: string }>> => {
    const u = s.repos.users.getById(userId);
    if (!u || !memoryEnabled(u, s.clock.now())) return [];
    const body = text.trim().slice(0, MAX_IMPORT_CHARS);
    if (!body) return [];
    // The pasted export is third-party-shaped text: it is only ever proposed, never activated without a tap.
    const proposed = await s.side.importFacts(body, u.languageCode ?? 'en', { userId, priority: 'interactive' });
    const scope = { kind: 'user' as const, userId };
    const batchAt = s.clock.now();
    const out: Array<{ id: string; text: string }> = [];
    for (const p of proposed.slice(0, MAX_IMPORT_FACTS)) {
      if (!KINDS.has(p.kind) || !p.text?.trim()) continue;
      const r = store.save(
        scope,
        { text: p.text, kind: p.kind, sensitivity: p.sensitivity, explicit: false, authorUserId: userId, source: { kind: 'import' } },
        { createdBy: 'import', forcePending: true, noCard: true, now: batchAt },
      );
      if ('id' in r && r.status === 'pending_confirm' && !out.some((x) => x.id === r.id)) out.push({ id: r.id, text: p.text.replace(/\s+/g, ' ').trim() });
    }
    if (out.length && u.dmChatId) {
      const card = renderCard(userId, batchAt);
      if (card) {
        s.telegram.outbox.enqueue({
          idempotencyKey: `mmimp:${userId}:${batchAt}`, userId, chatId: u.dmChatId, method: 'sendRichMessage', priority: 1,
          markdown: card.markdown, payload: { reply_markup: { inline_keyboard: card.buttons } },
        });
      }
    }
    return out;
  };

  return { importText, renderCard };
}
