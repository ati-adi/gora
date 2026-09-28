# friend-M progress log (set M: memory engine)

## Step 0 — started
- Read 05, 06 §0/§1/§4. Exploring src/memory/**.

## Step 1 — design (DONE reading)
- Jobs registered by createMemoryService (memory owns them): memory_extract, incognito_end, memory_embed (per scope `me:<scopeKey>`, no LLM), profile_consolidate (per user `pc:<userId>`, + hourly `sys:profile_consolidate` sweep → users at local 04:xx). The per-user handler calls `s.userProfile.consolidate` at call time (works with the fake too).
- Profile card sealed under the memory DEK `m:<userId>:<gen>` (AAD `user_profile|profile_enc|<userId>:<version>`); payload {card, removed[], corrected[]}. Forget → every version deleted immediately + `pc:<userId>` job reason forget (rebuild from facts only, never from the old card).
- Embeddings: `fact_embeddings` sealed under the fact's gen; re-sealed on rotation; deleted on forget/supersede/edit/expiry. Retrieval only uses the semantic leg when `embedder.status()==='ready'` (never blocks a turn on the 74 s first load); otherwise schedules the backfill job (which loads the model in the background).
- Retrieval: weighted RRF (k=60; semantic leg = facts within 0.1 cosine of the best, top 20; lexical leg = BM25>0; ties share a rank) × (0.5+importance) × 0.5^(age/30d) (pinned/profile kind: no decay). Expired facts excluded.
- <user_model>: profile head ≤ LIMITS.profileMaxTokens (250) + facts ≤ LIMITS.userModelMaxTokens (300) — 02 §D's 250+300 split (the plan text says "whole block ≤ 300"; 05 B3/B4 give 250 head + 300 facts).
- Sensitive: extraction keeps a sensitive fact only when explicit (the extract prompt now defines explicit for sensitive = plainly stated by the owner about themselves); no ✓/✗ card. Sensitive facts are excluded from the consolidation input (so the card, which B composes from, never holds them); MemoryFactView.sensitivity lets B filter `list`.
- Extraction batching: RunHook counts owner exchanges since the watermark: ≥ 3 → job now, else job at now+10 min (pushed back by each run). ✍ reaction on each source message that produced a saved fact.

## Step 2 — core implementation DONE (typecheck clean in src/memory)
- New: src/memory/vectors.ts (fact_embeddings repo + sealed vector cache), retrieval.ts (pure weighted RRF × importance × decay), consolidate.ts (prompt, zod schema, clamp, filters, local-time helpers), profileRepo.ts, profile.ts (real ProfileService).
- Changed: store.ts (memoryEnabled gate, no sensitive card, importance/expiresAt, async hybrid retrieve/search, vectors on save/edit/forget/rotate, profile delete + rebuild job on forget, embedMissing, sweepExpired, 15-facts trigger), extract.ts (batching 3 exchanges / 10 idle min, sensitive only if explicit, importance/ttl, ✍ per source message, no review markup), context.ts (<user_model> = card head + facts), tools.ts (about_me + Mini App link), callbacks.ts (mm:rv → expired), importer.ts (memoryEnabled), index.ts (memory_embed + profile_consolidate jobs, sys:profile_consolidate hourly sweep, export profile + embedding count, TTL sweep), repo.ts (importance/expires_at + helpers), agent/side.ts ExtractSchema (+importance, ttl_days), agent/prompt/side.ts extract prompt (kept the spec sentence P's prompt.test checks).
- Tests updated: test/unit/memory/{extract,memory}.test.ts, test/review/memory/{forget-leaks,scheduler-lease,forget-query-wildcard}.test.ts (batching timing; pending facts via import). All green (memory + review/memory).
- Next: new unit tests (retrieval, embeddings, profile, context, about_me, embedder), then e2e.

## Step 3 — unit tests DONE
- New: test/unit/memory/retrieval.test.ts (8), test/unit/memory/friend.test.ts (17), test/unit/capabilities/embedder.test.ts (3, transformers mocked), side.test.ts +1 (importance/ttl_days).
- env.ts: side.structured scripted queue (structuredQueue / structuredCalls).
- Next: e2e (memory.e2e.test.ts update + friend-memory.e2e.test.ts), full suites.

## Step 4 — e2e + full suites
- test/e2e/memory.e2e.test.ts: timings moved to the B1 batch (10 idle min). New test/e2e/friend-memory.e2e.test.ts (4): extraction w/o consent card + ✍, incognito/off → no extract; hybrid in <user_model> + lexical fallback; nightly consolidation via real SideCalls.structured (t.llm.pushParse('consolidate')) → card heads <user_model>, forget → rebuild w/o fact, versions gone, vector gone, relearning blocked; sealed vectors + deletion plan → 0 rows.
- test/e2e/integration.e2e.test.ts (not owned by any set): ONE line, `advance(3 min)` → `advance(10 min)` because 05 B1 changed the extraction timing (2-min debounce → batch).
- Core toolkit wire budget (registry.test 1185 tokens, 3 tokens headroom): memory_search description shortened to 'Search memory; about_me: all you know of them.' and memory_save's to 'Save a durable fact about the user or group.' to fit `about_me`.
- Retry fix: an 'unavailable' embedder is still asked by the backfill job (the embedder rate-limits load retries to 1/h), so a transient load failure does not disable semantic search until restart.
- Removed legacy combinedScore / MIN_OTHER_SCORE / EXTRACT_DEBOUNCE_MS.
- Status: typecheck clean; unit 1007/1007 at last full run; e2e: only webhook.e2e (P's command menu, `['memory','settings']`) failing — not M's.

## FINAL (2026-09-29)
- typecheck clean (tsc src + webapp); npm test 1023/1023 (187 files); npm run test:e2e:strict 115/115 (25 files).
- M-owned unit tests: 82 (memory 50 incl. new retrieval 8 + friend 17; review/memory 23; agent/side 6; capabilities/embedder 3). M e2e: memory 4 + friend-memory 4.
- CROSS-SET REQUESTS logged in the final report (P: prompt line for memory_search about_me; S08 / sentinel / context memory= via memoryEnabled. B: filter sensitivity on s.memory.list; dueThreads/get are live).
