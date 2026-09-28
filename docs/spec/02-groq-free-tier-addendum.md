# Gora spec addendum: provider-agnostic LLM layer on Groq's free tier

**Precedence:** this addendum OVERRIDES `01-build-spec.md` wherever they conflict. The build spec was written for Claude. The owner has only a Groq key, is staying on Groq's **free tier** (the Developer tier upgrade is unavailable), and wants Claude to plug in later through an `ANTHROPIC_API_KEY`.

Verified facts are in `docs/research/groq.md`, from live calls on 2026-09-28. The live-tested reference code is in `docs/reference/`:
- `agent-loop.ts`: groq-sdk streaming tool loop
- `websearch.ts`: browser_search sub-call
- `run-fail.ts`: `tool_use_failed` recovery
- `oggopus.ts`: WAV → OGG/Opus encoder

## A. Provider abstraction (replaces the build spec's direct Anthropic calls)

`src/llm/` owns every model call. No other module imports `groq-sdk` or `@anthropic-ai/sdk`.

```ts
type Role = 'main' | 'fast' | 'vision' | 'sentinel' | 'guard' | 'stt' | 'tts';

interface LlmMessage {                // neutral, persisted in SQLite
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;                    // text only; images arrive already described as text
  toolCalls?: { id: string; name: string; args: string }[];   // assistant only
  toolCallId?: string; toolName?: string;                     // tool only
  providerData?: { provider: 'groq' | 'anthropic'; raw: unknown }; // verbatim native assistant content (e.g. Claude thinking blocks), replayed only to the same provider inside the same tool loop
}

type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }          // never shown raw; may drive a "thinking…" indicator
  | { type: 'tool_call'; call: { id: string; name: string; args: string } }
  | { type: 'retry'; reason: string; model: string; discardPartial: boolean }  // renderer must discard partial draft text
  | { type: 'usage'; model: string; prompt: number; completion: number }
  | { type: 'done'; finish: 'stop' | 'tool_calls' | 'length' | 'refusal' | 'error'; text: string; toolCalls: {id:string;name:string;args:string}[]; providerData?: unknown };

interface LlmProvider {
  readonly name: 'groq' | 'anthropic';
  chatStream(req: { role: Role; messages: LlmMessage[]; tools: ToolSchema[]; maxOutputTokens: number; effort?: 'low'|'medium'|'high'; signal?: AbortSignal; priority: Priority }): AsyncIterable<LlmEvent>;
  structured<T>(req: { role: Role; system: string; input: string; schema: JsonSchema; zod: ZodType<T>; maxOutputTokens: number; priority: Priority }): Promise<T>;   // strict json_schema; one retry on output_parse_failed / json_validate_failed; validated with zod
  webSearch(q: { query: string; freshness?: string; priority: Priority }): Promise<{ answer: string; sources: { title: string; url: string }[] }>;
  openUrl(q: { url: string; question?: string; priority: Priority }): Promise<{ answer: string; sources: { title: string; url: string }[] }>;
  runCode(q: { task: string; priority: Priority }): Promise<{ text: string; images: Buffer[] }>;
  describeImage(q: { images: Buffer[]; mime: string; question?: string; priority: Priority }): Promise<string>;
  transcribe(q: { audio: Buffer; filename: string; prompt?: string; priority: Priority }): Promise<{ text: string; language?: string; noSpeech: boolean }>;
  speak?(q: { text: string; voice?: string; priority: Priority }): Promise<Buffer>;  // returns OGG/Opus bytes ready for sendVoice
  guardScore(text: string): Promise<number>;   // 0..1 prompt-injection probability (max over chunks)
  sentinel(q: SentinelInput): Promise<SentinelVerdict>;  // fail-closed
}
```

Provider selection is `LLM_PROVIDER=groq|anthropic|auto`, where `auto` means anthropic if `ANTHROPIC_API_KEY` is set, otherwise groq. Even when Claude is the main brain, **Groq stays the provider for STT/TTS/guard/sentinel/vision** whenever `GROQ_API_KEY` is set. Implement this as a `ProviderRouter` that resolves each Role to a concrete provider and model.

### Groq role → model map (defaults; override via env)

