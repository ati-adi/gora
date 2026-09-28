# 04 — Foundation notes (WP0 handbook). Read this FIRST.

The contracts in `src/contracts/*.ts` are **frozen**. They are the source of truth for every signature. Where
01 §4.4 prints a type differently, the contract file wins. For behaviour, the precedence is 03 > 02 > 01. This file
lists what WP0 added or changed and how to build and test against it.

Status at freeze: `npm run typecheck` is clean, `npm test` passes 134 tests in 13 files, and `npm run test:e2e:strict`
passes 2 tests (`test/e2e/boot.e2e.test.ts`).

---

## 1. Ground rules

- Only edit files your WP owns (01 §16, split as in §9 below). Every stub file starts with `// STUB (WP0). Ownership
  passes to WPx`. Replace the whole file, but keep its exported names and signatures.
- Import cross-module types only from `src/contracts/index.ts`. Never import another WP's internals. The only runtime
  imports allowed across WPs are the kernel, `config.ts`, and the `TOOLS` arrays that `app.ts` collects.
- Contract changes after the freeze go through the integration lead. Do not widen or cast a contract type locally.
- Never read or print `.env`. Tests are offline: see §4.7.

---

## 2. Contract deltas vs 01 §4.4

Everything below is in the code. The doc comments in each contract file carry the details: search for `WP0 addition`.

**common.ts**
- `scopeKey(s)` / `parseScopeKey(k)` build and parse `'user:<id>'` or `'grp:<chatId>'`.

**llm.ts**
- `Priority` and `PRIORITY_ORDER` (03 R6), and `TransportOpts { priority? }` on `stream`, `create` and `parse`.
- `ProviderProfile` has two extra fields: `id` (`'anthropic' | 'groq-free' | 'groq-dev'`) and `sideMaxOutputTokens`.
- New types: `GroqRole`, `GroqClient`, `RateGovernor` (`acquire`/`observe`), `UsageNumbers`, `ZERO_USAGE`.
- `SidePurpose = triage|extract|import|title|semantic|handoff|make_file|summarize`. Each call site has its own
  purpose, because `ScriptedTransport.pushParse` is keyed by purpose.
- `CallMeta { userId?, conversationId?, runId? }` is `SideRequest.meta`. Use it for llm_calls attribution and the
  per-user cost cap.
- `StreamHandlers.onBlockStart` special signals (index −1): `{type:'retry'}` means discard the partial text of the
  current model call; `{type:'busy', name:'<seconds>'}` means show "Busy — retrying in Ns".

**agent.ts**
- `SideCalls` methods take an optional last parameter `meta?: SideCallMeta` (`CallMeta` + `priority`, default `'background'`).
- `AgentRunner.kick(conv, o?: { replyRef? })`: WP7 passes the replyRef for guest runs.
- `startEventRun(..., { priority? })`.
- `requestRotation(conv, reason, { excludeTexts? })`: the excluded texts stay in memory only.
- `GoraEvent.untrusted[]` holds raw parts. WP3 wraps them with `s.untrusted.wrap()`.
- `ToolkitState` (`load` / `active` / `userTurn`) is WP3's, over tables `conversation_toolkits` and `conversation_turns`.

**storage.ts**
- `KeyStore` (not defined in 01): `getOrCreate/get/destroy/destroyOwner/isDestroyed/rewrap/backup/close` plus
  `kekVersion`.
- `Crypto.ensureDek(dek, owner, purpose)`. The DEK owner rules are documented above `Crypto`. Epoch DEKs
  `e:<conv>:<n>` MUST be created with ensureDek, with owner = the conversation's userId, `'guest'` or `'grp:<chatId>'`,
  so that `destroyOwner(userId)` covers them. ConversationsRepo.create and startEpoch (WP1) do this.
- `UserRow.voiceReplies`. `UserSettings.homeCity: {name,lat,lon} | null`, read and written through
  `settings`/`updateSettings`.
- `UsersRepo.list({status?, afterId?, limit})` and `iterate({status?, batchSize?})` page by keyset in ULID order.
- `EpochReason` adds `'user_new'` (plain `/new`; `/new wipe` uses `'wipe'`).
- `ConversationsRepo.listByUser`.
- `InputRow.tgUpdateId`. `InputsRepo.add` is idempotent per (conv, tgUpdateId, untrusted). New methods: `get`,
  `byTgMessage`, `replaceUnconsumed`, `delete`, `consumedBy`.
- `RunRow`: `priority`, `visibleText`, `stopCategory`. `RunsRepo.create({priority?})`, `llmCallsFor`,
  `conversationsUsingFact`.
- `LlmCallPurpose` adds `search|vision|guard|sentinel|stt|tts`.
- `ReplyRef.continueUrl`.
- `USER_DATA_TABLES` covers every user-data table, including `business_drafts`, `conversation_toolkits` and
  `conversation_turns`. `via:'shred'` marks conversation-derived rows; `via:'hook'` marks payments (pseudonymized by
  WP7a).

