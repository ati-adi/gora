// INTEGRATION (F4): S06 checks cls.quotaKind, so a successful execution must spend it (web_search / web_fetch / make_file
// were checked but never consumed). A failed execution (isError) spends nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BetaToolUseBlock, ToolSpec } from '../../../src/contracts/index.ts';
import { makeEnv, signal, use, type Env } from '../../unit/trust/env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const fileTool = (isError: boolean): ToolSpec =>
  ({
    name: 'make_file',
    description: 'test',
    input: z.object({ text: z.string() }),
    surfaces: ['dm', 'topic', 'mission'],
    parallelSafe: false,
    classify: () => ({ actionClass: 'compute', risk: 0, quotaKind: 'file' }),
    statusLabel: () => 'Making',
    execute: async () => ({ content: isError ? 'bad' : 'ok', ...(isError ? { isError: true } : {}) }),
  }) as unknown as ToolSpec;

describe('executor consumes the classified quota (F4)', () => {
  it('a successful make_file spends one file unit; a failed one spends none', async () => {
    for (const [isError, want] of [[false, 1], [true, 0]] as const) {
      env = makeEnv([fileTool(isError)]);
      const u = env.addUser();
      const { conv, run } = env.addConv(u);
      await env.s.executor.processRound(run, conv, 1, [use('t1', 'make_file', { text: 'x' })] as BetaToolUseBlock[], null as never, signal());
      expect(env.s.quotas.view(u.id).file.used).toBe(want);
      env.close();
      env = null;
    }
  });
});
