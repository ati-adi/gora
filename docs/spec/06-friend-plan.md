# 06: Friend mode, the build plan (planner output for spec 05)

**Binding:** 05 > 03 > 02 > 01. This file splits spec 05 into three builder sets that can run in parallel with **disjoint
file ownership**:
- **P**: persona, first contact and minimal UI.
- **M**: the memory engine.
- **B**: behaviour and proactive policy.

The foundation (§1) is already in the tree. Typecheck is clean, `npm test` passes 976 tests and
`npm run test:e2e:strict` passes 101. Read §0 and §1, then only your own set.

---

## 0. Rules for every builder

1. **Ownership.**
   - Edit only the files your set owns (§3, §4 and §5). New files go under your set's directories.
   - Everything in §0.4 is **planner-owned**: do not edit it. If you need a contract change, append a
     `CONTRACT REQUEST:` entry to your progress log (`docs/progress/friend-<P|M|B>.md`). Until it is applied, work
     against the current contract and use a local adapter.
2. **Environment.**
   - The bot runs live via `scripts/dev-tunnel.sh` on `./data` and `./keys`. Never touch `./data` or `./keys`, never
     start a bot instance, never call the Telegram API, and never read `.env`.
   - Tests use fakes only. There are no live LLM calls, and no real model loads: in tests, `EMBEDDINGS_PROVIDER` is
     forced to `fake`.
3. **Code rules** (04 §7 still applies). The foundation added two importRules:
   - **Erasable TypeScript only.** Relative imports end in `.ts`.
   - **Timers through `s.clock`.**
   - **Randomness only through `s.random`.** The rule `no-math-random` bans Math.random anywhere in `src/`.
   - **Only `src/capabilities/embedder.ts` imports `@huggingface/transformers`.** The rule is
     `transformers-runtime-import`.
   - **SQL table ownership** (enforced):

     | Tables | Owner |
     |---|---|
     | `user_profile`, `fact_embeddings` | `src/memory/` |
     | `user_signals`, `user_rhythm`, `proactive_arms`, `proactive_log` | `src/behaviour/` |
     | `users`, `user_settings`, `consents` | `src/db/repos/` only: go through `s.repos.users` |
   - **Timing rule.** Factories may register at factory time (jobs, callbacks, context providers, hooks, sent hooks).
     Every other `s.<x>` is dereferenced at call time.
   - **Logs never carry message text.** `user_signals` stores numbers and enums only.
4. **Planner-owned (frozen):**
   - `src/contracts/**`. Exception: **P** may add `STRING_KEYS` entries in `src/contracts/i18n.ts`.
   - `src/app.ts` and `src/config.ts`.
   - `src/db/migrations/**`, `src/db/repos/**`. Exception: **P** may make the one-line `onboarding_step` change in
     `src/db/repos/users.ts` (§3).
   - `src/kernel/**`.
   - `test/harness/**`. Put extra fakes in a NEW file `test/harness/friend-<set>.ts`, which you own.
   - `test/unit/foundation/**`.
   - `package.json`, `package-lock.json`, `Dockerfile`, and `src/telegram/outbox.ts` (the `onBlocked` hook is done).
5. **Gates.**
   - Each builder keeps `npm run typecheck`, `npm test` and `npm run test:e2e:strict` green.
   - An existing test that your spec change legitimately invalidates is yours to update only when it lives in your
     set's test files (listed per set). Otherwise, log a request.
6. **Resumable.** Keep `docs/progress/friend-<P|M|B>.md`. Read it first and append after each step.

---

## 1. Foundation (done by the planner)

| Area | What exists now |
|---|---|
| Dependency | `@huggingface/transformers` **4.3.0** (exact). This brings `onnxruntime-node` 1.30.0, whose bundled CPU binaries cover darwin-arm64, linux-x64 and linux-arm64. No postinstall is needed: it only fetches CUDA. `node:26-slim` is glibc, so the Dockerfile is fine. |
| Migration | `src/db/migrations/003_friend_personalization.sql`, additive only. Details below the table. |
| Random | `Random { next(); int(n) }` is in `contracts/common.ts`. `kernel/random.ts` has `systemRandom()` (crypto), `seededRandom(seed)`, `sampleBeta(r, α, β)`, `sampleGamma`, `sampleNormal` and `jitterMs(r, max)`. `s.random` is set by app.ts before any factory (`AppOptions.random`). The test harness uses `seededRandom(42)`, overridable with `createTestApp({ random })`. The scheduler's retry jitter now uses `s.random`. |
| Embedder | `Embedder { model, dim, embed(texts, 'query'\|'passage', {signal?}) → Float32Array[] \| null, status() }` is in `contracts/capabilities.ts` and lives at `s.caps.embedder`. `src/capabilities/embedder.ts` provides three implementations and helpers (listed below the table). |
| Config | Env: `EMBEDDINGS_PROVIDER` (default `local`; forced to `fake` under test), `EMBEDDINGS_MODEL` (default `Xenova/multilingual-e5-small`), `EMBEDDINGS_CACHE_DIR` (default `DATA_DIR/models`) and `PROACTIVE_TAU` (default 0.30). These appear as `config.providers.embeddings`, `config.embeddings {model, dtype:'q8', cacheDir}` and `config.proactive.tau`. `LIMITS` gains a friend block, listed below the table. |
| Memory contracts | `Extracted.facts[]` gains optional `importance` and `ttl_days`. `MemoryService.save` gains optional `importance` and `expiresAt`. `ProfileCard` (the B4 shape), `ProfileView`, `ProfileEdit` and `ProfileService {get, consolidate, edit, dueThreads}` are in `contracts/memory.ts`. Also `memoryEnabled(u, now)` and `memoryState(u, now)`, where **null consent = on**. |
| Behaviour contracts | New `contracts/behaviour.ts`. It holds the types (`SignalKind`, `GoraSentSource`, `ProactiveContentType` with `PROACTIVE_CONTENT_TYPES`, `GapBucket` with `GAP_BUCKETS`, `ProactiveLevel`, `StyleHints`, `StyleOverrides`, `ProactiveDecision`) and the constants `PROACTIVE_TAU_SCALE` and `PROACTIVE_LOG_PREFIX = 'pl_'`. The two services are `SignalsService` (`inbound`, `goraSent`, `reaction`, `feedback`, `blocked`, `lastInboundAt`, `pActive`, `styleHints`) and `ProactivePolicy` (`tick`, `decide`, `canSendNow`, `explain`). |
| Storage contracts | `UserRow.proactiveLevel` and `UserRow.tzHintAt`. `UserSettings.style: StyleOverrides \| null`, stored as `style_json` with enums only, sanitized by the repo. `USER_DATA_TABLES` covers the 6 new tables, with `fact_embeddings` before `memory_facts`. |
| Scheduler, ledger, LLM, agent contracts | Four additions, listed below the table. |
| Services | `s.random`, `s.userProfile` (ProfileService; named so because `s.profile` is the ProviderProfile), `s.signals` and `s.proactivePolicy`. `Factories.createProfileService` is built right after `createMemoryService`. `Factories.createBehaviourModule` returns `BehaviourModule {signals, policy}` and is built right after `createMissionModule`. |
| Stubs (safe no-ops, boot works) | `src/memory/profile.ts` → **M**. `src/behaviour/index.ts` → **B**. |
| Wiring done in foundation | Four call sites, listed below the table. |
| Harness | `FakeEmbedder`, `createFakeProfileService`, `createRecordingSignals` and `createFakePolicy`. Details below the table. |
| Tests | `test/unit/foundation/friend.test.ts`, the migration 003 test on a populated 001+002 database, and the importRules tests. |

