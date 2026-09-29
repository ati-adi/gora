# 07: Browser agent, Google Calendar via Composio, Gora as a group participant (binding, 2026-09-29)

**Precedence:** 07 > 05 > 03 > 02 > 01. The owner chose:
1. an **agent that works in the browser** (Muse-style "cloud computer": opens sites, fills forms, books, with approvals);
2. **Google Calendar through Composio**;
3. **Gora as a real participant in group chats** (reads the chat, remembers the group, chimes in when useful, and learns when that is welcome).

Friend-mode principles (05) apply everywhere: minimal, warm, no setup interrogations, learn rather than ask.

## A. Browser agent ("Gora in the browser")

- **A1. Runtime.** Headless Chromium via **Playwright**, running locally in the Gora process host. Today that is the owner's Mac; later a server or Docker.
  - Put it behind `BrowserCapability` (contracts), with implementations `PlaywrightBrowser` (real) and `FakeBrowser` (scripted sites for tests).
  - The planner verifies the current Playwright version and installs Chromium: `npx playwright install chromium`, into the default Playwright cache, not the repo.
  - Leave a clear seam for a hosted provider later (Browserbase or Steel); no hosted provider now.
- **A2. Where it runs.** A browser task always runs as a **mission** (01 F10: private topic when available, status card, Stop, budget, survives restarts via `task_wait`). The chat run starts it with the tool `browse_task {goal≤1000, start_url?, constraints?≤500}` (class `control`), which lives in a new `browser` toolkit.
  - Inside the mission run, the model gets the browser toolkit:
    - `browser_open {url}`, `browser_snapshot {}`, `browser_click {ref}`, `browser_type {ref, text, submit?:false}`, `browser_select {ref, value}`, `browser_press {key}`, `browser_scroll {direction}`, `browser_back {}`;
    - `browser_show {caption}`: sends a screenshot to the owner in the mission thread;
    - `browser_done {summary, result_url?}`.
  - One browser context per task, **ephemeral**: no persistent cookies or logins in v1. It is closed on finish, Stop, or crash recovery.
- **A3. Page representation (budget-critical).**
  - `snapshot()` returns compact text:
    - title and URL;
    - the viewport's interactive elements with short stable refs (`e1…`) and role, name and value;
    - the visible text condensed into headings and short excerpts;
    - forms grouped.
  - It is built from Playwright's accessibility/aria snapshot or DOM.
  - Size caps: ≤ 1,800 est. tokens on `groq-free`, ≤ 6,000 on larger profiles. Truncation is deterministic, prioritising focused/viewport interactive elements.
  - Every snapshot is untrusted web content: wrapped, guard-screened (03 R5), and it taints the run with `web`.
  - Optional: for pages whose snapshot is empty or ambiguous, a `vision` describe of a screenshot (qwen, ≤ 1 per 5 steps).
- **A4. Safety (Sentinel classes).**
  - **Reading and navigation:** `read_public`.
  - **Typing:** text into a field is `write_self` (no approval), but only for data the owner gave in the task or from the owner's own profile. Typing emails, phones, addresses or names that came from page content or third parties → `ask`.
  - **Submitting:** any action that submits or commits asks with an approval card, which includes a screenshot, the form fields and values (from the snapshot), the site host, and "what happens next".
    - Examples of such actions: a click on a submit or button whose accessible name matches book, reserve, confirm, send, submit, order, buy, pay, sign up, register, subscribe, delete, or the RU equivalents (забронировать, подтвердить, отправить, заказать, купить, оплатить, зарегистрироваться, подписаться, удалить); `browser_type` with `submit:true`; `browser_press Enter` inside a form.
    - Class: `send_external` / `spend`.
  - **Payment:** detected by card or payment fields or known payment hosts. The agent **never** enters payment data. It stops and hands the owner the URL: "the last step, payment, is yours".
  - **Logins:** no credential entry in v1. On a login wall the agent parks with a short message ("the site needs a login; I can go on without it, or here's the link") and continues on the owner's reply.
  - **Network guard:** every request is intercepted (Playwright `route`), with the same rules as SafeFetch (01 §11.5): http(s) only; block private, loopback, link-local and metadata IPs after DNS resolution; block Gora's own host, non-standard ports and file/data/chrome schemes.
  - **Downloads and uploads:** downloads are denied; file uploads are denied; popups are opened in the same context and counted.
  - **Limits:** at most 1 concurrent browser task per user; ≤ 40 steps; ≤ 15 min wall clock (then park, offering to continue); quota kind `browser`.
  - Every action is recorded in the ledger (host, action kind, ref name, never field values of type password).