**tools.ts**
- `ToolCtx.priority`.
- `ToolSpec.approvalMeta?(input, ctx)` returns `{card?, expiresAt?, sourceRefs?}`. The executor uses each returned
  field in place of its default.
- `ToolkitId`, `TOOLKIT_IDS`, `ToolDefinitions`.
- `ToolRegistry.toolkits()` and `subset(id, kits)`.
- `TOOL_OWNERS` and `TOOL_FILES`: see §5.

**trust.ts**
- `RoundOutcome.effects`.
- `Sentinel.decisionsFor(runId)`.
- `PendingActionView` gains `runId`, `conversationId` and `targets[]` (display + provenance). The step-up phrase is
  `ALWAYS <first word of targets[0].display>`.
- `ApprovalService.get(id, userId)` and `reshowPending(userId, chat)`: a typed "yes" re-shows the cards and never
  approves.
- New services: `UntrustedSource`, `UntrustedWrapper` (`wrap`/`redact`), `GrantService`, `TrustedTargetService`.

**telegram.ts**
- `OutboxMethod` adds `sendDocument|sendPhoto|sendVoice|editForumTopic|deleteMessage`. Binary payloads carry
  `payload.blob_id` (a `MessagesRepo.putBlob` id) plus `filename`, never bytes or base64. Inline messages are edited
  with `editMessageText` / `editMessageReplyMarkup` plus `payload.inline_message_id` and `chatId: 0`.
- `Outbox.flush()`.
- `CallbackKind` adds `'vo'`.
- `TopicManager.lookup`. `TgLinkRow.part`, `TgLinks.byRun`.
- `ReplyChannel.blockStart(b)` is required. The engine forwards every transport `onBlockStart` to it.
- `TelegramModule.dispatcher.lagMs()`.
- `ALLOWED_UPDATES_ALL` and `allowedUpdates({business, guest})`, shared by WP2 ingress and WP1's admin `set-webhook`.

**scheduler.ts**
- `JobKind` adds `backup` and `nudge_deferred`.
- `JOB_LLM_PRIORITY` (03 R6): before claiming a job with a non-null priority, the scheduler asks
  `s.llmBudget.allow(p)`.
- `Scheduler.list({userId, kinds?, limit})` and `health(): {lastTickAt}`.

**memory.ts**
- `getMany(scope, ids)` and `filterFingerprinted(scope, sentences)`.

**proactive.ts**
- `TodoService.setDone` (idempotent).
- `NUDGE_KINDS`, `NudgeService.get`, `prefs(userId)` and `setPref(userId, kind, {muted?, snoozeUntil?})`.
- `MissionView`, `MissionService.get/list/setStatusLine`. `WatcherView`, `WatcherService.list`.

**capabilities.ts**
- `SpeechToText.transcribe` (`caps.stt`) takes `priority?` and `meta?`, and returns `noSpeech?`.
- `MakeFileType` adds md/txt/json.
- 03 R7 capabilities: `search`, `vision`, `pdfText`, `tts`, `guard` (`score(text, {priority?, userId?, runId?})`)
  and `llmSentinel`, plus `LlmBudget`.
- `LocationService` (on `caps.location`, also `s.location`).

**integrations.ts**
- `IntegrationService.provider`: WP5 MUST use a passed provider as-is and expose it. `testApp.restart()` hands it to
  the next App.
- `sendConnectCard(userId, kind, chat, reason?)` and `devConnect(state)`.

**business.ts**
- `BizChatView.priority`. `BusinessService.context()` returns `windowExpiresAt`.
- `connection`, `updateChat`, `noteNoDraft`.

**billing.ts**
- `QuotaService.recordUsage`, `recordRefusal`, `cooldownUntil` and `registerCounter('mission'|'watcher', fn)`.
- `PaymentsService.status` and `refund(tgUserId, chargeId)` (idempotent; used by admin `refund`).

**ledger.ts**
- `LedgerKind` adds `'guard_block'`.

**i18n.ts (new)**
- `UiLang`, `uiLang(code)` (ru/uk/kk/be → ru, everything else → en), `STRING_KEYS` (key → `{en, vars, who,
  audience}`), `StringKey` and `Strings.t(key, lang, vars?)`.
- WP7a implements it in `src/surfaces/strings.ts` `createStrings()`, with en + ru for every key.
- Every other WP uses `s.strings.t(...)`. Module-private text that no other WP needs may stay local, choosing its
  language with `uiLang()`.

**services.ts**
- `PrivacyHook.exportUser?` and `retentionSweep?`. `RunHook` and `s.runHooks`.
- New services: `NoticeService`, `DeepLinkService`, `ChoiceService`, `GroupService`, `GuestService`.
- `Services` fields: `caps` and `capabilities` (the same object), `llmBudget`, `rateGovernor`, `groq`, `profile`,
  `toolkits`, `untrusted`, `grants`, `trustedTargets`, `location`, `notices`, `deepLinks`, `choices`, `groups`,
  `guests`, `strings` and `keyStore`.
