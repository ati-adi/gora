// PROOF (agent review): 01 §5.7 Stop maps the draft to its run via runner.stopByDraft(), which only searches the
// in-memory `live` map. A run in retry_wait (LLM busy → "retrying…" status on the draft, which Telegram keeps for ~30 s
// with its Stop button) is not live, so the owner's Stop is ignored (returns false) and the resume_run job later answers
// anyway. runs.draft_id is persisted but never consulted; stopRun() would handle retry_wait if it were reached.
import { afterEach, describe, expect, it } from 'vitest';
import { say, turn } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp, userSays } from './_app.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('Stop while the run waits to retry', () => {
  it('pressing Stop on the draft cancels a retry_wait run', async () => {
    const x = await agentApp();
    app = x.t;
    x.t.llm.push(turn().error('rate_limit'), say('Late answer after Stop.'));
    await userSays(x.t, x.conv, 'what is the capital of France?');
    const runId = x.t.s.repos.conversations.get(x.conv.id)!.activeRunId!;
    const run = x.t.s.repos.runs.get(runId)!;
    expect(run.state).toBe('retry_wait');
    expect(run.draftId).not.toBeNull();
    const stopped = await x.runner.stopByDraft(1001, 0, run.draftId!); // the owner presses Stop on the "retrying…" draft
    expect.soft(stopped, 'stopByDraft found the run').toBe(true);
    await x.t.advance(20_000); // resume_run fires
    expect(x.t.s.repos.runs.get(runId)!.state).toBe('cancelled');
  });
});
