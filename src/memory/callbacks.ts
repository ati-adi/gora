// memory/callbacks.ts (WP6a; friend mode) — `mm:` callbacks (01 §4.3 memory row, §9):
//   mm:cf:<id>:y|n  confirm a pending fact from its ✓/✗ card (proposals of tainted runs; old sensitive cards)
//   mm:ic:<id>:y|n  tick an item of an import checklist card (re-rendered in place)
//   mm:rv:<runId>   the removed [📝 Remembered N · Review] row (spec 05 A5): answers "expired" for old messages
//   mm:fg:<id>      forget one fact (also used by /memory's [Forget mN] buttons, WP7)
import type { InlineKeyboardButton } from 'grammy/types';
import type { CallbackAnswer, CallbackCtx } from '../contracts/telegram.ts';
import type { Services } from '../contracts/services.ts';
import { uiLang } from '../contracts/i18n.ts';
import type { MemoryStore } from './store.ts';
import type { createImporter } from './importer.ts';

const T = {
  saved: { en: '✓ Remembered', ru: '✓ Запомнил' },
  dropped: { en: '✗ Not saved', ru: '✗ Не сохранено' },
  memoryOff: { en: 'Memory is off (or incognito is on).', ru: 'Память выключена (или включён инкогнито).' },
  gone: { en: 'Already handled.', ru: 'Уже обработано.' },
  expired: { en: 'This button has expired — ask me “what do you know about me?” or open /memory.', ru: 'Кнопка устарела — спроси «что ты обо мне знаешь?» или открой /memory.' },
  forgotten: { en: 'Forgotten.', ru: 'Забыто.' },
} as const;
const tr = (k: keyof typeof T, lang: string | null | undefined) => T[k][uiLang(lang)];

export function registerMemoryCallbacks(s: Services, store: MemoryStore, importer: ReturnType<typeof createImporter>): void {
  const edit = (c: CallbackCtx, markdown: string, buttons: InlineKeyboardButton[][]): void => {
    if (!c.message) return;
    s.telegram.outbox.enqueue({
      idempotencyKey: `mmed:${c.message.chatId}:${c.message.messageId}:${c.callbackQueryId}:${c.parts.join(':')}`,
      ...(c.user ? { userId: c.user.id } : {}),
      chatId: c.message.chatId, method: 'editMessageText', priority: 0, markdown,
      payload: { message_id: c.message.messageId, reply_markup: { inline_keyboard: buttons } },
    });
  };

  s.telegram.callbacks.register('mm', async (c): Promise<CallbackAnswer> => {
    const u = c.user;
    const lang = u?.languageCode;
    if (!u) return { text: tr('gone', lang) };
    const [op, a, b] = c.parts;
    switch (op) {
      case 'cf':
      case 'ic': {
        if (!a) return { text: tr('gone', lang) };
        const own = store.ownFact(u.id, a);
        if (!own) return { text: tr('gone', lang) };
        const createdAt = own.row.createdAt;
        const [r] = store.confirm(u.id, [a], b === 'y');
        if (!r || r.status === 'skipped') return { text: tr('gone', lang) };
        if (r.status === 'denied') return { text: tr('memoryOff', lang), alert: true };
        if (op === 'ic') {
          const card = importer.renderCard(u.id, createdAt);
          if (card) edit(c, card.markdown, card.buttons);
        } else {
          const f = store.load(own.scope).facts.find((x) => x.row.id === a);
          const line = r.status === 'active' ? `🧠 ${tr('saved', lang)}: “${s.telegram.render.escape(f?.text ?? '')}”` : `🧠 ${tr('dropped', lang)}`;
          edit(c, line, []);
        }
        return { text: tr(r.status === 'active' ? 'saved' : 'dropped', lang) };
      }
      case 'rv':
        // spec 05 A5: the [📝 Remembered N · Review] row is gone (a ✍ reaction instead); old buttons in live chats expire
        return { text: tr('expired', lang) };
      case 'fg': {
        if (!a) return { text: tr('gone', lang) };
        const own = store.ownFact(u.id, a);
        if (!own || own.scope.kind !== 'user') return { text: tr('gone', lang) };
        const facts = store.select(own.scope, { ids: [a] });
        const out = store.forgetFacts(own.scope, facts, u.id);
        return { text: out.length ? `${tr('forgotten', lang)} ${out[0]!.preview}`.slice(0, 190) : tr('gone', lang) };
      }
      default:
        return { text: tr('gone', lang) };
    }
  });
}
