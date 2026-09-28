// telegram/render/cards.ts (WP2) — code-built cards (approvals, connect, nudges, notices). Every untrusted string is escaped;
// a body (e.g. an email draft) is shown verbatim inside a fenced code block within <details>, so nothing in it can render as
// markup, a link or a button. `lines` and `footerMarkdown` are trusted, code-built markdown.
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { CardSpec } from '../../contracts/index.ts';
import { codeBlock, escapeHtmlText, escapeMd } from './escape.ts';

export function renderCard(spec: CardSpec): { markdown: string; replyMarkup: InlineKeyboardMarkup } {
  const out: string[] = [`${spec.icon} **${escapeMd(oneLine(spec.title))}**`];
  for (const [k, v] of spec.rows ?? []) out.push(`**${escapeMd(oneLine(k))}:** ${escapeMd(oneLine(v))}`);
  for (const l of spec.lines ?? []) out.push(l);
  for (const w of spec.warnings ?? []) out.push(`⚠️ ${escapeMd(oneLine(w))}`);
  if (spec.body) {
    out.push('');
    out.push(`<details><summary>${escapeHtmlText(oneLine(spec.body.label))}</summary>\n\n${codeBlock(spec.body.text)}\n\n</details>`);
  }
  if (spec.footerMarkdown) {
    out.push('');
    out.push(spec.footerMarkdown);
  }
  return { markdown: out.join('\n'), replyMarkup: { inline_keyboard: spec.buttons } };
}

/** Card rows and titles are single lines: newlines would let text start a new block (a fake heading or list). */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}
