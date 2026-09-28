# Review: trust

Started 2026-09-28. Adversarial review of src/trust/**. Run proofs: npx vitest run --config test/review/trust/vitest.review.config.ts

## Findings
- [F1 high] provenance.ts containsValue substring match: owner typed anna@acme.co.uk → attacker anna@acme.co resolves 'user', skips S13, stored as trusted user_message. Proof: test/review/trust/provenanceSubstring.test.ts (FAILS as expected).
- [F2 medium] redact.ts gaps: "G-123456 … verification code", "code:123456", access_token=/client_secret:/GITHUB_TOKEN= (\b vs '_'), JWT signature kept. Proof: test/review/trust/redactionGaps.test.ts (6 FAIL).
- [F3 high] executor.supersedeWith: new card built with stale storedTargets + T01 warnings [] (never re-evaluated) → new recipient never provenance-checked; S13/L01 warnings dropped. Proof: test/review/trust/supersedeStaleTargets.test.ts (2 FAIL).
- [F4 medium] rows stuck in approved/executing after crash/restart mid-executeApproved: no recovery, re-tap already_handled, sweeps only 'pending'. Proof: test/review/trust/stuckApproved.test.ts (2 FAIL).
- [F5 medium] trust/context.ts: open-approval lines put diff.summary (third-party text: calendar invite titles, email subjects) unwrapped into the <gora_context> operator row of EVERY dm/topic/mission run of the owner (all conversations), without taint. Proof: test/review/trust/approvalsContextLaundering.test.ts
- [F6 medium] untrusted.wrap / kernel neutralizeReservedTags: '</untrusted​>', '<​/untrusted>', fullwidth '＜/untrusted＞' survive → early close after NFKC/Cf-strip. Proof: test/review/trust/wrapperUnicodeEscape.test.ts (3 FAIL).
- [F7 medium] approvals.resolve(editedInput) revises + immediately approves: TOCTOU compares to the just-rendered diff, not the one the owner saw; remote changes (new attendee) + new S13 warnings executed unseen. Proof: test/review/trust/editApproveToctou.test.ts
- [F8 low] rules.ts first-match: S10/S11/S12 return ask with warnings [] before S13 → injected recipient in a bulk send / destructive notify gets no provenance warning. Proof: test/review/trust/firstMatchHidesProvenance.test.ts (2 FAIL).
- [F9 low] step-up grant not bound to pending action: phrase 'ALWAYS ANNA' mints grant usable by createAlways for bob. Proof: test/review/trust/stepupNotBound.test.ts
- [F10 high] server-tool taint (web_search/web_fetch_tool_result) added in engine.afterRound AFTER processRound decided the same message's tool calls → S14/LLM Sentinel/ctx.taint see untainted. Proof: test/review/trust/serverToolTaintLate.test.ts (tainted=0).
- [F11 high] executor.finishInterruptedRound drops taint of calls finished before a crash/shutdown (and engine.stopDuringTools never adds out.taintAdded) → wrapped email in history, epoch untainted. Proof: test/review/trust/recoveryDropsTaint.test.ts

## Done (2026-09-28)
11 findings, 21 failing proof tests across 11 files in test/review/trust/. No production code changed. Checked and found sound: callback MAC binding (codec binds kind+parts+owner; resolve re-checks the owner), CAS pending→approved→executing (no double execution across callback/Mini App/revise races), replay after supersede/revise, 24h scope re-checked server-side, LLM Sentinel only tightens (allow→ask) and fails closed on error/timeout/invalid output, undo exactly-once.

## Fixer pass (2026-09-28)
- Baseline: all 11 proof files / 21 tests fail as reported (reproduced).
- TRUST-03 FIXED: provenance.ts ownerWroteTarget() — whole-target membership via extractOwnerTargets (email/@handle/phone), token-bounded fallback for other kinds. Untrusted check stays substring (only picks 'untrusted' vs 'unknown'; both ask S13).
- TRUST-10 FIXED: rules.ts attaches S13 provenance warnings to S10/S11/S12 asks; first-match still decides rule/grantability.
- TRUST-08 FIXED (in trust): untrusted.ts neutralizeLookalikeTags() folds each '<'/'＜'/'﹤' candidate (NFKC, Cf stripped) and neutralizes reserved names; applied to text and label. kernel/tags.ts itself (used by other paths) listed as cross_area.
- TRUST-09 FIXED: redact.ts — code look-behind allows letter+':'/'-' prefix; secret words bounded by alphanumerics only ('_' separates); JWT rule + bearer b64token rule.
- TRUST-01 FIXED (in trust, no engine change needed): executor.processRound reads the stored assistant row (seq) and seeds the round's taint with serverToolTaint (web_search/web_fetch results) + persists it; finishInterruptedRound does the same (resume path had msg=null). Engine-side cleanup listed as cross_area (optional).
- TRUST-02 FIXED: finishInterruptedRound re-derives taint from stored results (taintOfStoredResult parses <untrusted source=…>); runAllowed persists run+epoch taint immediately via persistTaint, so user Stop (engine.stopDuringTools, no addTaint) and shutdown can no longer lose it. Added regression test in recoveryDropsTaint.test.ts.
- TRUST-06 FIXED (trust part): context.ts lines are code-owned (id, tool, recipient count, this/another conversation, expiry); approvals.notify event text uses tool_name + code-only verb. agent/epochs.ts seed line listed as cross_area. Proof test fixed (parts() takes 3 args).
- TRUST-11 FIXED: stepup.ts phrase grants carry a keyed tag of their phrase in the id (no schema change); consume(user, id, expectedPhrase) checks it; grants.createAlways passes expectedPhrase(first target of the target action). Biometric stays unbound. Stronger per-action binding (pendingActionId) would need a contract/route change → cross_area (optional).
- TRUST-04 FIXED: executor prepare()/freshDiff() re-resolve targets (spec.targets + epoch provenance) into the TOCTOU diff/HMAC; supersedeWith runs decide(propose) on the changed action (deny → blocked) and merges its warnings + the original row's warnings + "draft changed"; afterExecuted records fresh targets.
- TRUST-05 FIXED: repo.stuck() + executor.recoverStuck() run from approvals.expireDue (boot +60 s and cron sweep): 'approved' → executeApproved while unexpired (idemKey pa:<id>), else failed; 'executing' → spec.reconcile or 'unknown'; card edited + run notified. In-process inFlight set prevents racing a live execution; threshold STUCK_AFTER_MS=10 min.
- TRUST-07 FIXED: approvals.resolve(editedInput) checks v1 staleness (isStale) before revising; stale or new warnings on v2 → v2 stays pending for review (status 'superseded'); Mini App edited values count as owner text for provenance so a typed recipient does not trip S13.
- All 11 proof files green (22 tests).
- Regression tests added: recoveryDropsTaint (persisted taint), editApproveToctou (+2: clean edit still one-step; changed edit waits with warnings), stuckApproved (+1: approved row executes exactly once after 10 min), redactionGaps (+4 negatives). Updated existing expectations for code-owned conv_events text: test/unit/trust/executor.test.ts, test/e2e/approvals.e2e.test.ts.
- Moved recoverStuck AFTER the expiry loop in expireDue (awaiting before it let business_window void a just-expired row first; business e2e).
- Final: tsc clean in trust (only error: test/review/tools/placePrivacy.test.ts, not ours); unit trust 92/92; review/trust 29/29; e2e 100/101 — the 1 failure (memory incognito) comes from the memory fixer's concurrent incognito changes (no taint/trust involvement). Foundation unit failures (config/freeze/kernel lockfile/importRules http ledger) belong to other areas' in-progress edits.
- (update) tsc --noEmit now fully clean.
