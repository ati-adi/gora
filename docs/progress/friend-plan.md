# friend-plan (planner + foundation) progress log

## Step 0: started 2026-09-29
- Read spec 05 fully.

## Step 2: embedding verification DONE (scratch: $SCRATCH/embcheck, cache in scratch/model-cache, not ./data)
- @huggingface/transformers@4.3.0 (deps onnxruntime-node 1.30.0 with bundled CPU binaries for darwin-arm64, linux-x64, linux-arm64; postinstall NOT needed (it only fetches CUDA); sharp, onnxruntime-web pulled too). node_modules +472MB.
- Xenova/multilingual-e5-small dtype q8 (model_quantized.onnx 118MB + tokenizer.json 17MB = 144MB cache), 384-d.
- Node 26.8.1 darwin arm64: cold load incl. download 74s; warm load 308ms; single embed 2-7ms; batch of 4 9-10ms; RSS ~650-720MB.
- Quality: cos(ru passage, en translation)=0.928; ru-vs-unrelated=0.717; query "где живёт сестра?" vs ru passage 0.836 vs unrelated 0.645 (e5 cosines are compressed toward 0.7; ranking is correct).
- linux x64: not runnable here; binaries present in package (bin/napi-v6/linux/x64). Needs glibc (check Dockerfile base).

## Step 1: code reading DONE
- Key findings: memory has NO FTS5 table (text is encrypted; retrieval = BM25-lite over decrypted per-scope LRU in memory/store.ts) → the "FTS5 BM25" leg = existing in-memory bm25(); no new FTS table (would leak plaintext).
- `s.profile` is already the ProviderProfile → the profile card service is `s.userProfile`.
- src/proactive/signals.ts already exists (nudge signal scan) → new behaviour code goes in new dir src/behaviour/.
- scheduler.ts uses Math.random (retryDelay) → migrate to s.random; add importRules rule no-math-random.
- users.status CHECK already includes 'blocked'; users.bot_blocked exists.
- memory_facts.kind CHECK lacks plan/event/context kinds → 003 rebuilds memory_facts? (decided below)
- jobs.kind / ledger.kind have no CHECK → new JobKinds/LedgerKinds need no DDL.
- transport.parse always uses the fast model → add SideRequest.role ('fast'|'main') for composition.

## Step 3: foundation design decisions (in progress)
- memory_facts: NO table rebuild on the live DB. 003 adds `importance REAL NOT NULL DEFAULT 0.5` and `expires_at INTEGER` (TTL for mood/context). FactKind unchanged: plans/events → 'date', mood/context → 'fact' with expires_at.
- users: + proactive_level ('off'|'less'|'normal'|'more', default 'normal'), + tz_hint_at (A6 once/7d). user_settings: + style_json (explicit style overrides).
- New tables per spec §D (+ dek_gen/scope where sealing needs it). New table owners: src/memory/ (user_profile, fact_embeddings), src/behaviour/ (user_signals, user_rhythm, proactive_arms, proactive_log).
- Services: + random, userProfile (ProfileService), signals (SignalsService), proactivePolicy (ProactivePolicy). caps.embedder (Embedder).
- SideCalls.structured(...) generic call (purposes consolidate|compose|judge, role fast|main) so M/B own their prompts but usage recording stays in agent/.
- ContextPart key 'user_model' rendered as a <user_model> block; 'user_model' becomes a RESERVED tag.

## Step 3 progress
- DONE: package.json (+@huggingface/transformers 4.3.0 exact), migration 003 (+test on a populated 001+002 db), contracts (common Random; capabilities Embedder; memory ProfileCard/ProfileService + Extracted/save optional importance/ttl; behaviour.ts new; storage UserRow.proactiveLevel/tzHintAt, UserSettings.style, USER_DATA_TABLES; scheduler JobKinds; ledger kinds; llm SidePurpose + SideRequest.role; agent ContextPart 'user_model' + SideCalls.structured; services random/userProfile/signals/proactivePolicy + BehaviourModule + factories), config (EMBEDDINGS_*, PROACTIVE_TAU, LIMITS friend block, compact 700), kernel/random.ts, kernel/tags user_model, agent/context.ts <user_model> block, agent/side.ts structured(), transports honor role, capabilities/embedder.ts (local/hash/none), users repo fields, scheduler off Math.random, stubs memory/profile.ts + behaviour/index.ts, app.ts wiring, harness fakes (FakeEmbedder, createFakeProfileService, createRecordingSignals, createFakePolicy, seededRandom), testApp random, importRules (no-math-random, transformers-runtime-import, table owners), test/unit/foundation/friend.test.ts.
- typecheck clean; foundation suite green. Next: full npm test + e2e, then write 06 plan.
- DONE: typecheck clean; npm test 975/975 (was 961 + new foundation tests); e2e strict 101/101 (privacy e2e seeder maps fact_embeddings.fact_id to the seeded fact).
- Project-level smoke of createLocalEmbedder (scratch cache): ready in 2.2 s warm, 384-d, EN query vs RU passage cos 0.833 vs unrelated 0.692.
- Next: write docs/spec/06-friend-plan.md (step 4).
- Extra foundation wiring: memoryEnabled/memoryState helpers (contracts/memory.ts); ProactivePolicy.explain + PROACTIVE_LOG_PREFIX 'pl_'; outbox onBlocked → s.signals.blocked (telegram/index.ts); dm.ts commit() → s.signals.inbound; handlers.ts reaction → s.signals.reaction + pl_ guard.

## Step 4: DONE — docs/spec/06-friend-plan.md written (P / M / B sets, owned files, consumes/provides, acceptance tests, integration, deviations).

## FINAL (2026-09-29): typecheck clean; npm test 976/976; test:e2e:strict 101/101; no Math.random in src/ code.
