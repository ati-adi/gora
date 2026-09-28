// agent/jobs.ts (WP3) — the agent's scheduler jobs: run_wake (task_wait timeout), resume_run (retry_wait backoff),
// epoch_rotate (forget / wipe / incognito rotations of idle conversations), handoff_fork (warm-cache handoff note at
// lastRequestAt + 45 min). Payloads hold ids and enums only.
import type { JobResult, Services } from '../contracts/index.ts';
import { AbortedError, TransientLlmError, errorMessage } from '../kernel/errors.ts';
import type { EngineRunner } from './engine.ts';
import { HANDOFF_FORK_DELAY_MS, handoffFork } from './epochs.ts';
import type { EpochDeps } from './epochs.ts';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function registerAgentJobs(s: Services, runner: EngineRunner, epochDeps: EpochDeps): void {
  const log = s.log.child({ mod: 'agent-jobs' });

  s.scheduler.register('run_wake', async (job): Promise<JobResult> => {
    const runId = str(job.payload['runId']) ?? job.refId;
    if (!runId) return { status: 'dead', error: 'run_wake without runId' };
    await runner.wakeById(runId, { reason: 'timeout' });
    return { status: 'done' };
  });

  s.scheduler.register('resume_run', async (job): Promise<JobResult> => {
    const runId = str(job.payload['runId']) ?? job.refId;
    if (!runId) return { status: 'dead', error: 'resume_run without runId' };
    const run = s.repos.runs.get(runId);
    if (!run || run.state !== 'retry_wait') return { status: 'done' };
    runner.launch(runId);
    return { status: 'done' };
  });

  s.scheduler.register('epoch_rotate', async (job, ctx): Promise<JobResult> => {
    const convId = str(job.payload['conversationId']) ?? job.refId;
    if (!convId) return { status: 'dead', error: 'epoch_rotate without conversationId' };
    try {
      const r = await runner.rotateNow(convId);
      if (r === 'busy') return { status: 'reschedule', runAt: ctx.now + 60_000 };
      return { status: 'done' };
    } catch (e) {
      if (e instanceof TransientLlmError) return { status: 'reschedule', runAt: ctx.now + (e.retryAfterMs ?? 60_000) };
      log.error({ conv: convId, err: errorMessage(e) }, 'epoch_rotate failed');
      return { status: 'retry', error: errorMessage(e).slice(0, 200) };
    }
  });

  s.scheduler.register('handoff_fork', async (job, ctx): Promise<JobResult> => {
    const convId = str(job.payload['conversationId']) ?? job.refId;
    if (!convId) return { status: 'dead', error: 'handoff_fork without conversationId' };
    const conv = s.repos.conversations.get(convId);
    if (!conv || conv.status !== 'active' || !s.config.profile.caching) return { status: 'done' };
    const epoch = s.repos.conversations.currentEpoch(convId);
    const want = typeof job.payload['epoch'] === 'number' ? (job.payload['epoch'] as number) : epoch.epoch;
    if (epoch.epoch !== want || epoch.taint.length > 0) return { status: 'done' };
    if (conv.activeRunId) return { status: 'reschedule', runAt: ctx.now + 5 * 60_000 };
    const due = (epoch.lastRequestAt ?? 0) + HANDOFF_FORK_DELAY_MS;
    if (due > ctx.now + 1_000) return { status: 'reschedule', runAt: due };
    if (epoch.handoffMadeAt !== null && epoch.lastRequestAt !== null && epoch.handoffMadeAt >= epoch.lastRequestAt) return { status: 'done' };
    try {
      const note = await handoffFork(epochDeps, conv, epoch, { priority: 'background', signal: ctx.signal });
      if (note) s.repos.conversations.updateEpoch(convId, epoch.epoch, { handoffSummary: note, handoffMadeAt: s.clock.now() });
      return { status: 'done' };
    } catch (e) {
      if (e instanceof AbortedError) return { status: 'retry', error: 'aborted' };
      if (e instanceof TransientLlmError) return { status: 'retry', error: `transient:${e.kind}` };
      log.warn({ conv: convId, err: errorMessage(e) }, 'handoff fork failed');
      return { status: 'done' }; // rotation falls back to the deterministic seed
    }
  });
}
