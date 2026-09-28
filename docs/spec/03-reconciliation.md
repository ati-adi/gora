# 03: Reconciling the build spec with Groq's free tier (binding)

**Precedence:** `03-reconciliation.md` > `02-groq-free-tier-addendum.md` > `01-build-spec.md`.

`01` stays the architecture of record: contracts, engine, trust, surfaces, data model and work packages. `02` gives the Groq facts and budgets. **This file says exactly how the two combine.** Where `02` proposed a different interface (its `LlmProvider` sketch), this file replaces that proposal: we keep `01`'s `LlmTransport` and add a Groq implementation of it.

Deployment reality: the owner has only `GROQ_API_KEY`, on the **free tier** (8K TPM, 30 RPM, 1K RPD per model; a request over 8K tokens is rejected with 413), plus a Telegram bot token. `ANTHROPIC_API_KEY` is absent today and may be added later. Both transports MUST exist. Groq is live-tested; Anthropic is tested only with fakes.

## R1. Canonical format stays Anthropic content blocks

- Transcript rows, grammar invariants, tool rounds, approvals, stop and recovery all stay exactly as in `01 §5`. The internal lingua franca remains the Anthropic Beta message and content-block types from `contracts/llm.ts`.
- `LlmTransport.mode` becomes `'anthropic' | 'groq' | 'demo' | 'scripted'`.
- New transport, `src/agent/groq/transport.ts` (WP3), `GroqTransport implements LlmTransport`. It translates `MainRequest` into a Groq `chat.completions.create({stream:true})` request and translates the stream back into a `BetaMessage`: `text` blocks, then at most one `tool_use` block per step (gpt-oss makes no parallel calls).
  - `stop_reason` mapping: `tool_calls` → `tool_use`, `stop` → `end_turn`, `length` → `max_tokens`.
  - `usage` maps into `UsageNumbers`, with cache fields = 0.
- **Only `src/agent/transport.ts` imports `@anthropic-ai/sdk` at runtime** (unchanged). **Only `src/agent/groq/*` and `src/capabilities/groq/*` import `groq-sdk` at runtime.** WP0's `importRules.test.ts` enforces both.
- **Translation rules** (in `src/agent/groq/map.ts`, pure, heavily unit-tested):
  - `system` text blocks → one `role:'system'` message.
  - Mid-conversation `role:'system'` rows → `role:'system'` messages in place.
  - `text` → `content`.
  - `thinking` / `redacted_thinking` → dropped.
  - `tool_use` → assistant `tool_calls[{id, type:'function', function:{name, arguments: JSON.stringify(input)}}]`.
  - `tool_result` → `role:'tool'` with `tool_call_id` and string content: text parts joined; `is_error` prefixed `ERROR: `.
  - `image` → text `[image: <description>]`, where the description comes from `VisionDescriber` (qwen) and is cached in `kv` by the blob's sha256, so replays are identical and free.
  - `document` (PDF) → text extracted by `PdfText` (unpdf), cached by sha256, truncated to 2,500 tokens with `[…truncated]`.
  - `server_tool_use` and `*_tool_result` blocks from past Anthropic runs → a short text summary. Unknown block types → `[unsupported block]`.
  - `cache_control`, `betas`, `fallbacks`, `context_management`, `thinking` and `output_config` are ignored. `output_config.effort` maps to `reasoning_effort` (`low`|`medium`|`high`).
- Reasoning deltas (`delta.reasoning`) are **not** passed to `onText` and are not persisted. A block-start of type `thinking` MAY be signalled through `onBlockStart` so the draft shows `<tg-thinking>`.
- **Error mapping:**

  | Groq error | Mapped to / handling |
  |---|---|
  | 429 | `TransientLlmError{kind:'rate_limit'}`, but only after the RateGovernor's fallback chain is exhausted |
  | 413 | Retry once with the budget shrunk by 30% (R3). A second 413 → `BadRequestLlmError` |
  | `tool_use_failed` (APIError with undefined status, `error.code==='tool_use_failed'`, possibly after streamed text) | Call `onBlockStart({index:-1, type:'retry'})`; the channel MUST discard partial draft text on this. Then retry once with an appended system note listing the valid tool names |
  | `output_parse_failed` / `json_validate_failed` (parse) | Retry once, then `parsed:null` |
  | 5xx / connection | `TransientLlmError` |

