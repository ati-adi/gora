# Review: memory

Started 2026-09-28. Adversarial review of src/memory/**, src/scheduler/**, src/reminders/**.
Proof tests: test/review/memory/*.test.ts (run: npx vitest run --config <scratch config> or `npx vitest run test/review/memory --project unit` is NOT matched; see notes).

## Findings
Runner: vitest config outside the unit include (scratch config with root=repo, include test/review/memory/**).

### F1 (high, privacy) incognito detected only by current epoch reason — CONFIRMED
- test/review/memory/incognito-leak.test.ts (3 failing tests)
- extract.ts:131 filters only inputs whose consumed epoch reason === 'incognito_start'. /new during incognito (reason user_new),
  or any size/idle/forget rotation, or a topic/mission conversation (only the DM rotates) → incognito-time inputs extracted after it ends.
- incognito.ts:27 skips rotation (and thus the shred) when the current epoch reason is not incognito_start.

### F2 (high, privacy) memory_search results never recorded in run_memory_uses → forget does not rotate that conversation — CONFIRMED
- test/review/memory/forget-leaks.test.ts #1; store.ts:403 search() has no recordMemoryUses (retrieve() does at :382-389); forgetFacts :571-586.

### F3 (medium, privacy) forgotten fact text survives in sibling fact's quote (extractor stores whole input as quote) — CONFIRMED
- test/review/memory/forget-leaks.test.ts #2; extract.ts:175 quote = src.text; forgetFacts only nulls the forgotten row; list/export/Mini App expose quote.

### F4 (medium, spam/rate-limit) cron min-interval checked only on first two occurrences — CONFIRMED
- test/review/memory/reminders-time.test.ts (cron minimum interval x2): "* 14 * * *" created at 14:58:30 accepted → 60 msgs/day.

### F5 (low-medium, DST) overlap: earlier instant picked then rejected as past though later instant is future — CONFIRMED
- test/review/memory/reminders-time.test.ts (DST overlap): Europe/Kyiv 2026-10-25 01:40Z, at_local 03:50 → 'past'.

### F6 (medium, rate-limit/dup) handler outliving lease is re-claimed concurrently, unbounded, never dead — CONFIRMED
- test/review/memory/scheduler-lease.test.ts: hung side.extract → 6 concurrent calls, attempts 6 > max 4, still leased.

### F7 (medium, privacy/data-rights) memory export truncated to 100 facts — CONFIRMED
- test/review/memory/export-truncated.test.ts; index.ts:50 list(limit 100000) clamped to 100 at store.ts:424, next ignored.

### F8 (medium, privacy) superseded facts keep text forever; forget-by-query/list/export can't see them — CONFIRMED
- test/review/memory/superseded-unforgettable.test.ts; store.ts:335-336, 529-535; repo.ts:57; rotate re-encrypts them.

### F9 (high, crash) group memory / group to-dos permanently crash after bot re-added to a group >7d after leaving — CONFIRMED
- test/review/memory/group-rejoin.test.ts (2): surfaces retention destroyOwner('grp:<id>') kills mg:/g: DEKs; memory_facts rows kept;
  currentGen resolves to the destroyed gen; seal → DekDestroyedError rethrown (store.ts:342). Same for todos/reminders (g:<chatId>).

### F10 (medium) boot-time upsert of system cron jobs drops missed runs and double-runs after crash-with-lease — CONFIRMED
- test/review/memory/scheduler-restart.test.ts (2): repo.upsert overwrites run_at; rearmed on stale lease → apply() re-schedules at past run_at.

### F11 (low) punctuation-only forget query matches every pending fact — CONFIRMED
- test/review/memory/forget-query-wildcard.test.ts; store.ts:530 normalize('?') === '' → includes('') true.

## Notes
- F1 tests model production scheduling (engine.ts:1022 schedules mx after every run; a job firing during incognito only bumps
  the watermark), so the leak window is the last ~2 min of incognito (expiry or /incognito off right after chatting), all topics.
- FTS5: no FTS5/MATCH anywhere in src (BM25 in JS over Intl.Segmenter tokens) → no MATCH-injection surface.
- Croner DST verified OK (overlap fires once, gap shifted forward) for Europe/Kyiv, America/New_York.
- tsc: my review tests compile; 2 tsc errors exist in other reviewers' files (test/review/tools, test/review/trust).
- Status: DONE (11 findings, 16 failing proof tests).

## Fixer (independent) — started 2026-09-28
Runner: scratch vitest config (root=repo, include test/review/memory/**); all 16 proof tests reproduced before any change.
- FIXED F9 (memory half): store.currentGen skips destroyed memory DEK generations and purges rows still holding ciphertext
  under a destroyed DEK (repo.gensWithText/deleteWithTextInGens); memory privacy hook retentionSweep purges such group rows.
- FIXED F2: store.search(scope, q, limit, kind, runId) records run_memory_uses (shared recordUses helper with retrieve);
  memory_search passes ctx.runId. (getMany is only used for display: /why, Mini App, export — no transcript.)
- FIXED F3: extractor quote = supporting sentence(s) only (extract.supportingQuote); forget → rotate() drops the quote of
  every fact sharing a forgotten fact's source input and re-filters every quote against the fingerprints.
- FIXED F7+F8: export uses store.exportFacts (active+pending+superseded, no clamp); forget-by-query also matches
  superseded facts (BM25 among them, or substring).
- FIXED F11: empty normalized query → no substring match in select() and list().
- FIXED F1: incognito run hook moves the conversation's extraction watermark to run end while incognito; extract floors the
  watermark at an expired-but-unfinalized incognito_until; incognito_end seals every conversation's watermark at the window
  end and rotates every conversation whose epoch chain since the last incognito_end has incognito_start, plus
  dm/topic/mission conversations with owner inputs inside the window. Unit memory tests 24/24 green.
- FIXED F9 (reminders half): repo.sealDek resolves 'g:<chatId>:<n>' when the base group DEK is destroyed, after purging orphan to-dos/reminders (and cancelling their jobs); reminders retentionSweep purges orphans of shredded groups. group-rejoin 2/2 green.
- FIXED F4: resolveCron checks every consecutive gap over CRON_INTERVAL_SAMPLE=400 occurrences (scheduler.cronRuns via
  croner nextRuns). Proof test 'end to end' updated to assert the rejection (created=false, 0 sent).
- FIXED F5: resolveAtLocal falls back to the later overlap instant (earlier + 30/60/120 min with the same wall time) when
  the earlier one is past. reminders unit 20/20.
- FIXED F10: repo.upsert keeps an earlier run_at for a 'scheduled' row of the same cron+tz (missed boot-time run coalesces
  into one run); schedule() re-arms a leased row only when its handler runs in THIS process.
- FIXED F6: scheduler tracks live handlers (id → token); every tick renews their leases (heartbeat) so they are never
  re-claimed mid-run; abort signal at 3 leases, abandonment at 12 leases (late result ignored); a claimed job with
  attempts > max_attempts is dead-lettered (apply 'dead', cron series continues) instead of launched. The extract handler
  cannot pass ctx.signal to side.extract (contract has no signal) → cross-area.
- Added test/review/memory/fixer-regressions.test.ts (7 tests). Review suite: 23/23 green.
- Boundary fix (F1): the window's last instant is end-1 (incognito holds while until > now), in incognito_end and in the
  extract floor; e2e memory incognito test green again.
- FINAL: typecheck 0 errors; unit 761/761; e2e 101/101; test/review/memory 23/23 (16 proof + 7 fixer regressions).
  Transient failures seen mid-run in foundation/config/freeze/importRules and e2e/epochs came from other fixers' in-flight
  edits (src/config.ts, src/db/sqlite.ts, src/http/routes/ledger.ts, src/agent/epochs.ts) and passed on re-run.
- Cross-area: X1 SideCallMeta.signal (agent/contracts), X2 /incognito command key + off path (surfaces/commands.ts),
  X3 optional eager purge of group rows on shred (surfaces/index.ts), X4 optional: engine skips memory_extract while incognito.
- Status: DONE (fixer).
