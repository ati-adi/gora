# Review: agent

Started 2026-09-28. Adversarial review of src/agent/**.

## Findings

Run proofs: `npx vitest run --config test/review/agent/vitest.review.config.ts`

### F1 (high, privacy) incognito_end seed quotes incognito-epoch owner messages into the permanent epoch — PROVEN
- test/review/agent/incognitoSeedLeak.test.ts (fails: seed row + later request contain the incognito text)
- epochs.ts:31 DETERMINISTIC_REASONS has incognito_end; deterministicSeed() quotes the last 8 owner inputs consumed in the OLD (incognito) epoch.

### F2 (medium, data loss) rotateNow() races a run start: double rotation, run's exchange orphaned — PROVEN
- test/review/agent/rotateNowRace.test.ts (fails: current epoch empty; the run's rows are in the orphaned epoch N+1)
- engine.ts rotateNow(): checks activeRunId, then awaits rotate() (handoff side call) while rotate_pending is still set; a
  run start meanwhile (engine.ts start(): rotationReason → rotate) rotates again. epochs.ts rotate() clears rotatePending only after the await.

### F3 (high, groq-free) toolkit selection ignores the 5,200 budget → prompt_budget on ordinary Gmail+Calendar flows — PROVEN
- test/review/agent/groqToolkitBudget.test.ts (fails: fitToBudget throws prompt_budget after calendar lookup + email draft)
- measured (real registry, groq-free): system 606 tok; tools core 1199, +web 678, +calendar 892, +email 561, +missions 1221, +account 773; ALL kits 5857 (> 5200 alone).
- engine.ts toolsFor() unions kits with no budget; map.ts fitToBudget never drops tool definitions.

### F4 (low, groq ceiling) tool_use_failed retry re-sends above maxPromptTokens — PROVEN
- test/review/agent/groqToolFailCeiling.test.ts (retried request 5385 > 5200 est. tokens)
- groq/transport.ts stream(): `t = { ...t, messages: [...t.messages, toolUseFailedNote(...)] }` with no fitToBudget.

### F5 (high, privacy) forget rotation at run start + quota template → old epoch never shredded — PROVEN
- test/review/agent/rotateThenQuotaNoShred.test.ts
- engine.ts start(): rotate() (clears rotate_pending) → quotaBlock() → finishWithTemplate() return false BEFORE `if (shred) scheduleShred(...)`; also drops rot.seed (context lost for size rotations). Also any throw in start() after rotate (crash path) skips the shred.

### F6 (high, crash path) exception in a tool round bricks the conversation — PROVEN
- test/review/agent/toolRoundCrashBricks.test.ts (epoch ends with unanswered tool_use; next "hi" never answered)
- engine.ts toolRound() `if (!out) throw err` → drive() catch → ensureAssistantLast() returns when last row is assistant (tool_use) → run failed, G3 open. Next run's start() append → GrammarError G3 → crash path consumes the new inputs → repeat.

### F7 (medium, rate) tool_use_failed retried at two layers: 6 main calls per failing step — PROVEN
- test/review/agent/toolUseFailedAmplification.test.ts (6 client calls, spec: one retry)
- groq/transport.ts retries once then throws BadRequestLlmError('tool_use_failed'); engine.ts handleError `e.code === 'tool_use_failed'` → jsonRetries<2 → re-stream (no note) ×2.

### F8 (high, crash/brick, externally triggerable) G8 content in a tool result crashes the run and bricks the conversation — PROVEN
- test/review/agent/g8ToolResultCrash.test.ts (tool output quoting Telegram's documented file URL; redact() keeps it)
- grammar.ts rowViolations G8 on tool_results append (engine.ts afterRound tx) → GrammarError → F6 path. Same for user inputs (start(): owner message dropped, "failed").

### F9 (medium, stop pairing) Stop on the draft is ignored while the run is in retry_wait — PROVEN
- test/review/agent/stopDuringRetryWait.test.ts (stopByDraft → false; run later 'done')
- engine.ts stopByDraft() only scans `live`; retry_wait runs are not live (drive() returned). runs.draftId is persisted but unused.

### F10 (high, privacy) size/idle rotation of an incognito epoch launders incognito content; incognito_end then shreds nothing — PROVEN
- test/review/agent/incognitoSizeRotation.test.ts (groq-free: 2nd incognito message rotates 'size'; handoff side call gets the incognito transcript; no shred of the incognito epoch at incognito end)
- epochs.ts rotationReason() has no incognito awareness; rotate() handoff allowed (untainted); new epoch reason 'size'; memory/incognito.ts keys on current reason 'incognito_start'.

### F11 (medium, robustness) Groq mid-stream drop: reset → non-retryable failure; clean EOF → truncated answer persisted as end_turn — PROVEN
- test/review/agent/groqMidStreamDrop.test.ts (real groq-sdk iterator + fake fetch)
- groq/transport.ts mapGroqError: TypeError('terminated') returned raw → engine handleError 'unexpected' → failed. map.ts ChunkAccumulator.toMessage: finish null → 'end_turn'.

## Final (2026-09-28)
All 13 proof tests fail for the stated reasons (`npx vitest run --config test/review/agent/vitest.review.config.ts`); typecheck clean.
Ranking: F8, F6, F1, F10, F3 (high) · F5, F2, F7, F11, F9 (medium) · F4 (low). No production code changed.
Checked, no finding: Groq chunk shapes (reasoning deltas, choices:[] usage chunk, x_groq.error, SSE error status_code fallback), 413 shrink-once, 429 → governor penalty/fallback, strictSchema, context tag neutralization, ownerAuthoredSince excludes untrusted, outbox idempotency on recoverFinalize, llm_calls.raw sealed under epoch DEK.

## Fixer (2026-09-28)
All 13 proofs reproduced before any change (`npx vitest run --config test/review/agent/vitest.review.config.ts`).
- F8 FIXED: grammar.ts scrubG8/scrubG8Text; engine.ts appendRows() scrubs every appended row (tool output, inputs, model text, context) → placeholders '[telegram file url]' / '[bot token]'; G8 stays as the validator.
- F6 FIXED: engine.ts closeOpenRound() — crash path (ensureAssistantLast) closes an open tool_use with stored results / OUTCOME_UNKNOWN + synthetic row; start() self-heals an already-open round (no parked owner) — heals conversations bricked before this fix.
- F7 FIXED: engine.ts handleError no longer re-streams on tool_use_failed (transport did the one retry).
- F4 FIXED: groq/transport.ts withToolUseFailedNote(): re-fits after the note; short note, then no note, when the ceiling would break.
- F11 FIXED: groq/transport.ts isNetworkError() → TransientLlmError('connection'); stream ends with finish_reason null → TransientLlmError('server').
- F3 FIXED: map.ts protectedEstimate(); toolkits.ts droppableKits/fitKitsToBudget; engine.ts requestFor() drops kits not used by the run while the undroppable part exceeds maxPromptTokens. Test rewritten through the budgeter (+ worst-case all-kits test).
- F1/F10 FIXED: epochs.ts incognitoWindow(); inside a window no handoff; incognito_end seeds from the pre-incognito epoch (fork handoff or its deterministic seed; no quotes when no window) and RotationResult.shred lists every window epoch. F10 test updated (it skipped the incognito_end request; memory/incognito.ts openWindowStart does request it).
- F5 FIXED: start() persists the seed on the new epoch and schedules shreds right after rotate() (before quota/template).
- F2 FIXED: engine.ts `rotations` lock: rotateNow() holds it; start() awaits it and re-reads. Test adjusted (its gate deadlocked against correct serialization).
- F9 FIXED: stopByDraft() falls back to queued/retry_wait runs by runs.draft_id (recoverable(MAX)).
- Extra: requestFor() also keeps kits the model loaded via use_toolkit in THIS run (never dropped). Unit tests added: grammar.test.ts (scrubG8), groqTransport.test.ts (isNetworkError).
- Final: typecheck clean; unit 764/764; review/agent 14/14; e2e 101/101.
- Cross-area notes: memory/incognito.ts openWindowStart stops at the most recent incognito_start (a re-issued /incognito inside a window) — agent side now shreds the whole window anyway; tools: core toolkit measured 1,199 est. tokens vs the 03 R3 ≤1,100 target.
