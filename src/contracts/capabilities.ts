// ── contracts/capabilities.ts (WP0, frozen) — 01 §4.4 + 03 R7
import type { Message } from 'grammy/types';
import type { Ms, UserId } from './common.ts';
import type { BetaContentBlockParam, CallMeta, Priority } from './llm.ts';
import type { DekId, InputKind } from './storage.ts';

export interface SpeechToText {
  readonly name: string;
  transcribe(audio: Uint8Array, o: { filename: string; mime: string; language?: string; signal?: AbortSignal; priority?: Priority; meta?: CallMeta }): Promise<{ text: string; language?: string; durationSec?: number; /** 03 R4: every segment no_speech_prob > 0.8 */ noSpeech?: boolean }>;
}
export interface Forecast { place: string; tz: string; current: { tempC: number; code: number; windKmh: number }; daily: Array<{ date: string; minC: number; maxC: number; precipProb: number; code: number }>; source: string }
export interface WeatherProvider { forecast(q: { lat: number; lon: number; days: number }): Promise<Forecast> }
export interface FxProvider { rate(from: string, to: string): Promise<{ rate: number; asOf: string; source: string }> }
/** featureCode / population: GeoNames data from the city geocoder (PPL* = a populated place), when the provider has it. */
export interface GeoPlace { name: string; lat: number; lon: number; country?: string; tz?: string; address?: string; featureCode?: string; population?: number }
export interface GeoProvider {
  geocodeCity(name: string, lang: string): Promise<GeoPlace[]>;
  searchPlace(q: string, near?: { lat: number; lon: number }): Promise<GeoPlace[]>;
  tzForPoint(lat: number, lon: number): string | null;
}
export interface SafeFetch { get(url: string, o?: { maxBytes?: number; timeoutMs?: number; accept?: string; signal?: AbortSignal }): Promise<{ status: number; finalUrl: string; contentType: string; body: Uint8Array }> }
/** On Groq (03 R4) fileType is restricted to 'csv'|'md'|'txt'|'json'|'png'; the others return isError from make_file. */
export type MakeFileType = 'xlsx' | 'csv' | 'docx' | 'pdf' | 'png' | 'md' | 'txt' | 'json';
export interface CodeFiles { make(p: { userId: UserId; fileType: MakeFileType; filename: string; instructions: string; inputs: Array<{ bytes: Uint8Array; filename: string; mime: string }>; signal: AbortSignal }): Promise<{ bytes: Uint8Array; filename: string; mime: string }> }
export interface MediaIngest {
  fromMessage(msg: Message, ctx: { userId: UserId | null; dek: DekId; lang: string }): Promise<{ blocks: BetaContentBlockParam[]; kind: InputKind; sttSeconds: number; untrusted: boolean } | { rejected: string }>;
  /**
   * Review F11 (02 §C): the photo messages of one album (same media_group_id, merged by the DM surface) as ONE input:
   * on Groq one vision call over the first 3 photos; on Anthropic one image block per photo. Captions follow.
   */
  fromAlbum?(msgs: readonly Message[], ctx: { userId: UserId | null; dek: DekId; lang: string }): Promise<{ blocks: BetaContentBlockParam[]; kind: InputKind; sttSeconds: number; untrusted: boolean } | { rejected: string }>;
}

// ── 03 R7 additions. `meta` (WP0 addition, optional everywhere): usage attribution for llm_calls and the per-user cost cap;
// the Groq implementations (WP5) record each call with it (purpose search/vision/guard/sentinel/stt/tts).
export interface SearchResult { answer: string; sources: Array<{ title: string; url: string }> }
export interface SearchCapability {
  search(q: { query: string; freshness?: string | null; priority: Priority; meta?: CallMeta }): Promise<SearchResult>;
  open(q: { url: string; question?: string | null; priority: Priority; meta?: CallMeta }): Promise<SearchResult>;
}
export interface VisionCapability { describe(q: { images: Array<{ bytes: Uint8Array; mime: string }>; question?: string | null; priority?: Priority; meta?: CallMeta }): Promise<string> }
export interface PdfTextCapability { extract(bytes: Uint8Array, maxChars: number): Promise<{ text: string; pages: number; truncated: boolean }> }
export interface TtsCapability { speak(text: string, o?: { voice?: string; priority?: Priority; meta?: CallMeta }): Promise<{ ogg: Uint8Array; durationSec: number }> }
/** null = unavailable. `o.priority` defaults to the caller's run priority, else 'background' (03 R6). */
export interface GuardCapability { score(text: string, o?: { priority?: Priority; userId?: UserId | null; runId?: string | null }): Promise<number | null> }
export interface LlmSentinelCapability { check(i: { tool: string; input: string; ownerText: string; taint: string[]; priority?: Priority; meta?: CallMeta }): Promise<{ violation: boolean; rationale: string } | null> } // null = error/timeout/disabled → caller asks
export interface LlmBudget {
  allow(p: Priority): boolean;
  snapshot(): Record<string, { rpdUsed: number; rpdLimit: number; tpmRemaining: number }>;
}

/**
 * location_state (WP5). Written by WP7 (surfaces/location.ts: shares and live-location edits, last point only),
 * read by WP5 (weather_get), WP6 (brief) and the location context line. Rows expire after 1 h (or at live_until).
 */
export interface LocationService {
  set(userId: UserId, p: { lat: number; lon: number; accuracyM?: number; livePeriodSec?: number }): void;
  get(userId: UserId): { lat: number; lon: number; accuracyM: number | null; updatedAt: Ms; liveUntil: Ms | null } | null;
  clear(userId: UserId): void;
}

/**
 * Friend-mode addition (spec 05 B2): local sentence embeddings (default Xenova/multilingual-e5-small, 384-d, q8, CPU,
 * via @huggingface/transformers; model cached under DATA_DIR/models). The e5 prefixes are the implementation's job:
 * 'query' texts get "query: ", 'passage' texts "passage: ". Vectors are L2-normalized, so cosine = dot product.
 * Availability is never an error: `embed` resolves null while the model is unavailable (disabled, download failed,
 * load error), and callers degrade to lexical-only retrieval. Pure CPU, no LLM budget.
 */
export interface Embedder {
  /** Stored in fact_embeddings.model; a vector from another model is never compared (re-embed instead). */
  readonly model: string;
  readonly dim: number;
  embed(texts: readonly string[], kind: 'query' | 'passage', o?: { signal?: AbortSignal }): Promise<Float32Array[] | null>;
  /** 'idle' before the first use (lazy load), 'loading', 'ready', or 'unavailable' (embed resolves null). */
  status(): 'idle' | 'loading' | 'ready' | 'unavailable';
}

export interface Capabilities {
  stt: SpeechToText; weather: WeatherProvider; fx: FxProvider; geo: GeoProvider; safeFetch: SafeFetch; codeFiles: CodeFiles; media: MediaIngest;
  // 03 R7
  search: SearchCapability; vision: VisionCapability; pdfText: PdfTextCapability; tts: TtsCapability; guard: GuardCapability; llmSentinel: LlmSentinelCapability;
  /** WP0 addition; app.ts also exposes it as `Services.location`. */
  location: LocationService;
  /** Friend-mode addition (spec 05 B2). */
  embedder: Embedder;
}