**Migration 003:**
- `users`: `proactive_level` (`off|less|normal|more`, default `normal`) and `tz_hint_at`.
- `user_settings.style_json`.
- `memory_facts`: `importance` (REAL 0–1, default 0.5) and `expires_at`, with index `memory_expiry`.
- New tables: `user_profile`, `fact_embeddings`, `user_signals`, `user_rhythm`, `proactive_arms` and `proactive_log`.
- `memory_facts` is **not** rebuilt, because the live DB would be at risk. `FactKind` is unchanged:
  - plans and events use kind `date`;
  - mood and context signals use kind `fact` with `expires_at` set.

**`src/capabilities/embedder.ts`:**
- `createLocalEmbedder`: lazy dynamic import, one inference at a time, e5 `query: ` / `passage: ` prefixes, L2-normalized
  output. A failed load resolves null and is retried after 1 h.
- `createHashEmbedder`: deterministic, no model. Used for `fake`.
- `createNoEmbedder`: used for `none`.
- Helpers: `cosine`, `vecToBytes` and `bytesToVec`.

**`LIMITS` friend block:**
- `compactSystemMaxTokens` is now 700.
- memory: `memoryHalfLifeDays` 30, `memoryExtractExchanges` 3, `memoryExtractIdleMs` 10 min,
  `profileConsolidateAfterFacts` 15, `profileMaxTokens` 250, `userModelMaxTokens` 300.
- time zone: `tzHintEveryMs` 7 days.
- signals and rhythm: `signalsRetentionDays` 90, `rhythmHalfLifeDays` 21, `rhythmPriorWeight` 5.
- proactive: `proactiveTickMin` 30, `proactiveTopHoursFraction` 0.3, `proactiveJitterMs` 20 min,
  `proactiveMaxPer24h` 1, `proactiveHardStopUnanswered` 4, `proactiveAnnoyancePerUnanswered` 0.25,
  `proactivePriorCap` 10, `proactiveReplyWindowMs` 24 h, `proactiveStopPenalty` 5.

**Scheduler, ledger, LLM and agent contracts:**
- **Scheduler.** New `JobKind`s:
  - `proactive_tick`, with priority `proactive`;
  - `profile_consolidate`, with priority `background` (both pause at ≥ 85% through `llmBudget`);
  - `memory_embed`, with priority `null` (CPU only).
- **Ledger.** New `LedgerKind`s `proactive_sent` and `profile_updated`.
- **LLM.**
  - `SidePurpose` gains `consolidate`, `compose` and `judge`.
  - `SideRequest.role?: 'fast'|'main'`. Both transports honour it: Groq uses `models.main` / `models.fast`, and
    Anthropic uses `profile.models.main` / the side model.
- **Agent.**
  - `SideCalls.structured({purpose, system, user, schema, role?, maxTokens?}, meta?)`. The caller owns the prompt and
    schema; usage is recorded as a side call.
  - `ContextPart.key` gains `'user_model'`. `agent/context.ts` renders a `<user_model>…</user_model>` block on dm,
    topic and mission only, trimmed right after `memories`. `user_model` is now a **reserved tag**
    (`kernel/tags.ts`), so owner text cannot forge it.

**Wiring done in foundation:**
- `surfaces/dm.ts` `commit()` calls `s.signals.inbound(userId, {at, text, replyToTgMessageId})` for every trusted owner
  input. Forwards are skipped; the text is used for features only.
- `surfaces/handlers.ts` calls `s.signals.reaction(...)` for owner reactions in the owner's DM. It also skips
  `pl_…` nudge ids.
- `telegram/outbox.ts`: a 403 in the owner's own DM sets `botBlocked` and calls `onBlocked` →
  `s.signals.blocked(userId, now)` (wired in `telegram/index.ts`).
