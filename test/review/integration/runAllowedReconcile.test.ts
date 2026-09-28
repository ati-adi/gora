// INTEGRATION (F2): a tool that throws on an auto-run path is reconciled like a crashed round: reconcile 'done' →
// tool_calls 'done' (ok result), 'unknown' (or an OutcomeUnknownError without reconcile) → 'unknown', 'not_done' → 'error'.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BetaToolUseBlock, ToolSpec } from '../../../src/contracts/index.ts';
import { makeEnv, signal, use, type Env } from '../../unit/trust/env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

function throwingTool(verdict: 'done' | 'not_done' | 'unknown' | null, errName = 'Error'): ToolSpec {
  return {
    name: 'note_save',
    description: 'test',
    input: z.object({ text: z.string() }),
    surfaces: ['dm', 'topic', 'mission'],
    parallelSafe: false,
    classify: () => ({ actionClass: 'write_self', risk: 1 }),
    statusLabel: () => 'Saving',
    async execute() {
      const e = new Error('socket hang up');
      e.name = errName;
      throw e;
    },
    ...(verdict ? { reconcile: async () => verdict } : {}),
  } as unknown as ToolSpec;
}

async function runOnce(spec: ToolSpec) {
  env = makeEnv([spec]);
  const u = env.addUser();
  const { conv, run } = env.addConv(u);
  const out = await env.s.executor.processRound(run, conv, 1, [use('t1', 'note_save', { text: 'x' })] as BetaToolUseBlock[], null as never, signal());
  const row = env.s.repos.runs.toolCallsFor(run.id, 1).find((r) => r.toolUseId === 't1')!;
  return { result: out.results[0]!, row };
}

describe('executor runAllowed reconciles a thrown execute (F2)', () => {
  it("reconcile 'done' → status done, not an error", async () => {
    const { result, row } = await runOnce(throwingTool('done'));
    expect(row.status).toBe('done');
    expect(result.is_error).toBeFalsy();
  });
  it("reconcile 'unknown' → status unknown", async () => {
    const { result, row } = await runOnce(throwingTool('unknown'));
    expect(row.status).toBe('unknown');
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('OUTCOME_UNKNOWN');
  });
  it("reconcile 'not_done' → status error, TOOL_FAILED", async () => {
    const { result, row } = await runOnce(throwingTool('not_done'));
    expect(row.status).toBe('error');
    expect(String(result.content)).toContain('TOOL_FAILED');
  });
  it('OutcomeUnknownError without reconcile → status unknown', async () => {
    const { row } = await runOnce(throwingTool(null, 'OutcomeUnknownError'));
    expect(row.status).toBe('unknown');
  });
  it('a plain throw without reconcile stays TOOL_FAILED / error', async () => {
    const { row } = await runOnce(throwingTool(null));
    expect(row.status).toBe('error');
  });
});