- Module shapes: `AgentModule`, `TrustModule`, `ReminderModule`, `ProactiveModule`, `MissionModule`,
  `SurfacesModule` (WP7a), `BusinessModule` (WP7b), `LlmGovernance`, `TelegramModuleOptions` and `Factories`.

**config.ts**
- `Config.backupDir` (`BACKUP_DIR`, default `./backups`; refused under DATA_DIR in production) and
  `features.voiceReplies`.
- `STT_PROVIDER=auto` is the default.
- With a bot token, a non-test boot that lacks GORA_KEK, GORA_CALLBACK_KEY and GORA_HASH_KEY is refused unless
  `ALLOW_INSECURE_DEV_KEYS=1`.
- `resolveProfile()` returns the demo transport when a key is missing (never in production).

**kernel/errors.ts**
- `BadRequestLlmError(message, requestId, code)`. `code` is, for example, `'prompt_budget'` or `'tool_use_failed'`.

---

## 3. Factory wiring (`src/app.ts`)

`createApp(opts)` fills `const s = {} as Services` in this order:

1. `strings` (`createStrings`), `keyStore`, `privacyHooks = []`, `contextProviders = []`, `runHooks = []`.
2. `s.telegram` = a **pre-gateway**. It exposes only `callbacks` (the final registry) and a buffering `outbox.onSent`.
   Any other property throws.
3. `crypto`, `repos`, then **`scheduler`** and **`quotas`** (early, so that later factories can register with them),
   `ledger`, `privacy`.
4. `groq` (the single client, only if GROQ_API_KEY is set; always `null` under NODE_ENV=test, even with
   `LLM_PROVIDER=groq`), `createLlmGovernance` → `rateGovernor` / `llmBudget`,
   then `transport` (the test transport when one is injected).
5. `caps` (`capabilities`), `integrations` (`createIntegrationService(s, opts.integrationProvider)`), `location`.
6. `registry = createToolRegistry(profile, EXTERNAL_TOOLS)`.
7. trust → memory → reminders (reminders, todos) → proactive (nudges, brief, commitments) → missions (missions,
   watchers) → agent (runner, conversations, side, toolkits).
8. `await createTelegramModule(s, {transformers, botInfo, fetchImpl, callbacks, sentHooks})` → `s.telegram` =
   the real gateway.
9. `createBusinessModule(s)` (WP7b) → `s.business`, then `createSurfaces(s)` (WP7a) → payments, notices,
   deepLinks, choices, groups and guests.
10. `surfaces.registerHandlers(bot)`, then `business.registerHandlers(bot)`, then `createHttpApp(s, tg)`.

`app.start()` starts ingress, runs `runner.recover()`, then starts the scheduler, the outbox and the dispatcher.
`app.stop()` stops, in order: ingress, scheduler, `runner.shutdown(grace)`, dispatcher, outbox flush (≤ 5 s), outbox
stop, then closes the DBs.

**Timing rule.** A factory may keep `s`, but it may dereference `s.<x>` only at call time. The exceptions below are
allowed at factory time, because each target exists before the first module factory runs:

| What | How |
|---|---|
| Job handlers | `s.scheduler.register(kind, h)` |
| System cron jobs | `s.scheduler.schedule({..., dedupeKey: 'sys:<kind>'})` (an idempotent upsert, e.g. backup, retention_sweep) |
| Callbacks | `s.telegram.callbacks.register(kind, h)` |
| Outbox sent hooks | `s.telegram.outbox.onSent(refKind, hook)`. The pre-gateway buffers it; WP2 MUST install every buffered hook before `outbox.start()` (the array is live) |
| Context providers | `registerNamed(s.contextProviders, p)` (kernel/registries.ts; throws on a duplicate name) |
| Privacy hooks | `s.privacyHooks.push(h)` |
| Run hooks | `s.runHooks.push(h)`. WP3 calls them after finalize for done, refused and failed runs, not parked ones |
| Quota counters | `s.quotas.registerCounter('mission' \| 'watcher', fn)` (WP6b) |
| UI strings | `s.strings.t(...)` (built first) |
| **Tools** | never registered at runtime. Export `TOOLS: readonly ToolSpec[]` from your `tools.ts` (§5) |

Anything else touched at factory time, such as `s.telegram.api` or `s.runner`, throws or is `undefined`.

---

## 4. The test harness (`test/harness/*`)

### 4.1 createTestApp(options) → TestApp

