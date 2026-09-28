- 17:17 started WP6b; read 04. Next: read contracts + spec sections.
- read: 04, contracts (all), 01 §2 F10/F11/§2.17, §4.1-4.5, §5.1/5.4-5.11, §6 tools, §7.1 DDL (my tables), §7.2, §8, §9, §11.5-11.9, §15.2, §16; 03 fully.
PLAN (files):
  proactive/: repo.ts (nudges, nudge_prefs, commitments SQL) · nudgeGate.ts (pure gate) · nudges.ts (NudgeService, send, outcomes, jobs nudge_ignore/nudge_deferred) · signals.ts (scan: commitment_due, they_owe_stale, unanswered_business, calendar_conflict, inbox_important, date_from_memory; sys job proactive_scan every 30 min UTC, per-user local slots 09:30/13:30/18:30) · brief.ts (BriefService, job brief cron per user dedupe brief:<userId>) · commitments.ts (CommitmentService + followup_due) · callbacks.ts (ng:) · context.ts (budget) · index.ts (factory, privacy hook)
  missions/: repo.ts (missions, watchers SQL) · missions.ts (MissionService) · statusCard.ts (render + 3s coalesced edits) · watchers.ts (WatcherService + watcher_check job) · watcherConditions.ts (pure: html→text, hash, conditions, number_below) · tools.ts (5 tools) · callbacks.ts (ms:, wt:) · context.ts (mission/open) · index.ts (factory, quota counters, privacy hook, run hook)
  ids: missions 'M'+7 base32 (deterministic from idemKey sha256 in tools), watchers 'W'+7, nudges n_<ulid>, commitments cm_<ulid>.
  park detection: setStatusLine → coalesced card refresh reads run state; RunHook on mission conv done → parked.
  tests: unit proactive/{nudgeGate,nudges,commitments,signals,brief}, missions/{conditions,missions,watchers,tools}; e2e nudges/missions with pinned fakes (fake scheduler, fake runner/conversations, fake tg module with recording topics).
- RESTART #1 (context lost): found nudgeGate.ts (done, pure gate) + watcherConditions.ts (done). Re-read 04/contracts/§8.4/§8.5/F10/F11/§5.5-5.7/§6 rows/03. Real scheduler (WP6a) computes cron runAt when runAt<=0; fake scheduler does not -> compute runAt myself (croner).
DESIGN: nudge ids n_<ulid>; mission ids 'M'+6 base32 (hash of userId|idemKey in tool, internals via WeakMap<Services,…> in missions/internal.ts); watchers 'W'+6.
  default mission budget = 50% plan max, +Budget adds 25% plan max up to plan max; budget park token 'budget:<M>' woken by addBudget.
  proactive_scan = sys cron */30 UTC, per-user local slots 09:30/13:30/18:30 window 30 min; dedupe keys make rescans harmless.
  brief job per user dedupe 'brief:<userId>' cron 'M H * * *' tz; handler self-heals tz change, skips >2h late, checks llmBudget.allow('proactive').
  watcher_check job per watcher dedupe 'wch:<W>' returns reschedule; semantic only when hash changed and llmBudget.allow('background').
NEXT: proactive/repo.ts -> nudges.ts -> commitments.ts -> signals.ts -> brief.ts -> callbacks/context/index; then missions/*; then tests.
- RESTART #2: found proactive/repo.ts (226 lines), nudgeGate.ts, watcherConditions.ts. Re-reading.
- RESTART #3: found proactive/{repo,nudgeGate,index}.ts, missions/{index,tools,watcherConditions}.ts. Re-reading.
- R3 plan: write proactive/nudges.ts (service+jobs nudge_deferred/nudge_ignore+ng callback+sent hook) next; then commitments, signals, brief, index.
- nudges.ts + util.ts written (typecheck clean). Next: commitments.ts
- commitments.ts, signals.ts written (clean). Next: brief.ts then proactive/index.ts
- brief.ts written. Next: proactive/index.ts (factory: jobs, callbacks ng, sent hook, privacy hook, sys:proactive_scan)
- proactive/index.ts written. Proactive src DONE (pending tests). Next: missions/repo.ts
- MISSIONS DESIGN (R3): checklist_enc = sealed JSON {items,note}; status card edits coalesced 3s via clock timer (in-memory statusLine map);
  parked derived from conv.activeRunId→run.state (persisted when seen); stop: parked→wake(each wakeOn token,'cancelled') else stopRun; chargeCost→budget_exhausted + card [➕ Budget][⏹ Stop];
  addBudget +25% plan max (cap plan max) → wake('budget:M') or startEventRun continue; tools use WeakMap<Services,internals> (missions/internal.ts) for deterministic ids.
  watchers: job 'watcher_check' dedupe 'wch:<W>' returns reschedule; failures≥5 → paused + DM notice [Resume]; hit → wake('watcher:W') else nudge watcher_hit budget-exempt.
- missions/repo.ts written. Next: missions/internal.ts + missions.ts (service + status card)
- missions/internal.ts + missions.ts (service, card, budget, stop) written. Next: watchers.ts
- watchers.ts written (clean). Next: missions/tools.ts, callbacks+context+index
- missions/tools.ts written. Next: missions/index.ts (callbacks ms/wt, context provider, run hook, quota counters, privacy hook)
- missions/index.ts written. ALL SRC DONE. Next: tests (unit proactive/missions, e2e nudges/missions)
- TESTS plan: helper test/unit/proactive/wp6bHarness.ts (pinned fakes: fake scheduler/quotas/ledger/strings/caps, TestRunner over real runs repo, test conversations, recording topics). Then e2e nudges, e2e missions, unit tests.
- test/unit/proactive/wp6bHarness.ts + test/e2e/nudges.e2e.test.ts GREEN (8). Next: test/e2e/missions.e2e.test.ts
- test/e2e/missions.e2e.test.ts written (6 tests). Next: unit tests proactive/{nudgeGate,commitments,signals,brief} missions/{conditions,watchers,tools}
- unit nudgeGate + watcherConditions tests green. Next: unit commitments/signals/brief + missions/watchers
- unit commitments(5)+signals(5) green. Next: unit brief, missions/watchers, missions/missions
- unit brief(4) + missions/watchers(5) green. Next: test/unit/missions/missions.test.ts (tools meta, card coalescing, report throttle, quota, budget cap, context, export)
- unit missions(6) green. Next: full gate (typecheck + all my tests)
- GATE GREEN: typecheck clean for my paths; unit 51 + e2e 14 pass. Scoped timer cleanup on delete. Remaining: final answer.