- `create()` is the same as `stream()` without handlers.
- `parse()` uses `GROQ_MODEL_FAST` with `response_format:{type:'json_schema', json_schema:{name, strict, schema}}`. The schema comes from `z.toJSONSchema(zod)` and is post-processed by `toGroqStrictSchema()`: every property required, optional → `anyOf [T, null]` / type union with `'null'`, `additionalProperties:false`. `strict:true` when that conversion succeeds, else `false`. The result is validated with zod after mapping nulls back to undefined for optional fields. One retry.
- `files.*` on Groq is an in-process no-op store. Nothing in the Groq path uses the Files API.

## R2. Provider profiles (budget-aware request building)

`config.ts` exports `PROVIDER_PROFILES`, and `requestBuilder` MUST honor the active profile:

```ts
interface ProviderProfile {
  provider: 'anthropic' | 'groq';
  maxPromptTokens: number;         // anthropic 150_000 · groq-free 5_200 · groq-dev 60_000
  maxOutputTokens: number;         // anthropic per route · groq 1_200 (side/parse 500)
  systemVariant: 'full' | 'compact';
  toolMode: 'static' | 'toolkits';
  caching: boolean;                // cache_control markers only when true
  epochRotateTokens: number;       // anthropic 120_000 · groq-free 2_400 · groq-dev 40_000
  maxToolSteps: number;            // anthropic 24 · groq 8
  models: { main: string; fast: string };
}
```

- The active profile is resolved at boot from `LLM_PROVIDER=auto|groq|anthropic`: `auto` means anthropic if `ANTHROPIC_API_KEY` is set, else groq if `GROQ_API_KEY` is set, else demo. `GROQ_TIER=free|dev` picks the Groq profile.
- `ConversationRow.model` records `groq:<model>` or the Claude model id.
- A conversation's frozen settings (`01 §5.1`) stay frozen per epoch. **Switching provider is an epoch rotation**, with a handoff note seeding the new epoch.
- **Compact system prompt:** `src/agent/prompt/system.compact.ts` is a verbatim condensed version of `01 §5.12` that keeps every rule under these headings:
  - authority and untrusted content
  - honesty
  - time via `time_resolve`
  - approvals are not performed until tapped
  - format (Telegram Markdown, short)
  - surfaces
  - toolkits: "Call `use_toolkit` to load more tools"

  It MUST be ≤ 650 estimated tokens (test). `SYSTEM_VERSION` hashes whichever variant is used.
- **Epochs:** with a small window the existing epoch and handoff machinery (`01 §5.9`) does the context management.
  - When the estimated tokens of the current epoch's rows exceed `epochRotateTokens` at run start, the engine rotates **synchronously before the run**. The handoff note comes from a `parse`/`create` side call on the fast model (≤ 250 words on Groq), not a warm-cache fork (no caching on Groq).
  - The warm-cache fork (`01 §5.9`) applies only when `profile.caching`.
- **Hard ceiling:** `GroqTransport` computes the estimated tokens of the translated request. If it exceeds `maxPromptTokens`, it drops the oldest complete turns (never splitting a `tool_calls` message from its `tool` results, never dropping system messages, the handoff seed or the current run-start row) and inserts one system line `[earlier conversation omitted]`. If still too big, it truncates the longest tool result to 600 tokens, then fails with `BadRequestLlmError('prompt_budget')`, which the engine turns into the plain reply "That was too long for me to process — could you split it?"
- **Token estimator** (`src/kernel/tokens.ts`, WP0): `estimateTokens(text) = ceil(len / 3.2)`; +12 per message, +4 per tool-call wrapper. It has a test.