- **A5. Groq free tier.** Each step is about 3.5–4.5K prompt tokens. The rate governor's fallback chain spreads steps across models, so a 15-step task can take minutes. The status card shows progress ("Шаг 7: заполняю форму…"). This is fine: missions are asynchronous.
- **A6. Tests (FakeBrowser).**
  - A scripted three-page site: search → results → booking form → confirm.
  - The e2e test asserts: the goal is reached; an approval card before confirm, with a screenshot; Deny stops cleanly; Stop closes the context; a private-IP URL is blocked; a login wall parks; a payment page stops with a handover; a prompt injection inside page text does not trigger a submit without approval; snapshots respect the token cap.

## B. Google Calendar (and Gmail) via Composio

- **B1.** Implement or fix `ComposioProvider` (01 F9, ⚠U11) against the **current** Composio API and SDK (`@composio/core`, already an optional dependency; the planner verifies version and shapes from the official docs):
  - **Connect link:** per user (`user_id` = a stable HMAC of our user id, never the Telegram id in clear), Composio-managed Google auth config, toolkits `googlecalendar` (required) and `gmail` (optional, same mechanism).
  - **Connection status:** callback to `${PUBLIC_URL}/oauth/callback` with state, **plus polling** of the connected-account status every 5 s for 10 min after a link is issued. Polling matters because the tunnel URL can change, so the callback may never arrive.
  - **Tool execution** for the mapped calendar operations: list events, free slots (freebusy), create, update, delete, respond to invite. Gmail search, read, create draft and send draft are mapped too if the planner confirms them.
  - All slugs and parameters live in `composioMap.ts`. Unknown or unsupported operations fail cleanly.
  - Tool calls run **client-side through our executor** (Sentinel, approvals, ledger), never as Composio or MCP server-side autonomous calls.
- **B2. Friend-mode UX.**
  - When a calendar question arrives and nothing is connected, one short line plus a `[Подключить Google Календарь]` url button.
  - After connecting: "Готово ✓", then the answer to the original question (the pending run resumes) rather than a card storm. Permission chips stay in the Mini App, not in chat.
  - `first_look` (01 F9) becomes one friendly line.
- **B3. Live smoke.** `scripts/smoke-composio.ts` (`LIVE=1`, `COMPOSIO_API_KEY`) creates a connect link for a test user and prints it. With `--after-connect` it lists tomorrow's events and free slots. It never creates events unless `--write`, and then deletes what it created.
- **B4. Env.** `INTEGRATIONS_PROVIDER=composio`, `COMPOSIO_API_KEY`, and optionally `COMPOSIO_AUTH_CONFIG_GCAL` / `_GMAIL` when managed auth configs need explicit ids.
- **B5. Facts verified live by the lead on 2026-09-29. Do not re-verify them; code against them.**
  - The owner's key is a **Platform project key** (`ak_…`), sent as `x-api-key` to `https://backend.composio.dev/api/v3/*`. `GET /api/v3/toolkits?limit=1` → 200. (A `ck_…` consumer key is rejected with 401 code 801 `APIKey_InvalidAPIKey`. Config validation should warn when the key does not start with `ak_`.)
  - `GET /api/v3/toolkits/googlecalendar` → `composio_managed_auth_schemes: ['OAUTH2']`.
  - A Composio-managed auth config for googlecalendar now exists: `ac_kB4OafdmH77M`. It was created with `POST /api/v3/auth_configs {"toolkit":{"slug":"googlecalendar"},"auth_config":{"type":"use_composio_managed_auth","name":"gora-googlecalendar"}}`. The owner's `.env` has `COMPOSIO_AUTH_CONFIG_GCAL=ac_kB4OafdmH77M`.
  - When the env var is absent, the provider should find or create one the same way, idempotently by name. No Gmail auth config exists yet; create one lazily only when a Gmail tool is first needed.

## C. Gora as a group participant