```ts
const t = await createTestApp({ env?: {LLM_PROVIDER:'groq'}, config?: DeepPartial<Config>, now?, factories?, noopFallback?,
                                 integrations?, llm?, tg?, clock?, log?, dir?, start? /* default true */ });
t.s / t.app / t.tg / t.llm / t.clock / t.config / t.dir
await t.userSends('hi', {user?, threadId?, replyTo?});   await t.send(U.voice());   await t.tap(callbackData, {messageId?});
await t.pressStop();  t.lastCard() // {messageId, markdown, buttons}
await t.api('GET', '/api/…', body?, {initData?, user?}) // signed initData by default; initData:null → no auth header
await t.advance(ms)   // FakeClock + scheduler.tick() + settle()
await t.settle()      // loops dispatcher.drain / runner.idle / outbox.flush until quiet
const t2 = await t.restart()  // same files, FakeTelegram and ScriptedTransport; a new FakeClock at the same time (use t2.clock); integration provider kept
await t.close()
```

- **noopFallback** (default true): a factory that throws `NotBuiltError` (a stub) falls back to `NOOP_FACTORIES` in
  `fakes.ts`. `t.app.fallbacksUsed` lists which factories did. Pass `noopFallback: false` to require real factories.
- **Pin the fakes you rely on.** Once another WP merges, its real factory replaces the fake automatically. If your
  test depends on a fake's behaviour, pass it explicitly, for example
  `factories: { createStrings: createFakeStrings, createAgentModule: ... }`. The fake strings echo keys
  (`'busy_retrying(seconds=12)'`), so assert on keys only when the fake is pinned.

### 4.2 Fakes (`fakes.ts`)

- **Capabilities:** `createFakeCapabilities`, which bundles FakeSTT, FakeWeather, FakeFx, FakeGeo, FakeSafeFetch,
  FakeCodeFiles, FakeMediaIngest, FakeSearch, FakeVision, FakePdfText, FakeTts, FakeGuard, FakeLlmSentinel and
  FakeLocation. Also `FakeLlmBudget`, `FakeRateGovernor` and `createFakeGovernance`.
- **Storage:** `createFakeKeyStore` (`.deks`, `.backups`), `createFakeCrypto`, `dekOwner`, `createMemoryCoreRepos`,
  `createMemoryKv`, `createFakeLedger` (`.entries`), `createFakeQuotas`, `createFakePrivacy`, `createFakeScheduler`
  (`.jobs`, `.ran`, `.kinds()`).
- **Agent:** `createFakeRunner` (`.kicks`, `.kickOpts`, `.events`, `.wakes`, `.rotations`), `createRefusingTransport`,
  `createMemoryToolkitState` (`.bumpTurn`).
- **Tools and trust:** `createStaticRegistry(specs, toolsets?)`, `createEmptyRegistry`, `toolInputSchema`,
  `createPassThroughExecutor(s)` (`.executed`), `createFakeUntrusted` (`.calls`), `createMemoryTrustedTargets`.
- **Telegram:** `createFakeTelegramModule` (a real grammY `Bot` over the fake transport), `createFakeOutbox`,
  `createFakeRenderer`, `createFakeCodec` (no MAC; for boot tests only), `createMemoryLinks`.
  `createRecordingChannelFactory()` keeps every channel in `.channels`; each records its calls in `.log`: text, status, `blockStart` (a retry
  drops pending text; busy logs status `busy:<s>`), commit, checkpoint (`.flushed`) and finalize.
- **Surfaces and HTTP:** `createRecordingNotices`, `createMemoryDeepLinks`, `createMemoryChoices`,
  `createMemoryGroups`, `createRecordingGuests`, `createFakeIntegrations(publicUrl, provider)` (`.connectCards`),
  `createFakeHttpApp` (`/healthz` reports `lastTickAt` and `inboxLagMs`), `createFakeStrings` (`.calls`).
- **Helpers:** `notImplemented<T>(name, partialImpl)` is a proxy: every member you did not supply is a method that
  throws `NotBuiltError('fake', '<name>.<member>')` when called.

### 4.3 FakeTelegram (`fakeTelegram.ts`)

- `t.tg.calls: TgCall[]` records every Bot API call as `{method, payload, at, result?, error?}`.
- `byMethod('sendMessage')` returns the payloads of one method. `callsOf(...methods)` returns the calls of several
  methods, in order.
- `failNext(method, {error_code, description, parameters?}, times?)` and `setResult(method, fn)` script errors and
  results.
- `addFile(fileId, bytes, filePath?)` registers a download. `t.tg.fetch` serves only those file downloads.
- `lastDraftId()` and `reset()`.
- The transformer is installed innermost, so the calls are recorded whether WP2's real module or the fake module is
  in use.
- `TEST_TOKEN`, `TEST_BOT_INFO`.

### 4.4 ScriptedTransport (`scriptedTransport.ts`)