## R3. Toolkits (tool selection under the budget)

`toolMode:'toolkits'` (Groq) replaces "one frozen toolset per conversation" **for request building only**. Registry membership, the FULL/GROUP/GUEST/BIZ surface membership, Sentinel and execution are unchanged. A tool outside the surface's toolset can still never run.

- `src/tools/toolkits.ts` (WP5) defines named toolkits over FULL:

  | Toolkit | Tools |
  |---|---|
  | `core` (always) | `time_resolve, reminder_create, reminder_list, reminder_manage, memory_save, memory_search, memory_forget, todo_manage, offer_choices, react, use_toolkit` |
  | `web` | `web_search, web_fetch, weather_get, fx_convert, share_place, location_request` |
  | `calendar` | `calendar_*` |
  | `email` | `gmail_*, integration_connect` |
  | `missions` | `mission_*, task_wait, watcher_*` |
  | `secretary` | `business_*` |
  | `files` | `make_file` |
  | `account` | `settings_update, ledger_query, integration_connect, revise_pending_action` |

  - GROUP: core ∩ GROUP + `web` ∩ GROUP + `poll_create`, always all loaded (it is small).
  - GUEST and BIZ are small and always fully loaded.
- **`use_toolkit`** is a new tool in FULL:
  - Input: `{name: enum(toolkits except core), reason≤120}`. Class `control`, risk 0.
  - Its description lists each toolkit in one line.
  - Execute writes `conversation_toolkits(conversation_id, toolkit, expires_after_turn)` (new table, WP3-owned, in `001_init.sql` via WP0) and returns `Loaded <name>: <tool names>`.
  - The engine rebuilds the tool list before the next model call **in the same run**.
- Active toolkits for a request are the union of:
  - `core`;
  - toolkits loaded in the last 6 user turns;
  - toolkits of any tool called in the visible history window;
  - **deterministic preloads**:
    - a URL in the input → `web`;
    - a pending approval exists → `account`;
    - mission route → `missions`;
    - connected integrations mentioned (calendar/meeting/event → `calendar`; mail/email/inbox → `email`);
    - keywords "search|find|price|news|weather|курс|погода|найди" → `web`.
- Tests:
  - the `core` toolkit's serialized definitions ≤ 1,100 estimated tokens;
  - every FULL tool belongs to at least one toolkit;
  - tool descriptions ≤ 160 chars (terse; say WHEN to call).
- Anthropic (`toolMode:'static'`) keeps `01`'s frozen full toolset and caching. `use_toolkit` is then omitted from the definitions.

## R4. Web, code and media on Groq (client tools instead of server tools)

- `tools/serverTools.ts` (WP5) returns Anthropic server tool definitions only when `profile.provider==='anthropic'`.
- For Groq, the registry provides **client** tools with the **same names**:
  - `web_search {query≤300, freshness?:'day'|'week'|'month'|null}`
  - `web_fetch {url, question?≤300}`

  They are implemented in `src/tools/impl/web.ts` (WP5), class `read_public`, risk 0, `outputTaint:'web'`. They call `services.capabilities.search`:
  - **`GroqSearch.search`:** a separate `GROQ_MODEL_FAST` call with `tools:[{type:'browser_search'}]`, `reasoning_effort:'low'`, `include_reasoning:false`, and a system prompt asking for ≤ 180 words and a numbered source list. It returns `{answer, sources:[{title,url}]}` from `content` + `executed_tools[].search_results`, with the inline citation glyphs `【…】` stripped.
  - **`GroqSearch.open`:** asks it to open the URL (the model uses browser.open) and answer the question.
  - **Prechecks in `open`:** http(s) only; reject IP literals and localhost / `.local` / `.internal` names; reject `BLOCKED_DOMAINS`.
  - Output ≤ 1,500 tokens, wrapped `<untrusted source="web">`. Per-surface max uses per run: FULL 5, GROUP/GUEST 3; enforced by the executor counting calls in the run. The prompt rule "confirm a business still operates before recommending it" stays.
