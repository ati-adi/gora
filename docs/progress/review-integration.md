# Review integration log (lead, post adversarial review)

## Start (2026-09-28)
- Applying cross-area fixes X1..typecheck-telegram, then full gate.
- [x] X1 (memory): incognito.ts openWindowStart walks to the earliest incognito_start since the last incognito_end.
- [x] X2 (tools): trimmed core descriptions (choices, use_toolkit, time_resolve, react, memory_save, reminder_create/_manage). Core raw 1,099→~1,083 est. tokens (03 R3 'serialized definitions' ≤1,100 holds); Groq wire form 1,199→1,182. registry.test now also caps the wire form at 1,185. Reaching ≤1,100 on the wire would need removing parameters (e.g. memory_search.kind) — left open.
- [x] X3 (db): RunsRepo.byDraft(chatId, threadId, draftId) (contract + sqlite + fake); engine.stopByDraft uses it instead of recoverable(MAX_SAFE_INTEGER).
- [x] F4-index: new migration 002_review_indexes.sql — outbox_chat(chat_id, status), runs_draft(draft_id) partial; IF NOT EXISTS (the live DB gets it on its next restart). Migration tests expect [1, 2].
- [x] DEPS-1: package.json declares decode-named-character-reference 1.3.0, mdast-util-from-markdown 2.0.3, mdast-util-gfm 3.1.0, micromark-extension-gfm 3.0.0 (deps) and @types/mdast 4.0.4, mdast-util-to-string 4.0.0 (dev); lockfile updated with --package-lock-only (node_modules untouched; same versions already installed).
- [x] F10-main: main.ts uncaughtException handler (logs error name/code only, keeps serving; >10 in 60 s → graceful shutdown).
- [x] TRUST-01/02: engine.toolRound adds serverTaint(msg) before processRound; stopDuringTools adds out.taintAdded before appending.
- [x] TRUST-06: epoch deterministic seed lists open approvals as '<id> <toolName> (<status>)' (no summary).
- [x] TRUST-08: neutralizeLookalikeTags moved to kernel/tags.ts; neutralizeReservedTags applies ASCII + lookalike folding for every caller; containsReservedTag detects lookalikes; trust/untrusted.ts re-exports.
- [x] TRUST-11: StepUpService.verifyPhrase(.., pendingActionId?) and consume(.., expectedPhrase?, pendingActionId?); the route passes pa.id; grants.createAlways passes row.id. Proof: test/review/integration/stepupActionBound.test.ts (anna@x.com vs anna@evil.com).
- [x] F6: IntegrationProvider.completeConnection(query, expect?) in contracts; service.ts widening cast removed.
- [x] F2: executor.runAllowed reconciles a thrown execute (spec.reconcile; OutcomeUnknownError without reconcile → unknown): done→'done', unknown→'unknown' (OUTCOME_UNKNOWN), not_done→'error' (TOOL_FAILED). Proof: test/review/integration/runAllowedReconcile.test.ts.
- [x] F4 (quotas): executor consumes cls.quotaKind after a successful auto-run or approved execution (runAllowed / executeApproved); agent/usage.ts recordMainCall consumes 'web_search' for Anthropic server-tool web_search+web_fetch requests (Groq's are client tools → executor; no double count). Proof: test/review/integration/quotaConsume.test.ts. Open: Anthropic server web tools are not gated by the web_search quota before the call (only counted).
- [x] X1 (F6): SideCallMeta.signal; side.ts passes it to transport.parse; memory extract handler passes ctx.signal through extract() into side.extract.
- [x] X2 (F1): /incognito uses dedupeKey incog:<userId> (refId userId); /incognito off clears incognito_until and schedules incognito_end for now (handler seals + rotates all window conversations). flows.test updated.
- [-] X3 (F9, optional) NOT applied: memory_facts/todos/reminders are owned by memory/reminders (importRules own()); surfaces may not delete them. The memory + reminders retention hooks already delete undecryptable 'grp:*' rows and cancel their jobs on the sweep; orphan window ≤ one sweep.
- [x] X4 (F1): engine.scheduleAfterRun skips memory_extract while users.incognitoUntil > now.
- [x] F1 (engine): missionStop(): budget_exhausted → MISSION_BUDGET_MARK + 'budget'; done/failed/cancelled → MISSION_ENDED_MARK + stopCategory 'system_stop'; no further model call. Proof: test/review/integration/missionEndedStopsRun.test.ts.
- [x] F8 (surfaces): util.ts missionReplyConversation(); dm.ts onMessage/onEdited route a main-DM reply to a bot message linked to an active/parked topic-less mission's conversation into 'mission:<id>' (kick wakes task_wait user_input). Mission start prompt now says only replies to its own messages reach it (review/proactive fixRegressions updated). Proof: test/review/integration/fallbackMissionReply.test.ts.
- [x] F8 (telegram): notify channel prefixes checkpoint/final/stopped/fail posts of a topic-less mission run with escaped '[<missionId>]' (own paragraph before a leading block construct).
- [-] F8 (trust, optional task_wait rejection): superseded by the routing above (replies now reach the mission); not applied.
- [x] F7 (scheduler): already holds — repo.finish() only updates status='leased' rows and cancel() moves a leased row to 'cancelled'; added test/review/integration/schedulerSelfCancel.test.ts (done + reschedule).
- [x] F5: TriageSchema/Triage commitment.source_message_id (int, nullable, optional); triage prompt asks for the '#id'; business triage prefers a cited owing-side message, else commitmentSource(). Proof: test/review/integration/triageSourceMessage.test.ts.
- [x] F7 (engine metering): quotaBlock meters owner-requested interactive event runs: brief preview checks cooldown/cost/turn and consumes a turn; owner Retry checks cooldown/cost only. finishWithTemplate consumes pending inputs only for user_input runs and restarts the queue for others. Proof: test/review/integration/ownerEventMetering.test.ts.
- [x] PLAT-1-chat: onboarding runImport checks cooldown (refusal_cooldown), cost cap and turn quota (notices.quotaExceeded) before importText and consumes a turn. Proof: test/review/integration/chatImportQuota.test.ts.
- [x] typecheck-telegram: already resolved by the telegram fixer (npm run typecheck clean at start).
- [x] F11: MediaIngest.fromAlbum? (contract); capabilities/media.ts album(): Groq = one vision call over ≤3 photos + captions, Anthropic = one image block per photo; surfaces/dm.ts buffers photo parts by user+media_group_id for ALBUM_WINDOW_MS=1.5 s (≤10 parts) and commits ONE input (commit() helper shared with onMessage). Proof: test/review/integration/albumMerge.test.ts.
  (TRUST-08 proof: test/review/integration/reservedTagsLookalike.test.ts)
- [x] vitest.config.ts: the unit project now includes test/review/**/*.test.ts (all area regression proofs + test/review/integration/*).

## Gate (end, 2026-09-28)
typecheck clean (src + webapp) · unit (incl. test/review/**) 182 files / 961 tests · e2e strict 23 files / 101 tests · build:webapp ok · sim ok (onboarding done, 0 model requests).

## Still open
- X2: core toolkit on the Groq wire is ~1,182 est. tokens (03 R3's ≤1,100 holds for the serialized definitions, ~1,083); the gap is the OpenAI function wrapper (~9 tok/tool). Closing it needs removing parameters (e.g. memory_search.kind) — not done.
- X3 (F9, optional): eager delete of grp:* memory/todos/reminders after a group's DEK is destroyed not applied (table ownership); retention hooks clean up on the sweep.
- F4 follow-up: Anthropic server web_search/web_fetch are counted against the 'web_search' quota after the call but not gated before it (tools stay in the request when the quota is spent).
- F11: album parts are buffered in memory for 1.5 s; a crash or shutdown inside that window drops that album.
- Carried from round 1: brief cron re-arm after tz change is lazy; Composio action names / Anthropic web_fetch url_sources unverified live.
- Migration 002 (indexes) applies to the live DB on its next restart (the running instance was not touched).
