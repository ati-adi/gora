# WP2 progress
- started: reading specs
- read 04, 03, 01 §2 F2/§2.17/§4.1-4.5/§5.5/§5.7/§11.4/§15/§16, research grammy+telegram. next: read app.ts, services contract, harness
## PLAN (files, in order; mark done below)
1 render/{escape,time,sanitize,hygiene,split,fallback,cards,index}.ts  2 callbackCodec.ts  3 limiter.ts bot.ts flags.ts allowedUpdates.ts
4 inboxRepo.ts lanes.ts ingress.ts dispatcher.ts  5 outbox.ts links.ts files.ts topics.ts(+rename_topic job) commands.ts gateway.ts
6 channels/{common,dmStream,notify,group,guest,bizOwner,index}.ts  7 index.ts (createTelegramModule, privacy hook retention)
8 tests unit: sanitize cards callbackCodec topics ingress dispatcher outbox dmStream (+channels, split/hygiene) ; e2e webhook
Decisions: limiter enforce outside NODE_ENV=test (observe-only in test env so FakeClock e2e never deadlocks; unit tests use enforce).
 autoRetry (@grammyjs/auto-retry) outermost but bypassed for drafts/sendChatAction (U3 needs to see 429).
 codec: '<kind>:<parts…>:<mac12>' mac = 10 chars HMAC(owner-bound) + 2 chars unbound tag (not_owner vs bad_mac).
 Undo button = codec('ud',[undoId],tg); Listen = codec('vo',[runId],tg); Retry = codec('ct',[convId,'r'],tg) (WP7 owns ct).
 tg_updates payload sealed under 'sys' (AAD tg_updates|payload_enc|<id>); outbox payload under u:<userId> or 'sys'.
 polling loop not started in NODE_ENV=test (tests use webhookHandler).
- RESTART 21:34: no files existed. Re-read 04, contracts, spec sections. Decisions+: own Clock-based autoRetry (limiter.ts) instead of @grammyjs/auto-retry (real timers); WP7 owns bot handlers (callback router, stop, pcq); ingress answers pcq inline via bot.handleUpdate + safety answer; retry button = ct:<conv>:r. Writing render/* now.
- render/* (escape,time,sanitize,hygiene,split,fallback,cards,index), callbackCodec, limiter(+Clock autoRetry), bot, flags, allowedUpdates, commands, lanes, inboxRepo, dispatcher, ingress, outbox written. next: links, files, topics, gateway, channels, index
- links, files, topics, channels/{common,dmStream,notify,group,guest,bizOwner,index} written. next: gateway.ts + index.ts, then tests
- helpers.ts + dmStream.test.ts green (17). next: sanitize, cards, callbackCodec, topics, ingress, dispatcher, outbox, channels tests; e2e webhook
- sanitize(20) cards+codec(8) topics(6) green. next: outbox, ingress, dispatcher, channels tests, e2e
- outbox(13) ingress(7) dispatcher(8) green (fixed outbox wake loop). next: channels.test (notify/group/guest/biz), e2e webhook, typecheck tests
- channels.test(9) + e2e webhook(3) green. next: review gaps, full typecheck/test sweep, final answer
- DONE 22:05: all WP2 files written; unit 90/90 (10 files), e2e webhook 3/3, typecheck clean for WP2 paths, importRules green. Foundation testApp/freeze failures are integration (WP7 handlers/strings, registry, kv bot_flags pre-insert) — reported.
