# Gora

A Telegram-native personal AI agent that feels like a **friend you talk to and consult with**: it stays quiet
until spoken to, learns each person from how they talk (memory, style, rhythm) instead of asking, and writes first
only when a friend would. Underneath: streaming DM chat with Stop, approvals rendered by code, a hash-chained ledger,
memory you can truly forget, reminders and missions, Secretary Mode, `@gora` guest answers, groups, and a Mini App
control center.

- **Runtime:** Node ≥ 26.8 (runs `.ts` directly through type stripping; built-in `node:sqlite`, SQLite 3.53.4)
- **Language:** TypeScript, erasable syntax only (no `enum`, `namespace`, parameter properties or decorators); `tsc` is typecheck-only
- **Telegram:** grammY 1.46.0 (Bot API 10.3) · **HTTP:** Hono + `@hono/node-server` · **Mini App:** React + Vite
- **LLM:** Groq (`groq-sdk` 1.6.0, free tier by default) or Anthropic (`@anthropic-ai/sdk` 0.128.0) behind one `LlmTransport`

The specs are the source of truth, in precedence order:
`docs/spec/05-friend-and-personalization.md` > `docs/spec/03-reconciliation.md` > `docs/spec/02-groq-free-tier-addendum.md`
> `docs/spec/01-build-spec.md` (build notes: `docs/spec/04-foundation-notes.md`, the friend-mode plan: `docs/spec/06-friend-plan.md`).

## Status

Every work package of 01 §16 is built, and friend mode (spec 05) is integrated on top: `npm run typecheck`,
`npm test` (unit + the `test/review/**` regression proofs), `npm run test:e2e:strict`, `npm run build:webapp` and
`npm run sim` are the gate. Progress logs live in `docs/progress/`.

## Friend mode (spec 05)

The owner's direction: minimalism. Gora is a friend, not a service.

- **Silence by default.** `/start` answers with exactly one line («Привет! Я Гора 🙂 Рассказывай, что у тебя?» /
  "Hey! I'm Gora 🙂 What's up?"), no buttons, nothing reset. There is no onboarding flow and no setup question. The
  bot description (set once per hash, EN + RU) carries the privacy notice; the first message records the memory
  consent row (`desc-v1`) silently.
- **Minimal UI.** A saved memory is a ✍ reaction on your message; a reminder is a 🫡 reaction plus one short line.
  Footers only for pending approvals and Undo. The command menu lists `/memory` and `/settings`; every other command
  still works when typed.
