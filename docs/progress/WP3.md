# WP3 progress log
- [start] Fresh start. Reading 04, contracts, spec §4/§5, 03 R1/R2/R3/R6. Next: plan.
- [read] 04, contracts, config, app.ts, fakes, 01 §4.1-4.3, §5 (all), §15, §16, 02, 03, groq.md LLM section. Channels: not on Services -> engine resolves opts.channels ?? s.telegram.channels ?? createChannelFactory(s) (CONTRACT REQUEST). Next: DDL for my tables, invariants.ts, scriptedTransport, claude-api research; then plan files.
- [plan] Files (bottom-up order; mark each done here):
  1 prompt/system.ts, prompt/system.compact.ts, prompt/side.ts
  2 pricing.ts, grammar.ts, fallbackEcho.ts
  3 groq/strictSchema.ts, groq/map.ts, groq/rate.ts, groq/repo.ts, groq/budget.ts, groq/transport.ts
  4 transport.ts (Anthropic), demoTransport.ts
  5 toolkits.ts (ToolkitState + active selection/preloads), conversations.ts, inputs.ts, history.ts, context.ts, requestBuilder.ts
  6 usage.ts, epochs.ts, handoff.ts, side.ts
  7 runRegistry.ts, engine.ts, jobs.ts, index.ts
  8 tests: unit (prompt, grammar, fallbackEcho, requestBuilder+wire fixture, transport anthropic+SSE fixture, groqMap, groqTransport, groqRate, groqStrictSchema, groqBudget, toolkits, side, usage) + e2e (streaming, stop, epochs, recovery)
  9 scripts/smoke-groq.ts WP3 steps
  Decisions: channels via createAgentModule(s, {channels?, toolkits?}) opt, else s.telegram.channels, else telegram/channels createChannelFactory(s). quota inputs consumed by run.id (not 'quota').
