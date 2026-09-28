// PROOF (agent review): an unexpected exception in a tool round (engine.ts toolRound(): `if (!out) throw err`) reaches
// drive()'s crash handler, whose ensureAssistantLast() does nothing when the last row is the assistant tool_use row
// (`last.role === 'assistant'` → return). The run is marked failed with an UNANSWERED tool_use as the epoch's last row
// (G3/G6 broken). Every later run then appends its user_input row after that tool_use row → GrammarError G3 inside
// start() → crash path again, which also marks the owner's new inputs consumed. The conversation is bricked: each new
// message gets "failed", and the message itself is silently dropped.
import { afterEach, describe, expect, it } from 'vitest';
import { checkEpochGrammar } from '../../../src/agent/grammar.ts';
import { say, turn } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp, rowsOf, userSays } from './_app.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('crash during a tool round', () => {
  it('leaves a well-formed transcript so the next message is answered', async () => {
    const x = await agentApp();
    app = x.t;
    const ex = x.t.s.executor as unknown as { processRound: (...a: unknown[]) => Promise<unknown> };
    const orig = ex.processRound.bind(ex);
    ex.processRound = async () => {
      throw new Error('SQLITE_BUSY: database is locked'); // any unexpected failure inside the round
    };
    x.t.llm.push(turn().toolUse('weather_get', { place: 'Almaty' }).stop('tool_use'));
    await userSays(x.t, x.conv, 'weather in Almaty?');
    ex.processRound = orig; // the transient problem is gone
    expect(checkEpochGrammar(rowsOf(x.t, x.conv)), 'grammar after the crashed run').toEqual([]);
    const last = rowsOf(x.t, x.conv).at(-1)!;
    expect.soft(last.hasClientToolUse, 'epoch must not end with an unanswered tool_use').toBe(false);
    x.t.llm.push(say('Hello again!'));
    await userSays(x.t, x.conv, 'hi');
    const texts = JSON.stringify(rowsOf(x.t, x.conv).map((r) => r.content));
    expect(texts).toContain('Hello again!');
  });
});
