# WP7a progress log
- 2026-09-28 17:17:35 started; read 04 handbook. Next: read spec sections + contracts.
- read 01 §2-3, §4.5, §10, §13, §15.2, §16, 03 fully, WP7 DDL. Next: read contracts + harness + app.ts, then plan files.
- read contracts, app.ts, harness (testApp/fakes/updates/fakeTelegram), 01 §5.5-5.9, §6, §9, §11.3/11.8/11.9, §12, §13, research. 
## PLAN (files, in order)
1 strings.ts (STRING_KEYS en+ru + private SURF catalog, tr()) 2 repo.ts (groups/guest_invocations/deeplink_tokens/choice_sets/subscriptions/payments SQL + DeepLink/Choice/Group/Guest services)
3 util.ts (send helpers: outbox card send/edit, idem keys, rate buckets) 4 payments.ts 5 onboarding.ts (M1-M9, NoticeService, ob:/tz: cbs, RunHook, kv state 'ob:<userId>')
6 location.ts 7 dm.ts (private ingest, edits, yes->reshowPending, import paste, name reply) 8 commands.ts 9 why.ts 10 guest.ts 11 group.ts (+/me, my_chat_member)
12 callbacks.ts (router + ch/pl/ct/dl/vo) 13 context.ts (group/onboarding/guest/location providers) 14 tools.ts (poll_create) 15 handlers.ts 16 index.ts (+privacy hook, subscription_reconcile job)
17 unit tests test/unit/surfaces/* 18 e2e tests (skip parts needing real WP3 while fallbacks used) 19 scripts/sim.ts
Decisions: mm forget button layout mm:fg:<id>; import card mm:imp:<id>:y|n + mm:imp:save:y; bizChat /start → next() to WP7b handlers; guest conv userId=null (DEK owner guest).
- RESTART 17:56: strings.ts done (CATALOG+SURF). Re-read 04, 03, §2-3, §10, §13, §15.2, contracts. Next: app.ts/harness, DDL WP7, then repo.ts.
- RESTART 18:57: strings.ts exists (376 lines). Re-reading context.
- RESTART 21:27: strings.ts exists. Reading 04 + contracts; then write repo.ts immediately.
- RESTART 3 (context re-read done). Decisions add: bizChat for new users → replay synthetic /start after consent via bot.handleUpdate (next() → WP7b). typed city during step tz = short text (≤40 chars, ≤4 words, no ?) geocoded, else normal chat. reshow current onboarding card at most once per step after a completed run. tz proposal kept in kv 'tzp:<userId>' (callback tz:y/tz:n/tz:ch/tz:skip). export = sendDocument blob in DM. group left → retentionSweep destroyOwner('grp:<id>') after 7d. pre_checkout dedupe per query id.
- writing now: repo.ts → util.ts → payments.ts → onboarding.ts → location.ts → dm.ts → commands.ts → why.ts → guest.ts → group.ts → callbacks.ts → context.ts → tools.ts → handlers.ts → index.ts
- repo.ts written
- util.ts, payments.ts written. next onboarding.ts
- onboarding.ts written (M1-M9, notices, ob:/tz:, runHook, interceptText, import). next location/dm/commands
- location.ts, dm.ts written. next commands.ts
- commands.ts written. next why.ts guest.ts group.ts
- why.ts written. next guest.ts group.ts
- guest.ts written. next group.ts
- group.ts written. next callbacks.ts context.ts tools.ts handlers.ts index.ts
- callbacks.ts written (router, ch, pl, ct, vo). next context.ts tools.ts handlers.ts index.ts
- tools.ts, context.ts written. next handlers.ts index.ts
- handlers.ts written. next index.ts
- index.ts written (all src files done). next: unit tests test/unit/surfaces/*
- unit tests strings/repo green. next: helpers.test.ts then e2e
- test/unit/surfaces/env.ts (createSurfacesApp) written. next: e2e onboarding
- onboarding.e2e written; running
- onboarding.e2e green (3 + 1 full-stack skipped until no fallbacks). next guest.e2e
- guest.e2e green. next group.e2e
- group.e2e green. next payments.e2e, why.e2e
- payments.e2e green. next why.e2e
- why.e2e green. next scripts/sim.ts
- scripts/sim.ts done (npm run sim prints M1-M9, 0 model requests). next: full typecheck, unit/e2e rerun, review gaps
- flows.test.ts green (29 unit total). next: final gate
- DONE (gate green): typecheck 0 errors in owned paths; unit test/unit/surfaces 29/29; e2e onboarding/guest/group/payments/why 16 pass + 2 full-stack skipped (auto-run once no NOOP fallbacks); importRules clean; npm run sim prints M1–M9 with 0 model requests.
- Known cross-WP notes: foundation testApp/freeze tests expect stub strings/surfaces (lead must pin NOOP createStrings/createSurfaces there); mm:imp:<id>:y|n / mm:imp:save and mm:fg:<id> callback formats need WP6a to handle.