- **`make_file` on Groq** (`capabilities/codeFiles.groq.ts`, WP5):
  - `png`: a `code_interpreter` sub-call on `GROQ_MODEL_FAST` ("Always execute Python; save exactly one chart"), taking `executed_tools[].code_results[].png`.
  - `csv|md|txt|json`: a `parse` side call returning `{filename, content}`.
  - `xlsx|docx|pdf`: returns `isError` "Not available on the current model — I can make a CSV instead", and the zod enum on Groq is `csv|md|txt|json|png`.
- **Images:** `capabilities/groq/vision.ts` (`GROQ_MODEL_VISION` = qwen3.8-27b, `reasoning_effort:'low'`, ≤ 3 images, prompt "Describe precisely; transcribe all visible text verbatim").
- **PDF:** `capabilities/pdfText.ts` uses `unpdf`.
- **STT:** `capabilities/stt.ts` already follows `01` (Groq whisper, per-kind filenames). Use groq-sdk `audio.transcriptions.create` with `toFile`, `response_format:'verbose_json'`, and noSpeech detection (all segments `no_speech_prob>0.8`).
- **TTS (new, opt-in):**
  - `capabilities/groq/tts.ts`: Orpheus (`GROQ_MODEL_TTS`, voice `GROQ_TTS_VOICE`, WAV only, ≤ 200 chars per request, split at sentence boundaries, sequential calls, concatenated PCM).
  - `capabilities/oggopus.ts`: a port of `docs/reference/oggopus.ts` (opusscript) that returns OGG/Opus.
  - Command `/voice on|off` (WP7) sets `users.voice_replies` (new column, WP0).
  - When a DM run started from a voice input finishes and `voice_replies=1`, the `dmStream` channel (WP2) also calls `services.capabilities.tts.speak(finalPlainText ≤ 600 chars)` and sends `sendVoice(chat, InputFile(ogg), {reply_parameters})`. Longer answers get a `[🔊 Listen]` button (callback `vo:<runId>`, WP7) that synthesizes the first 600 chars on tap.
  - TTS failure is silent (logged); the text is always sent.

## R5. Trust additions on Groq (additive: they can only make things stricter)

- **PromptGuard** (`src/trust/guard.ts`, WP4): `llama-prompt-guard-2-86m`, via `services.capabilities.guard.score(text)`, implemented in `capabilities/groq/guard.ts`.
  - Chunking: 1,500 chars with 200 overlap, ≤ 6 chunks scanned (the rest are scanned only if the first 6 are clean and at most 12 chunks exist; otherwise the rest is marked unscanned). Results cached by sha256 in `kv`.
  - `untrusted.wrap()` calls it on every untrusted text before the model sees it.
    - Score ≥ 0.9: the chunk is replaced with `[removed: likely prompt injection]`, plus a ledger entry `guard_block`.
    - Score ≥ 0.5: an attribute `suspicious="true"` is added.
    - Guard unavailable: the text passes through (the run is already tainted by the untrusted source).
- **LLM Sentinel** (`src/trust/llmSentinel.ts`, WP4): `gpt-oss-safeguard-20b` with a static policy (≤ 600 tokens, in `trust/llmSentinelPolicy.ts`, verbatim).
  - It is consulted **only** when the rules Sentinel (`01 §11.1`) returns `allow` for an action whose class is `write_self | send_external | spend | destructive | account_admin` **and** the run is tainted or is an event run.
  - It sees the tool name, the canonical input (≤ 2,000 chars), the owner's run-start text (≤ 500 chars) and the taint sources.
  - `violation:1` → the decision becomes `ask` with a ⚠ warning line `Safety check: <rationale ≤ 120 chars>`.
  - Any error, timeout (3 s) or invalid JSON → `ask`.
  - It can never turn `ask` or `deny` into `allow`.
  - Disabled when there is no Groq key.
