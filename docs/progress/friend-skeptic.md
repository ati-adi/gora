# friend-skeptic progress log
- step 0: read spec 05. Starting review of the 9 check areas.
- step 1: read migration 003 + migrations.test (003-on-001+002 covered), behaviour (bandit/rhythm/signals/policy/index), memory retrieval/profile/consolidation triggers, tz.ts + executor tz hint, onboarding /start, USER_DATA_TABLES, app.ts wiring.
  Suspects: (a) pre-003 users have no signals -> treated as never-wrote -> first_hint; (b) rhythm hist binned in the tz at write time, never re-binned on tz change (lazy tz makes that common). Writing proofs in test/review/friend/.
- step 2: proofs written: test/review/friend/preMigrationFirstHint.test.ts (FAILS, first_hint for pre-003 users), rhythmTzChange.test.ts (FAILS, pReal 0.009 < pGhost 0.32). Other files in test/review/friend are redteam's.
- step 3: proof blockedStatusSticks.test.ts FAILS {status blocked, miniApp 403, sentinel paused} after unblock. Checked tz hint (single gate tzHintAt, OK), consolidation triggers (OK), USER_DATA_TABLES (OK), wiring in app.ts (OK), budget map (OK).
- step 4: city regex false positives (Love/Slack/Chrome/Trouble -> geocoder, first hit accepted, no feature filter). Math.random none in src. Composing final report.
- step 5: DONE. Findings reported via StructuredOutput: 4 failing proofs in test/review/friend/{preMigrationFirstHint,rhythmTzChange,blockedStatusSticks}.test.ts (+ city regex trace, compact prompt gap, live-DB 003 drift risk).
