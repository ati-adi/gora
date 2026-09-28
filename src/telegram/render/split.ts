// telegram/render/split.ts (WP2) — splits Rich Markdown into messages of ≤ 30 000 chars and ≤ 450 blocks (01 §11.4 step 6,
// F2 "split at 30 000 chars or 450 blocks"). Cuts prefer blank-line boundaries, never break a fenced code block without
// closing and reopening it, and close/reopen open <details> sections across a cut.
//
// A cut can still change how the text around it parses (a multi-line code span, a fence inside a blockquote or list item
// cut in two), so when a message IS split every part is re-sanitized on its own (review F12): nothing that was literal
// code in the whole message can become live markup in a part. Pieces of one over-long paragraph that land in the same
// part are re-joined with a single newline, never a blank line.
import { resanitizePart } from './sanitize.ts';

export const SPLIT_MAX_CHARS = 30_000;
export const SPLIT_MAX_BLOCKS = 450;

/** `cont`: the piece continues the previous piece of the same paragraph. */
interface Unit { text: string; blocks: number; code: boolean; cont?: boolean }

export function splitMarkdown(md: string, o: { maxChars?: number; maxBlocks?: number } = {}): string[] {
  const maxChars = o.maxChars ?? SPLIT_MAX_CHARS;
  const maxBlocks = o.maxBlocks ?? SPLIT_MAX_BLOCKS;
  const text = md.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  if (text.length <= maxChars && countBlocks(text) <= maxBlocks) return [text];

  const units: Unit[] = [];
  for (const u of toUnits(text)) for (const piece of shrink(u, Math.floor(maxChars * 0.9), Math.floor(maxBlocks * 0.9))) units.push(piece);

  const chunks: string[] = [];
  let cur: string[] = [];
  let curChars = 0;
  let curBlocks = 0;
  const openDetails: string[] = []; // summary label of each open <details> at the end of the current chunk
  let reopen = '';
  const closeFor = (n: number) => '\n' + '</details>\n'.repeat(n).trimEnd();
  const flush = () => {
    if (!cur.length) return;
    let body = cur.join('\n\n');
    if (openDetails.length) body += closeFor(openDetails.length);
    chunks.push(body);
    reopen = openDetails.map((label) => `<details><summary>${label}</summary>`).join('\n');
    cur = reopen ? [reopen] : [];
    curChars = reopen.length;
    curBlocks = openDetails.length;
  };
  for (const u of units) {
    const reserve = openDetails.length * 12 + 64;
    if (cur.length && (curChars + u.text.length + 2 + reserve > maxChars || curBlocks + u.blocks > maxBlocks)) flush();
    if (u.cont && cur.length && cur[cur.length - 1] !== reopen) cur[cur.length - 1] += `\n${u.text}`;
    else cur.push(u.text);
    curChars += u.text.length + 2;
    curBlocks += u.blocks;
    if (!u.code) trackDetails(u.text, openDetails);
  }
  if (cur.length && !(cur.length === 1 && cur[0] === reopen)) {
    const body = cur.join('\n\n');
    chunks.push(body);
  }
  const parts = chunks.filter((c) => c.trim().length > 0);
  return parts.length > 1 ? parts.map((p) => resanitizePart(p, text).trim()).filter((p) => p.length > 0) : parts;
}

/** Conservative block count: a fenced code block is one block; every other non-empty line counts as one. */
export function countBlocks(md: string): number {
  let n = 0;
  let inFence: string | null = null;
  for (const line of md.split('\n')) {
    if (inFence) {
      if (new RegExp(`^ {0,3}${inFence[0] === '`' ? '`' : '~'}{${inFence.length},}\\s*$`).test(line)) inFence = null;
      continue;
    }
    const o = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (o) {
      inFence = o[1]!;
      n++;
      continue;
    }
    if (line.trim()) n++;
  }
  return n;
}

function toUnits(text: string): Unit[] {
  const lines = text.split('\n');
  const units: Unit[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) units.push({ text: para.join('\n'), blocks: para.filter((l) => l.trim()).length, code: false });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const o = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (o) {
      flushPara();
      const fence = o[1]!;
      const block = [line];
      let j = i + 1;
      for (; j < lines.length; j++) {
        block.push(lines[j]!);
        const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!);
        if (c && c[1]![0] === fence[0] && c[1]!.length >= fence.length) break;
      }
      units.push({ text: block.join('\n'), blocks: 1, code: true });
      i = j;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  return units;
}

/** Breaks a unit that alone exceeds the limits: code blocks are re-fenced per piece, text is cut at lines / spaces. */
function shrink(u: Unit, maxChars: number, maxBlocks: number): Unit[] {
  if (u.text.length <= maxChars && u.blocks <= maxBlocks) return [u];
  if (u.code) {
    const lines = u.text.split('\n');
    const open = lines[0]!;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(open)![1]!;
    const body = lines.slice(1, lines.length - (/^ {0,3}(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1]!) && lines.length > 1 ? 1 : 0));
    const out: Unit[] = [];
    let cur: string[] = [];
    let size = 0;
    const room = maxChars - open.length - fence.length - 4;
    for (const l of hardWrap(body, room)) {
      if (cur.length && size + l.length + 1 > room) {
        out.push({ text: `${open}\n${cur.join('\n')}\n${fence}`, blocks: 1, code: true });
        cur = [];
        size = 0;
      }
      cur.push(l);
      size += l.length + 1;
    }
    if (cur.length) out.push({ text: `${open}\n${cur.join('\n')}\n${fence}`, blocks: 1, code: true });
    return out;
  }
  const out: Unit[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const l of hardWrap(u.text.split('\n'), maxChars)) {
    if (cur.length && (size + l.length + 1 > maxChars || cur.length + 1 > maxBlocks)) {
      out.push({ text: cur.join('\n'), blocks: cur.length, code: false, cont: out.length > 0 });
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += l.length + 1;
  }
  if (cur.length) out.push({ text: cur.join('\n'), blocks: cur.length, code: false, cont: out.length > 0 });
  return out;
}

/** Lines longer than `max` are cut at the last space before the limit (or hard at the limit). */
function hardWrap(lines: string[], max: number): string[] {
  const out: string[] = [];
  for (let l of lines) {
    while (l.length > max) {
      let cut = l.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      // never cut inside a surrogate pair
      const code = l.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
      out.push(l.slice(0, cut));
      l = l.slice(cut).replace(/^ /, '');
    }
    out.push(l);
  }
  return out;
}

function trackDetails(text: string, open: string[]): void {
  const re = /<details(?:\s[^>]*)?>\s*(?:<summary>([\s\S]*?)<\/summary>)?|<\/details\s*>/gi;
  for (const m of text.matchAll(re)) {
    if (m[0].startsWith('</')) open.pop();
    else open.push(`${(m[1] ?? '').trim() || '…'} (cont.)`.replace(/(?: \(cont\.\))+$/, ' (cont.)'));
  }
}