```ts
t.llm.push(turn().thinking().text('Checking…').toolUse('weather_get', {place:'Almaty'}, 'toolu_1'));  // stop 'tool_use' implied
t.llm.push(say('It is 12°C.'));
t.llm.push(turn().signal('busy', '12').text('ok'));                  // onBlockStart({index:-1,type:'busy',name:'12'})
t.llm.push(turn().text('partial').signal('retry').text('clean'));    // {index:-1,type:'retry'}; blocks before it are dropped from the final message
t.llm.push(turn().error('bad_request', 'too big', {code:'prompt_budget'}));   // BadRequestLlmError.code
t.llm.push(turn().error('rate_limit'));   // TransientLlmError; also 'overloaded'|'server'|'connection'; 'json' → JsonInputError
t.llm.pushParse('triage', {...});  t.llm.pushParse('make_file', null /* parsed:null */);
```

- Other builder methods: `serverSearch`, `fallback(from,to)`, `compaction`, `stop(reason)`,
  `refusal(category?, {midStream?})`, `hang()`, `delay(ms)`, `usage({...})`, `expect(req => ...)`, and
  `error(kind, message?, {code?})` placed after some blocks (it throws after emitting them).
- Recorded calls: `requests` (from stream), `createRequests`, `parseRequests`, `callOpts` (`{kind, opts}`, so you
  can assert the priority), `files`, and `remaining()`.
- `parse()` validates a scripted value against `req.schema` and throws if it does not match. With nothing scripted
  for a purpose, it returns `{parsed:null, stopReason:'no_script'}`.
- `t.llm.assertInvariants({provider?:'groq', epochKey?})` runs `invariants.ts` over every request:
  - grammar checks G1–G3, G5 and G7;
  - G8: no bot token and no `api.telegram.org`;
  - no `@blob:` references;
  - no temperature, top_p, top_k or tool_choice, and never `thinking:disabled`;
  - anthropic: `fallbacks:'default'`, the fallback beta, and at most 4 cache markers, each with a 1 h TTL;
  - groq: no cache markers at all;
  - the byte-exact prefix holds per epoch;
  - system and tools are byte-identical per toolset, where requests are grouped by the sorted tool names.

### 4.5 Clock, DB and updates

- **Clock:** `FakeClock` (`src/kernel/clock.ts`) starts at 2026-09-28 09:00 UTC. Methods: `now`, `setTimeout`,
  `sleep`, `advance(ms)`, `set(at)`, `pending()`, `nextAt()`. Also `flushMicrotasks()`.
- **DB:** `openTmpDb({dir?, migrate?, now?})` → `{db, dbPath, keysDbPath, backupDir, close, cleanup}`. Pass
  `dir` again to reopen the same files. Also `makeTmpDir`, `tmpPaths`, `removeDir`.
- **Update builders:** `U.*` in `updates.ts`, all typed grammY `Update`s:
  - private chat: `privateText`, `command`, `start`, `voice`, `videoNote`, `audio`, `photo`, `document`, `forward`,
    `replyToCard`, `location`, `liveLocationEdit`, `editedText`;
  - topics: `topicMessage`, `forumTopicCreated`;
  - payments: `successfulPayment`, `preCheckoutQuery`, `subscription`;
  - groups: `groupMention`, `groupReply`, `groupText`, `groupCommand`, `ephemeralMe`;
  - guest: `guestMessage`;
  - business: `businessConnection`, `businessMessage`, `editedBusinessMessage`, `deletedBusinessMessages`;
  - other: `callbackQuery`, `stoppedGeneration`, `messageReaction`, `myChatMember`.
- **Test users:** `TEST_USER` (1001, en), `OTHER_USER`, `RU_USER`, `TEST_GROUP_ID`.
- **Mini App auth** (`initData.ts`): `signInitData(user, {authDate, token?, ...})`, `tamperInitData`, `staleInitData`
  and `verifyInitData`. The signing recipe matches 01 §12 (`hash` is excluded; `signature` is kept).

### 4.6 Fixtures (`test/fixtures`)

- `redTeam()` returns injections covering all 9 untrusted sources: email, web, calendar, business_peer, forward,
  group_member, guest_reply, file and import.
- `MEDIA` (pdf/png/transcript), `fixtureBytes`, `fixtureText`.
- `wire/` and `sse/` belong to WP3.

### 4.7 Offline guard

`setup.ts` runs for every test. It replaces global `fetch` with one that throws `NetworkDisabledError`, and it blocks
TCP connects to non-loopback hosts, which also covers grammY's node-fetch and `node:https`. Adapters must take
`fetchImpl` by injection. In tests, `t.tg.fetch` serves Telegram file downloads.

---

## 5. Tool ownership

`TOOL_OWNERS` and `TOOL_FILES` in `contracts/tools.ts` are authoritative. Tool names MUST match them.