- `SideCalls.structured` is implemented in `agent/side.ts`.

**Harness:**
- `FakeEmbedder` is `s.caps.embedder` when the fake capabilities are used. `set(text, vec)` pins a vector,
  `available=false` simulates an unavailable model, and `.calls` records calls.
- `createFakeProfileService` (`put`, `consolidations`), `createRecordingSignals` (`calls`, `active`, `hints`) and
  `createFakePolicy` (`decision`, `allow`, `ticks`).
- `NOOP_FACTORIES` gains both new factories, and `seededRandom` is re-exported from `fakes.ts`.

### Embedding verification (step 2)

The check ran in the scratch directory `embcheck/`, with the model cache in scratch, never `./data`.
- **Model:** `Xenova/multilingual-e5-small`, `dtype: 'q8'`, 384-d. `model_quantized.onnx` is 118 MB and
  `tokenizer.json` 17 MB, so the cache is **144 MB**. `node_modules` grows by about 470 MB, of which `onnxruntime-web`
  is 142 MB and unavoidable.
- **Node 26.8.1, darwin-arm64:**
  - cold load, including the download: **74 s**;
  - warm load: **0.3 s** (2.2 s through `createLocalEmbedder` from the project);
  - one embedding: **2–7 ms**; a batch of 4: **10 ms**;
  - RSS: **650–720 MB** in a standalone process.
- **Quality:**
  - a Russian passage vs its English translation: cos 0.928;
  - that passage vs an unrelated passage: 0.717;
  - the query «где живёт сестра?» ranks the right passage first (0.836 vs 0.645);
  - the project smoke, with an English query against a Russian passage: 0.833 vs 0.692.
- **linux-x64:** not executed here, but the package ships `bin/napi-v6/linux/x64` and the Docker base is glibc. **M**
  must keep the degrade path: any load failure sets `status()` to `'unavailable'`, and retrieval falls back to
  lexical only.
- **Implications for M:**
  - e5 cosines are compressed around 0.6–0.9. Use **rank** fusion (RRF), not raw thresholds.
  - Load lazily on the first embed, never at boot. Warm it in the background, for example on the first
    `memory_embed` job.

---

## 2. Cross-set interface map (who provides, who consumes)

| Interface (contract) | Provider | Consumers |
|---|---|---|
| `s.caps.embedder` (Embedder) | M (`capabilities/embedder.ts`) | M |
| `s.userProfile` (ProfileService) | M (`memory/profile.ts`) | P (Mini App route and screen, A6 city guess), B (`dueThreads`, `get` for composition) |
| `s.memory.*` (MemoryService, extended by M internally) | M | P (routes), B (useful items: `date` facts via `list`, never sensitive) |
| `memoryEnabled`/`memoryState` (contracts/memory.ts) | planner | M (all memory gates), P (settings/UI, `memory=` context line, trust S08), B (never compose from memory when off) |
| `ContextPart 'user_model'` | M (profile + facts lines), B (one `style:` line) | the agent (renders) |
| `s.signals` (SignalsService) | B | P (`settings_update` → `feedback`), foundation call sites (dm, handlers, outbox), B's proactive module (`goraSent` from brief and nudges) |
| `s.proactivePolicy` (ProactivePolicy) | B | P (`why.ts` → `explain` for `pl_` links), B (`proactive_tick`) |
| `SideCalls.structured` | planner (agent/side.ts) | M (`consolidate`), B (`compose` role main, `judge`) |
| `UserRow.proactiveLevel`, `UserSettings.style`, `UserRow.tzHintAt` | planner (repo) | P (writes via `settings_update`, reads for UI), B (reads) |
| `STRING_KEYS` / `s.strings` | P | all (M and B may keep module-local text via `uiLang()`) |

**Ordering and dependencies.** All three sets start now. Each consumer codes against the contract and tests with the
harness fakes, never against another builder's internals. The integration run happens after all three finish (§6).

---

## 3. Set P: persona, first contact and minimal UI

**Owned files:**
- **Prompts:**
  - `src/agent/prompt/system.ts` and `src/agent/prompt/system.compact.ts`;
  - `test/unit/agent/prompt.test.ts` and `test/unit/agent/context.test.ts`.
- **Agent context and footers:**
  - `src/agent/context.ts`: the `memory=` owner line through `memoryState`, and drop the `onboarding` part. Keep the
    `<user_model>` rendering.
  - `src/agent/engine.ts`: **only** `footerLines()`, for A5.
- **Surfaces:** all of `src/surfaces/**` **except** `src/surfaces/business/**`. That covers `onboarding.ts`, `dm.ts`,
  `commands.ts`, `handlers.ts`, `callbacks.ts`, `context.ts`, `index.ts`, `location.ts`, `strings.ts`, `util.ts`,
  `why.ts`, `repo.ts`, `payments.ts`, `group.ts`, `guest.ts` and `tools.ts`.
- **Telegram:** `src/telegram/commands.ts` (menu and bot description) and `src/telegram/index.ts` (the sync call site
  only).
- **Trust:**
  - `src/trust/rules.ts`: S08 through `memoryEnabled`, S09 removed or relaxed;
  - `src/trust/sentinel.ts`: the `memoryConsent` and `tzConfirmed` facts;
  - `src/trust/executor.ts`: **only** `sideCardForDeny`'s `tz_unconfirmed` branch and a new tz-hint effect.
- **Tools:** `src/tools/impl/settings.ts` (settings words) and `src/reminders/tools.ts` (**only** the ⏰ reaction ack
  on `reminder_create`).