| Role | Model | Notes |
|---|---|---|
| main | `openai/gpt-oss-120b` | stream, `reasoning_effort:'low'` (`'medium'` for missions), `include_reasoning` default; emits ONE tool call per step (no parallel calls) |
| fast | `openai/gpt-oss-20b` | memory extraction, rolling summaries, classification, and the `browser_search` / `code_interpreter` sub-calls. Strict json_schema (all props required, `additionalProperties:false`, nullable as `['string','null']`). Never combine json_schema with tools or browser_search |
| vision | `qwen/qwen3.8-27b` | only model that accepts images (≤3 per call). Needs explicit `reasoning_effort` to think. Output is text that gets injected into the conversation |
| sentinel | `openai/gpt-oss-safeguard-20b` | policy in the system message, JSON `{violation, category, rationale}`, `reasoning_effort:'low'`, `include_reasoning:false`, zod-validated, fail-closed |
| guard | `meta-llama/llama-prompt-guard-2-86m` | exactly one user message ≤512 tokens. Content is a float as a string. Chunk at 1500 chars with 200 overlap, max 6 chunks per document, results cached by sha256 |
| stt | `whisper-large-v3-turbo` | `toFile(buf, name)`; Telegram voice `.oga` MUST be renamed `voice.ogg`; audio files keep their real extension (mp3/m4a); video notes → `video.mp4`; `response_format:'verbose_json'`; `no_speech_prob > 0.8` on all segments → noSpeech |
| tts | `canopylabs/orpheus-v1-english` | WAV only, ≤200 chars per request → split on sentence boundaries, synthesize sequentially, concatenate PCM, encode once to OGG/Opus with `opusscript` + `src/audio/oggopus.ts` (port of `docs/reference/oggopus.ts`). Voices: hannah (default), diana, autumn, austin, daniel, troy. Opt-in only (`/voice`), 100 requests/day free |

### Anthropic mapping (implemented, unit-tested with a fake client, not live-tested: no key yet)

- **Roles:** main = `claude-opus-5` (adaptive thinking, `output_config.effort`, streaming via `client.messages.stream`); fast = `claude-opus-5` with effort `low`.
- **Web tools:** `webSearch` / `openUrl` = a one-off sub-call with the server tools `web_search_20260209` / `web_fetch_20260209`.
- **Code:** `runCode` = a sub-call with `code_execution_20260521`.
- **Images:** `describeImage` = Claude vision.
- **Fallbacks:** follow `docs/research/claude-api.md` and the claude-api skill (fallbacks `"default"` + beta header, refusal handling).
- **Assistant content:** keep Claude's native assistant content blocks in `providerData.raw` so thinking blocks are passed back unchanged *within a tool loop*. Never edit persisted rows.

## B. Hard budget: every Groq request must fit the free tier

The free tier allows 8,000 TPM, 30 RPM and 1,000 RPD **per model**. A single request above about 8K tokens returns **413** before it runs. Completion tokens count once produced.

1. **Prompt cap.** `LLM_MAX_PROMPT_TOKENS` defaults to 5200 for groq and 150000 for anthropic. `max_completion_tokens` defaults to 1200 for chat and 400 for extraction.
2. **Token estimate.** Use `ceil(chars / 3.2) + 12 per message` (conservative for Cyrillic). Put this in `src/llm/tokens.ts`, with a test.
3. **Context assembler** (`src/agent/context.ts`) builds every main request under the cap, in priority order:
   1. core system prompt (≤ 700 tok, frozen, no timestamps)
   2. **turn context** as one short system message after it: now in the user's TZ, locale, location city, active mission/topic, quiet hours
   3. tool schemas for the *active toolkits only* (see 4)
   4. memory digest: pinned profile facts (≤ 250 tok) + FTS5-retrieved facts relevant to the current input (≤ 300 tok)
   5. rolling conversation summary (≤ 350 tok)
   6. as many recent turns as fit, newest first, never splitting an assistant tool_call from its tool results
   7. the current user input

   Old tool results inside history are elided to `[tool result elided: <first 200 chars>]`. A single tool result is capped at 1,500 tokens before it enters history.