- Both are defense in depth. `01`'s rules, taint, provenance and "tainted runs never auto-send" remain the primary guarantees.

## R6. RateGovernor (WP3, `src/agent/groq/rate.ts`) and Groq client factory (WP0)

- `src/kernel/groqClient.ts` (WP0) exports `createGroqClient({apiKey, fetchImpl})`, which returns `new Groq({apiKey, maxRetries:0, fetch: fetchImpl, timeout: 60_000})`. This is the **only** construction site; `capabilities/groq/*` and `agent/groq/*` receive the client by DI. This file is type-only for importRules purposes, apart from the constructor call.
- **Per-model buckets:**
  - TPM/RPM sliding 60 s windows, synchronized from `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`, `x-ratelimit-remaining-requests` and `x-ratelimit-reset-requests`. Reset durations use the format `2.085s`, `1m26.4s`, `7h12m0s`; the parser needs tests.
  - Headers are read via groq-sdk `.withResponse()` (non-stream) or the stream's `response` headers.
  - Free defaults: 8,000 TPM, 30 RPM, 1,000 RPD (whisper: 20 RPM / 2,000 RPD; guard: 30 RPM / 14,400 RPD).
- **Daily counters** live in the table `llm_rate_daily(model, day_utc, requests, tokens)` (WP0 DDL, WP3 repo).
- **Priorities:** `interactive > approval > reminder > background > proactive`. Every transport or capability call passes a priority. The `MainRequest` carries it in `metadata`-side options, so the transport signature gains an optional `opts?: {priority?: Priority}`; WP0 adds this to `LlmTransport`.
- **`acquire(model, estTokens, priority)`:**
  1. If the call fits, it goes now.
  2. Else, if interactive and the wait is ≤ 4 s, it waits.
  3. Else it tries the fallback chain: main `120b → qwen3.8-27b → 20b`; fast `20b → 120b`; vision and guard have none.
  4. Else, if interactive, it notifies via `onBlockStart({index:-1,type:'busy', name:'<seconds>'})` so the channel shows `⏳ Busy — retrying in Ns` and waits up to 45 s.
  5. Else it throws `TransientLlmError('rate_limit')`, and the scheduler re-queues background jobs with backoff.
- **Daily degrade:** at ≥ 85% of RPD on the main model, proactive and background jobs are paused (checked by the scheduler through `services.llmBudget.allow(priority)`). At ≥ 97%, only interactive calls run.
- **Usage reporting:** every Groq call records usage into `01`'s usage tables. Groq prices go in `agent/pricing.ts`: 120b $0.15/$0.60; 20b $0.075/$0.30; qwen $0.80/$4.00; safeguard $0.075/$0.30; guard 86m $0.04; whisper-turbo $0.04 per hour; Orpheus $22 per 1M chars.

## R7. Contract and schema deltas WP0 MUST apply

1. `contracts/llm.ts`:
   - `mode` adds `'groq'`.
   - `stream`/`create` take an optional `opts?: { priority?: Priority }`.
   - Add `export type Priority = 'interactive'|'approval'|'reminder'|'background'|'proactive'`.
   - Add `ProviderProfile` (R2).
2. `contracts/capabilities.ts`, new interfaces:
   ```ts
   SearchCapability   { search(q:{query:string; freshness?:string|null; priority:Priority}): Promise<{answer:string; sources:{title:string;url:string}[]}>;
                        open(q:{url:string; question?:string|null; priority:Priority}): Promise<{answer:string; sources:{title:string;url:string}[]}> }
   VisionCapability   { describe(q:{images:{bytes:Uint8Array; mime:string}[]; question?:string|null}): Promise<string> }
   PdfTextCapability  { extract(bytes:Uint8Array, maxChars:number): Promise<{text:string; pages:number; truncated:boolean}> }
   TtsCapability      { speak(text:string, o?:{voice?:string}): Promise<{ogg:Uint8Array; durationSec:number}> }
   GuardCapability    { score(text:string): Promise<number | null> }   // null = unavailable
   LlmSentinelCapability { check(i:{tool:string; input:string; ownerText:string; taint:string[]}): Promise<{violation:boolean; rationale:string} | null> }
   LlmBudget          { allow(p:Priority): boolean; snapshot(): Record<string,{rpdUsed:number; rpdLimit:number; tpmRemaining:number}> }
   ```
   Add all of them to `Services.capabilities` / `Services`, each with a fake in `test/harness/fakes.ts`.
