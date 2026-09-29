# s07-GR progress log (builder: group participant, spec 07 §C, plan 08 §5)

- step 0: read 07, 08; starting to read 04/05 and the code.
- step 1: read 04/05/08 §5, contracts (groups, services, storage GROUP_DATA_TABLES), migration 004, surfaces/group.ts,
  handlers.ts, strings.ts, memory/store.ts gate, side.structured, scheduler upsert semantics, harness (updates, fakes).
  Design decisions:
  - bandit: kernel/random.ts sampleBeta (bandit.ts thompson() is typed to proactive content types; not reusable).
  - addressed-reply group context: GroupParticipation has no method for it → groups impl exposes extra
    `recentContext()`; surface duck-types it (CONTRACT REQUEST logged).
  - bot's own addressed replies → onBotMessage via a run hook (conv.kind 'group') reading messages.last().
  - bot-left purge: groups can't read `groups` table (surfaces-owned) → retentionSweep purges chats whose 'g:<chatId>'
    DEK is destroyed (surfaces' sweep destroys grp:<chatId> after the 7-day grace).
- step 2: src/groups/{names,heuristic,repo,prompts,strings,ctx,feedback,chime,summary,catchup,observe,index,tools}.ts
  written; typecheck clean for src/groups.
- step 3: edited memory/store.ts (gate + label + createdBy 'extractor' for auto group facts), surfaces/{group,handlers,
  strings,commands}.ts, telegram/commands.ts (catchup, is_ephemeral), http/routes/me.ts (addToGroupUrl), webapp Home.tsx.
  Typecheck clean for my files (BR's src/browser/strings.ts has errors — not mine).
- step 4: test/harness/s07-gr.ts; test/unit/groups/{pure,module}.test.ts → 20/20 green. Next: e2e group-participant.
  Note: never t.clock.advance(days) in a started app (scheduler timers make it crawl); pass `now` to retentionSweep.
- step 5: test/e2e/group-participant.e2e.test.ts (10 tests) green together with group.e2e (4). Added /forget all|всё
  (purge + group facts forget) in surfaces/group.ts + SURF group_forget_all. Next: full gates.
- step 6: summaries now go INSIDE the untrusted wrap (model-written but derived from members' words); one wrap reused
  for judge+compose; same-second ordering fixed (catch-up uses (at, message id); summary coverage ends at last.at-1).
  Boot-time readsAll() in handlers.ts (C1 BotFather hint logged once at boot). e2e + no-DM catch-up deep link test.

CONTRACT REQUEST (GR-1): add to GroupParticipation
  `recentContext(chatId: number, o: { excludeTgMessageId?: number; threadId?: number | null }): string | null`
  — the recent group lines (+ rolling summary) for an addressed reply, added by the surface as ONE untrusted member
  input. Implemented in src/groups/index.ts (GroupParticipationImpl) and duck-typed in src/surfaces/group.ts until then;
  createRecordingGroupAgent() may add it (return null).
CONTRACT NOTE (GR-2): the plan's `thompson()` from behaviour/bandit.ts is typed to proactive content types/gap buckets;
  GR samples with kernel/random.ts sampleBeta (same injected Random, fixed draw order) in src/groups/feedback.ts.
- step 7 (DONE): gates with the other sets' current tree: `npm run typecheck` clean; `npm test` 213 files / 1207 tests
  green; `npm run test:e2e:strict` 29 files / 143 tests green. (Under load avg ≥ 13 a few day-advancing tests of other
  modules hit the 20 s timeout once; they pass on rerun — not GR code.)
  GR tests: test/unit/groups/pure.test.ts (13), module.test.ts (7), test/e2e/group-participant.e2e.test.ts (10);
  test/e2e/group.e2e.test.ts unchanged and green (privacy mode ON → mention-only).
  Other requests: webapp/src/lib/me.ts `Me.addToGroupUrl?: string | null` (Home.tsx casts meanwhile); webapp i18n keys for
  the Home add-to-group row (inline en/ru meanwhile).
