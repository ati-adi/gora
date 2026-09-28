// agent/groq/budget.ts (WP3) — 03 R6 daily degrade (LlmBudget) and the governance factory.
// At ≥ 85% of the main model's RPD, proactive and background work pauses; at ≥ 97% only interactive calls run.
// The scheduler asks allow(JOB_LLM_PRIORITY[kind]) before claiming a job.
import type { LlmBudget, LlmGovernance, Priority, Services } from '../../contracts/index.ts';
import { createRateDailyRepo } from './repo.ts';
import { createRateGovernor, passThroughGovernor } from './rate.ts';
import type { RateGovernorImpl } from './rate.ts';

export function budgetAllows(p: Priority, use: number, proactiveAt: number, interactiveOnlyAt: number): boolean {
  if (use >= interactiveOnlyAt) return p === 'interactive';
  if (use >= proactiveAt) return p !== 'proactive' && p !== 'background';
  return true;
}

export function createGroqBudget(gov: RateGovernorImpl, mainModel: string, t: { proactiveAt: number; interactiveOnlyAt: number }): LlmBudget {
  return {
    allow: (p) => budgetAllows(p, gov.dailyUse(mainModel), t.proactiveAt, t.interactiveOnlyAt),
    snapshot: () => gov.snapshot(),
  };
}

export function alwaysAllowBudget(): LlmBudget {
  return { allow: () => true, snapshot: () => ({}) };
}

/**
 * The governor is real whenever Groq is in play (the groq profile, or a Groq key used by the Groq capabilities on the
 * anthropic profile); the daily budget gates work only on the groq profile. Anthropic/demo without a Groq key: a
 * pass-through governor and an always-allow budget.
 */
export function createLlmGovernance(s: Services): LlmGovernance {
  const cfg = s.config;
  const groqInPlay = cfg.profile.provider === 'groq' || !!s.groq;
  if (!groqInPlay) return { governor: passThroughGovernor(), budget: alwaysAllowBudget() };
  const gov = createRateGovernor({
    clock: s.clock,
    log: s.log.child({ mod: 'rate' }),
    repo: createRateDailyRepo(s.db),
    tier: cfg.groq.tier,
    models: cfg.groq.models,
    interactiveWaitMs: cfg.limits.groqInteractiveWaitMs,
    busyWaitMaxMs: cfg.limits.groqBusyWaitMaxMs,
  });
  const budget = cfg.profile.provider === 'groq'
    ? createGroqBudget(gov, cfg.profile.models.main, { proactiveAt: cfg.limits.groqDegradeProactiveAt, interactiveOnlyAt: cfg.limits.groqDegradeInteractiveOnlyAt })
    : { allow: () => true, snapshot: () => gov.snapshot() };
  return { governor: gov, budget };
}
