# WP6a progress
- [start] read 04 handbook. next: read stubs, contracts (scheduler, memory, proactive, tools, services), 01 §4, §8.1-8.3, §9, §15.2 WP6a rows, 03 R6/R8
- [read] contracts, 01 §4/§8.1-8.3/§9/§5.4/§5.9/§6 rows/§15.2, 02 §B/§D, 03 fully, DDL, kernel, harness fakes. No FTS5 table in DDL + facts encrypted -> in-process BM25-lite over decrypted LRU.
- [plan] files: scheduler/{repo,scheduler,index}.ts; reminders/{repo,reminders,todos,tools,callbacks,context,index}.ts; memory/{repo,text(norm/shingles/tokens),fingerprints,store,retrieve,extract,forget,import,tools,callbacks,context,index}.ts.
  Conventions: jobs dedupe 'rem:<id>' (reminder/checkin), 'rem:<id>:snz' (snooze of cron), 'mx:<convId>' memory_extract (refId=convId, payload.runId?) also scheduled by my RunHook; incognito_end userId-based (dedupe 'incog:<userId>').
  Scheduler: register duplicate -> warn + replace (foundation testApp.test re-registers reminder_fire). Budget gate via json_each kinds. Handlers launched async; tick() awaits them.
  Tests: unit memory/scheduler/reminders w/ openTmpDb + fake crypto + memory repos (+ raw users rows for FK); e2e memory/reminders via createTestApp with pinned fakes.
- next: write scheduler
- [resume 2] scheduler/{repo,scheduler,index}.ts written (untested); test/unit/memory/env.ts written. next: re-read spec sections, write scheduler test, then reminders, then memory
- [done] test/unit/scheduler/scheduler.test.ts green (17). next: reminders module (repo, service, todos, tools, callbacks, fire handlers)
- [resume 3] re-read 04, contracts, §8/§9/§6 rows/§5.6/§5.9. Plan reminders: repo.ts (reminders/todos/todo_messages SQL, text sealed u:<uid>|g:<chat>, AAD reminders|text_enc|<id>), service.ts (create/list/manage/restore/rescheduleForTz, rate caps), todos.ts, fire.ts (reminder_fire/checkin_fire handlers, late/missed), callbacks.ts (rm:<id>:d|10|60|tm, td:<id>), context.ts ('open' next reminders), tools.ts, index.ts (privacy hook export/delete, onSent 'todo'). Ids 'R'+5 crockford.
- [done] reminders/{repo,service,todos,fire,callbacks,context,impl,tools,index}.ts written, typecheck clean. next: test/unit/reminders/reminders.test.ts, then memory
- [done] test/unit/reminders/reminders.test.ts green (20). next: memory module: repo, text(normalize/shingles/tokens), store(consent/incognito gates, cap 2000, gen rotation), retrieve(BM25-lite+LRU, groq token budget 250/300), forget(fp+rotation+rotate convs+delete input+ledger), extract job + RunHook debounce 2min, import, callbacks mm:, tools, context 'memories', incognito_end job, privacy hook
- [done] memory/{text,repo,store,extract,importer,callbacks,context,incognito,impl,tools,index}.ts written, typecheck clean. next: unit tests test/unit/memory/*.test.ts
- [done] test/unit/memory/memory.test.ts (store: gates, fp, rotation, scoring, isolation). next: test/unit/memory/extract.test.ts (extraction, import, callbacks, context, incognito, tools)
- [done] test/unit/memory/extract.test.ts green; unit total 59 green. next: run foundation tests, then e2e memory/reminders
- [done] test/e2e/reminders.e2e.test.ts green (4) via test/unit/memory/e2eHarness.ts (real WP6a factories + pinned fakes). next: test/e2e/memory.e2e.test.ts
- [done] test/e2e/memory.e2e.test.ts green (4). next: gate (typecheck, all my tests, importRules), review for gaps
- [done] gate green: typecheck clean for my paths; unit memory/scheduler/reminders 61 + e2e 8 green; importRules/contracts green. Remaining foundation failures belong to other WPs (strings/surfaces/kv/registry). FINISHED.
