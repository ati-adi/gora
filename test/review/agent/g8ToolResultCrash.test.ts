// PROOF (agent review): G8 (grammar.ts rowViolations: no Telegram file URL / bot-token-like string in any row) is enforced
// as a hard append failure, but third-party TOOL OUTPUT is never scrubbed for it (trust/redact.ts leaves the URL as is).
// A web page / search answer / e-mail that quotes Telegram's documented download URL
// "https://api.telegram.org/file/bot<token>/<file_path>" makes afterRound()'s tool_results append throw GrammarError;
// the run crashes with the assistant tool_use as the last row, and (see toolRoundCrashBricks) the conversation is bricked:
// every later message fails. Externally triggerable by content, not by a bug.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolSpec } from '../../../src/contracts/index.ts';
import { redact } from '../../../src/trust/redact.ts';
import { say, turn } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp, rowsOf, userSays } from './_app.ts';

const PAGE = 'Download: use https://api.telegram.org/file/bot<token>/<file_path> where <file_path> is taken from the getFile response.';
const webFetch: ToolSpec = {
  name: 'web_fetch', description: 'Fetch a page.', input: z.object({ url: z.string() }), surfaces: ['dm', 'topic', 'mission'], parallelSafe: true,
  classify: () => ({ actionClass: 'read_public', risk: 0 }), statusLabel: () => 'fetch',
  execute: async () => ({ content: redact(PAGE) }), // the executor's redaction does not touch it
} as unknown as ToolSpec;

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('G8 content in a tool result', () => {
  it('does not crash the run or brick the conversation', async () => {
    expect(redact(PAGE)).toContain('api.telegram.org/file');
    const x = await agentApp({ specs: [webFetch] });
    app = x.t;
    x.t.llm.push(turn().toolUse('web_fetch', { url: 'https://core.telegram.org/bots/api#getfile' }).stop('tool_use'), say('Use getFile, then download from the file endpoint.'));
    await userSays(x.t, x.conv, 'how do I download a file with the Bot API?');
    let texts = JSON.stringify(rowsOf(x.t, x.conv).map((r) => r.content));
    expect.soft(rowsOf(x.t, x.conv).at(-1)!.hasClientToolUse, 'epoch left ending in an unanswered tool_use').toBe(false);
    expect.soft(texts, 'first answer').toContain('Use getFile');
    x.t.llm.push(say('Sure, anything else?'));
    await userSays(x.t, x.conv, 'thanks');
    texts = JSON.stringify(rowsOf(x.t, x.conv).map((r) => r.content));
    expect(texts, 'the next message is answered').toContain('Sure, anything else?');
  });

  it('a model answer that quotes the documented Bot API file URL is delivered, not turned into a failed run', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(say('Call getFile, then GET https://api.telegram.org/file/bot<token>/<file_path>.'));
    await userSays(x.t, x.conv, 'how do I download a file with the Bot API?');
    const texts = JSON.stringify(rowsOf(x.t, x.conv).map((r) => r.content));
    expect(texts).toContain('Call getFile');
  });
});