- **Mini App API:** `src/http/routes/memory.ts`, `src/http/routes/me.ts` and `src/http/routes/settings.ts`.
- **Mini App:** `webapp/src/screens/Memory.tsx`, `Settings.tsx`, `TzDetect.tsx` and `Home.tsx`, plus
  `webapp/src/lib/*.ts`.
- **Contract exception:** new `STRING_KEYS` entries in `src/contracts/i18n.ts`.
- **Repo exception:** in `src/db/repos/users.ts`, only the `INSERT` in `upsertFromTelegram`, which gets
  `onboarding_step = 'done'`.
- **Tests:**
  - `test/unit/surfaces/**` (except `business*.test.ts`), `test/unit/telegram/commands*.test.ts` (if any) and
    `test/unit/trust/rules*.test.ts` (S08/S09 cases only);
  - e2e: `test/e2e/onboarding.e2e.test.ts` (rewrite as `first-contact`), `why.e2e.test.ts`, `miniapp.e2e.test.ts`;
  - new: `test/e2e/friend-first-contact.e2e.test.ts` and `test/unit/surfaces/friend*.test.ts`.

**Keep the foundation call sites in files you now own:** `s.signals.inbound` in `dm.ts` `commit()`, `s.signals.reaction` and the `pl_` guard in `handlers.ts`, and the `<user_model>` rendering in `agent/context.ts`.

**Consumes:** `s.userProfile` (get, edit), `s.memory` (list, search, forget, edit), `s.signals.feedback`,
`s.proactivePolicy.explain`, `memoryEnabled` / `memoryState`, `s.repos.users` (proactiveLevel, tzHintAt, style) and
`s.location`.

**Provides:** strings, the Mini App endpoints, `NoticeService` (its new semantics are below), and the persona prompts
that mention `<user_model>`.

**Work items (spec 05 §A):**
1. **A1 bot description.** In `telegram/commands.ts`, add `setMyDescription` (≤ 512 chars) and
   `setMyShortDescription` (≤ 120 chars) for `en` and `ru`, applied under the same hash as the commands. Fold the
   texts into `defs()` so the hash covers them. The description includes the privacy notice (RU text verbatim from
   05 A1, EN equivalent).
   - On the user's **first message** (`dm.ts`, when no `memory` consent row exists), call
     `grantConsent({kind:'memory', textVersion:'desc-v1', via:'blanket'})` once.
