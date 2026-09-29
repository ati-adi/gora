# 08: s07 build plan: browser agent, Google Calendar via Composio, Gora in groups (planner output for spec 07)

**Binding:** 07 > 05 > 03 > 02 > 01. This file splits spec 07 into three builder sets that run in parallel with
**disjoint file ownership**:
- **BR**: the browser agent (spec 07 §A).
- **CAL**: the Composio provider fix-up and the friend-mode connect UX (spec 07 §B).
- **GR**: Gora as a group participant (spec 07 §C).

The foundation (§1) is already in the tree. Typecheck is clean, `npm test` passes 1080 tests and
`npm run test:e2e:strict` passes 118 (baseline 1077 / 118 at commit 3118466). Read §0 and §1, then only your own set.
The verified external facts are in §1.2 (Playwright) and §4.2 (Composio). Code against them; do not re-verify.

---

## 0. Rules for every builder

1. **Ownership.**
   - Edit only the files your set owns (§3, §4, §5). New files go under your set's directories.
   - Everything in §0.4 is **planner-owned** (frozen). If you need a contract change, append a `CONTRACT REQUEST:`
     entry to your progress log (`docs/progress/s07-<BR|CAL|GR>.md`). Until the lead applies it, work against the current
     contract and use a local adapter.
   - Some files are owned by exactly one set even though they sit in another module's directory, for example
     `src/trust/executor.ts` → BR, `src/agent/engine.ts` → nobody, and `src/memory/store.ts` → GR. The tables in §3–§5
     are the complete list. Any file not listed there belongs to nobody: do not edit it.
2. **Environment.**
   - A live bot runs from a separate snapshot directory, but it uses `/Users/adi/Desktop/Gora/data` and `/keys`.
     Never touch `./data`, `./keys` or `.env`. Never start a bot instance, never call the Telegram API, and make no live
     LLM calls.
   - Tests use fakes only: FakeTelegram, ScriptedTransport, `FakeBrowser` and `FakeIntegrationProvider`, or a
     Composio fake over an injected `fetchImpl`. Chromium is installed for the one opt-in real-browser test (BR,
     `LIVE_BROWSER=1`), which is never part of `npm test`.
   - Never `git commit`: the lead commits.
3. **Code rules** (04 §7, plus 06 §0.3). The foundation added:
   - **`playwright-runtime-import`:** only `src/browser/playwright.ts` imports `playwright` or `playwright-core` at
     runtime, lazily, on the first `openSession`, never at boot. `import type` is fine anywhere.
   - **SQL table ownership** (enforced):

     | Tables | Owner |
     |---|---|
     | `browser_tasks` | `src/browser/` |
     | `integration_links` | `src/integrations/` (with `src/tools/` and `src/capabilities/`, as for `connections`) |
     | `group_messages`, `group_summaries`, `group_policy` | `src/groups/` |
   - Timers go through `s.clock`, randomness through `s.random` (the GR bandit uses `thompson()` from
     `src/behaviour/bandit.ts`, imported, not edited), and the code is erasable TypeScript with `.ts` specifiers.
   - **Timing rule** (04 §3): register jobs, callbacks, hooks and context providers at factory time. `createGroupModule`
     and `createBrowserModule` run after `createBehaviourModule` and before `createAgentModule`: at factory time,
     `s.runner`, `s.conversations`, `s.side` and the real `s.telegram` do not exist yet.
   - **Logs and ledger never carry message text,** typed field values, page text or screenshots.
4. **Planner-owned (frozen):**
   - `src/contracts/**`, `src/app.ts`, `src/config.ts`, `src/db/migrations/**`, `src/db/repos/**`, `src/kernel/**`.
   - `test/harness/**`, including `fakeBrowser.ts`. Put extra fakes or fixtures in a NEW file,
     `test/harness/s07-<set>.ts`, which you own.
   - `test/unit/foundation/**`, `package.json`, `package-lock.json`.
   - `src/tools/toolkits.ts`, `src/tools/impl/useToolkit.ts` and `src/agent/toolkits.ts`. The s07 toolkit and preload
     changes are already done (§1.1).
5. **Gates.**
   - Each builder keeps `npm run typecheck`, `npm test` and `npm run test:e2e:strict` green, together with the other
     sets' merged work.
   - An existing test that spec 07 legitimately invalidates is yours to update only if it is in your set's test list.
     Otherwise, log a request.
6. **Resumable.** Keep `docs/progress/s07-<BR|CAL|GR>.md`. Read it first and append after each step.

---

## 1. Foundation (done by the planner; in the tree)

### 1.1 What exists