| WP | File exporting `TOOLS` | Tools |
|---|---|---|
| WP4 | `src/trust/tools.ts` | `revise_pending_action`, `task_wait` |
| WP5 | `src/tools/impl/*.ts` (imported by WP5's own registry, not via TOOLS) | web_search, web_fetch (server tools on anthropic, client tools on groq), calendar_* (6), gmail_* (4), fx_convert, integration_connect, ledger_query, location_request, make_file, offer_choices, react, settings_update, share_place, time_resolve, weather_get, use_toolkit |
| WP6a | `src/memory/tools.ts`, `src/reminders/tools.ts` | memory_forget/save/search; reminder_create/list/manage, todo_manage |
| WP6b | `src/missions/tools.ts` | mission_start/report/finish, watcher_create/manage |
| WP7a | `src/surfaces/tools.ts` | poll_create |
| WP7b | `src/surfaces/business/tools.ts` | business_draft_reply, business_list_chats, business_read_chat |

- `app.ts` concatenates the six `TOOLS` arrays into `EXTERNAL_TOOLS` and calls
  `createToolRegistry(profile, EXTERNAL_TOOLS)`. The registry throws on a duplicate name.
- Only `src/trust/executor.ts` may call `spec.execute` or `spec.undo`.
- `execute` MUST be idempotent per `ctx.idemKey`. A tool that can be asked MUST have `renderDiff`.
- Tools never wrap their own output: the executor does, using `outputTaint` / `ToolOutput.untrusted`.

---

## 6. Typecheck and test only your part

```sh
npx tsc -p tsconfig.json 2>&1 | grep -E '^(src/agent/|test/unit/agent/)'   # whole project in seconds (TS 7); filter to yours
npm run typecheck                                    # the merge gate: server/tests + webapp
npx vitest run --project unit test/unit/agent        # one folder
npx vitest run --project unit test/unit/agent/engine.test.ts -t 'parks on ask'
npx vitest run --project e2e test/e2e/approvals.e2e.test.ts
npm test          # unit gate (test/unit/**/*.test.ts)
npm run test:e2e  # e2e (still --passWithNoTests);  npm run test:e2e:strict → the final gate, no flag
```

- Put unit tests in `test/unit/<module>/*.test.ts`. Put e2e tests in `test/e2e/<name>.e2e.test.ts`; the suffix
  matters.
- `test/unit/foundation/*` stays green: the import rules scan all of `src/`, so your code is checked there too.

---

## 7. importRules conventions (`test/unit/foundation/importRules.test.ts`)

| Rule | What is enforced |
|---|---|
| no-global-fetch | Never call `fetch(`, `globalThis.fetch`, `globalThis['fetch']`, or use bare `fetch` as a value. Adapters take `fetchImpl`; only `main.ts` and `app.ts` may pass `globalThis.fetch` |
| timers-via-clock | `setTimeout/setInterval/setImmediate`, `Date.now()`, `new Date()`, `performance.now()`, `AbortSignal.timeout()` and `node:timers[/promises]` are allowed only in `src/kernel/clock.ts`. Use `s.clock` (`now`, `setTimeout`, `sleep(ms, signal)`). `new Date(ms)` with an argument is fine |
| execute-only-in-executor | `.execute(` and `.undo(` only in `src/trust/executor.ts`. **The UndoService is always called as `undo.undo(...)`** (e.g. `s.undo.undo(id, tgId)`), which the rule allows |
| anthropic-sdk-runtime-import | Only `src/agent/transport.ts`. Type-only imports are fine anywhere |
| groq-sdk-runtime-import | Only `src/agent/groq/`, `src/capabilities/groq/` and `src/kernel/groqClient.ts`. **Groq STT/TTS/vision/guard live in `src/capabilities/groq/`** |
| groq-client-construction | `new Groq(` only in `kernel/groqClient.ts`. Use `s.groq` |
| telegram-file-url | `/file/bot` and `api.telegram.org/file` only in `src/telegram/files.ts` |
| erasable-only | No enums, namespaces, parameter properties, decorators or `import x = require` |
| ts-import-specifiers | Relative imports end in `.ts` (or `.tsx` / `.json`) |
| no-await-in-tx | Never `db.tx(async ...)`. `tx` is synchronous; a returned Promise rolls back and throws |
| no-secret-logging | No `initData`, `initDataRaw`, `botToken`, `bot_token` or `apiKey` keys in `.debug/.info/.warn/.error({...})` log objects |
| sql-table-ownership | SQL naming a table (upper-case keywords anywhere, or any-case keywords with SQL context such as `select * from users where`) only inside the owner's dirs (below). `contracts/storage.ts` and `src/privacy/` are exempt |

SQL table owners: `src/db/repos/`, `keystore.ts`, `crypto.ts`, `ledger/`, `billing/` and `privacy/` (WP1) own the core
tables of 01 §7.2. `src/telegram/` owns tg_updates, outbox, tg_links and topics. `src/agent/` owns
conversation_toolkits, conversation_turns and llm_rate_daily. `src/trust/` owns the WP4 tables. `src/tools/`,
`capabilities/` and `integrations/` own connections, oauth_states, anthropic_files and location_state. The WP6 dirs
own the WP6 tables. `src/surfaces/` owns the WP7 tables, including business_drafts.

The rule does not enforce the 6a/6b and 7a/7b splits. Keep to your own tables:
- WP6a: memory_*, extraction_watermarks, reminders, todos, todo_messages, jobs.
- WP6b: missions, watchers, nudges, nudge_prefs, commitments.
- WP7b: business_*.

Other conventions:
- AAD is `'<table>|<column>|<row key>'`.
- HMAC domains are `content|target|fp|ledger|chat_ref|anthropic-user` (+ `diff`, `input` for WP4).
- Job payloads hold ids and enums only.
- Log objects never carry message text.

---

## 8. DDL additions (`src/db/migrations/001_init.sql`, marked `-- WP0:`)

- `users.voice_replies`.
- `user_settings.home_city_enc` (sealed JSON `{name,lat,lon}` under `u:<userId>`).
- `tg_links.kind` adds `'voice'`.
- `epochs.reason` adds `'user_new'`.
- `conversation_inputs.tg_update_id`, the unique partial index `inputs_update(conversation_id, tg_update_id,
  untrusted)` and the index `inputs_tg_message`.
- `runs.priority` (CHECK over the 5 priorities). `runs.visible_text_enc` and `runs.stop_category` are in 01's DDL
  and are now on `RunRow`.
- `llm_calls.purpose` adds `search|vision|guard|sentinel|stt|tts`.
- `business_drafts(conversation_id PK → conversations, connection_id, chat_id, message_ids_json, created_at)` (WP7b).
- 03 R7 tables: `conversation_toolkits` and `llm_rate_daily` (+ `rpd_limit`, `reset_at`, `updated_at`).
- `conversation_turns(conversation_id PK, user_turns)` (WP3).
- Reserved kv keys: `bot_flags`, `commands_hash`, `polling_offset`, `vision:<sha>`, `pdf:<sha>`, `guard:<sha>`.

`001_init.sql` was edited in place: no database exists yet. After the freeze, schema changes go in `002_*.sql`
through the lead.

---

## 9. Per-WP checklist: what exists for you

Registrations are made in your factory, using the timing rule in §3.

Job owners:
- WP1: `shred_epoch`, `retention_sweep`, `backup`.
- WP2: `rename_topic`.
- WP3: `run_wake`, `resume_run`, `epoch_rotate`, `handoff_fork`.
- WP4: `approval_expire`.
- WP5: `first_look`.
- WP6a: `reminder_fire`, `checkin_fire`, `memory_extract`, `incognito_end`.
- WP6b: `brief`, `proactive_scan`, `nudge_ignore`, `nudge_deferred`, `watcher_check`, `followup_due`.
- WP7a: `subscription_reconcile`.
- WP7b: `business_triage`, `business_window`, `business_digest`.

Callback owners:
- WP4: `a1`, `ud`.
- WP5: `cn`.
- WP6a: `mm`, `rm`, `td`.
- WP6b: `ng`, `ms`, `wt`.
- WP7a: `ob`, `ch`, `pl`, `ct`, `tz`, `dl`, `vo` (03 R4/R8: the 🔊 Listen tap; WP2 only renders the button).
- WP7b: `bz`.

**WP1 (storage, crypto, ledger, billing, privacy, admin)**
- Implement `openKeyStore`, `createCrypto` (with `ensureDek`), `createCoreRepos`, `createLedger`,
  `createQuotaService` and `createPrivacyService`.
- ConversationsRepo.create and startEpoch call `crypto.ensureDek('e:<id>:<n>', owner, 'epoch')`.
- Implement `UsersRepo.list/iterate`, `homeCity` and the new Inputs and Runs methods.
- Deletion follows `USER_DATA_TABLES` in order. It honours `via:'shred'` (shred tokens first) and `via:'hook'`
  (never DELETE), and calls the privacy hooks.
- Upsert the `sys:backup` job: `KeyStore.backup` + gora.db backup into `config.backupDir`, 7-day retention.
- Admin CLI: `set-webhook` uses `allowedUpdates(config.features)`; `refund` calls `s.payments.refund`.
- Tests: `test/unit/{db,privacy}/*`, `test/e2e/privacy.e2e.test.ts`. Pin the fakes you rely on with `factories`.

**WP2 (Telegram)**
- `createTelegramModule(s, o)`: install `o.transformers` innermost, then the limiter and autoRetry. The gateway MUST
  expose `o.callbacks`. Install every `o.sentHooks` entry before `outbox.start()`.
- Outbox methods include the binary sends (`payload.blob_id`), `editForumTopic` and `deleteMessage`.
- `dispatcher.lagMs()` backs /healthz.
- Channels implement `blockStart` (retry → `resetIteration`; busy → the `busy_retrying` string).
- Ingress uses `allowedUpdates(features)`.
- Use `s.strings` for `stopped`, `busy_retrying`, the `*_button` keys and `slow_down`.
- Voice reply on DM finish (03 R4/R8): `sendVoice` with `payload.blob_id`; longer answers get the `listen_button`
  with callback `vo:<runId>`, whose handler is WP7a's.

**WP3 (agent)**
- `createTransport` (anthropic/groq/demo), `createLlmGovernance` and `createAgentModule`, including `ToolkitState`.
- Forward every `onBlockStart` to `ch.blockStart`.
- Wrap untrusted inputs and event parts with `s.untrusted.wrap`.
- Call `s.runHooks` after finalize.
- Record usage with `CallMeta` and `quotas.recordUsage`.
- Map `BadRequestLlmError.code` (`prompt_budget` → the plain reply `prompt_budget`; `tool_use_failed` → retry).
- `runs.priority` flows into every transport call.
- Use the `SidePurpose`s `handoff` and `summarize`.

**WP4 (trust)**
- `createTrustModule`: sentinel (with `decisionsFor`), approvals (with `get` and `reshowPending`), executor
  (`RoundOutcome.effects`, `ToolSpec.approvalMeta`), undo, step-up (the phrase comes from `targets[0].display`),
  untrusted (03 R5 guard thresholds), grants and trustedTargets.
- `trust/tools.ts` TOOLS.
- The `a1`/`ud` callbacks and the `approval_expire` job.

**WP5 (tools, capabilities, integrations)**
- `createToolRegistry(profile, external)`: throw on duplicates; implement `toolkits()` and `subset()`.
- All `src/tools/impl/*` tools.
- `createCapabilities(cfg, fetchImpl, s)`, including the Groq capabilities in `capabilities/groq/` (record llm_calls
  via `meta`) and `location`.
- `createIntegrationService(s, provider?)`: use a passed provider as-is and expose it as `.provider` (restart relies
  on this). Also `sendConnectCard` and `devConnect`.
- `make_file` on Groq uses parse purpose `make_file`. `weather_get` falls back to `settings.homeCity`.

**WP6a (memory, scheduler, reminders)**
- `createScheduler`: `register/schedule/list/health/tick`. Check `JOB_LLM_PRIORITY` against `s.llmBudget.allow`
  before claiming.
- `createMemoryService`, including `getMany` and `filterFingerprinted`; forget calls `s.runner.requestRotation(...,
  {excludeTexts})`.
- `createReminderModule`: todos with `setDone`; the display uses `formatDisplay`.
- Tools in `memory/tools.ts` and `reminders/tools.ts`.

**WP6b (proactive, missions)**
- `createProactiveModule`: NudgeGate; `nudge_deferred` scheduled at `nextOutsideQuiet` + jitter; `prefs` and
  `setPref`; `NUDGE_KINDS`; brief (weather from `homeCity`); commitments.
- `createMissionModule`: `get`, `list` and `setStatusLine`. Register the quota counters
  `registerCounter('mission' | 'watcher')`.
- Tools in `missions/tools.ts`.
- The unanswered_business signal reads `BizChatView.priority`.

**WP7a (surfaces)**
- `src/surfaces/strings.ts` `createStrings()`: en + ru for every `STRING_KEYS` entry. Keep the placeholders
  (`freeze.test.ts` checks the catalog's placeholders; WP7a should add a test that en and ru both cover every key).
- `createSurfaces`: handlers, commands (`/new` → `'user_new'`), onboarding, payments (`status`, `refund`), notices,
  deepLinks, choices, groups and guests.
- The DM handler calls `s.approvals.reshowPending` when the user types "yes".
- The `homeCity` writer (onboarding, tz card, /settings).
- The `/voice` command and the `vo` callback (03 R8).
- `poll_create` in `surfaces/tools.ts`.

**WP7b (business)**
- `createBusinessModule` in `src/surfaces/business/index.ts`: `business` (`connection`, `updateChat`,
  `noteNoDraft`, `priority`) and `registerHandlers`.
- The `bz` callback, the business jobs and the privacy hook.
- `business_drafts` rows. On `deleted_business_messages`, shred those drafts and call `voidBySourceRef('bizmsg:…')`.
- Tools in `surfaces/business/tools.ts`.

**WP8 (Mini App)**
- `createHttpApp(s, tg)`: `/healthz` checks `s.scheduler.health().lastTickAt` (within 10 s) and
  `tg.dispatcher.lagMs()` (under 30 s).
- `/dev/fake-connect` → `s.integrations.devConnect(state)`.
- The API routes use `todos.setDone`, `nudges.prefs/setPref`, `approvals.get`, `missions.list`, `watchers.list`,
  `scheduler.list`, `payments.status`, `grants`, `trustedTargets` and `conversations.listByUser`.
- Test with `t.api(...)` and `signInitData`.