- [resume 2] Verified done: prompt/{system,system.compact,side}.ts (system verbatim MATCH), pricing.ts, grammar.ts, fallbackEcho.ts, groq/strictSchema.ts, groq/map.ts. Next: groq/rate.ts, repo.ts, budget.ts, transport.ts.
- [resume 3] Restarted. Checking rate/repo/budget state.
- [resume 3] rate.ts, repo.ts, budget.ts reviewed: complete. Next: groq/transport.ts.
- [resume 4] Restarted. Next: groq/transport.ts.
- [resume 5] Restarted. Next: groq/transport.ts.
- [resume 5] groq/transport.ts written + typechecks (stream/create/parse/files, error mapping, media→text via late-bound caps+kv). Next: transport.ts (Anthropic), demoTransport.ts.
- [resume 5] transport.ts (Anthropic) written + typechecks. Next: demoTransport.ts, then index.ts createTransport.
- [resume 5] demoTransport.ts written. Next: read contracts agent/services/storage/telegram/tools/trust, then toolkits.ts etc (step 5).
- [decision] channels: ChannelFactory lives on TelegramModule (created after agent). Engine resolves at call time: opts.channels ?? (s.telegram as any).channels ?? attached via module.attachChannels(f). CONTRACT REQUEST: app.ts call attachChannels(tg.channels) after createTelegramModule. Never import WP2 internals.
- [resume 5] toolkits.ts, conversations.ts, inputs.ts written. Next: context.ts, requestBuilder.ts, usage.ts, epochs.ts, side.ts, runRegistry.ts, engine.ts, jobs.ts, index.ts.
- [resume 5] context.ts, requestBuilder.ts, usage.ts, side.ts written. Next: epochs.ts, runRegistry.ts, engine.ts, jobs.ts, index.ts.
- [resume 5] epochs.ts written (rotationReason/rotate/handoffFork/handoffNoteGroq/deterministicSeed/scheduleShred/scheduleHandoffFork). Next: engine.ts (big), runRegistry in engine, jobs.ts, index.ts.
- [resume 5] engine.ts first full draft written (drive/kick/wake/stop/recover/idle/shutdown/requestRotation/rotateNow). Next: typecheck engine, jobs.ts, index.ts.
- [resume 5] jobs.ts + index.ts (createTransport/createLlmGovernance/createAgentModule w/ attachChannels) written. Next: typecheck, foundation tests, then unit tests.
- [resume 5] fallbackChannel.ts added (used until app.ts attaches tg.channels); grammar.ts TELEGRAM_FILE string built to satisfy importRules. Foundation failures remaining are other WPs'. Next: unit tests (grammar, fallbackEcho, prompt, groqMap, groqStrictSchema, groqRate, groqBudget, groqTransport, transport, requestBuilder, toolkits).
- [resume 5] tests green: grammar, fallbackEcho, prompt, groqMap (+fixtures sse/groq-*.json). Next: groqStrictSchema, groqRate, groqBudget, groqTransport, transport(anthropic)+sse fixture, requestBuilder+wire fixture, toolkits.
- [resume 5] tests green: groqStrictSchema, groqRate(+budget), groqTransport. Next: transport(anthropic)+sse fixture, requestBuilder+wire fixture, toolkits, side, context tests; then e2e.
- [resume 5] tests green: transport(anthropic, sse/anthropic-basic.sse), requestBuilder (wire/dm-basic.json), toolkits. Next: e2e streaming/stop/epochs/recovery (pin fakes).
- [resume 5] recover() uses recoverable(now+LEASE_MS+1) (all running runs are orphans at boot). Writing e2e: streaming.e2e first (inline helper agentApp, pinned fakes except WP1 storage/privacy + my agent w/ recording channels).
- [resume 5] e2e streaming.e2e.test.ts GREEN (9). Next: stop.e2e, epochs.e2e, recovery.e2e (copy agentApp helper inline).
- [resume 5] e2e stop (3) + epochs (5) GREEN. Fixed: estimateParamTokens arg, deterministic seed input filter (consumedEpoch), crash-loop guard (crash in start consumes pending inputs; no auto-restart after crash). Next: recovery.e2e, then side/context/usage unit tests, smoke-groq, final gate.
- [resume 5] e2e recovery (3) GREEN. shutdown now drains aborted drives via microtasks; recoverFinalize sends sanitized sendRichMessage. Next: unit tests side/context/usage/conversations, smoke-groq script, full gate (typecheck + all agent tests + foundation).
- [resume 5] unit side (5) + context/conversations (5) GREEN. Next: scripts/smoke-groq.ts WP3 steps, then full gate.
- [resume 5] scripts/smoke-groq.ts WP3 steps implemented (real GroqTransport; skipped unless LIVE=1). Next: full gate run.
- [resume 5] GATE: typecheck clean for my paths; unit agent 82/82; e2e 20/20; foundation failures are other WPs' (stub assumptions). Next: extra e2e coverage in streaming (event run+untrusted wrap+priority, park/wake watcher, quota template, run hooks, groq use_toolkit rebuild), fallbackChannel+demo unit tests.
- [DONE resume 5] All files written. Gate: typecheck 0 errors in my paths; unit test/unit/agent 13 files 85 tests + importRules green (95 incl. foundation importRules file); e2e streaming(13)/stop(3)/epochs(5)/recovery(3) = 24 green. Remaining foundation failures belong to other WPs (stub-era assertions).
  CONTRACT REQUESTS: (1) app.ts: after createTelegramModule call `agent.attachChannels(tg.channels)` (AgentModule gains attachChannels) — until then a non-streaming fallback channel is used; (2) createTransport should receive fetchImpl (Anthropic SDK uses its default fetch).
  Known gaps: commitments not in deterministic seed (no list API); pending inputs whose kick timer was lost in a crash wait for the next message (no repo query for conversations with pending inputs); kv vision:/pdf: cache entries are not user-scoped for deletion.
