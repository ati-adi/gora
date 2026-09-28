# friend-redteam progress log (privacy/creepiness red team)

- step 0: log started; read spec 05. Reading src/behaviour, src/memory/{profile,vectors,consolidate}, proactive.
- step 1: read behaviour/{policy,signals,repo,compose,index}, memory/{profile,consolidate,profileRepo,store forget}. Candidates: hard-stop & first_hint reset by 90d retention; forget wipes Mini App removals; proactive_log text survives forget; no deterministic sensitive filter on draft/turns.
- step 2: more candidates: date_from_memory nudge ignores sensitivity (proactive/signals.ts:206); '</data>' not neutralized in compose/judge; looksSensitive prefix-only gaps. Writing proofs in test/review/friend/.
- step 3: PROOF retentionResetsStops.test.ts (2 failing): hard stop resets after 90d sweep (decision becomes send:true above_tau); first_hint cap resets after log pruning.
- step 4: PROOF sensitiveDateNudge.test.ts (1 failing + control): sensitive date fact sent as Gora-first date_from_memory nudge.
- step 5: PROOF profileRemovals.test.ts (2 failing): forget wipes Mini App removals (item resurrected); Mini App delete leaves fact in <user_model> and re-sends deleted text to LLM.
- step 6: PROOF forgetProactiveLog.test.ts (1 failing): forgotten fact text persists in proactive_log; re-sent to judge LLM + in export.
- step 7: PROOF composeJudgeGuards.test.ts (3 failing): </data> breakout; looksSensitive misses 20/21; sensitive draft sent (no output filter).
- step 8: PROOF unrequestedNudgeHardStop.test.ts (1 failing). Checked: USER_DATA_TABLES has all 003 tables; forget deletes vectors in tx; embedMissing re-checks; budget gate pauses 'proactive' at 85%. Next: expired TTL mood facts persisting in card.
- step 9: PROOF expiredMoodInCard.test.ts (1 failing). Math.random: none in src (comments only).
- step 10: note: another agent (friend-skeptic) also writes into test/review/friend/ (preMigrationFirstHint, rhythmTzChange) — not mine, untouched. Running tsc.

## Findings (run: npx vitest run --config test/review/friend/vitest.review.config.ts)
- R1 HIGH sensitive date fact → Gora-first date_from_memory nudge (proactive/signals.ts dates: no sensitivity filter, no friend check). Proof sensitiveDateNudge.test.ts.
- R2 HIGH hard stop (4 unanswered) evaporates after the 90-day user_signals sweep → decision send:true; first_hint cap (2) resets with proactive_log pruning. Proof retentionResetsStops.test.ts (2).
- R3 MEDIUM hard stop not applied to unrequested nudges (canSendNow ignores unanswered). Proof unrequestedNudgeHardStop.test.ts.
- R4 MEDIUM forgotten fact text survives in proactive_log (u: DEK), re-sent to judge LLM, in export. Proof forgetProactiveLog.test.ts.
- R5 MEDIUM forget wipes Mini App removals → deleted card items resurrected. Proof profileRemovals.test.ts (a).
- R6 MEDIUM Mini App card delete does not erase: fact stays in <user_model>, deleted text re-sent to LLM on each consolidation. Proof profileRemovals.test.ts (b).
- R7 MEDIUM '</data>' breakout in compose/judge prompts (data not a reserved tag). Proof composeJudgeGuards.test.ts (a).
- R8 MEDIUM no deterministic sensitive check on the composed draft; looksSensitive misses 20/21 common terms. Proof composeJudgeGuards.test.ts (b)(c).
- R9 LOW-MED expired TTL mood facts stay in the card/<user_model>; nightly skip ignores TTL deletions. Proof expiredMoodInCard.test.ts.
- R10 LOW (trace) proactive text re-enters as trusted <gora_event> (onSent addEvent) though compose read assistant turns that may paraphrase untrusted content.
- R11 LOW (trace) never-wrote users on a default tz (en→UTC, ru→Moscow) get first_hint / quiet hours in the guessed zone (eligibility ignores tz_source).
- R12 LOW (trace) 'checkin' in CAP_SOURCES but reminders/fire.ts never reports; nudge deliver records goraSent after `await todayThread` (race window vs proactive sendJob final cap check).
Checked OK: no Math.random in src; USER_DATA_TABLES covers all 003 tables; forget deletes vectors in the same tx + re-seal; embedMissing re-checks status/gen; group/biz/guest facts never reach the card (user scope, EXTRACT_SURFACES dm/topic/mission, group memory_save → group scope); budget pauses 'proactive'+'background' at ≥85%; judge null → no send; blocked/off/paused/quiet/no_dm re-checked in sendJob.
## Status: DONE. 13 failing proofs in 7 files (mine) + 3 trace findings. No production code changed.