- **Lazy time zone.** Nothing is asked. Time-dependent tools run on the best guess (last shared location → your home
  city or a city in your profile → your language's default zone) and the reply carries ONE "🕒 Set my time zone"
  button, at most once a week, until the zone is confirmed. "I live in Almaty" / «живу в Алматы» or a shared location
  confirms it silently; a weak "I'm in X" (maybe a trip) only moves the guess.
- **Settings by words.** "Be shorter", "call yourself Nova", "don't text me first", "don't remember this" go through
  `settings_update` (undoable) and are acknowledged in one line.
- **Transparent, never interrogating.** "What do you know about me?" answers from the profile card and the top facts
  with a Mini App link; `/memory` shows the card (each item can be corrected or deleted — a delete erases the facts
  behind it) above the fact list; "forget …" works everywhere.

## How personalization works

All learning is per user and local; the LLM only writes text. On Groq's free tier the rhythm, style, bandit and
retrieval parts cost zero LLM calls.

- **Memory (spec 05 B1–B5, `src/memory/`).** On unless `/incognito` or "не запоминай". Extraction runs in the
  background in batches (after 3 exchanges or 10 idle minutes), keeps facts, people, plans with dates, preferences
  and short-lived mood/context facts (with a TTL), each with an importance. Sensitive facts (health, money, intimate)
  are kept only when stated plainly about oneself and are never used when Gora writes first.
- **Local embeddings.** `Xenova/multilingual-e5-small` (384-d, q8) runs on CPU in Node via
  `@huggingface/transformers`; it is downloaded once into `DATA_DIR/models` (~144 MB, ~0.7 GB RSS once loaded) by a
  background job. Vectors are sealed like the fact text. Until the model is ready, search is keyword-only.
- **Hybrid retrieval.** Reciprocal-rank fusion of keyword BM25 and cosine similarity, weighted by importance and a
  30-day recency decay (pinned and profile facts don't decay), fills `<user_model>` each turn.
- **Profile card.** A nightly (~04:00 local) or every-15-new-facts consolidation (≤ 1 per user per day) rewrites a
  compact card (summary, people, goals, preferences, style, current context, open threads) that heads `<user_model>`.
  Forget rotates the keys and rebuilds the card without the fact; owner removals are kept as token signatures (never
  sent to the model) and survive a forget; an expired mood fact takes its card lines with it.
- **Behaviour model (`src/behaviour/`).** Features only, never text: a 7×24 activity histogram (UTC-binned, read in
  your current zone; 21-day half-life; a population prior and hour pooling for new users), style EMAs (length, emoji,
  ты/вы, language) that become one `style:` hint line (your explicit style settings win).
- **Learned proactivity.** Every 30 min a policy looks at each eligible user (not blocked, proactive not off, outside
  quiet hours, LLM budget below 85%). Once a day, at a slot in your top-30% active hours, Thompson sampling over
  Beta posteriors (content type × gap since you last wrote, pooled hierarchical prior) decides whether to write
  first: `follow_up` (an open thread whose time passed), `useful` (something concretely relevant), `checkin`, or
  `first_hint` (only if you never wrote). Hard limits: ≤ 1 Gora-first message per 24 h (shared with nudges, the brief
  and check-ins), silence after 4 unanswered until you write, "don't write first" → never. A main-role call composes
  ≤ 2 sentences, a fast-role friend check can veto it, and a deterministic filter drops anything sensitive. A reply
  within 24 h rewards the arm; `/why` on the message explains the arm, gap, score and reason.

## Running live for development (`scripts/dev-tunnel.sh`)

```bash
npm run build:webapp          # the Mini App is served from dist/webapp at /app/
scripts/dev-tunnel.sh         # Ctrl+C stops the tunnel and Gora
```

The script opens a free `localhost.run` SSH tunnel to `PORT` (8080), writes the public URL into `.env`
(`PUBLIC_URL`) and restarts Gora (`node src/main.ts`, polling mode) whenever the URL changes, so the menu button and
web_app buttons follow it; it pings `/healthz` every 60 s to keep the tunnel open. Logs: `$LOG_DIR/gora.log`
(default `./data/logs`). It uses `./data` (gora.db) and `./keys`, runs migrations at every boot (additive only;
`003_friend_personalization.sql` added the friend-mode tables) and is for development only: run exactly one
instance, and never point tests or a second bot at the same `./data`.

Before restarting a live bot onto new code, `node scripts/check-schema.ts` (read-only; default `$DATA_DIR/gora.db`)
compares the database's schema with what `src/db/migrations/` produce and exits 1 with a diff if they drifted (e.g. a
bot that booted while an earlier draft of a migration was on disk). A drift is repaired with a new migration, never by
editing an applied one.

## Setup

```bash
npm ci
cp -n .env.example .env     # only if you don't have one yet (-n never overwrites); never commit .env
npm run typecheck
npm test
```

Generate the three 32-byte secrets (run once per secret):

```bash
node -e "console.log(crypto.randomBytes(32).toString('base64'))"   # GORA_KEK, GORA_CALLBACK_KEY, GORA_HASH_KEY
```

They are **required whenever `TELEGRAM_BOT_TOKEN` is set** (real user data must never be sealed under keys anyone can
derive from this repository) and always in production. Only without a bot token (tests, `npm run sim`) do missing secrets
fall back to fixed, insecure development keys, with a warning. `ALLOW_INSECURE_DEV_KEYS=1` overrides this for a throwaway
test bot; never use it with real users.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `node --watch src/main.ts`, loading `.env` if present |
| `npm start` | `node src/main.ts` (`.env` loaded if present; Docker passes real env) |
| `npm run typecheck` | `tsc` for the server/tests and for `webapp/` |
| `npm test` | unit tests (`vitest --project unit`: `test/unit/**` and the `test/review/**` regression proofs) |
| `npm run test:e2e` | end-to-end tests (`test/e2e/**`, e.g. `friend-day.e2e.test.ts`) |
| `npm run test:e2e:strict` | the same without `--passWithNoTests` (the gate) |
| `npm run build:webapp` | builds the Mini App into `dist/webapp` (served at `/app/`) |
| `npm run sim` | prints the friend first contact (`/start`, first message, silent tz) against fakes, no tokens (`-- --lang ru`) |
| `npm run smoke:groq` | opt-in live smoke against Groq; runs only with `LIVE=1` and `GROQ_API_KEY` (≤ 6K tokens) |
| `npm run admin -- <cmd>` | admin CLI: `stats`, `refund`, `purge-user`, `verify-ledger`, `set-webhook`, `rewrap` (WP1) |

Network is blocked at the socket level in tests: `test/harness/setup.ts` guards `net.Socket#connect`, so any TCP
connection to a non-loopback host (grammY's default node-fetch client, `node:http(s)`, undici, TLS) fails with
`NetworkDisabledError`, and it also replaces the global `fetch` with one that throws. Adapters receive an injected
`fetchImpl`. No bot token, LLM key or network is needed.

## Environment

See `.env.example` for every variable with its default. The important groups:

- **Core:** `NODE_ENV`, `GORA_MODE` (`polling` for development, `webhook` in production), `PORT`, `PUBLIC_URL`
  (must equal the Mini App domain registered in BotFather), `DATA_DIR`, `KEYS_DB_PATH` (a separate volume in production).
- **Telegram:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_API_ROOT`, `TELEGRAM_TEST_ENV`, `ADMIN_TG_IDS`.
- **Secrets:** `GORA_KEK`, `GORA_CALLBACK_KEY`, `GORA_HASH_KEY` (base64, 32 bytes each).
- **LLM (03 R2):** `LLM_PROVIDER=auto|groq|anthropic`. `auto` uses Anthropic when `ANTHROPIC_API_KEY` is set, else Groq when
  `GROQ_API_KEY` is set, else the demo transport (never in production). `GROQ_TIER=free|dev` selects the budget profile.
  With its key set, Groq also serves TTS, the prompt guard, the LLM sentinel and vision, and STT under the default
  `STT_PROVIDER=auto`.
- **Friend mode (05):** `EMBEDDINGS_PROVIDER=local|fake|none` (local e5 model on CPU by default; `none` = keyword
  search only), `EMBEDDINGS_MODEL`, `EMBEDDINGS_CACHE_DIR` (default `DATA_DIR/models`), and `PROACTIVE_TAU` (the
  send threshold, default 0.30; each user's "less"/"more" scales it ×1.5/×0.7).
- **Feature flags** (`FEATURE_*`) and **providers** (`INTEGRATIONS_PROVIDER`, `STT_PROVIDER`, `WEATHER_PROVIDER`, …; fakes by default).
  `STT_PROVIDER=auto` (the default) transcribes with Groq when `GROQ_API_KEY` is set, else OpenAI when `OPENAI_API_KEY` is set, else
  STT is off; `STT_PROVIDER=fake` is refused whenever a real `TELEGRAM_BOT_TOKEN` is configured.

In `NODE_ENV=test` every provider is forced to its fake, the mode is `polling`, and LLM keys are ignored.

### Provider profiles (03 R2)

| Profile | Prompt cap | Output cap | System prompt | Tools | Caching | Epoch rotation | Tool steps |
|---|---|---|---|---|---|---|---|
| `anthropic` | 150 000 | per route | full | static toolsets | 1 h cache markers | 120 000 | 24 |
| `groq-free` | 5 200 | 1 200 | compact | toolkits (`use_toolkit`) | none | 2 400 | 8 |
| `groq-dev` | 60 000 | 1 200 | compact | toolkits | none | 40 000 | 8 |

## BotFather checklist (01 §4.5)

At boot Gora reads `getMe` and logs a checklist line for every capability that is off.

1. Turn **ON**: *Threaded Mode* (topics in private chats) and "allow users to create topics"; *Guest Mode*
   (Mini App settings); *Secretary Mode* (Chat Automation).
2. Set the **Main Mini App** and its domain to exactly `PUBLIC_URL`, and set the menu button
   (Gora also sets it with `setChatMenuButton` when the definitions change).
3. Stars payments need no provider token.
4. Keep **Inline mode OFF**, **Group Privacy ON**, **Bot-to-Bot Communication Mode OFF**, and Mini App origin
   protection **ON** (the default).

Commands are registered by Gora itself (`setMyCommands`, private and group scopes; `/me` is ephemeral).

## Deployment

`Dockerfile` builds the Mini App in a builder stage and runs `node src/main.ts` as `USER node` with volumes
`/data` (gora.db, WAL), `/keys` (keys.db) and `/backups`. Run **exactly one instance**: SQLite has a single writer and
the process takes a `gora.db.lock` lockfile. `.dockerignore` keeps `.env`, data, keys and `node_modules` out of the build context.

Backups: planned (01 §11.7) — a nightly `backup` job (WP1) copies gora.db and keys.db into `BACKUP_DIR` with 7-day
retention. Not implemented until WP1 lands.

**Production env checklist** (`NODE_ENV=production` refuses to boot otherwise):
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` (required even in polling mode);
- `GORA_KEK`, `GORA_CALLBACK_KEY`, `GORA_HASH_KEY`;
- an `https://` `PUBLIC_URL`;
- `GROQ_API_KEY` or `ANTHROPIC_API_KEY` (matching `LLM_PROVIDER`);
- `INTEGRATIONS_PROVIDER=none` or `composio` (+ `COMPOSIO_API_KEY`) — the default `fake` is refused;
- `KEYS_DB_PATH` and `BACKUP_DIR` outside `DATA_DIR` (the Docker image uses `/keys` and `/backups`).

## Architecture map

One Node process: Hono HTTP (webhook, OAuth callback, Mini App API and static files, `/healthz`), a durable
Telegram inbox with per-conversation lanes, the run engine, a leased job scheduler and a durable outbox, all on
`gora.db` plus a separate `keys.db` holding KEK-wrapped data keys (crypto-shred by destroying keys).

```
src/
  main.ts  app.ts  config.ts        boot + signals · composition root (two-phase wiring) · env/ROUTES/PLANS/PROFILES   [WP0]
  contracts/                         frozen cross-module interfaces (01 §4.4 + 03 R7)                                    [WP0]
  kernel/                            clock, ids, log, errors, canonicalJson, keyedMutex, tags, timeMath, registries,
                                     tokens (estimator), groqClient (the only groq-sdk construction site)                [WP0]
  db/        sqlite.ts migrate.ts migrations/ (001_init, 002_review_indexes, 003_friend_personalization; additive)     [WP0]
  db/        keystore.ts crypto.ts repos/ · ledger/ · billing/ · privacy/                                                [WP1]
  telegram/  bot, ingress, inbox, dispatcher/lanes, outbox/limiter, files, topics, links, commands, codec,
             render/ (sanitize, split, fallback, cards), channels/ (dmStream, notify, group, guest, bizOwner)           [WP2]
  agent/     transports (anthropic, groq/, demo), request builder, context, grammar, engine, epochs, side calls        [WP3]
  trust/     sentinel rules, taint/provenance, grants, approvals, executor, undo, step-up, redaction, guard            [WP4]
  tools/ capabilities/ integrations/   registry + toolkits, SafeFetch, STT/TTS/vision/search, Gmail/Calendar           [WP5]
  memory/ scheduler/ reminders/                      memory (+ embeddings, hybrid retrieval, profile card), scheduler,
                                                     reminders/check-ins/to-dos                                       [WP6a, 05 M]
  behaviour/                                         signals, rhythm, style, bandit, proactive policy (compose/judge) [05 B]
  proactive/ missions/                                nudges, signals, brief, commitments, missions, watchers          [WP6b]
  surfaces/  handlers, onboarding, commands, callbacks, /why, guest, groups, payments, strings                        [WP7a]
  surfaces/business/                                  Secretary pipeline (createBusinessModule), business tools        [WP7b]
  http/      Hono server, initData auth, API routes · webapp/ React Mini App                                            [WP8]
test/harness/   fakeTelegram, scriptedTransport, invariants, tmpDb, updates, initData, fakes, testApp                  [WP0]
```

### Wiring rules

`createApp()` fills `const s = {} as Services` in dependency order. Factories may only dereference `s.<x>` at
call time, except for factory-time registrations: job handlers (`s.scheduler.register`), callbacks
(`s.telegram.callbacks.register`), context providers, privacy hooks, run hooks (`s.runHooks`), outbox sent hooks
(`s.telegram.outbox.onSent`, buffered until the Telegram module exists and installed before the outbox starts) and
quota counters (`s.quotas.registerCounter`), system cron upserts (`s.scheduler.schedule` with a `sys:<kind>` dedupe key)
and UI strings (`s.strings`, built first) — those registries exist before any module factory runs.
Implementers: read `docs/spec/04-foundation-notes.md` first.

Tools owned by WP4, WP6 and WP7 are exported as `TOOLS` from `trust/tools.ts`, `memory/tools.ts`, `reminders/tools.ts`,
`missions/tools.ts`, `surfaces/tools.ts` and `surfaces/business/tools.ts`; `app.ts` passes them to
`createToolRegistry(profile, external)` (WP5). `TOOL_OWNERS` / `TOOL_FILES` in `contracts/tools.ts` say who owns each tool.

### Coding rules (enforced by `test/unit/foundation/importRules.test.ts`)

- Every timer goes through `Clock`; no `Date.now()` outside `kernel/clock.ts`. Never `await` inside `db.tx()`.
- `src/` never calls the global `fetch`; adapters receive `fetchImpl`.
- Only `telegram/files.ts` sees Telegram file URLs. Only `trust/executor.ts` calls `ToolSpec.execute` / `undo`.
- Only `agent/transport.ts` imports `@anthropic-ai/sdk` at runtime; only `agent/groq/*`, `capabilities/groq/*` and
  `kernel/groqClient.ts` import `groq-sdk` at runtime (types may be imported anywhere).
- SQL for a table lives only in the owning work package's modules (01 §7.2). Never log message text, tokens or initData.
- Randomness only through the injectable `Random` (`kernel/random.ts`, `s.random`): no `Math.random` in `src/`.
  Only `capabilities/embedder.ts` loads `@huggingface/transformers` (lazily, never at boot).

### Testing

```ts
import { createTestApp } from '../harness/testApp.ts';
import { turn } from '../harness/scriptedTransport.ts';

const t = await createTestApp();                       // temp gora.db, FakeClock, FakeTelegram, ScriptedTransport
t.llm.push(turn().text('Done — reminder set.'));
await t.userSends('remind me to pay rent on the 1st at 10');
t.llm.assertInvariants();                              // grammar G1–G8, byte-exact prefixes, cache markers, …
await t.close();
```

While a work package is still a stub, `createTestApp()` substitutes the matching fake from
`test/harness/fakes.ts`, so each package can be tested before the others merge. The stand-ins include a full
in-memory `CoreRepos` (`createMemoryCoreRepos`), recording reply channels (`createRecordingChannelFactory`), a static
tool registry (`createStaticRegistry`) and a pass-through executor with no Sentinel (`createPassThroughExecutor`).
