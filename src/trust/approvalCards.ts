// trust/approvalCards.ts (WP4) — F7 card layout, rendered by code (never by the model) through render.card.
// Header '🔐 Approve: <title>', a 2-column table, the body (code block inside <details>, by the renderer), ⚠ warnings,
// expiry as <tg-time format="r">. Buttons: row 1 Approve / Deny; row 2 Edit (web_app, private chats only), and when
// eligible '24 h' and 'Always…' (web_app to the grant screen). callback_data 'a1:<id6>:<y|n>:<o|d>' + MAC (codec).
import type { InlineKeyboardButton } from 'grammy/types';
import type { CardSpec, Services, StringKey, UserId } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';

export interface CardModel {
  id: string; title: string; rows: Array<[string, string]>; body?: { label: string; text: string }; warnings: string[];
  expiresAt: number; chatId: number; grantable: boolean; ladderOffer: boolean; ownerTgId: number; lang: string | null; firstTargetDisplay?: string;
}

function t(s: Services, key: StringKey, lang: string | null, vars?: Record<string, string | number>): string {
  try {
    return s.strings.t(key, uiLang(lang), vars);
  } catch {
    return key;
  }
}

function local(lang: string | null, en: string, ru: string): string {
  return uiLang(lang) === 'ru' ? ru : en;
}

/** The model may never produce a lock-and-key card header: strip it from any model-sourced text on the card. */
export function neutralizeCardText(text: string): string {
  return text.replace(/🔐/gu, '🔒').replace(/<\/?tg-button\b[^>]*>/gi, '');
}

export function webAppUrl(s: Services, screen: 'approval' | 'grant', id: string): string | null {
  const base = s.config.publicUrl;
  if (!base || !/^https:\/\//.test(base)) return null;
  return `${base}/app/?screen=${screen}&id=${encodeURIComponent(id)}`;
}

export function cardButtons(s: Services, m: CardModel): InlineKeyboardButton[][] {
  const codec = s.telegram.codec;
  const rows: InlineKeyboardButton[][] = [
    [
      { text: t(s, 'approve_button', m.lang), callback_data: codec.encode('a1', [m.id, 'y', 'o'], m.ownerTgId) },
      { text: t(s, 'deny_button', m.lang), callback_data: codec.encode('a1', [m.id, 'n', 'o'], m.ownerTgId) },
    ],
  ];
  const row2: InlineKeyboardButton[] = [];
  const isPrivate = m.chatId > 0;
  const editUrl = webAppUrl(s, 'approval', m.id);
  if (isPrivate && editUrl) row2.push({ text: local(m.lang, '✏️ Edit', '✏️ Изменить'), web_app: { url: editUrl } });
  if (m.grantable && m.ladderOffer) {
    row2.push({ text: t(s, 'approve_24h_button', m.lang), callback_data: codec.encode('a1', [m.id, 'y', 'd'], m.ownerTgId) });
    const grantUrl = webAppUrl(s, 'grant', m.id);
    if (isPrivate && grantUrl) row2.push({ text: local(m.lang, `♾ Always${m.firstTargetDisplay ? ` for ${m.firstTargetDisplay}` : ''}…`, `♾ Всегда${m.firstTargetDisplay ? ` для ${m.firstTargetDisplay}` : ''}…`), web_app: { url: grantUrl } });
  }
  if (row2.length) rows.push(row2);
  return rows;
}

export function approvalCard(s: Services, m: CardModel): { markdown: string; replyMarkup: { inline_keyboard: InlineKeyboardButton[][] } } {
  const title = `${local(m.lang, 'Approve', 'Подтвердите')}: ${neutralizeCardText(m.title)}`;
  const expiry = s.telegram.render.tgTime(Math.floor(m.expiresAt / 1000), 'r', new Date(m.expiresAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
  const spec: CardSpec = {
    icon: '🔐',
    title,
    rows: m.rows.map(([k, v]) => [neutralizeCardText(k), neutralizeCardText(v)] as [string, string]),
    ...(m.body ? { body: { label: neutralizeCardText(m.body.label), text: neutralizeCardText(m.body.text) } } : {}),
    warnings: m.warnings.map(neutralizeCardText),
    footerMarkdown: `${local(m.lang, 'Expires', 'Истекает')} ${expiry} · \`${m.id}\``,
    buttons: cardButtons(s, m),
  };
  const r = s.telegram.render.card(spec);
  return { markdown: r.markdown, replyMarkup: { inline_keyboard: (r.replyMarkup.inline_keyboard ?? spec.buttons) as InlineKeyboardButton[][] } };
}

export type Outcome = 'executed' | 'denied' | 'expired' | 'superseded' | 'failed' | 'unknown' | 'voided' | 'blocked';

/** The card edited into its outcome (no buttons). `summary` is code-built (never model text). */
export function outcomeMarkdown(s: Services, o: { outcome: Outcome; title: string; summary?: string; at: number; tz: string; ledgerSeq?: number; lang: string | null; note?: string }): string {
  const hhmm = (() => {
    try {
      return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: o.tz }).format(new Date(o.at));
    } catch {
      return new Date(o.at).toISOString().slice(11, 16);
    }
  })();
  const esc = (x: string) => s.telegram.render.escape(neutralizeCardText(x));
  let head: string;
  switch (o.outcome) {
    case 'executed':
      head = `✅ ${esc(o.summary ?? o.title)} · ${hhmm}${o.ledgerSeq ? ` · ledger #${o.ledgerSeq}` : ''}`;
      break;
    case 'denied':
      head = `${t(s, 'approval_not_sent', o.lang)} · ${esc(o.title)}`;
      break;
    case 'expired':
      head = `${t(s, 'approval_expired', o.lang)} · ${esc(o.title)}`;
      break;
    case 'superseded':
      head = `${t(s, 'approval_superseded', o.lang)} · ${esc(o.title)}`;
      break;
    case 'voided':
      head = `${local(o.lang, '✖ Cancelled', '✖ Отменено')} · ${esc(o.title)}`;
      break;
    case 'blocked':
      head = `⛔ ${local(o.lang, 'Blocked by policy', 'Заблокировано политикой')} · ${esc(o.title)}`;
      break;
    case 'failed':
      head = `⚠️ ${local(o.lang, 'Failed', 'Не удалось')} · ${esc(o.title)}`;
      break;
    default:
      head = `❔ ${local(o.lang, 'Outcome unknown — check before retrying', 'Результат неизвестен — проверьте')} · ${esc(o.title)}`;
  }
  return o.note ? `${head}\n${esc(o.note)}` : head;
}

export function ownerLang(s: Services, userId: UserId): string | null {
  try {
    return s.repos.users.getById(userId)?.languageCode ?? null;
  } catch {
    return null;
  }
}