3. `config.ts`:
   - Groq env vars from `02 §F`, plus `LLM_PROVIDER` and `GROQ_TIER`;
   - `PROVIDER_PROFILES`;
   - `resolveProfile(env)`;
   - `ANTHROPIC_API_KEY` becomes optional;
   - the fake/demo defaults stay.
4. `001_init.sql` additions:
   - `users.voice_replies INTEGER NOT NULL DEFAULT 0`;
   - table `conversation_toolkits`;
   - table `llm_rate_daily`;
   - `conversations.model` stays TEXT and holds `groq:<model>` or the Claude model id;
   - kv keys `vision:<sha>`, `pdf:<sha>`, `guard:<sha>` (kv already exists).
5. `package.json` dependencies:
   - add `groq-sdk@1.6.0`, `opusscript@0.1.1`, `unpdf` (latest);
   - keep all of `01`'s dependencies (grammy 1.46.0 etc.), but `@anthropic-ai/sdk` 0.128.0 stays a dependency.
   - Scripts: `smoke:groq`, which runs `scripts/smoke-groq.ts` (live, `LIVE=1`, ≤ 6K tokens total).
6. `kernel/tokens.ts` and `kernel/groqClient.ts` (R2, R6).
7. `importRules.test.ts`: the groq-sdk import rule (R1).

## R8. Work-package ownership deltas

| WP | Adds these files / responsibilities |
|---|---|
| WP0 | R7 in full; `kernel/tokens.ts`, `kernel/groqClient.ts`; DDL additions; harness fakes for the new capabilities; `scripts/smoke-groq.ts` skeleton (WP3 fills in the agent part) |
| WP3 | `src/agent/groq/{transport.ts,map.ts,rate.ts,strictSchema.ts,budget.ts,repo.ts}`; `agent/prompt/system.compact.ts`; profile-aware `requestBuilder` and epoch rotation (R2); `use_toolkit` handling in the engine and the `conversation_toolkits` repo; `scripts/smoke-groq.ts` (live) |
| WP4 | `trust/guard.ts`, `trust/llmSentinel.ts`, `trust/llmSentinelPolicy.ts` (R5) |
| WP5 | `tools/toolkits.ts`, `tools/impl/web.ts`, `tools/impl/useToolkit.ts`; `capabilities/groq/{search.ts,vision.ts,tts.ts,guard.ts,sentinel.ts}`; `capabilities/{pdfText.ts,oggopus.ts,codeFiles.groq.ts}`; STT through groq-sdk |
| WP2 | Voice reply on DM finish (R4); `retry` and `busy` block-start handling in `dmStream` (discard partial draft / show busy status) |
| WP7 | `/voice` command, the `vo:` callback, strings (en/ru) |
| WP8 | Mini App Settings: voice replies toggle; Home shows the provider and today's LLM budget (`services.llmBudget.snapshot()`) |

## R9. Definition of done (overall)

- `npm run typecheck && npm test && npm run test:e2e` all green, using fakes only.
- `npm run sim` prints onboarding with no tokens.
- `LIVE=1 npm run smoke:groq` passes against the real Groq key (≤ 6K tokens).
- `npm run dev` connects to Telegram with polling. A real DM to @goratgai_bot gets a streamed Groq answer, a reminder can be created and fires, a voice note is transcribed, and web search answers with sources.
