# s07 red team progress log
- step 0: log started; read spec 07. Reading src/browser, integrations, groups.
- step 1: read browser/{netGuard,playwright,tools,tasks,detect,classify,snapshot,index}, trust/rules. Candidates:
  B1 browser_open read_public: URL query exfil of memory/user_model (mission ctx has user_model+memories+location); B2 typing non-personal memory facts = write_self on any host; ownerProvided not host-bound;
  B3 press Enter with r.focus null / Space / Tab bypass (real focus != r.focus); B4 link with url (#, javascript:) named "Confirm" never a commit; JS div role=button "Next" not commit;
  B5 select → onchange submit, WRITE_SELF no recheck; B6 Playwright route not called for redirects? (verify live); B7 WebRTC bypasses route; B8 DNS rebinding (accepted residual).
- step 2: LIVE proofs test/review/s07/browserLive.live.test.ts: 7/7 fail as predicted (redirect SSRF confirmed: guard never sees 302 target, /secret reached; autofocus Enter, Tab+Space, href=# link, select onchange all submit while classified free; keystroke beacon; WebRTC UDP to 127.0.0.1).
- step 3: dropped the planned executor-level exfil test file (write interrupted); B1/B2 reported as code trace instead. Moving to Composio.
- step 4: Composio reviewed (service/links/composio/connections): state claim once, account/user binding OK, poll stops at deadline. Candidates: bearer connect link (victim's Google on attacker's Gora user), no cap on pending links via Mini App POST /link (120 polls each), approved-by-idemKey-prefix pattern. Now groups.
- step 5: groups read (index/observe/chime/feedback/summary/catchup/names/surfaces group). Candidates: G-RET /forget всё + 14d retention miss the group conversation transcript (recentContext block copied into conversation_inputs, 90d epoch retention); G-WORDS negated louder ('не встревай чаще', "don't ... more often") → louder; catch-up gives 24h history to new members; deleted/edited messages kept.
- step 6: NOTE another agent writes test/review/s07/{browserApprovalAndQuota,catchupNewestMissing,groupRejoinAfterShred}.test.ts — not mine, untouched. My proofs: groupForgetTranscript (a fails as predicted), groupWords (4 fail). Fixing (b) text.
- step 7: PROOFS groupFactsForget (1 fail), groupCapsReset (1 fail). Next: DM<->group canary paths, privacy-mode ON storage.
- step 8: PROOF groupSummaryRetention (1 fail). Verified Playwright chromiumSandbox defaults false (launch passes none) + Chromium inherits process.env (.env via --env-file). Testing file:/data: navigation live.
- step 9: data: navigation loads without policy (file: blocked, chrome: fails). Running full proof suite + typecheck.

## Findings (run: npx vitest run --config test/review/s07/vitest.review.config.ts ; LIVE_BROWSER=1 npx vitest run --config test/review/s07/vitest.live.config.ts)
- CRIT redirect hops bypass the browser network guard (live B-NET-1).
- HIGH commit detection bypasses: autofocus Enter, Tab+Space, href=# link, select onchange (live B-COMMIT-1..4); SEARCH_RE names ("Go/Show/Далее") un-commit any form.
- HIGH injection exfil w/o approval: browser_open read_public w/ memory in mission ctx; typing = send (live B-DATA-1); ownerText not host-bound (trace).
- MED WebRTC UDP bypass (live B-NET-2); Chromium unsandboxed + inherits .env secrets (trace); DNS rebinding residual (trace).
- MED groups: transcript copies survive /forget + 14d (groupForgetTranscript 2); summary outlives 14d (groupSummaryRetention); auto facts unforgettable by members (groupFactsForget); /forget resets chime caps (groupCapsReset); negated words → louder (groupWords 4).
- LOW-MED Composio bearer connect link (trace). LOW: data: nav unguarded; group edits ignored; catch-up 24h for never-wrote members; no cap on pending links; 'pa:' idemKey approval signal.
## Status: DONE. Mine: 7 live failing + 10 failing in 6 files (groupWords control passes). Not mine in s07/: browserApprovalAndQuota, catchupNewestMissing, groupRejoinAfterShred. No production code changed.
