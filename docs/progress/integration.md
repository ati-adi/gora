# Integration log (lead)

## Round 1 — start state (2026-09-28)
- typecheck clean; unit 752/757 (5 foundation failures: testApp x4, freeze x1).
- [x] CR WP2/WP3: `AgentModule.attachChannels?(f)` added to contracts/services.ts; app.ts calls it after createTelegramModule; removed WP2's hidden `gateway.channels` bridge + WP3's Reflect lookup + files.e2e workaround. Explicitly injected channels (tests) win.
- [x] CR WP3: `createTransport(cfg, log, s, o?: {fetchImpl})`; app.ts passes fetchImpl to the Anthropic SDK.
- [x] CR WP5: `createToolRegistry(.., o?: {webFetchUrlSources})`, `createCapabilities(.., o?: {sentinelPolicy})` (app.ts passes LLM_SENTINEL_POLICY), `createIntegrationService(.., o?: {fetchImpl})`.
- [x] CR WP8: trust/approvals.ts `applyEdits()` merges Mini App edited fields into the stored input (EDIT_PATHS maps display field → input path; calendar start/end → start_local/end_local, update → patch.*; gmail_send_draft not editable: its input is only draft_id).
- [x] Foundation tests (stub-era assumptions contradicted by merged modules): freeze strings → real; testApp pins WP7 to no-op fakes where it tests raw handler plumbing, registry now asserts EXTERNAL_TOOLS present, kv restart uses its own key. Foundation 134/134.
- [x] 03 R3 core toolkit ≤ 1,100 tokens (was ~1,500): tools/schema.ts `compactJsonSchema` used by the registry on toolMode 'toolkits' (drops additionalProperties/min/max/default/format, `type` beside string enums, pattern when described; zod still validates); trimmed 9 core tool descriptions (memory/reminders/choices/react/time). Now 1,099. registry.test asserts whole ≤ 1100; closed-object assertion only on static profiles (03 > 01).
- [x] WP3 gap: agent/context.ts ALLOWED.biz_draft now includes 'memories' (01 §10.2 step 4 top-8 memories; WP6a provider already limits to 8).
- [x] WP6b request: engine stops a mission run at the next model-call boundary once the mission is 'budget_exhausted' (synthetic MISSION_BUDGET_MARK, stopCategory 'budget'); ➕ Budget continues via missions.wakeOrContinue (event run). Parking was not used: wakeRun needs a pending tool round.
- [x] Bug: engine Continue button encoded `ct:<conv>` without the `c` part → WP7a answered "invalid". Now `ct:<conv>:c`.
- [x] Bug: WP2 sent todo_list effects with refKind 'todo_list' but WP6a's onSent hook listens on 'todo' → fixed in telegram/channels/common.ts.
- [x] Gap: onboarding setTimezone (WP7a) now calls reminders.rescheduleForTz on a zone change (settings tool + Mini App already did). Brief cron self-heals on tz mismatch (WP6b).
- [x] CR WP7b (optional, taken): PendingActionView.card? {chatId, threadId, messageId}; business window job edits the card in place into "⌛ window closed" + draft (+📋 Copy ≤256). business.e2e updated to assert editMessageText on the card message.
- Verified already done: WP2 notify channel calls setStatusLine(null) on checkpoint; reactions → nudges.outcome (surfaces/handlers.ts); ct:r retry; shred_epoch payload; WP7a /incognito + mm:fg + group_explicit.
- [x] Privacy (WP3 known gap): Groq vision/PDF text cache in kv was plaintext and outlived /forget + /deletemydata. Now `TransportOpts.dek?` (contract addition, llm.ts); engine passes the epoch DEK; agent/index.ts `createMediaTextCache` keys by HMAC(dek|sha) and seals values under that DEK (shred → miss). New test/unit/agent/mediaCache.test.ts.
- [x] test/unit/trust/applyEdits.test.ts for the WP8 merge.
- [x] New test/e2e/integration.e2e.test.ts (full stack, no pinned fakes): streaming via WP2 channels, web_fetch url_sources client_tool_results none in the real request, Continue `ct:<conv>:c` re-runs (verified it fails without the fix), forwarded email never reaches extraction / memory. Covers the two injection assertions WP4 left open.
- [x] streaming.e2e callOpts assertions updated for `dek`.
- [x] Dry boot (scratch script, real factories, polling, fetch that throws, fake Telegram transformer): anthropic-demo and groq-free profiles boot with fallbacksUsed [], /healthz 200, 0 network attempts, clean stop.
- [x] grep NotBuilt/TODO/FIXME/not implemented in src: only kernel NotBuilt helper + app/main fallback plumbing (test-only path); no shipped stubs.

## Round 1 gate (end)
typecheck clean · unit 87 files / 761 tests · e2e 23 files / 101 tests (0 skipped) · build:webapp ok · sim ok (0 model requests).

## Remaining / for stage 3 review
- Brief cron after a tz change self-heals on the next firing (may skip one day's brief); tz-change sites don't re-arm it eagerly.
- Group scheduled jobs are not cancelled when the bot leaves a group (scheduler has no lookup by scope); retention sweep destroys group data after 7 days.
- WP3: rotation seed built without the model omits open commitments; inputs arriving in the 700 ms pre-run window wait for the next message after a crash.
- Composio action names unverified live (⚠U11); smoke-groq not run live; Anthropic web_fetch url_sources acceptance (⚠U8) unverified live.
- Core toolkit is at 1,099/1,100 estimated tokens: any new core description text will break the test.