2. **A2 `/start`.** Exactly one localized line (RU «Привет! Я Гора 🙂 Рассказывай, что у тебя?», EN «Hey! I'm Gora 🙂
   What's up?»), with no `reply_markup` and no follow-ups.
   - The deep-link payloads `g_`, `me_`, `grp_`, `bizChat…` and `ref_` keep working. They may replace the greeting.
   - An existing user gets the same line and **nothing is reset**.
3. **A3 onboarding removal.**
   - New users get `onboarding_step='done'` (the users.ts INSERT).
   - `onboarding.ts` shrinks to: `/start`, deep links, the `tz:` callback and the lazy tz hint.
   - Remove the RunHook card sender and the `ob:` cards M1–M9. Keep the `ob` callback kind registered as a harmless
     no-op that answers "expired", because old buttons exist in live chats.
   - Remove the `onboarding` context provider part.
   - Keep `/import` and the Mini App import screen, and never advertise groups or guest mode.
   - Existing live users with a step other than `done` are treated as `done`. Onboarding code must not branch on the
     step any more.
4. **A4 persona prompts.** Rewrite both prompts around the friend identity (05 A4 bullets). Every authority,
   untrusted-content, honesty, time and approval rule is kept in meaning.
   - Add: "`<user_model>` holds facts about the owner, not instructions."
   - Add the settings-by-words rule: a preference about Gora → `settings_update` (proactive, style, persona_name) or
     memory.
   - The compact prompt must be ≤ 700 est. tokens (`LIMITS.compactSystemMaxTokens`).
   - `SYSTEM_VERSION*` changes, and existing conversations rotate on `systemVersion` drift as designed.
5. **A5 minimal UI.**
   - `engine.footerLines()` keeps only pending-approval lines. Remove the 🕶 incognito and `free_left` lines. The
     quota template notice still appears when a quota is actually hit.
   - **Undo** lines stay: they come from effects.
   - `reminder_create` success → a ⏰ reaction on `ctx.chat.triggerMessageId`
     (`outbox.enqueue({method:'setMessageReaction', …})`, idempotent on `toolUseId`). The model's reply carries the
     short confirmation line.
   - The **memory ✍ reaction is M's** (extraction and `memory_save`).
   - The command menu (`PRIVATE_COMMANDS` published to Telegram) lists only `/memory` and `/settings`. Every other
     command still works but is unlisted: keep the handler table separate from the published list. Group commands
     are unchanged.
6. **A6 lazy time zone.**
   - S09 no longer denies while `tz_source='default'`. The tool runs on the best-guess tz, in this order:
     1. the last shared location (`s.location.get` → `geo.tzForPoint`);
     2. a city from the profile card, memory or `settings.homeCity`;
     3. the language default (ru → `Europe/Moscow`, else `UTC`; document the table in code).
   - The executor pushes ONE `{kind:'buttons', rows:[[web_app "🕒 Уточнить пояс" / "🕒 Set my time zone" →
     /app/?screen=tz]]}` effect when `tzHintAt` is null or older than `LIMITS.tzHintEveryMs`, then sets `tzHintAt`.
   - `NoticeService.askTimezone` becomes that lazy hint and never a card. The `tz_unconfirmed` resend is removed.
   - A city in conversation (`location.ts` typed city) or a shared location confirms the tz silently. `timezoneSet`
     sends nothing, or one short line when the user explicitly set it.
7. **Settings words (C5 UI side).** `settings_update` gains:
   - `proactive: 'off'|'less'|'normal'|'more'`, which writes `proactiveLevel` and calls
     `s.signals.feedback(userId, {kind: off→'stop', less→'less', more→'more'})`;
   - `style: {length?, emoji?, register?} | null`, which writes `settings.style`;
   - `memory: 'on'|'off'`, which sets `memoryConsent` true or false with the matching consent grant or revoke. This
     is 05 B1's «не запоминай». It is an explicit owner choice, so 05 overrides 01's "never touches consents" for this
     one field.
   - All three are undoable like the other fields.
   - The prompt tells the model to map «не пиши мне первым» → `proactive:'off'`, «короче» → `style.length:'short'`,
     and so on, with a one-line acknowledgement.
   - `/settings` shows memory on/off/incognito through `memoryState`, the proactive level and the style.
8. **B5 UI side (profile card).**
   - `GET /api/memory` also returns `profile: ProfileView | null` from `s.userProfile.get`.
   - `PATCH /api/memory/profile {op, field, index?, text?}` → `s.userProfile.edit` (write-level initData, ledger
     `settings`).
   - `Memory.tsx` shows the card above the fact list: summary, people, goals, preferences and open threads, each with
     delete or correct.
   - The `/memory` command opens the Mini App Memory screen (`web_app` button) or answers in chat.
9. **/why for proactive messages.** When `link.nudgeId` starts with `pl_`, show
   `s.proactivePolicy.explain(id)` (type, gap, score and reason) instead of `nudges.get`.
10. **Strings.** Add the keys you need (en + ru) and delete the onboarding card keys that nothing uses. Keep `why_now`
    until B confirms that nothing uses it.

**Acceptance tests (05 §E rows owned by P):**
- `/start` → exactly one `sendMessage` or `sendRichMessage` with no `reply_markup`, in the user's language (ru and en).
  A second `/start` from an existing user sends the same line and leaves `users` / `user_settings` rows unchanged.
- **No onboarding card is ever sent:** over a first-contact e2e (start, three messages, a time-dependent request,
  `t.advance(2 days)`), no outbound message has `reply_markup` except the one lazy tz `web_app` button. None of it is
  onboarding text.
- The compact prompt is ≤ 700 est. tokens and contains the persona markers ("friend", `<user_model>`) and every
  safety rule marker (authority, untrusted, honesty "pending_approval", time_resolve, approvals, safety). Update
  `prompt.test.ts`.
- **Lazy tz:** with `tz_source='default'`, `reminder_create` succeeds and the reply has exactly one `web_app`
  "screen=tz" button. A second time-dependent call within 7 days has no button; after 7 days it has one again.
- The command menu published to Telegram lists exactly `memory` and `settings` (both languages). `setMyDescription`
  and `setMyShortDescription` are called once per hash in both languages, and the RU description contains `/memory`.
- `settings_update {proactive:'off'}` → `proactiveLevel='off'` and `signals.feedback` is called with 'stop' (pin
  `createRecordingSignals`). `{memory:'off'}` → `memoryState` is 'off'.
- The first user message records `consents(memory, 'desc-v1')` exactly once.

---

## 4. Set M: the memory engine

**Owned files:**
- **Memory:** `src/memory/**`. That includes `store.ts`, `extract.ts`, `context.ts`, `tools.ts`, `callbacks.ts`,
  `importer.ts`, `incognito.ts`, `repo.ts`, `index.ts` and `text.ts`, plus `profile.ts` (the stub; replace it), and
  new files such as `embeddings.ts`, `retrieval.ts`, `profileRepo.ts`, `consolidate.ts` and `userModel.ts`.
- **Capability:** `src/capabilities/embedder.ts` (tuning only; keep its exports).
- **Side calls:** `src/agent/side.ts` (**only** `ExtractSchema` and `extract()`: add `importance` 0–1 and
  `ttl_days` number|null) and `src/agent/prompt/side.ts` (the `extract` prompt only).
- **Memory gates elsewhere:** in `src/proactive/signals.ts`, NOT M's (see B). M changes `memoryConsent === true`
  checks only inside `src/memory/**`.
- **Tests:**
  - `test/unit/memory/**`, `test/unit/agent/side.test.ts` and `test/unit/capabilities/embedder*.test.ts` (new);
  - e2e: `test/e2e/memory.e2e.test.ts` and new `test/e2e/friend-memory.e2e.test.ts`.

**Consumes:** `s.caps.embedder`, `s.side.extract`, `s.side.structured` (purpose `consolidate`, role fast),
`s.llmBudget`, `s.scheduler`, `s.crypto` (memory generation DEKs), `memoryEnabled`, `s.repos.users` and the
`LIMITS.memory*` / `profile*` / `userModelMaxTokens` values.

**Provides:**
- `ProfileService` (`createProfileService`).
- The `memory` context provider, now emitting key **`user_model`**: the profile head (≤ 250 tokens) and the top facts,
  with the whole block ≤ 300 tokens.
- `memory_search` about-me support, and the ✍ reaction ack.
- The jobs `profile_consolidate` and `memory_embed`.
- Export and delete hooks for its tables.

**Work items (spec 05 §B):**
1. **B1 extraction without consent.**
   - Every gate uses `memoryEnabled(u, now)`: `store.ts`, `extract.ts`, `context.ts`, `importer.ts` and `tools.ts`.
     Memory is on unless incognito or `memoryConsent === false`.
   - **Batching:** per conversation, after `LIMITS.memoryExtractExchanges` (3) owner exchanges since the watermark, or
     `memoryExtractIdleMs` (10 min) idle, whichever comes first. Priority `background` (paused through `llmBudget`).
     Replace the 2-min debounce RunHook logic.
   - Store `importance` (default 0.5) and `expires_at` (`now + ttl_days`; mood and context signals).
   - **No confirmation cards:** remove the ✓/✗ sensitive card path. A sensitive fact is saved only when the model
     marks it explicit or plainly stated by the owner about themselves; otherwise it is dropped. Sensitive facts are
     never exposed to B's composer (`list` filters, or a flag in what B reads).
   - Expired facts are excluded from retrieval, and the retention sweep deletes them.
   - «не запоминай» is P's `settings_update {memory:'off'}`. A single "don't remember this" → `memory_forget` as
     today.
2. **A5 ack.** Replace the `[📝 Remembered N · Review]` markup with a ✍ reaction on the owner's triggering message:
   `setMessageReaction` via outbox, idempotent per input. Do the same for `memory_save`. Remove the `mm:` review row
   UI but keep the `mm` callback registered, answering "expired", for old messages.
3. **B2 embeddings.**
   - On save or edit, embed the fact text (`passage`) and store a sealed row in `fact_embeddings`:
     `vec_enc = crypto.seal('m:<userId>:<gen>' | 'mg:<chatId>:<gen>', vecToBytes(v), 'fact_embeddings|vec_enc|<factId>')`,
     plus `model`, `dim` and `dek_gen`.
   - Embedding runs async (never blocks save). Missing vectors are backfilled by the `memory_embed` job (per scope,
     batch 32).
   - Forget, supersede and the generation rotation delete or re-seal embeddings together with the fact text. A
     forgotten fact must leave **no** vector.
   - Vectors whose `model` differs from `embedder.model` are ignored and re-embedded.
   - Keep decrypted vectors in the same per-(scope, gen) LRU as the texts.
4. **B3 hybrid retrieval.** Rank A is the existing BM25-lite (in memory; there is no FTS5 table because the texts are
   encrypted, which is the documented deviation from 05's "FTS5"). Rank B is the cosine against the `query:` vector.
   - Fuse with RRF (k = 60), then multiply by importance and recency decay: half-life `memoryHalfLifeDays` (30);
     pinned and profile-kind facts do not decay.
   - When the embedder returns null, use Rank A only, silently.
   - The `<user_model>` block is the profile head plus the top facts within 300 tokens. The `run_memory_uses`
     recording stays.
5. **B4 profile consolidation.**
   - The job `profile_consolidate` runs as a nightly system cron (`sys:profile_consolidate`, each user at about
     04:00 local, or pick users whose local hour is 4 on an hourly tick) and per user after
     `profileConsolidateAfterFacts` (15) new facts (dedupe key `pc:<userId>`).
   - It makes one `s.side.structured({purpose:'consolidate', role:'fast', schema: ProfileCard zod})` call, at ≤ 1 per
     user per day except for forget.
   - Store the result sealed in `user_profile` as a new version, then ledger `profile_updated`. Skip it when memory is
     off, incognito, or `llmBudget.allow('background')` is false.
   - **Forget:** `forgetFacts` → `consolidate(userId, {reason:'forget'})`. The rebuild excludes the forgotten facts,
     and all older versions are deleted. The fingerprint filter also runs over the new card text.
   - `/deletemydata` is already covered by `USER_DATA_TABLES`; also drop the caches.
6. **B5 "what do you know about me?".**
   - `memory_search` gains `about_me: true`, or treats an empty query plus `kind:'profile'` as about-me. It returns the
     profile card and the top facts and a Mini App link (`${publicUrl}/app/?screen=memory`, or the `startapp` deep
     link).
   - Say in the persona prompt what to call. P owns the prompt, so coordinate the wording through your log.
7. **Export and privacy hooks.** Export the profile card and the fact count with embeddings (not the vectors).

**Acceptance tests (05 §E rows owned by M):**
- **Extraction without a consent card:** a new user (`memoryConsent null`) sends three messages → a `memory_extract`
  job runs → facts are saved → **no** `reply_markup` card is sent; a ✍ `setMessageReaction` is sent. With incognito
  on, or with `memoryConsent=false`, no extraction call is made (`t.llm.parseRequests` has no `extract`).
- **Hybrid retrieval ranks a paraphrase above an unrelated keyword match.**
  - `FakeEmbedder` pins "Anna is allergic to nuts" and the query "what can't Anna eat?" to near-identical vectors, and
    "nut-free chocolate recipe" (keyword overlap) to an orthogonal one. Retrieval ranks the allergy fact first.
  - With `embedder.available=false`, the order falls back to BM25 and nothing throws.
- **Decay ordering:** two equal-score facts, 10 days vs 90 days old → the newer ranks first. A pinned old fact does
  not decay. Higher `importance` beats lower at equal age.
- **Profile consolidation (scripted parse):** `t.llm.pushParse('consolidate', card)` → `s.userProfile.get(user)`
  returns the card, and `<user_model>` in the next main request contains the summary.
- **Forget → profile rebuild without the fact:**
  1. Forget fact X.
  2. A `consolidate` parse is requested whose user message does not contain X's text.
  3. The old versions are gone.
  4. `fact_embeddings` has no row for X.
  5. Re-extraction of X is blocked by fingerprints.
- The embedding rows are sealed. The raw `vec_enc` bytes are not a plain Float32 view of the vector, and
  `USER_DATA_TABLES` deletion leaves 0 rows.

---

## 5. Set B: behaviour and proactive policy

**Owned files:**
- **Behaviour:** `src/behaviour/**`. That includes `index.ts` (the stub; replace it) and new files such as
  `repo.ts`, `features.ts`, `signals.ts`, `rhythm.ts`, `style.ts`, `bandit.ts`, `policy.ts`, `compose.ts` and
  `context.ts`.
- **Proactive:** `src/proactive/**`: `nudges.ts`, `brief.ts`, `signals.ts` (the scan), `commitments.ts`, `index.ts`,
  `repo.ts`, `nudgeGate.ts` and `util.ts`.
- **Tests:**
  - `test/unit/behaviour/**` (new), `test/unit/proactive/**` and `test/review/proactive/**`;
  - e2e: `test/e2e/nudges.e2e.test.ts` and new `test/e2e/friend-proactive.e2e.test.ts`.

**Consumes:**
- `s.random` (every draw and the jitter).
- `s.userProfile.dueThreads`, `s.userProfile.get`, and `s.memory.list` (only non-sensitive `date` facts for `useful`).
- `s.side.structured` (`compose` with role main, `judge` with role fast).
- `s.llmBudget`, `s.scheduler`, `s.telegram.outbox` (and `onSent` with refKind `proactive`), `s.telegram.links.record`,
  `s.conversations.resolve`, `s.repos.inputs.addEvent`, `s.repos.users`, `s.ledger` and `memoryEnabled`.
- The `LIMITS.proactive*`, `rhythm*` and `signals*` values, and `config.proactive.tau`.

**Provides:**
- `SignalsService` and `ProactivePolicy` (`createBehaviourModule`).
- The `proactive_tick` job and the `sys:proactive_tick` cron (`*/30 * * * *` UTC).
- The `behaviour` context provider: one `user_model` line
  `style: reply_length=… emoji=… register=… lang=…`, with the explicit `settings.style` overriding the learned hints.
- The export, delete and retention hooks for the behaviour tables. Signals older than 90 days are purged; delete rows
  on `/deletemydata`.

**Work items (spec 05 §C):**
1. **C1 signals.** Implement `SignalsService` over `user_signals`, with features only.
   - **`inbound`:** local hour and weekday in the user's tz, length, emoji count, language (script heuristic:
     Cyrillic/Latin/other), the question flag, and the register (ты/вы markers → informal/formal).
     - It updates the rhythm and style synchronously (cheap).
     - If there is an open proactive message (`proactive_log` sent, `replied_at` null, within 24 h), it sets
       `replied_at`, `reward=1`, updates the arms (α += 1 on both arms) and writes a `reply` signal with the latency.
     - It resets the unanswered counter.
     - If `status='blocked'`, it sets `status='active'` and `botBlocked=false`.
   - **`goraSent`:** a signal row. The brief and the nudges call it on send; the proactive tick calls it too.
   - **`reaction` / `feedback`:** signal rows. `feedback('stop')` → β += `proactiveStopPenalty` on the arm of the last
     proactive message and `proactiveLevel='off'` (idempotent with P's `settings_update`).
   - **`blocked`:** `status='blocked'` plus a signal row. Every proactive path skips blocked users.
2. **C2 rhythm.**
   - A 7×24 histogram as a Float64 blob with exponential decay (half-life 21 days, decayed lazily by elapsed time).
   - Smoothing: the population prior (pooled over all users' histograms, normalized, weight 5 pseudo-messages) plus a
     circular hour ±1 kernel.
   - `pActive(user, at)`. Top-30% hours = the hours whose smoothed `P` is in the user's top `proactiveTopHoursFraction`.
3. **C3 style.** EMAs of length, emoji rate, formality and language mix → `StyleHints`. Return null until about 5
   messages.
4. **C4 policy.**
   - **The tick**, every 30 min. For each user (`s.repos.users.iterate({status:'active'})`), check eligibility:
     - not paused or blocked, with `botBlocked` false;
     - `proactiveLevel !== 'off'`;
     - outside quiet hours (reuse NudgeGate's quiet logic);
     - `llmBudget.allow('proactive')`;
     - memory not required.
   - **Gap and bucket.** The gap is `now − lastInboundAt` (for never-wrote users, the gap since `createdAt`). Compute
     the bucket.
   - **Hard stop.** After 4 consecutive unanswered Gora-initiated messages: silence until the user writes.
   - **Cap.** At most 1 per 24 h, shared: any `goraSent` with source proactive, nudge, brief or checkin in the last
     24 h blocks. `canSendNow` exposes the same check.
   - **Timing.** Only in the user's top-30% hours. Apply ±20 min jitter by scheduling a one-off `proactive_tick`
     sub-job `pt:<userId>` at `now + jitterMs(s.random, 20 min)`, or by picking a slot inside the window.
   - **Content types available:**
     - `follow_up`: `s.userProfile.dueThreads(user, now)` is non-empty;
     - `useful`: a due item, a known plan's date or an upcoming `date` fact, non-sensitive only;
     - `checkin`: always;
     - `first_hint`: only when the user has no inbound after `/start`.
   - **Thompson sampling.** Beta posteriors per `(user, 'type:<t>')` and `(user, 'gap:<b>')` in `proactive_arms`.
     - The prior is the pooled population mean, capped at 10 pseudo-counts, and conservative: the initial mean is
       low, for example Beta(1, 4).
     - Draw θ_gap and θ_type with `sampleBeta(s.random, …)`.
     - Score = θ_gap·θ_type·(1 − 0.25·unanswered).
     - Send iff score > τ·`PROACTIVE_TAU_SCALE[level]` (τ = `config.proactive.tau`).
   - **Composition.** One `s.side.structured({purpose:'compose', role:'main'})` call writes ≤ 2 sentences in the
     user's language and style. Its input is the profile summary, the chosen thread or item and the last few turns.
     No buttons, no "Why now". Sensitive facts are never used.
   - **Friend check.** Then one `s.side.structured({purpose:'judge', role:'fast', schema:{send:boolean, reason}})`
     call, which also sees the last 5 proactive messages. If `send=false`: nothing is sent, the arms are **not**
     updated, and the row is logged with `sent=0`.
   - **Delivery.**
     - Resolve the DM conversation (`conversations.resolve({kind:'dm', tgUserId}, …)`).
     - `outbox.enqueue({method:'sendMessage' | 'sendRichMessage', refKind:'proactive', refId: pl_id, idempotencyKey: pl_id})`.
     - On `onSent`: `links.record({kind:'nudge', nudgeId: pl_id, userId, conversationId})`, then
       `inputs.addEvent(convId, 'You messaged the owner first: «…»')`, so the next run sees it as its own message.
       Appending a transcript row would break the message grammar; the event row is the chosen mechanism.
     - Ledger: `proactive_sent` with detail `{arm, score, reason}` and **no text**.
   - **Reward window.** A job or a tick sweep marks `reward=0` after 24 h without a reply, and updates β.
5. **C4 integration with the existing module.**
   - Remove the visible `why_now` line from nudge messages (`nudges.ts` render). The reason stays in the DB, the
     ledger and `/why`.
   - The brief and nudges call `s.signals.goraSent`.
   - Unrequested nudge kinds (`date_from_memory`, `checkin`) ask `s.proactivePolicy.canSendNow` first.
   - NudgeGate (budget, quiet hours) stays authoritative for nudges. The policy uses the same quiet-hours helper.
   - There must be no fixed-cadence re-engagement path besides the policy. Make sure nothing else pings inactive
     users.
6. **C5.** τ scaling by level. Read `settings.style` for the style line. P writes both.
7. **C6 budget.** `proactive_tick` has JOB_LLM_PRIORITY `proactive`, so the scheduler pauses it at ≥ 85%. Also check
   `llmBudget.allow('proactive')` inside the tick before composing: a long tick can cross the threshold.
8. **Rhythm, style and bandit use zero LLM calls.** Sending costs exactly 2 LLM calls.

**Acceptance tests (05 §E rows owned by B):**
- **The rhythm model learns peaks.** Feed inbound signals at 20:00–21:00 local on 14 days → `pActive` at 20:30 >
  `pActive` at 04:00, and 20:00 is in the top-30% set. The population prior smooths a new user (no zeros).
- **The bandit converges.** Simulate a user who always replies to `follow_up` and never to `checkin`, using
  `seededRandom`, 200 decisions → `follow_up` is chosen far more often (for example ≥ 80% of the last 50 sends), and
  `checkin`'s posterior mean is below `follow_up`'s.
- **Re-engagement e2e with FakeClock** (`createTestApp`, scripted `compose` and `judge`):
  - an inactive user gets at most 1 message per 24 h, and only at learned active hours (assert the local hours of
    the sends);
  - a user reply resets the unanswered counter and gives reward 1;
  - 4 ignored messages → silence (no sends for the next 7 days);
  - «не пиши мне первым» → `settings_update {proactive:'off'}` (scripted tool call) → no sends;
  - a 403 on a send → `status='blocked'` → no sends; the user writes again → active.
- **The judge veto sends nothing:** `pushParse('judge', {send:false, reason:'needy'})` → no outbox row, a
  `proactive_log` row with `sent=0`, and the arms unchanged.
- **Seeded RNG:** the same seed gives the same decisions (run `decide()` twice with `seededRandom(1)`).
- **The budget gate:** `FakeLlmBudget` denies proactive at ≥ 85% → no `compose` or `judge` parse and no send. When
  allowed again, sends resume.
- **Cap sharing:** a brief sent at 08:00 → no proactive message until 08:00 the next day.

---

## 6. Integration (after P, M and B are green)

The planner or integrator runs, in this order:
1. Merge. There are no file conflicts by construction.
2. `npm run typecheck && npm test && npm run test:e2e:strict`.
3. An end-to-end "friend day" e2e (planner-owned: `test/e2e/friend-day.e2e.test.ts`):
   1. `/start`;
   2. five messages across 3 days with a plan ("interview on Thursday");
   3. extraction runs with a ✍ reaction;
   4. the nightly consolidation, whose card has an open thread;
   5. the user goes silent;
   6. on Friday at a learned active hour, one `follow_up` proactive message (compose and judge scripted);
   7. the user replies (reward 1);
   8. «что ты обо мне знаешь?» → `memory_search about_me` → a summary with the Mini App link;
   9. forget the interview → the card is rebuilt without it.
4. `npm run smoke:groq` (live, owner-run only). The first real `memory_embed` downloads the model to
   `DATA_DIR/models`, about 144 MB, in the background. Expect about 0.7 GB more RSS once it loads.
5. Restarting the live bot applies migration 003 (additive) automatically at boot. `keys.db` is untouched.

## 7. Known deviations and decisions (recorded for review)

- **05 B3 says "FTS5 BM25".** Facts are encrypted at rest, so an FTS5 index would store plaintext. The lexical leg is
  the existing in-memory BM25-lite over the decrypted per-scope cache.
- **05 D: `memory_facts` is not rebuilt** (the live DB). Mood and context facts are `kind='fact'` with `expires_at`;
  plans and events are `kind='date'`. `importance` and `expires_at` are new columns.
- **The proactive message is recorded as a `conv_events` row**, so the model sees "you messaged the owner first:
  «…»" on the next turn. It is not an assistant transcript row, which would break the alternation grammar.
- **tg_links** records a proactive message as `kind='nudge'` with `nudge_id='pl_…'`, because the `kind` CHECK list
  cannot grow without a table rebuild.
- **`settings_update` gains `memory: on|off`.** 05 removes the consent card, so the explicit words are the switch.
- The existing `users.memory_consent = 0` rows (people who declined the old card) stay **off**. Only `NULL` means on.
