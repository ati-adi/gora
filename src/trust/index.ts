// trust/index.ts (WP4) — createTrustModule: sentinel, approvals, executor, undo, step-up, untrusted wrapping, grants
// and trusted targets; registers the a1:/ud: callbacks, the approval_expire job and the open-approvals context part.
import type { Services, TrustModule } from '../contracts/index.ts';
import { registerNamed } from '../kernel/registries.ts';
import { createApprovals, type ApprovalsImpl } from './approvals.ts';
import { registerTrustHandlers } from './callbacks.ts';
import { createApprovalsContext } from './context.ts';
import { createExecutor, type ExecutorImpl } from './executor.ts';
import { createGrants } from './grants.ts';
import { createTrustedTargets } from './provenance.ts';
import { createPaRepo } from './repo.ts';
import { createSentinel } from './sentinel.ts';
import { createStepUp } from './stepup.ts';
import { createUndo } from './undo.ts';
import { createUntrustedWrapper } from './untrusted.ts';

export function createTrustModule(s: Services): TrustModule {
  const pa = createPaRepo(s);
  const stepup = createStepUp(s);
  const tt = createTrustedTargets(s);
  const grants = createGrants(s, pa, () => stepup);
  const sentinel = createSentinel(s, grants, tt);
  let approvals: ApprovalsImpl | null = null;
  let exec: ExecutorImpl | null = null;
  approvals = createApprovals(s, pa, grants, () => ({ executeApproved: (id) => exec!.executor.executeApproved(id), revise: (id, input, ctx, opts) => exec!.revise(id, input, ctx, opts), isStale: (id) => exec!.isStale(id), recoverStuck: (now) => exec!.recoverStuck(now) }));
  exec = createExecutor(s, { pa, grants, tt, sentinel, approvals: () => approvals! });
  const undo = createUndo(s, () => exec!.runUndo);
  const untrusted = createUntrustedWrapper(s);

  registerTrustHandlers(s, () => approvals!);
  registerNamed(s.contextProviders, createApprovalsContext(s));

  const { sourceOf: _sourceOf, addApproved: _addApproved, ...trustedTargets } = tt;
  return {
    sentinel: sentinel.sentinel,
    approvals: approvals.service,
    executor: exec.executor,
    undo,
    stepup,
    untrusted,
    grants: grants.service,
    trustedTargets,
  };
}