| Area | Files | Content |
|---|---|---|
| Dependency | `package.json` | `playwright` **1.63.0**, exact (dependency). Chromium is in the default cache `~/Library/Caches/ms-playwright` (`chromium-1243`, `chromium_headless_shell-1243`), not in the repo. `@composio/core` 0.21.0 stays optional and **unused**: see §4.2 for why REST over `fetchImpl` is used instead. |
| Migration | `src/db/migrations/004_browser_calendar_groups.sql` | `conversation_toolkits` rebuilt with `'browser'` in its CHECK (rows kept); `usage_daily.browser_tasks`; `browser_tasks` (one active task per user by a partial UNIQUE index; `current_url_enc` for crash recovery); `integration_links` (UNIQUE `state`); `group_messages`, `group_summaries`, `group_policy`. Every column is documented inline. |
| Browser contracts | `src/contracts/browser.ts` | `BrowserCapability` / `BrowserSession` (a raw, policy-free seam), `AriaNode`, `FieldInfo`, `RawPageState`, `NetworkPolicy`, `BrowserActionResult`, `BROWSER_KEYS`, `BrowserTaskStatus`/`BROWSER_TASK_ACTIVE`, `BrowserParkReason`, `BrowserTaskView`, `BrowserTaskService`, `BrowserModule`. |
| Group contracts | `src/contracts/groups.ts` | `GroupParticipation` (`readsAll`, `onJoin`, `observe`, `onReaction`, `onBotMessage`, `setChattiness`, `addressedByName`, `chattinessFromWords`, `catchup`, `policy`, `purge`), `GroupObservedMessage`, `GroupPolicyView`, `GROUP_CHIME_KINDS`, `GROUP_CHATTINESS`, `GroupModule`. |
| Integration contracts | `src/contracts/integrations.ts` | `connectLink` → `{url, pendingRef?, expiresAt?}`; optional `connectionStatus?(pendingRef, expect) → ConnectionPoll`; optional `IntegrationService.pendingLinks?(userId)`. |
| Other contracts | `tools.ts` | `ToolkitId` + `'browser'`; `TOOL_OWNERS`/`TOOL_FILES` for `browse_task`, `browser_*` (BR) and `group_invite_link` (GR); **`ToolSpec.approvalAttachment?`** (a photo beside an approval card). |
|  | `scheduler.ts` | Job kinds `browser_sweep`, `integration_poll`, `group_summarize`, `group_chime`, `group_feedback`, with their `JOB_LLM_PRIORITY`. |
|  | `agent.ts` | `GoraEvent.type` + `'integration_connected'` \| `'browser_resume'`; `SideCalls.structured` purpose = `StructuredPurpose` (+ `group_summary`, `group_facts`, `group_judge`, `group_compose`, `group_catchup`). |
|  | `llm.ts` | `SidePurpose` + the same five group purposes. |
|  | `services.ts` | `MissionHook` + `Services.missionHooks` (factory-time registry); `Services.groupAgent`, `Services.browserTasks`; `Factories.createGroupModule`, `createBrowserModule`. |
|  | `capabilities.ts` | `Capabilities.browser`. |
|  | `billing.ts` | `QuotaKind` + `'browser'`; `PlanLimits.browserTasksPerDay` (free 3, plus 15, pro 50). |
|  | `ledger.ts` | `LedgerKind` + `'browser_action'`. |
|  | `storage.ts` | `USER_DATA_TABLES` + `integration_links`, `browser_tasks`, `group_messages` (`from_tg_id = :tgUserId`: a member's own group lines go on /deletemydata); **`GROUP_DATA_TABLES`** (the per-group deletion plan, keyed by `:chatId`, where `group_policy` has `keepOnForget`). |
| Config | `src/config.ts` | Env: `COMPOSIO_AUTH_CONFIG_GCAL`, `COMPOSIO_AUTH_CONFIG_GMAIL`, `BROWSER_PROVIDER` (`playwright`\|`none`, forced to `none` under test), `BROWSER_HEADLESS`, `BROWSER_EXECUTABLE_PATH`, `FEATURE_BROWSER`, `FEATURE_GROUP_PARTICIPANT`. `cfg.browser`, `cfg.composio.authConfigs`, `cfg.features.browser` and `.groupParticipant`. All s07 `LIMITS.browser*`, `integrationPoll*` and `group*` constants. `configWarnings(cfg)` (a non-`ak_` Composio key; composio selected without a key) is logged once by app.ts. |
| Wiring | `src/app.ts` | `EXTERNAL_TOOLS` += BR/GR `TOOLS`; `s.missionHooks = []`; `s.groupAgent` and `s.browserTasks` built after behaviour; `AppOptions.browser` replaces `caps.browser`; `app.stop()` closes all browser contexts (≤ 5 s) after the runner. |
| Missions | `src/missions/index.ts`, `missions.ts` | `onFinished(id, status)` calls every `s.missionHooks[i].onMissionEnded` (fire-and-forget, errors logged). |
| Quotas | `src/billing/quotas.ts`, `src/db/repos/usage.ts` | Kind `browser` → the `usage_daily.browser_tasks` column. |
| Toolkits | `src/tools/toolkits.ts`, `useToolkit.ts`, `src/agent/toolkits.ts` | The `browser` kit (`browse_task` + `browser_*`); `group_invite_link` in `account`; `integration_connect` in `calendar`. Preloads: calendar words → `calendar` **even when not connected** (B2), and browse words (забронируй, запиши меня, book me, reserve, fill out the form, …) → `browser`. |
| Stubs | `src/browser/{capability,index,tools}.ts`, `src/groups/{index,tools}.ts` | Safe no-ops: the browser is `'none'`, `readsAll()` is false (so the old 01 F14 mention-only behaviour stays), and `TOOLS = []`. |
| Harness | `test/harness/fakeBrowser.ts` | `FakeBrowser` / `FakeBrowserSession` (scripted sites, events/requests logs, `failNextOpen`, `isAvailable`), `bookingSite()` (search → results → booking form → confirm, `/login`, `/pay` with stripe frame, `/menu` download, `/map` popup, a `10.0.0.5` link, a `169.254.169.254` beacon, `BOOKING_INJECTION` on the results page) and `longPageSite()`. |
|  | `fakeTelegram.ts` | `TEST_BOT_INFO_READS_ALL` (privacy mode OFF). |
|  | `testApp.ts` | `createTestApp({browser, botInfo})`; `t.browser`. Both survive `restart()`. |
|  | `fakes.ts` | `createRecordingGroupAgent()`; NOOP factories for the new modules; `createFakeCapabilities().browser`. |
| Tests | `test/unit/foundation/*` | importRules (playwright rule, s07 table owners, s07 module layout), contracts (catalog + BR/GR owners, 32 job kinds), migrations (004 on a populated 003 DB, `GROUP_DATA_TABLES`), testApp (factory list, schema v4). The privacy e2e seeds `from_tg_id`. The registry wire-size guard is 1,192 (+8 tokens for the `browser` kit). |

### 1.2 Playwright, verified on this machine (2026-09-29)

- `playwright@1.63.0` is the latest on npm (`npm view playwright version`). `npx playwright install chromium` installed
  Chrome for Testing **153.0.8010.12** into `~/Library/Caches/ms-playwright/chromium-1243` (+ `chromium_headless_shell-1243`).
- Probe (`scratchpad/pw/probe.mjs`, outside `src/`), re-run on the day:
  - `chromium.launch({headless:true})` took 127 ms.
  - `browser.newContext({viewport:{1280,800}, acceptDownloads:false, serviceWorkers:'block'})`.
  - `page.goto('https://example.com', {waitUntil:'domcontentloaded'})` returned 200 at +335 ms.
  - `page.screenshot({type:'jpeg', quality:70})` produced 17.9 KB.
  - Close took 625 ms in total.
- **Snapshot API** (use these, not `page.accessibility`, which is removed):
  - `page.ariaSnapshot({mode:'ai'})` returns YAML with `[ref=eN]`.
  - `page.ariaSnapshotJSON({mode:'ai', boxes:true})` returns a node tree `{role, name?, ref, box{x,y,width,height}, text?, url?, level?, checked?, active?, cursor?, children:[node|string]}`.
  - Actions go through `page.locator('aria-ref=eN')` with `.click()`, `.fill()`, `.selectOption()` or `.press()`.
  - Refs are stable across snapshots of the same DOM. A stale ref waits until the timeout, so always pass a short
    `timeout` (LIMITS.browserActionTimeoutMs = 5 s). Ten JSON snapshots of a small page take 7 ms.
  - **GOTCHA:** a password input's value appears in clear in the aria tree, and input `type` and `autocomplete` are
    not exposed. One `page.evaluate` per snapshot must collect `FieldInfo` (type, autocomplete, name, form id, submit)
    for each ref. Resolve refs with `locator('aria-ref=…').evaluate(...)`, or tag the elements in one pass.
- **Network guard:** `context.route('**/*', h)` intercepts documents and subresources. `route.abort('blockedbyclient')`
  makes `page.goto` reject with `net::ERR_BLOCKED_BY_CLIENT` (verified for `169.254.169.254` and a blocked host).
  `route.continue()` lets a request through.
- A submit button's form membership is available from `evaluate(el => ({tag, type, form: !!el.form}))` (verified).
  Clicking a submit runs the form's handler.
- Events to wire: `page.on('popup')`, `page.on('download')` (deny: `acceptDownloads:false` plus cancel), and
  `page.on('filechooser')` (deny).

---

## 2. Cross-set interface map

| Interface | Provider | Consumers | Notes |
|---|---|---|---|
| `BrowserCapability` (`caps.browser`) | BR (`src/browser/playwright.ts`, via `createBrowserCapability`) | BR only | Tests inject `FakeBrowser`. |
| `s.browserTasks: BrowserTaskService` | BR | Mini App (later), `/why` (later) | Read-only view. |
| `s.missionHooks` | planner (registry) | BR registers one | Closes the context when a mission ends. |
| `ToolSpec.approvalAttachment` | contract | BR implements it in `trust/executor.ts` and uses it in `browser_click`/`browser_type`/`browser_press` | Nobody else. |
| `IntegrationProvider.connectLink` → `pendingRef`, `connectionStatus` | CAL (`composio.ts`, `fake.ts`) | CAL (`service.ts` polling) | |
| `GoraEvent 'integration_connected'` | CAL (emits it after a connect completes) | agent engine (already generic) | Resumes the owner's pending question (B2). |
| `s.groupAgent: GroupParticipation` | GR | GR (`surfaces/group.ts`, `handlers.ts`) | |
| `GROUP_DATA_TABLES` | planner | GR (`purge`) | |
| `SideCalls.structured` group purposes | planner (contract); `agent/side.ts` already generic | GR | |
| `preloadKits` browser/calendar | planner (done) | BR / CAL rely on it | |

The sets have no runtime dependencies on each other, so they merge in any order. **CAL ↔ BR:** none. **GR ↔ BR:** none (a
browse task is never started from a group: `browse_task.surfaces = ['dm','topic']`). **GR ↔ CAL:** none.

---

## 3. Set BR: the browser agent (spec 07 §A)

### 3.1 Owned files

| File | Status | Content |
|---|---|---|
| `src/browser/capability.ts` | owns the stub | `createBrowserCapability(cfg, deps)` returns a lazy `PlaywrightBrowser` when `cfg.providers.browser === 'playwright' && cfg.features.browser`, else `createNoBrowser()`. Keep the exported names. `available()` stays false until the first launch succeeds or fails; a launch failure logs the "`npx playwright install chromium`" hint once. |
| `src/browser/playwright.ts` | new | `PlaywrightBrowser implements BrowserCapability`: the ONLY runtime importer of `playwright` (dynamic `import('playwright')` on the first `openSession`); one shared `Browser`, one `BrowserContext` per task (`acceptDownloads:false`, `serviceWorkers:'block'`, viewport, locale, timezoneId); `context.route('**/*')` → `policy.check(url, kind)` → `continue` / `abort('blockedbyclient')`; popups adopted as the current page (counted); downloads and file choosers denied; `state()` = `ariaSnapshotJSON({mode:'ai', boxes:true})` + one `evaluate` for `FieldInfo` + frame hosts; actions via `aria-ref=`; `screenshot` jpeg q70 of the viewport; `close` idempotent; `closeAll`. The seam comment names Browserbase/Steel (`chromium.connectOverCDP`) as a later provider; do not implement one. |
| `src/browser/netGuard.ts` | new | `createNetworkPolicy(s, o)` implements `NetworkPolicy`. It reuses `validateUrl`, `isBlockedAddress` and `guardedLookup` from `src/capabilities/safeFetch.ts` (import only): http(s) only, ports 80/443, no credentials, no `localhost`, not `cfg.publicUrl`'s host, not `BLOCKED_DOMAINS`, and DNS-resolved addresses not private/loopback/link-local/metadata. `data:`, `blob:`, `file:` and `chrome:` are refused (`blob:` for documents only). It memoizes DNS per task for 60 s. Residual risk: Chromium re-resolves DNS itself (rebinding); record it in §7 and do not try to solve it in v1. |
| `src/browser/snapshot.ts` | new | `buildSnapshot(raw, o:{maxTokens, ownerValues})` returns `{text, refs: Map<ref, RefInfo>, forms, flags:{login, payment, captcha}, tokens}`. Format: `Title / URL`, then `Interactive (viewport):` lines `eN role "name" [value="…"] [form fN]`, then `Text:` (headings + short excerpts), grouped by form. **Masking:** a value of `type=password` or `autocomplete=cc-*|current-password|new-password`, or a name matching card/cvc/cvv/iban, is rendered as `value=•••`. Deterministic truncation by priority: focused, then viewport interactive (top-to-bottom), then forms, headings, below-fold interactive, and text excerpts last, measured with `estimateTokens` (`src/kernel/tokens.ts`). Caps come from `LIMITS.browserSnapshotMaxTokensSmall` (profile `groq-free`) or `…Large`. |
| `src/browser/detect.ts` | new | Pure detectors over `RawPageState` and the snapshot refs: `isSubmitAction(ref)` (FieldInfo.submit, or a button/link name matching the EN/RU verb list of A4: book, reserve, confirm, send, submit, order, buy, pay, sign up, register, subscribe, delete, забронировать, подтвердить, отправить, заказать, купить, оплатить, зарегистрироваться, подписаться, удалить, and their inflections), `isPaymentPage` (cc-* autocomplete, card/cvc names, or frame/host in `PAYMENT_HOSTS`: stripe, checkout, paypal, yookassa, cloudpayments, kaspi, …), `isLoginWall` (a password field, or a sign-in form with no other form), `isCaptcha`. |
| `src/browser/classify.ts` | new | Sentinel classification for the browser tools. Reading and navigation are `read_public` (risk 0). `browser_type` is `write_self` when the text is owner-provided (it appears in the task's goal or constraints, or in the owner's profile or `users` row: name, phone, email). An email, phone, address or person name that is **not** owner-provided, including text from a page, is `send_external`, risk 3, and asks. A submit action (click on a submit, `type{submit:true}`, `press Enter` in a form) is `send_external`, risk 3, or `spend`, risk 4, when payment words or a payment page are detected. It is never grantable (`grantable:false`). Classification reads `session.lastState()` synchronously. |
| `src/browser/tools.ts` | owns the stub | `TOOLS`: `browse_task` (surfaces `dm`,`topic`; class `control`; zod `{goal≤1000, start_url?: url, constraints?≤500}`) and the in-mission tools `browser_open {url}`, `browser_snapshot {}`, `browser_click {ref}`, `browser_type {ref, text≤500, submit?:false}`, `browser_select {ref, value≤200}`, `browser_press {key ∈ BROWSER_KEYS}`, `browser_scroll {direction: up\|down}`, `browser_back {}`, `browser_show {caption≤200}`, `browser_done {summary≤1000, result_url?}`, all with surfaces `['mission']` only (S02 refuses them elsewhere). Snapshot-returning tools set `outputTaint: 'web'` and return the snapshot as `ToolOutput.untrusted: {source:'web', label: host}` (the executor wraps it `<untrusted source="web">`, exactly like `web_fetch`), guard-screened (03 R5). The submit tools implement `renderDiff` (host, action, the form fields and values from the snapshot with secrets masked, and "what happens next"), `approvalMeta` (card goes to the mission thread) and **`approvalAttachment`** (a fresh screenshot). |
| `src/browser/tasks.ts` | new | The `browser_tasks` repo and lifecycle. `startTask` checks the quota (`browser`), the one-active-task index and `caps.browser.available()`, then calls `s.missions.start(...)` with a browse-mission goal template, `s.toolkits.load(missionConvId, 'browser')`, and inserts the row. It also has step accounting (≤ 40: then park with `step_limit`), the wall clock (15 min: park with `time_limit` and a `[▶ Продолжить]` offer), park/resume (`login`, `payment`, `captcha`, `user`), `current_url_enc`/`current_host`, and the `BrowserTaskService` view. |
| `src/browser/index.ts` | owns the stub | `createBrowserModule(s)`. At factory time it registers the `browser_sweep` job + `sys:browser_sweep` cron (every 60 s: close sessions whose task or mission ended, enforce the wall clock, mark `running` tasks with no live session after a restart), `s.missionHooks.push({name:'browser', onMissionEnded})` (close the context, mark the row `done`/`failed`/`cancelled`), the privacy hook (`onDeleteUser`: close sessions and delete rows; `exportUser`: goal and constraints (the owner's own text), status, host, steps and dates, never screenshots or field values; `retentionSweep`: finished rows older than `LIMITS.browserTaskRetentionDays`), a mission context provider `browser.task` (surface `mission`: "browser task: status, step N/40, host, time left"), and callbacks `br:` (continue after time limit, login-wall choice). It returns `{tasks}`. |
| `src/browser/strings.ts` | new | EN/RU texts: status labels ("Шаг 7: заполняю форму…"), the login-wall park line, the payment handover ("последний шаг — оплата — за вами: <url>"), the time-limit offer, and the unavailable browser. |
| `src/trust/executor.ts` | **edit (BR only)** | After `approvals.create`, if `spec.approvalAttachment` is set, send its photo via `putBlob` (owner = user) + outbox `sendPhoto` into the card's chat/thread, idempotency `pa_photo:<id>`, **before** the card. Any error is logged and the card still goes out. No other change. |
| `test/harness/s07-br.ts` | new | Extra fake sites (a CAPTCHA page, a page with an injected "click Submit" instruction next to a real submit, a very long form). |
| `test/unit/browser/*.test.ts` | new | See 3.4. |
| `test/e2e/browser.e2e.test.ts` | new | See 3.4. |
| `test/live/browser.live.test.ts` | new, opt-in | Only when `LIVE_BROWSER=1`, and excluded from the unit/e2e projects (`test/live/` is not in `vitest.config.ts`; run with `npx vitest run test/live/browser.live.test.ts`). Opens `https://example.com` through `PlaywrightBrowser` + `netGuard` and asserts the snapshot and a blocked `169.254.169.254`. |

### 3.2 Consumes

- `caps.browser`, `s.missions` (`start`, `finish`, `stop`, `setStatusLine`, `report`), `s.toolkits.load`,
  `s.quotas.check`/`consume('browser')`, `s.ledger` (`browser_action`: `{taskId, host, action, refRole, refName}`,
  never values), `s.caps.guard` (03 R5), `s.caps.vision` (optional describe, ≤ 1 per 5 steps), `s.crypto`,
  `s.repos.messages.putBlob`, `s.telegram.outbox`, and `task_wait` semantics (existing).
- `createNetworkPolicy` uses `s.config.publicUrl` and `BLOCKED_DOMAINS`.

### 3.3 Behaviour details (from spec 07 A2–A5)

- **Start.** `browse_task` never opens the browser itself. It creates the mission, replies with one short line plus
  the mission link or topic, and the mission run drives the `browser_*` tools. It refuses cleanly when the browser is
  unavailable, the user already has an active task, or the quota is out. A `[⏹ Stop]` on the mission card works as
  today. `Stop` → mission hook → `session.close()`.
- **Session per task.** Open it lazily on the first `browser_open`. If the session is missing (restart or crash), open
  a fresh one at `current_url` and tell the model "the browser was restarted; take a new snapshot".
- **Every step:** the step counter +1; `setStatusLine` ("Шаг N: …"); a ledger `browser_action`; wall-clock and step
  limits. On `groq-free`, every snapshot must stay under 1,800 tokens.
- **Payment page detected** (`browser_open`/`click` lands on one, or `browser_type` targets a payment field): the tool
  refuses to type and parks the task with `payment`. The owner gets the URL and the "last step is yours" line. Then
  `browser_done` is expected.
- **Login wall:** park with `login`. The owner gets a short message with `[Продолжить без входа]` and the link. The
  owner's reply (or the button) resumes the run through a `browser_resume` event. No credentials are ever typed:
  `browser_type` into a password field → tool error `NO_CREDENTIALS`.
- **Injection:** page text is untrusted and wrapped, and the run is web-tainted, so a submit always asks (it is never
  grantable, even with a grant). The e2e test proves that `BOOKING_INJECTION` leads to no submit without an approval
  tap.
- **Deny** on the submit card: the tool result is "the owner declined"; the model calls `browser_done` or asks. The
  task finishes cleanly and the context is closed.

### 3.4 Acceptance tests (spec 07 A6 + A3/A4)

Unit tests (`test/unit/browser/`):
- `snapshot`:
  - the caps (`longPageSite` ≤ 1,800 on groq-free, ≤ 6,000 large);
  - deterministic truncation (same input → same text), with viewport and focused elements first;
  - password and card values masked;
  - forms grouped.
- `netGuard`:
  - `10.0.0.5`, `127.0.0.1`, `169.254.169.254`, `[::1]`, `localhost`, the Gora host, `:8080`, `file:`, `data:`,
    `chrome:` are blocked;
  - a hostname resolving to a private IP is blocked (injected lookup);
  - `https://tables.example` is allowed.
- `detect`:
  - submit verbs EN/RU, payment page (autocomplete, stripe frame), login wall, captcha;
  - a non-submit "Найти" search button is NOT classified as a commit, so search forms go through without a card.
- `classify`:
  - the owner's own name or phone typed → `write_self`;
  - a page-derived email → ask;
  - submit → `send_external` (non-grantable);
  - pay → `spend`.
- `tasks`:
  - one active task per user;
  - the step limit parks with `step_limit`;
  - the wall clock parks with `time_limit` (FakeClock);
  - a mission hook closes the session.

E2e tests (`test/e2e/browser.e2e.test.ts`, FakeBrowser `bookingSite()`, ScriptedTransport):
1. "Забронируй столик в Café Alma сегодня на 19:00 на имя Adi, 2 гостя": `browse_task` → mission → search → results →
   booking form → the submit asks. The approval card is preceded by a **sendPhoto** in the mission thread, and the card
   lists Name=Adi, Guests=2 and the host. Approve → confirm page → `browser_done` → mission done, context closed.
2. **Deny** on the card → no submit event in `FakeBrowser.events`, the mission finishes cleanly and the context is
   closed.
3. **Stop** mid-task → `FakeBrowser.opened[0].closed === true`, and no further actions.
4. `browser_open http://10.0.0.5/admin` → tool error `blocked`. The metadata beacon subresource is refused
   (`FakeBrowser.requests`).
5. Login wall (`/login`) → the task parks with `login` and a short message. The owner replies "продолжай без входа" →
   resumes.
6. Payment (`/pay`) → no typing into card fields, the task parks with `payment`, and the owner gets the URL.
7. Injection: the results page's `BOOKING_INJECTION` + a scripted model that obeys it → the click on «Забронировать»
   produces an approval card, never an unapproved submit.
8. Snapshot token cap on `longPageSite()` under the `groq-free` profile.
9. Restart mid-task (`t.restart()`) → the task continues in a fresh context at `current_url`, or the sweep marks it
   `interrupted` when the mission ended.
10. Quota: free plan, 4th task of the day → refused with the plan line.

Existing tests BR may update: none expected. If an approvals e2e breaks because of the executor edit, BR owns the
fix, limited to `test/e2e/approvals.e2e.test.ts` assertions about message counts.

---

## 4. Set CAL: the Composio provider fix-up (spec 07 §B)

### 4.1 Owned files

| File | Status | Content |
|---|---|---|
| `src/integrations/composioMap.ts` | edit | All slugs, arguments, **pinned toolkit versions** and parsers (§4.3). `CAL_SLUGS.respond` = `GOOGLECALENDAR_PATCH_EVENT` with `rsvp_response`. |
| `src/integrations/composio.ts` | edit | REST over the injected `fetchImpl` (keep it; the SDK would use global fetch and bypass DI). Fix every item in §4.2. Add `connectionStatus`, `composioUserId(userId)` = `'g_' + s.crypto.hmac('composio_user', userId).slice(0, 32)` (stable, never the Telegram id: pass `crypto` in the options), auth config resolution per B5, and `version` on every execute. |
| `src/integrations/links.ts` | new | The `integration_links` repo. Insert on `startConnect` (`state`, sealed `pending_ref`, `deadline = now + LIMITS.integrationPollForMs`, `next_poll_at = now + integrationPollEveryMs`, the return chat and `resume_conversation_id`). The `integration_poll` job handler (§4.4). `pendingLinks(userId)`. |
| `src/integrations/service.ts` | edit | `startConnect` records a link row (pendingRef, expiresAt) and schedules `integration_poll` (dedupe `ipoll:<linkId>`). `complete()` is shared by the callback and the poller: it **claims the same `oauth_states` row** (`used_at IS NULL`), so a callback and a poll hit complete exactly once, and it checks that the callback's `connected_account_id` equals the link's `pending_ref` when both exist. B2 UX: the "Connected ✓" message becomes **"Готово ✓"** (one line, no permission chips: they live in the Mini App Connections screen), then emit `GoraEvent {type:'integration_connected', ref: kind, body: 'The owner just connected <Service>. Answer their pending question now.'}` into `resume_conversation_id` (else the DM conversation) with `priority 'interactive'`. `first_look` becomes one friendly line and no event run when a resume is pending. `sendConnectCard` becomes one short line + `[Подключить Google Календарь]` (EN: `[Connect Google Calendar]`), with no "Зачем:"/"Why:" paragraph. `pendingLinks`. The privacy hook also deletes `integration_links`. The `capabilities` context line is unchanged. |
| `src/integrations/fake.ts` | edit | `FakeIntegrationProvider.connectLink` returns a `pendingRef`; `connectionStatus` is scripted (`fake.completeByPoll(pendingRef)` flips it to active) so tests exercise polling without a callback. |
| `src/integrations/index.ts` | edit | Pass `s.crypto`, `cfg.composio.authConfigs` and `s.config.env` into `ComposioProvider`. |
| `src/tools/impl/connect.ts` | edit | `integration_connect` passes the run's conversation id as the resume target. The text contract: "Connect button sent; say ONE short line; the question resumes automatically after connect". |
| `src/tools/impl/calendar.ts` | edit | On `NOT_CONNECTED` (owner in DM/topic): send the connect card itself once per run (via `s.integrations.sendConnectCard`, with the run's conversation as the resume target), then return a tool result telling the model to say one short line and stop. This is B2's "one line + button" without an extra model round. `calendar_respond_invite` now works (the respond op is mapped). |
| `src/tools/impl/gmail.ts` | edit only if the §4.3 arguments change its call shapes | e.g. `send_updates` or `thread_id`. |
| `scripts/smoke-composio.ts` | new | B3. With `LIVE=1` and `COMPOSIO_API_KEY`, it creates a connect link for the test user `smoke-<hmac>` and prints the URL. `--after-connect` lists tomorrow's events and free slots (freebusy) for the same user. `--write` creates one event (the summary `Gora smoke <iso>`), prints its id and **deletes** it. `--gmail` also resolves or creates the Gmail auth config lazily and searches for 1 message. It uses the real `ComposioProvider` with `globalThis.fetch` (a script, not `src/`), never touches `./data`, and exits 2 without `LIVE=1`. `package.json` already has `"smoke:composio": "node --env-file-if-exists=.env scripts/smoke-composio.ts"` (planner-added). |
| `webapp/src/screens/Connections.tsx` | edit if needed | Show "ожидаю подключения…" for `pendingLinks`. The permission chips stay here. |
| `src/http/routes/*` (only the connections route) | edit if needed | Expose `pendingLinks` to the Connections screen. |
| `test/unit/integrations/*.test.ts` | new | See 4.5. |
| `test/review/tools/composioBinding.test.ts`, `test/review/tools/ambiguousFailure.test.ts` | update | Adjust them to the HMAC user id, exact `ACTIVE` status and pinned versions. |
| `test/e2e/integrations.e2e.test.ts`, `test/e2e/integration.e2e.test.ts` | update | Adjust them to the "Готово ✓" + resume UX. |
| `test/harness/s07-cal.ts` | new | `createComposioFetch()`: a fake Composio REST server over `fetchImpl`. It records requests and scripts the link, account status, auth configs and tool responses, with shapes from §4.2. |

### 4.2 Composio, verified from the current docs (2026-09-29)

Sources:
- the docs.composio.dev raw pages `/toolkits/googlecalendar.md`, `/toolkits/gmail.md`,
  `/docs/authentication/manually-authenticating.md` and `/examples/harness-integration.md` (saved under
  `scratchpad/composio/`);
- the typings of `@composio/core` **0.21.0** / `@composio/client` **2.0.0-rc.8**;
- spec 07 §B5 (the lead's live facts).

- **REST versions:**
  - v3.1 (`https://backend.composio.dev/api/v3.1`) is current.
  - v3 is frozen but supported. **On v3, omitting `version` on `POST /tools/execute/{slug}` selects the pinned
    `00000000_00` tool schemas.** On v3.1 omission selects the latest.
  - Gora pins `version` explicitly on every execute: the toolkit versions are `googlecalendar` **`20260915_00`**
    (50 tools) and `gmail` **`20260915_00`** (62 tools), so argument names cannot drift under us.
- **Auth:** header `x-api-key: ak_…`. The Platform project key works on `/api/v3/*` (B5, live); `ck_…` → 401 code 801.
- **Auth configs** (B5: code against v3 exactly as the lead did):
  - `GET /api/v3/auth_configs?toolkit_slug=<slug>` → `{items:[{id, name, status, is_composio_managed, toolkit:{slug}}]}`.
  - `POST /api/v3/auth_configs {"toolkit":{"slug":"googlecalendar"},"auth_config":{"type":"use_composio_managed_auth","name":"gora-googlecalendar"}}`
    → `{auth_config:{id}}`.
  - Resolution order: `cfg.composio.authConfigs.gcal|gmail` → an existing config **named `gora-<slug>`** (enabled) →
    create it. This is idempotent by name. The Gmail config is created lazily, only on the first Gmail connect.
    The live gcal config is `ac_kB4OafdmH77M` (`.env` `COMPOSIO_AUTH_CONFIG_GCAL`).
- **Connect link** (SDK `connectedAccounts.link(userId, authConfigId, {callbackUrl})`):
  - `POST /api/v3.1/connected_accounts/link {auth_config_id, user_id, callback_url}` → 201
    `{link_token, redirect_url, expires_at, connected_account_id}`.
  - The account starts `INITIATED`. After auth, Composio redirects to `callback_url` with `status=success|failed` and
    `connected_account_id` appended (existing query params are kept).
  - The docs require checking the callback's `connected_account_id` against the attempt stored server-side ("query
    parameters alone aren't proof of ownership").
- **Status** (SDK `connectedAccounts.get(nanoid)` / `waitForConnection`):
  - `GET /api/v3.1/connected_accounts/{id}` → `{id, user_id, status, toolkit:{slug}, auth_config:{id, is_composio_managed}}`.
  - `status ∈ INITIALIZING | INITIATED | ACTIVE | FAILED | EXPIRED | INACTIVE | REVOKED`.
  - Revoke: `DELETE /api/v3.1/connected_accounts/{id}`.
- **Execute** (SDK `tools.execute(slug, {userId, connectedAccountId, arguments, version})`):
  - `POST /api/v3.1/tools/execute/{slug} {connected_account_id, user_id, arguments, version}` →
    `{data, error, successful, log_id}`.
  - This is a client-side call made by our executor after Sentinel. Never use Composio sessions, MCP or Tool Router
    (B1: no server-side autonomous calls).

**Mismatches in the current `composio.ts` / `composioMap.ts` (CAL fixes all of them):**
1. `user_id` is Gora's internal user id in clear. It must be a stable HMAC (B1) in link, execute, and the ownership
   check in `completeConnection`/`connectionStatus`.
2. `completeConnection` accepts `status` via `/active/i`, which also matches **`INACTIVE`**. It must be `=== 'ACTIVE'`.
3. `authConfig()` takes "the first enabled config of the toolkit" (possibly a foreign, non-managed one) and creates one
   **without a name** (not idempotent). It also ignores `COMPOSIO_AUTH_CONFIG_*`. Fix per B5 (above).
4. `connectLink` drops `connected_account_id` and `expires_at`, so polling is impossible. Return them as
   `pendingRef`/`expiresAt`.
5. There is no `connectionStatus`, so no polling (B1 requires every 5 s for 10 min).
6. No `version` on execute: the tool schemas drift. Pin the versions per toolkit in `composioMap.ts`
   (`TOOLKIT_VERSIONS`).
7. The callback's `connected_account_id` is not compared with the issued link's id. Compare it (service + links).
8. `CAL_SLUGS.respond = null` ("no documented RSVP"). It **is** documented:
   `GOOGLECALENDAR_PATCH_EVENT {calendar_id:'primary', event_id, rsvp_response:'accepted'|'declined'|'tentative'}`.
9. `calArgs.list` sends `calendar_id` and `q`. `GOOGLECALENDAR_EVENTS_LIST` takes **`calendarId`** and **`query`**
   (camelCase: `timeMin`, `timeMax`, `maxResults`, `singleEvents`, `orderBy`, `timeZone`,
   `privateExtendedProperty`).
10. `calArgs.findByIdem` sends `calendar_id`. It must be `calendarId` (and `privateExtendedProperty: 'gora_idem=<key>'`
    is right).
11. `calArgs.create` sends `send_updates: boolean`. It is an enum string: `'all'|'externalOnly'|'none'`, and the
    default `'all'` emails every attendee. Map it to `'all'` only when attendees exist (the approval covers it), else
    `'none'`. Also set `create_meeting_room: false` (a Meet link is requested by default).
12. `calArgs.update` (PATCH): the arguments are right (`calendar_id` is required, `start_time`/`end_time`/`timezone`),
    but add `send_updates` (string) when attendees are affected.
13. `calArgs.remove`: add `send_updates` (string); `send_notifications` is deprecated.
14. `calArgs.freeBusy`: `GOOGLECALENDAR_FREE_BUSY_QUERY {items:['primary'], timeMin, timeMax, timeZone}` is fine. Add
    `timeZone` (the docs warn that UTC skews results). `GOOGLECALENDAR_FIND_FREE_SLOTS` exists
    (`{items, time_min, time_max, timezone}`), but keep freebusy: `calendar_find_free_slots` computes slots locally
    from busy intervals.
15. Gmail slugs are all current: `GMAIL_FETCH_EMAILS {query, max_results, include_payload, verbose, ids_only}`,
    `GMAIL_FETCH_MESSAGE_BY_THREAD_ID {thread_id}`,
    `GMAIL_CREATE_EMAIL_DRAFT {recipient_email, extra_recipients, cc, bcc, subject, body, is_html, thread_id}`,
    `GMAIL_GET_DRAFT {draft_id, format}`, `GMAIL_DELETE_DRAFT {draft_id}`, `GMAIL_SEND_DRAFT {draft_id}`. Add
    `is_html:false` to create, and `format:'full'` to get. Keep `findSent` on `GMAIL_FETCH_EMAILS`.
16. The error mapping ignores HTTP 401 code 801 (wrong key type). Map it to a clean "integrations misconfigured" error
    (and the boot warning already exists).

### 4.3 Calendar and Gmail tool slugs (pinned `20260915_00`)

| Op | Slug | Arguments (required*) |
|---|---|---|
| list | `GOOGLECALENDAR_EVENTS_LIST` | `calendarId:'primary'`, `timeMin`, `timeMax`, `timeZone`, `query?`, `maxResults`, `singleEvents:true`, `orderBy:'startTime'` |
| freeBusy | `GOOGLECALENDAR_FREE_BUSY_QUERY` | `items*:['primary']`, `timeMin*`, `timeMax*`, `timeZone` |
| create | `GOOGLECALENDAR_CREATE_EVENT` | `calendar_id:'primary'`, `summary`, `start_datetime*`, `end_datetime`, `timezone`, `attendees[]`, `location?`, `description?`, `send_updates:'all'\|'none'`, `create_meeting_room:false`, `extended_properties:{private:{gora_idem}}` |
| update | `GOOGLECALENDAR_PATCH_EVENT` | `calendar_id*:'primary'`, `event_id*`, `summary?`, `start_time?`, `end_time?`, `timezone?`, `location?`, `description?`, `attendees?`, `send_updates?` |
| remove | `GOOGLECALENDAR_DELETE_EVENT` | `event_id*`, `calendar_id:'primary'`, `send_updates` |
| respond | `GOOGLECALENDAR_PATCH_EVENT` | `calendar_id*:'primary'`, `event_id*`, `rsvp_response*:'accepted'\|'declined'\|'tentative'` |
| findByIdem | `GOOGLECALENDAR_EVENTS_LIST` | `calendarId:'primary'`, `privateExtendedProperty:'gora_idem=<key>'`, `maxResults:1` |
| mail search / findSent | `GMAIL_FETCH_EMAILS` | `query`, `max_results`, `include_payload:false` |
| readThread | `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` | `thread_id*` |
| createDraft | `GMAIL_CREATE_EMAIL_DRAFT` | `recipient_email`, `extra_recipients`, `cc`, `subject`, `body`, `is_html:false`, `thread_id?` |
| getDraft | `GMAIL_GET_DRAFT` | `draft_id*`, `format:'full'` |
| deleteDraft | `GMAIL_DELETE_DRAFT` | `draft_id*` |
| sendDraft | `GMAIL_SEND_DRAFT` | `draft_id*` |

Responses: tools return `{data, successful, error, log_id}`. Create returns the event under `data.response_data`
(`payload()` already unwraps it).

### 4.4 Polling (B1)

- Job `integration_poll` (payload `{linkId}`, priority null). Each run:
  - load the link and stop when it is no longer `pending`;
  - past `deadline_at` → `expired` (a quiet ledger entry; no message);
  - call `provider.connectionStatus(pendingRef, {userId, kind})`:
    - `pending` → reschedule at +5 s (`integrationPollEveryMs`);
    - `active` → `complete()` (claims the `oauth_states` row, exactly once) → "Готово ✓" + resume;
    - `failed` → mark it `failed`, plus one line in the return chat ("не получилось подключить — попробуем ещё раз?");
    - a network error → `last_error` class and a retry.
- The fake provider and tests drive it with FakeClock.
- A callback arriving after a poll completed returns the existing "Connected ✓" HTML page (the state is already used
  → "already connected" wording; no second message).

### 4.5 Acceptance tests

Unit tests (`test/unit/integrations/`):
- The composio request shapes against `createComposioFetch()` (see §4.2):
  - link (HMAC `user_id`, `callback_url` with state) → `pendingRef` + `expiresAt`;
  - status mapping for all 7 statuses (**`INACTIVE` is not active**);
  - the owner or toolkit mismatch returns `mismatch`;
  - auth config resolution: env id → by name `gora-<slug>` → create with name, and it is idempotent (a second call
    makes no POST);
  - the Gmail config is created only on the first Gmail connect;
  - every execute carries `version:'20260915_00'`;
  - `rsvp_response` for respond;
  - camelCase EVENTS_LIST arguments;
  - `send_updates` is a string;
  - 401/801 → a misconfigured error.
- `links`: polling every 5 s until active, the 10-min deadline → expired, a callback + poll race → exactly one
  "Готово ✓".

E2e tests (`test/e2e/calendar-connect.e2e.test.ts`, the fake provider):
1. "Что у меня завтра в календаре?" with nothing connected → exactly ONE short line + one url button
   `[Подключить Google Календарь]`. No card storm and no chips in chat.
2. Complete by **polling** (no callback): after ≤ 5 s of FakeClock → "Готово ✓", then the answer to the original
   question in the same chat (the scripted model lists tomorrow's events from the fake calendar).
3. Complete by **callback** → the same single "Готово ✓" + answer, and the poller stops.
4. `calendar_respond_invite` accepted → the provider `respond` is called through the executor (approval per the
   existing class).
5. `first_look` = one friendly line.

---

## 5. Set GR: Gora as a group participant (spec 07 §C)

### 5.1 Owned files

| File | Status | Content |
|---|---|---|
| `src/groups/index.ts` | owns the stub | `createGroupModule(s)` → `{participation}`. At factory time it registers:<br>• jobs `group_summarize`, `group_chime`, `group_feedback`;<br>• the privacy hook `groups` (see below);<br>• a context provider `groups.policy` (surface `group`: "group chattiness: less; recent summary available" — metadata only, never member text).<br>`readsAll()` = `s.telegram.botInfo.can_read_all_group_messages === true && cfg.features.groupParticipant && cfg.features.groups`. It is checked at call time. The first `false` logs the BotFather step once: `/setprivacy` → Disable, then re-add the bot.<br>The privacy hook `groups`:<br>• `retentionSweep`: messages older than 14 days, the purge of chats that left more than 7 days ago (`GROUP_DATA_TABLES`), and expired open reward windows;<br>• `onDeleteUser`: nothing extra (`USER_DATA_TABLES` already deletes the member's `group_messages` rows);<br>• `exportUser`: the member's own group lines are listed as a count per chat only. |
| `src/groups/repo.ts` | new | SQL for `group_messages`, `group_summaries`, `group_policy`. Text is sealed under `g:<chatId>` (owner `grp:<chatId>`, via `s.crypto`, the same DEK family as group memory) with AAD `<table>\|<column>\|<chatId>:<key>`. `sender_hmac = crypto.hmac('member', chatId:tgId)`. |
| `src/groups/observe.ts` | new | `observe(m)`:<br>• store the message: caption, and a voice transcript only when STT is available and the plan allows (background priority);<br>• bump `pending_count`;<br>• schedule `group_summarize` (dedupe per chat) at 40 messages or 10 idle min;<br>• (re)schedule `group_chime` at `at + 45 s` (the lull; dedupe per chat);<br>• treat a reply to a bot chime as engagement (reward);<br>• notice when a message by a member previously asked about is answered.<br>It never throws. |
| `src/groups/heuristic.ts` | new | A pure `scoreWindow(msgs, now, policy)` → `{score, kind hint, reasons}`.<br>Positive signals:<br>• an open question to the group, unanswered ≥ 2 min (`?` / question words EN/RU, no reply after it);<br>• a factual disagreement ("нет, это не так", "actually", conflicting numbers or dates);<br>• planning (dates, times, places, "когда соберёмся", "где встречаемся");<br>• a recommendation request ("посоветуйте", "какой лучше");<br>• an explicit help request.<br>Negative signals:<br>• a personal or emotional conversation (venting words, 1:1 back-and-forth with emotional markers) → **veto**;<br>• a fast back-and-forth (≥ 6 msgs/min).<br>Threshold by chattiness: `quiet` = ∞ (mention-only), `less` high, `normal`, `more` low; plus `threshold_adj`. |
| `src/groups/chime.ts` | new | The `group_chime` job:<br>• caps first: ≤ 1 per 30 min, ≤ 6 per local day, not at night (22:00–09:00 in the group tz: the majority of known members' `users.tz`, else group memory, else no chime-ins at all), not while venting, `llmBudget.allow('background')` (degrades to mention-only when the budget is tight);<br>• the heuristic;<br>• over the threshold → the fast judge `s.side.structured({purpose:'group_judge', role:'fast'})` → `{should_speak, kind, value≤100}`;<br>• the Thompson choice over `kind` via `thompson(s.random, …)` from `src/behaviour/bandit.ts` (a per-group Beta with a population prior Beta(1,3), `LIMITS.groupPriorAlpha/Beta`);<br>• compose with `purpose:'group_compose', role:'main'`, ≤ 2 sentences, passed through `sanitizeDraft` (`src/behaviour/compose.ts`, import only) and the outbox;<br>• `onBotMessage` with `chime`; open a 10-min reward window (`group_feedback` job). |
| `src/groups/feedback.ts` | new | The bandit update:<br>• reward: a positive reaction (👍❤🔥😂👏🙏) on the chime, or a reply to it / a message addressing Gora within 10 min;<br>• penalty: ignored (the window closes), a negative reaction (👎🤡😴), or "тише/не лезь/замолчи" (strong: β += 3 and chattiness steps down).<br>`chattinessFromWords`: "Гора, тише", "не лезь", "замолчи" → quieter; "можешь чаще", "активнее", "говори больше" → louder. |
| `src/groups/summary.ts` | new | `group_summarize`: a rolling summary (fast, batched) of new messages + the previous summary → `group_summaries` (sealed), then **group facts** (`purpose:'group_facts'`) → `s.memory.save({kind:'group', chatId}, {kind:'group_decision'\|'date'\|'preference'\|'fact', explicit:false, authorUserId:null, source:{kind:'user_message', tgMessageId}})`. Plans, decisions, dates, stated preferences only; sensitive topics are skipped. |
| `src/groups/catchup.ts` | new | `catchup(chatId, forTgId, …)`: messages since that member's last message (cap ~150, the summary for older ones) → `purpose:'group_catchup'` (fast, `interactive`) → ≤ 8 lines. Delivery (by the surface): an ephemeral reply if the message has `ephemeral_message_id` (as `/me` does), else a DM (or the `me_` deep link when there is no DM). |
| `src/groups/names.ts` | new | `addressedByName` (`^\s*(гора\|gora)\b[,!?:]?`, plus "гора, ты тут", vocative forms; not "горы", "в горах") and `chattinessFromWords`. |
| `src/groups/tools.ts` | owns the stub | `group_invite_link {}` (surfaces dm/topic, class `ui`, toolkit `account`) → `https://t.me/<bot>?startgroup=g&admin=` (no rights requested) as a url button effect + one line. |
| `src/groups/prompts.ts` | new | System prompts and zod schemas for the five purposes. Member text is always wrapped as `group_member` untrusted content. The judge sees the window + summary only; it never sees DM data. |
| `src/surfaces/group.ts` | **edit (GR only)** | See the note after this table. |
| `src/surfaces/handlers.ts` | **edit (GR only)** | See the note after this table. |
| `src/surfaces/strings.ts` | **edit (GR only)** | New `SURF` keys: `group_join_line` (C2, EN/RU/…; the RU text is exactly the spec line), `group_catchup_*`, `group_quieter_ack`, `group_louder_ack`, `add_to_group_button`. |
| `src/surfaces/commands.ts` | **edit (GR only)** | The `/settings` answer gets the url button `[Добавить Гору в группу]` (C6). |
| `src/telegram/commands.ts` | **edit (GR only)** | The group command list gets `catchup` (EN "What did I miss?", RU "Что я пропустил?"). |
| `src/memory/store.ts` | **edit (GR only)** | The §9 gate: also allow a **group** scope save when `src.kind === 'user_message' && !explicit` (the automatic group facts of spec 07 C3, which overrides 01 §9's explicit-only rule). `sourceLabel`: a group-scope `user_message` + `extractor` → "noticed in the group" / «замечено в группе». Nothing else. |
| `src/http/routes/me.ts` | **edit (GR only)** | Add `addToGroupUrl` to the `/api/me` payload. |
| `webapp/src/screens/Home.tsx` | **edit (GR only)** | The `[Добавить Гору в группу]` button (`openTelegramLink(addToGroupUrl)`). |
| `test/harness/s07-gr.ts` | new | Update builders that `test/harness/updates.ts` lacks: `message_reaction` in a group, a group voice note, and a reply to a given message from another member. `U.groupText`, `groupMention`, `groupReply`, `groupCommand` and `ephemeralMe` already exist. |
| `test/unit/groups/*.test.ts` | new | See 5.4. |
| `test/e2e/group-participant.e2e.test.ts` | new | See 5.4. |
| `test/e2e/group.e2e.test.ts` | update | The first test must keep passing with the default `TEST_BOT_INFO` (privacy mode ON → mention-only, nothing stored). |

Edits to `src/surfaces/group.ts` (GR only):
- In `onGroupMessage`, when `s.groupAgent.readsAll()`:
  - every non-bot message goes into `observe` (with `addressed`), `addressedByName` counts as a trigger, and chattiness
    words are handled first (ack + `setChattiness`);
  - an addressed message gets the last N stored messages + the summary added as **one untrusted `member` input**
    (`untrusted:true`, like the replied-to message today) before the member's input. This is the group context, and it
    never goes into system context lines.
- `/catchup` and "что я пропустил?" → `catchup`.
- `onMyChatMember` on join: when `readsAll()`, send ONE join line (C2, no buttons) instead of the intro with a button;
  record `join_line_at`. On leave: nothing new (the purge runs after the grace period via retention).
- Gora's own sends in the group → `onBotMessage` (outbox `onSent` refKind `grp_bot`, registered at factory time in
  `src/groups/index.ts`).
- `/forget all|всё` in the group → `purge(chatId,'forget')`, besides memory.

Edit to `src/surfaces/handlers.ts` (GR only): the `message_reaction` handler gets a group branch →
`s.groupAgent.onReaction`. The group message handler passes captions/voice.

### 5.2 Consumes

- `s.telegram.botInfo`, `s.telegram.outbox` (+ `onSent`), `s.side.structured` (group purposes), `s.llmBudget`,
  `s.random`, `s.clock`, `s.crypto`, `s.memory` (save/list/forget for the group scope), `s.groups` (surfaces repo:
  `get`, `leftBefore`), `s.repos.users` (member tz / language: the majority), `s.caps.stt` (voice, optional) and
  `s.scheduler`.
- `thompson` / `posteriorOf` from `src/behaviour/bandit.ts`, `sanitizeDraft` from `src/behaviour/compose.ts` (import
  only; B-set files are not edited).

### 5.3 Isolation (C3, the canary)

- Group requests (`surface 'group'` runs, the judge, compose, summary, facts, catchup) carry only group-scope data.
  Nothing from `user:<id>` memory, profile, signals, style or DM transcripts is added to them: the group conversation's
  `userId` is null, and GR's side calls build prompts from `src/groups/*` only.
- DM/topic/mission requests never read `group_messages`/`group_summaries` (their context providers are in other
  modules and never query these tables; the importRules table ownership enforces it).
- The canary test asserts both directions at the transport level (ScriptedTransport request log).

### 5.4 Acceptance tests (spec 07 C8)

Unit tests (`test/unit/groups/`):
- `heuristic`:
  - an unanswered question ≥ 2 min scores over the threshold;
  - venting (emotional words, a 1:1 exchange) vetoes;
  - a fast back-and-forth is negative;
  - planning (dates, places) is positive;
  - `quiet` = never.
- `names`:
  - "Гора, как думаешь?" and "gora what's up" match;
  - "поехали в горы" and "на горе" do not.
- `chattinessFromWords`: RU/EN phrases.
- `caps`:
  - 30-min spacing, 6/day, the night window in the group tz (FakeClock);
  - no tz → no chime-ins.
- `bandit`:
  - a reward on a positive reaction, a penalty on ignore, a strong penalty on "тише";
  - chattiness steps;
  - with a seeded `s.random`, the same choice every time.
- `repo`:
  - sealed text (no plaintext in the DB file);
  - 14-day retention;
  - `purge('forget')` keeps `group_policy.chattiness` and resets the counters;
  - `purge('left')` removes all rows.

E2e tests (`test/e2e/group-participant.e2e.test.ts`, `botInfo: TEST_BOT_INFO_READS_ALL`):
1. Join → exactly one join line in the group language, no buttons.
2. Non-addressed messages are stored (count via GR's repo in the test, or `policy()`) but produce no send.
3. A mention, a reply to Gora and "Гора, …" are always answered in-thread; the request contains the recent group lines
   as untrusted content.
4. An unanswered question + a 45 s lull + 2 min → the judge → one chime-in (≤ 2 sentences). The same flow on a venting
   window → the judge is never called.
5. Caps: a second chime-in within 30 min is suppressed; the 7th of the day is suppressed; none at 23:00 group time.
6. "Гора, тише" → chattiness drops (`policy().chattiness`) + a short ack; subsequent eligible windows are skipped.
   "Гора, можешь чаще" raises it.
7. A reaction 👍 on a chime-in → arm α+1; ignored for 10 min → β+1.
8. `/catchup` → a summary scoped to messages after the member's last message (ephemeral when
   `ephemeral_message_id`, else DM).
9. **Canary:** a DM-only fact ("мой паспорт 1234", saved in DM memory) never appears in ANY group request (addressed
   reply, judge, compose, summary), and a group line ("встречаемся в пятницу у Лены") never appears in any DM request.
10. Retention: after 14 days, messages are gone; `/forget всё` in the group purges messages + summary; the bot left +
    7 days → everything purged.
11. Privacy mode ON (`TEST_BOT_INFO`) → mention-only: nothing stored, no chime-ins, the old intro (01 F14 fallback),
    and the BotFather hint logged once.
12. `group_invite_link` from the DM returns the `startgroup=g&admin=` url button; `/settings` shows the button.

---

## 6. Integration (after BR, CAL and GR are green)

The lead merges the three sets, applies the queued `CONTRACT REQUEST`s and runs the full gates. Manual checks with the owner:
- `npm run smoke:composio` with `LIVE=1` (link → connect in the browser → `--after-connect`);
- BotFather `/setprivacy` → Disable, then re-add the bot to a test group;
- one real browse task on a harmless site.

## 7. Known deviations and decisions

1. **REST, not the SDK, for Composio.**
   - `@composio/core` 0.21.0 would use global `fetch`, which importRules forbids. It is also built around
     sessions/Tool Router (server-side tool loops), while B1 requires client-side execution through our executor.
   - The REST shapes are taken from the SDK's own client typings (`@composio/client` 2.0.0-rc.8).
   - The dependency stays optional and unused.
2. **API versions:**
   - `auth_configs` use `/api/v3` (live-verified by the lead, B5).
   - `connected_accounts` and `tools/execute` use `/api/v3.1` (current) **with explicit `version: '20260915_00'`**.
   - Bumping the toolkit version is a deliberate change in `composioMap.ts` together with its tests.
3. **Chromium DNS rebinding.** The network guard resolves before allowing a request, but Chromium resolves again. The
   residual risk is accepted for v1 (Gora runs on the owner's Mac). A later hosted provider (Browserbase/Steel) or an
   egress proxy closes it.
4. **Approval screenshots** go beside the card (`ToolSpec.approvalAttachment`), not inside `ApprovalDiff`: the diff is
   sealed and HMAC-compared at execution, and a screenshot is never byte-stable.
5. **Group auto-facts** use the memory source `user_message` with `created_by 'extractor'` in the `grp:` scope. There
   is no new DB enum (the `memory_facts.source_kind` CHECK is unchanged). Spec 07 C3 overrides 01 §9's explicit-only
   group memory rule, and only GR's summarizer writes them.
6. **Reactions in groups** reach the bot only when it is an administrator (a Telegram rule for `message_reaction`). In
   groups where Gora is a plain member, the bandit learns from replies and ignores only. Documented; no admin rights
   are requested (C6).
7. **`conversation_toolkits` rebuild** in 004: the only table rebuild, because a CHECK cannot be altered. It is safe:
   the table is derived, has no triggers and nothing references it. The test proves that rows survive.
8. **Preload for unconnected calendars** (B2): the calendar kit is preloaded on calendar words even when nothing is
   connected, and it carries `integration_connect`. CAL's calendar tools send the connect card themselves on
   `NOT_CONNECTED`.
