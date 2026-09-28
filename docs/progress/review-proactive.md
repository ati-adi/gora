# Review: proactive (adversarial)

Started 2026-09-28. Scope: src/proactive/**, src/missions/**.
Run proofs: npx vitest run --config test/review/proactive/vitest.review.config.ts

## Findings
- F1 HIGH Stop on a budget_exhausted mission does not wake/stop its run (effective() returns run undefined for non-active/parked); once cancelled the engine's budget gate (status==='budget_exhausted') is off. Proof: test/review/proactive/missionStopBudget.test.ts (2 failing).
- F2 MEDIUM Commitments can never be closed (no writer of 'done'/'dismissed'; Do-it doesn't close; scan selects open+nudged) → same commitment re-nudged every 7 days forever, brief lists it daily. Proof: test/review/proactive/commitments.test.ts (a).
- F3 HIGH Taint laundering: business commitments (peer chat title as counterpart, triage text) → commitment_due/they_owe_stale not in UNTRUSTED_KIND → nudge_do run body trusted, no taint. Also brief 'commitments due' lines + suggestion. Proof: commitments.test.ts (b).
- F4 HIGH Semantic watcher: TransientLlmError from side.semanticCheck escapes check() → watcher_check (maxAttempts 3) dead-lettered after ~3 min of 429s; watcher stays 'active' w/o job forever; Resume no-op. Proof: test/review/proactive/watcherDeadJob.test.ts (real scheduler).
- F5 MEDIUM Watcher conditions evaluated on text truncated to 20K chars (hash on full text) → contains/absent/number_below/semantic targets beyond 20K never fire. Proof: test/review/proactive/watcherTruncation.test.ts (control with short page passes).
- F6 MEDIUM Snoozed nudge re-gated at +3h (budget/mute/backoff) → silently dropped when budget filled meanwhile. Proof: test/review/proactive/snooze.test.ts (control without budget fill passes).
- F7 MEDIUM brief job returns 'dead' for paused/blocked owner → real scheduler notifyDead → daily "couldn't complete a scheduled brief" DM to a /paused owner. Proof: test/review/proactive/briefPaused.test.ts (real scheduler).
- F8 MEDIUM (trace) Topic fallback: mission conv 'mission:M' in main DM w/o thread; surfaces/util.ts dmConversation maps to mission only via topic thread lookup → owner replies never reach the mission; task_wait(user_input) never wakes; card says "reply here to continue".
- F9 MEDIUM Watchers ignore owner status (paused / bot blocked): fetch + semantic LLM calls continue forever, results dropped by gate → shared Groq quota burn. Proof: test/review/proactive/watcherInactiveUser.test.ts.
- F10 HIGH watcher_hit goes through score backoff: after 4 un-tapped hits weight 0.6 < 0.7 → all later hits of all watchers silently dropped. Proof: test/review/proactive/watcherHitBackoff.test.ts (DB: 4 sent, 1 dropped, weight 0.6 streak 4).
- F11 LOW-MED Semantic side call returning null → recordCheck resets fail_count, keeps old hash → LLM re-called every interval forever, never paused. Proof: test/review/proactive/watcherSemanticNull.test.ts.

## Status
DONE. 11 findings, 12 failing proof tests in test/review/proactive/ (9 files) + 1 code-trace finding (F8). No production code changed.
Checked and not reported: SafeFetch/checkWatchUrl SSRF (DNS-guarded lookup, redirects re-validated, IP literals refused), nudge gate order vs §8.4, deferred-nudge dedupe, reaction weight math, scan slot windows, mission budget cap/addBudget, deterministic ids, ownership checks on ms:/wt:/ng: callbacks.

## Fixer (independent) — started 2026-09-28
- Baseline: all 12 proof tests fail as reported (9 files). F8 is a code trace.
- F1 FIXED: missions.ts stop() reads the run from conversation.activeRunId regardless of mission status (parked → wake 'cancelled', live → stopRun). Engine-side gate (end runs of non-open missions) → cross_area.
- F2 FIXED: 'Do it' on commitment_due/they_owe_stale closes the commitment (status 'done', fu: job cancelled) — nudges.ts closeCommitment. Scan selects only status 'open' commitments and marks them 'nudged' when proposed (repo.markCommitmentNudged), so one nudge per commitment. Brief lists due-today + overdue-but-never-nudged only.
- F3 FIXED: nudges.untrustedSourceOf(kind, refId): commitment kinds → 'business_peer' unless the commitment is source 'dm' (missing row → untrusted). startDo uses it (untrusted part + taint). Brief: business commitments go into an untrusted 'business commitments due' part + taint; suggestion uses untrustedSourceOf.
- F4/F9/F11/F5/F10/F6/F7 reproduced (proof tests fail as described); F8 confirmed by trace (surfaces/util.ts dmConversation maps DM→mission only via topic thread). Fixing next.
- F4 FIXED: watchers.ts check() catches semanticCheck errors (Transient/Aborted → keep old hash, move next check, no failure; other throws → counted failure); onHit errors caught; job() never throws (counts a failure instead); manage('resume') on an 'active' watcher re-arms its job (upsert revives a dead job).
- F11 FIXED: null semantic result → counted failure via shared fail() (pause + Resume notice at MAX_FAILS), old hash kept.
- F9 FIXED: check() skips fetch/LLM when owner is not active or botBlocked (repo.setNextCheck keeps cadence; resumes by itself after /resume or unblock).
- F5 FIXED: conditions evaluated on the full text; stored snapshot is condition-aware (watcherConditions.snapshotValue: needle excerpts for contains/absent/number_below, 400K head for semantic, 20K head otherwise).
- F10 FIXED: nudges.ts OWNER_REQUESTED={watcher_hit}: gate sees neutral weight/streak (no score backoff) and ignores are not penalized.
- F6 FIXED: snoozed copies get countsAgainstBudget=false and jobDeferred evaluates them with snoozeCopy (no score/dedupe/budget; quiet hours defer even low priority).
- F7 FIXED: brief job returns reschedule (next cron) for paused/blocked owners and a disabled brief; 'dead' only for missing/deleting users.
- F8 PARTIAL (in-area mitigation + cross_area): topic-less mission card no longer says "reply here" (idleNoTopic); mission_start body tells the model owner messages cannot reach it and never to task_wait on user_input. Routing + [M…] prefix need surfaces/util.ts, telegram/channels/notify.ts, trust/tools.ts (cross_area).
- Extra regressions: test/review/proactive/fixRegressions.test.ts (7 tests). Review suite: 19/19 green.
- Verification: typecheck clean in src/ (remaining errors only in other areas' review tests), unit 761/761, review/proactive 19/19, e2e 101/101. DONE.
