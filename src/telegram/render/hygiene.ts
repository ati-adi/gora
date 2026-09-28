// telegram/render/hygiene.ts (WP2) — makes a streaming prefix safe to render as a draft (01 §4.4 Renderer.hygiene):
// close an unterminated code fence or $$ block, drop a partial tag / entity / link at the very end, close open <details>.
// The result is only ever shown as a draft; the final message is rendered from the complete text.

export function hygiene(partialMd: string): string {
  let s = partialMd;
  // 1. a trailing partial HTML tag or comment ("<tg-but", "</deta", "<!--") — Telegram would reject or show it raw
  s = s.replace(/<\/?[A-Za-z!][^<>\n]*$/, '');
  s = s.replace(/<$/, '');
  // 2. a trailing partial entity ("&am")
  s = s.replace(/&[A-Za-z#0-9]{0,8}$/, '');
  // 3. a trailing partial link or image "[text](http…" without its closing paren
  s = s.replace(/!?\[[^\]\n]*\]\([^)\n]*$/, '');

  const lines = s.split('\n');
  // 4. unterminated fence → close it with the same fence
  let fence: { ch: string; len: number } | null = null;
  let math = false;
  let details = 0;
  for (const line of lines) {
    if (fence) {
      const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (c && c[1]![0] === fence.ch && c[1]!.length >= fence.len) fence = null;
      continue;
    }
    const o = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (o) {
      fence = { ch: o[1]![0]!, len: o[1]!.length };
      continue;
    }
    // $$ block math toggles (count occurrences on the line)
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars % 2 === 1) math = !math;
    details += (line.match(/<details(?=[\s>])/gi) ?? []).length;
    details -= (line.match(/<\/details\s*>/gi) ?? []).length;
  }
  let out = s;
  if (fence) out += `\n${fence.ch.repeat(fence.len)}`;
  else {
    if (math) out += '$$';
    // an odd number of inline backticks on the last line → drop the dangling span opener
    const last = out.slice(out.lastIndexOf('\n') + 1);
    const ticks = (last.replace(/\\`/g, '').match(/`/g) ?? []).length;
    if (ticks % 2 === 1) {
      const k = out.lastIndexOf('`');
      out = out.slice(0, k) + out.slice(k + 1);
    }
  }
  for (let i = 0; i < details; i++) out += '\n</details>';
  return out;
}
