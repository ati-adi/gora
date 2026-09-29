# s07 skeptic log

- step 0: started; reading spec 07, 08 plan, builder logs
- step 1: read spec 07, plan 08, BR/CAL/GR sources. candidates: quota_browser string missing; approval after 15-min idle close fails; group DEK shred on rejoin breaks storage; catchup 2000-oldest cap; COMMIT_RE lacks "Записаться"
- step 2: test/review/s07/browserApprovalAndQuota.test.ts written; both fail as predicted (control with 1-min delay passes; PA expires in 7 days, status failed, context closed)
- step 3: groupRejoinAfterShred + catchupNewestMissing written; both fail (DekDestroyedError confirmed; catch-up prompt ends at MSG-1999)
- step 4: commitVerbsRu.test.ts written; 3 fail (Записаться / Complete registration → read_public)
- step 5: pressFocusedCommit.test.ts written; Space/Enter on focused commit button → read_public (2 fail)
- step 6: netGuardRedirect.live.test.ts (opt-in LIVE_BROWSER=1) fails: context.route not called for redirect targets (doc + subresource); verified with Chromium
- step 7: checked CAL (REST shapes/slugs vs 08 §4.2-4.3 OK; poll/callback exactly-once OK; resume OK), migration 004 test passes, delete/export/retention wiring present, app.ts wiring real (no stubs reachable), typecheck clean. Noted overlap with s07-redteam (redirect, press/focus).
## Findings (proofs in test/review/s07/: browserApprovalAndQuota, groupRejoinAfterShred, catchupNewestMissing, commitVerbsRu, pressFocusedCommit, netGuardRedirect.live [LIVE_BROWSER=1])
- CRIT redirect hops bypass the network guard (live proof)
- HIGH approval tapped >15 min after the card always fails (sweep idle-closes the context while waiting on the approval)
- HIGH Space/Enter on the real focused commit button = unapproved commit (classifier uses bookkeeping focus, Enter only)
- HIGH re-added group after 7-day shred: nothing stored ever again (DekDestroyedError on g:<chatId>), policy purged every sweep
- MED SURF.quota_browser missing → quotaExceeded throws; BR e2e swallows it
- MED «Записаться» / "Complete registration" not commit verbs → unapproved JS-button booking
- MED catch-up uses the OLDEST 2000 messages then slice(-150): newest missing
- LOW superseded card has no screenshot; chime heuristic ignores `addressed` (double answer on slow addressed runs); sweep maps a missed cancelled mission to 'interrupted'
## Status: DONE. No production code changed.