- **C1. Visibility.**
  - Group privacy mode must be **OFF** in BotFather (`/setprivacy` → Disable), and the bot must then be re-added to existing groups.
  - At boot and on join, read `getMe().can_read_all_group_messages`. If it is false, fall back to 01 F14 mention-only behaviour and log the BotFather step.
- **C2. On join** (`my_chat_member`), send ONE line in the group's language: «Привет! Я Гора — читаю чат, чтобы помогать: отвечу, если позовёте, и иногда подскажу сама. „Гора, тише“ — и я буду реже встревать.» Group members must know the bot reads the chat (ToS transparency). No buttons.
- **C3. Storage.**
  - Group messages (text, plus captions and transcripts for voice notes) are stored **encrypted under the group DEK**, with a rolling 14-day retention and deletion on `/forget` or when the bot leaves (7-day grace, as in 01).
  - A **rolling group summary** (fast model, batched: every 40 messages or after 10 min idle) is stored encrypted.
  - **Group facts** (plans, decisions, dates, preferences stated in the group) are extracted automatically into group-scoped memory.
  - **Strict separation:** group data never enters DM context and DM data never enters group context. This extends the existing canary tests. Members' messages are untrusted (`group_member` taint).
- **C4. When Gora speaks.**
  - **Always**, when mentioned, replied to, or addressed by name ("Гора, …", "Gora, …"). Reply in-thread, short.
  - **Unprompted chime-ins, learned per group:**
    1. After a burst ends (a 45 s lull), a local heuristic scores the window. Positive signals: an open question to the group that is unanswered for ≥ 2 min; a factual disagreement; planning or scheduling (dates, places, "когда соберёмся"); a request for a recommendation; an explicit help request. Negative signals: a personal or emotional conversation between members; a fast back-and-forth.
    2. Only windows over the threshold go to a `fast`-model judge `{should_speak, kind: answer|fact_check|plan_help|summary|fun, value≤100 chars}`.
    3. The main model then composes ≤ 2 sentences, which pass the output sanitizer.
  - **Learning.** A per-group Thompson bandit over `kind` (Beta, with a conservative population prior).
    - Reward: a positive reaction or reply engaging Gora within 10 min.
    - Penalty: ignored, a negative reaction, or "тише / не лезь / замолчи" (strong).
    - "Гора, можешь чаще / активнее" lowers the threshold; "тише" raises it. This is a per-group `chattiness` setting, set by words.
  - **Caps:** ≤ 1 unprompted message per 30 min and ≤ 6 per day per group, never at night in the group's inferred time zone (majority of members' tz or group memory), and never in a thread where someone is venting.
- **C5. Catch-up.** "что я пропустил?" / `/catchup` summarises since that member's last message (from stored messages plus the summary). It is an ephemeral reply if supported (01 U5), else a DM (with the `me_` deep link if no DM exists).
- **C6. Add to group.**
  - The Mini App Home and the `/settings` answer show `[Добавить Гору в группу]`, a url `https://t.me/<bot>?startgroup=g&admin=` with no admin rights requested.
  - The model can offer the same link through a small tool `group_invite_link {}` when the owner talks about a group of friends.
- **C7. Budget.**
  - Group reading costs no LLM calls: heuristics are local.
  - LLM calls happen only for summaries (batched), fact extraction (batched), the judge (candidate windows only) and replies.
  - Everything group-proactive runs at priority `background` and respects `llmBudget` (03 R6). On Groq free tier it degrades to mention-only when the daily budget is tight.
- **C8. Tests.**
  - Non-addressed messages are stored but not answered.
  - Mentions and name-address are always answered.
  - The heuristic/judge chime-in fires on an unanswered question and not on venting.
  - Caps hold, and "тише" reduces chattiness.
  - Bandit updates from reactions.
  - `/catchup` summary scope.
  - Canary: a DM-only fact never appears in any group request, and group text never appears in DM requests.
  - Retention and `/forget` purge.
  - Privacy mode ON → mention-only fallback.

## D. Data

New migration `004_browser_calendar_groups.sql` (never edit applied migrations):
- `browser_tasks`
- `group_messages` (encrypted text, sender hmac, tg ids)
- `group_summaries`
- `group_policy` (chattiness, arms Beta, caps counters)
- `integration_links` (pending Composio links with a polling deadline)

All tables are added to `USER_DATA_TABLES` or the group deletion plan, export and retention.