4. **Toolkits, not a flat tool list.** Tools are grouped into toolkits.
   - `core` is always loaded: `remember`, `recall`, `forget`, `remind`, `list_reminders`, `cancel_reminder`, `use_toolkit`.
   - The others load on demand: `web` (web_search, open_url), `tasks` (missions/checklists), `routines` (cron routines, daily brief), `files` (run_code, make_file), `secretary` (drafts, inbox), `integrations`, `groups`.
   - `use_toolkit(name)` is a cheap tool whose description lists each toolkit in one line. Calling it adds that toolkit to the conversation's active set for the next N=6 turns. There is also a keyword pre-loader: a URL loads `web`; "remind/every/each morning" loads `routines`.
   - Tool descriptions must be terse, since each tool's schema costs tokens. Test that the core toolset serializes to ≤ 900 tokens.
5. **RateGovernor** (`src/llm/rate.ts`), one instance per model:
   - Sliding-window TPM/RPM accounting, synced from response headers: `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens` (format like `2.085s` or `1m26.4s`, needs a parser with tests), `x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`. Read them via groq-sdk `.withResponse()`.
   - Create the client with `new Groq({ maxRetries: 0 })`: the SDK sleeps uncapped on retry-after.
   - **Priorities:** interactive > approval > reminder > background > proactive.
   - Before each call, `acquire(estTokens, priority)`:
     - if the budget fits, go;
     - if the wait is under 4 s and the call is interactive, wait;
     - otherwise try the role's **fallback chain** (main: 120b → qwen3.8-27b → 20b; fast: 20b → 120b), each model with its own bucket;
     - otherwise, for interactive calls, emit a visible "⏳ busy, retrying in Ns" status and wait. Lower priorities are deferred to a queue.
   - **Daily budget:** track RPD per model in SQLite (resets at the header's reset time). Above 85% daily use, pause proactive/background jobs. Above 97%, only interactive calls run.
   - **429:** respect `retry-after`, and switch to the fallback model if the wait is over 4 s.
   - **413:** never retry as-is. Shrink the context by 30% (fewer turns, drop the digest) and retry once.
   - **`tool_use_failed`** (streamed as an SSE error event after reasoning; the SDK throws an APIError with `status` undefined and `e.error.code === 'tool_use_failed'`): emit `retry{discardPartial:true}`, append a system note listing the valid tool names, retry once with `tool_choice:'auto'`.
   - **`output_parse_failed` / `json_validate_failed`:** retry once, then throw.
6. **Tool-call detection:** decide whether tools ran by `toolCalls.length > 0`, never by `finish_reason` (Groq MCP/built-ins can report `tool_calls` with none). The stream may end with a final `choices: []` chunk, so guard `chunk.choices[0]`.
7. **Step limit:** at most 8 tool steps per run on groq (gpt-oss makes one call per step). Missions can checkpoint and continue in a later run.

## C. Capabilities: Groq-specific implementations

- **Web search:** a Gora function tool `web_search(query)`. Its handler calls `provider.webSearch`, a separate `fast`-role call with `tools:[{type:'browser_search'}]`. The handler returns `{answer (≤ 1200 chars), sources[]}`. Search results never enter history on Groq otherwise, which makes the model re-search. The answer is screened by guard before it reaches the main model and wrapped as untrusted (see E). One search costs about 4.5K tokens of the 20b budget, so the governor must account for it.
- **open_url(url, question?):** same pattern, prompting browser.open on the URL, so there is no server-side HTTP fetch and no SSRF surface. Only http(s) is accepted; private/loopback hosts and IP literals are rejected before the call.
- **run_code(task):** a `fast`-role sub-call with `tools:[{type:'code_interpreter'}]` and the system prompt "Always execute Python for any computation; never guess results." Returns stdout text plus any PNG charts from `executed_tools[].code_results[].png` (base64), which get sent as photos.
- **Images:**
  - Photos go to `vision` (qwen). With no caption, the prompt is "Describe precisely, transcribe any text". With a caption, the prompt is the caption.
  - The result goes into the conversation as `[image: …description…]` in the user turn.
  - Up to 3 images per album.
- **PDF / text documents:** extract text locally with `unpdf` (PDF) or read UTF-8 (txt/md/csv/json). Documents over the context budget are summarized by `fast` in chunks. The document text is untrusted: guard-screened and tagged.
- **Voice in:** STT as above. The transcript becomes the user text, with a 🎙 marker in history. The detected language drives the reply language.
- **Voice out:** off by default. `/voice on` means Gora answers voice notes with a voice note (short answers only, ≤ 600 chars; otherwise text plus a "🔊 Listen" button that synthesizes on demand).

## D. Memory under a tiny context

- **Facts storage:** facts live in SQLite with an FTS5 index (verified: node:sqlite 3.53.4 has FTS5 with `unicode61 remove_diacritics 2` and handles Cyrillic).
- **Retrieval:** BM25 search over the current user message's keywords plus pinned profile facts. There are no embeddings (Groq has no embedding model on this key).
- **Extraction:** runs *after* the reply, in the background (priority `background`), as a `fast` structured call over the last exchange only. It outputs `{facts:[{text, kind: profile|preference|relationship|plan|other, pinned:boolean, sensitive:boolean, supersedes?: string|null}]}`.
- **Batching:** under daily-budget pressure, extraction batches every 3 exchanges.
- **Consent and forgetting:** these follow the build spec (consent card, incognito, forget with fingerprints). Because history sent to the model is a window plus a summary, "forget" also rewrites the rolling summary (a new summary row; old rows are marked superseded, never edited in place) and excludes turns containing the forgotten text from the replay window.

## E. Trust layer on Groq

- **Untrusted content** is anything not typed or spoken by the owner in their DM: web answers, fetched pages, documents, forwarded messages, business/group messages from others, integration outputs. It is:
  - wrapped as `<untrusted source="…">…</untrusted>` (JSON-escaped);
  - screened with guard 86m, where score ≥ 0.5 marks the run **tainted** and ≥ 0.9 replaces the chunk with `[removed: likely prompt injection]`;
  - fail-closed: a guard error or 429 also marks the run tainted.
- **Sentinel** (safeguard-20b) runs only for side-effecting tools, *after* the fixed rules (see the build spec). Its JSON is zod-validated. Error, timeout or invalid output means block → approval card to the owner. The Sentinel is never the only gate: irreversible and outward actions always need the owner's tap.

## F. Env additions

```
LLM_PROVIDER=auto                 # auto|groq|anthropic
GROQ_API_KEY=
ANTHROPIC_API_KEY=
GROQ_MODEL_MAIN=openai/gpt-oss-120b
GROQ_MODEL_FAST=openai/gpt-oss-20b
GROQ_MODEL_VISION=qwen/qwen3.8-27b
GROQ_MODEL_SENTINEL=openai/gpt-oss-safeguard-20b
GROQ_MODEL_GUARD=meta-llama/llama-prompt-guard-2-86m
GROQ_MODEL_STT=whisper-large-v3-turbo
GROQ_MODEL_TTS=canopylabs/orpheus-v1-english
GROQ_TTS_VOICE=hannah
GROQ_TIER=free                    # free|dev — sets default TPM/RPM/RPD and the prompt cap
LLM_MAX_PROMPT_TOKENS=            # optional override
ANTHROPIC_MODEL_MAIN=claude-opus-5
```

## G. Testing additions

- `FakeProvider`: implements `LlmProvider` from a script of `LlmEvent` sequences, plus canned search, vision, guard and sentinel results. All agent, trust and scheduler tests use it.
- Groq adapter unit tests: a fake groq client produces the exact chunk shapes from `docs/research/groq.md` (reasoning deltas with `channel:'analysis'`, one complete tool_call delta, the final `choices:[]` usage chunk, an SSE `tool_use_failed` error after reasoning, 429 with retry-after, 413).
- RateGovernor tests: header parsing (`2.085s`, `1m26.4s`, `7h12m0s`), window accounting, fallback chain, priority deferral, and the daily threshold.
- Context assembler tests: never exceeds the cap on a 200-turn history with long tool results, keeps tool_call/tool-result pairs intact, and always includes the current input.
- Encoder test: synthesize a sine WAV → encode → parse the OGG pages (capture pattern, CRC, OpusHead/OpusTags, granule position ≈ duration × 48k).
- An **opt-in live smoke test** (`npm run smoke:groq`, skipped unless `GROQ_API_KEY` is set and `LIVE=1`): one short streamed chat, one tool call, one guard call, one STT of a generated WAV. It must stay under about 6K tokens in total.
