// test/harness/fakes.ts (WP0) — fakes for every capability (incl. the 03 R7 ones) and no-op / in-memory
// implementations of every service, used (a) by unit tests of each WP and (b) by createTestApp() as the
// `notBuiltFallback` factories while WP1–WP8 are still stubs.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { Bot, webhookCallback } from 'grammy';
import { Hono } from 'hono';
import { z } from 'zod';
import type {
  AgentModule, AgentRunner, ApprovalService, StringKey, Strings, StringVars, MessagesRepo, CallbackCodec, CallbackKind, Capabilities, ChannelFactory, ChoiceService, Clock, CodeFiles, ConversationRow, ConversationsRepo,
  CoreRepos, Crypto, DeepLinkService, DekId, Effect, EpochRow, Factories, GrantService, Forecast, FxProvider, GeoPlace, GeoProvider, GroupService, GuardCapability, GuestService, InputRow, InputsRepo,
  IntegrationProvider, IntegrationService, JobHandler, JobKind, JobRow, KeyStore, KvRepo, Ledger, LedgerEntry, LlmBudget, LlmCallRecord, LlmGovernance, LlmSentinelCapability, LlmTransport, LocationService,
  MediaIngest, MemoryService, MessageRow, MissionModule, NoticeService, Outbox, OutboxRequest, PdfTextCapability, PrivacyService, ProactiveModule, QuotaKind, QuotaService, RateGovernor,
  ReminderModule, Renderer, ReplyChannel, RoundOutcome, RunRow, RunsRepo, SafeFetch, Scheduler, SearchCapability, SentRef, Services, SpeechToText, SurfacesModule, Surface, TelegramFiles, BusinessModule,
  TelegramModule, TelegramModuleOptions, TgLinkRow, TgLinks, ToolCallRow, ToolCtx, ToolDefinitions, ToolExecutor, ToolkitId, ToolkitState, ToolRegistry, ToolSpec, ToolsetId, TopicManager,
  TrustedTargetService, TrustModule, TtsCapability, UntrustedWrapper, UserRow, UserSettings, UsersRepo, VisionCapability, WeatherProvider,
  BehaviourModule, BrowserModule, GroupChattiness, GroupModule, GroupObservedMessage, GroupParticipation, GroupPolicyView, Embedder, ProactiveDecision, ProactivePolicy, ProfileCard, ProfileService, ProfileView, SignalsService, StyleHints, UserId,
} from '../../src/contracts/index.ts';
import type { BetaContentBlockParam, BetaToolResultBlockParam, BetaToolUnion } from '../../src/contracts/llm.ts';
import { TOOLKIT_IDS } from '../../src/contracts/tools.ts';
import { GROUP_CHIME_KINDS } from '../../src/contracts/groups.ts';
import { uiLang } from '../../src/contracts/i18n.ts';
import { ZERO_USAGE } from '../../src/contracts/llm.ts';
import { canonicalJson } from '../../src/kernel/canonicalJson.ts';
import { DekDestroyedError, errorMessage, NetworkDisabledError, NotBuiltError } from '../../src/kernel/errors.ts';
import { newId, ulid } from '../../src/kernel/ids.ts';
import { createCallbackRegistry } from '../../src/kernel/registries.ts';
import { escapeAttr, neutralizeReservedTags } from '../../src/kernel/tags.ts';
import { TEST_BOT_INFO, TEST_TOKEN } from './fakeTelegram.ts';
import { FakeBrowser } from './fakeBrowser.ts';
import { createHashEmbedder } from '../../src/capabilities/embedder.ts';
export { seededRandom } from '../../src/kernel/random.ts';

// ───────────────────────── generic helper

/** An object whose listed members are implemented and every other method throws NotBuiltError('fake', '<name>.<method>'). */
export function notImplemented<T extends object>(name: string, impl: Partial<T> = {}): T {
  return new Proxy(impl as T, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      if (prop === 'then' || typeof prop === 'symbol' || prop === 'toJSON') return undefined;
      return () => {
        throw new NotBuiltError('fake', `${name}.${String(prop)}`);
      };
    },
  });
}

// ───────────────────────── capabilities (01 §4.4 + 03 R7)

export class FakeSTT implements SpeechToText {
  readonly name = 'fake';
  transcript = 'Remind me to call mom tomorrow at 10';
  language = 'en';
  noSpeech = false;
  calls: Array<{ filename: string; mime: string; bytes: number; language?: string }> = [];
  async transcribe(audio: Uint8Array, o: { filename: string; mime: string; language?: string }) {
    this.calls.push({ filename: o.filename, mime: o.mime, bytes: audio.length, ...(o.language ? { language: o.language } : {}) });
    return { text: this.transcript, language: this.language, durationSec: 14, noSpeech: this.noSpeech };
  }
}

export class FakeWeather implements WeatherProvider {
  calls: Array<{ lat: number; lon: number; days: number }> = [];
  async forecast(q: { lat: number; lon: number; days: number }): Promise<Forecast> {
    this.calls.push(q);
    const daily = Array.from({ length: q.days }, (_, i) => ({ date: `2026-09-${String(28 + i).padStart(2, '0')}`, minC: 8 + i, maxC: 19 + i, precipProb: 10 * i, code: 1 }));
    return { place: 'Almaty', tz: 'Asia/Almaty', current: { tempC: 17, code: 1, windKmh: 9 }, daily, source: 'fake-weather' };
  }
}

export class FakeFx implements FxProvider {
  rates: Record<string, number> = { 'USD:KZT': 480, 'EUR:KZT': 520, 'USD:RUB': 92, 'USD:EUR': 0.92 };
  async rate(from: string, to: string) {
    const r = from === to ? 1 : (this.rates[`${from}:${to}`] ?? (this.rates[`${to}:${from}`] ? 1 / this.rates[`${to}:${from}`]! : undefined));
    if (r === undefined) throw new Error(`FakeFx: no rate ${from}->${to}`);
    return { rate: r, asOf: '2026-09-28', source: 'fake-fx' };
  }
}

export class FakeGeo implements GeoProvider {
  cities: Record<string, GeoPlace> = {
    almaty: { name: 'Almaty', lat: 43.24, lon: 76.95, country: 'KZ', tz: 'Asia/Almaty' },
    kyiv: { name: 'Kyiv', lat: 50.45, lon: 30.52, country: 'UA', tz: 'Europe/Kyiv' },
    istanbul: { name: 'Istanbul', lat: 41.01, lon: 28.98, country: 'TR', tz: 'Europe/Istanbul' },
  };
  places: GeoPlace[] = [{ name: 'Ramen Bar', lat: 43.238, lon: 76.945, address: 'Abay Ave 10, Almaty' }];
  async geocodeCity(name: string) {
    const c = this.cities[name.trim().toLowerCase()];
    return c ? [c] : [];
  }
  async searchPlace(q: string) {
    return this.places.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  }
  tzForPoint(lat: number, lon: number): string | null {
    for (const c of Object.values(this.cities)) if (Math.abs(c.lat - lat) < 2 && Math.abs(c.lon - lon) < 2) return c.tz ?? null;
    return 'UTC';
  }
}

export class FakeSafeFetch implements SafeFetch {
  pages = new Map<string, { status?: number; contentType?: string; body: string | Uint8Array }>();
  calls: string[] = [];
  set(url: string, body: string | Uint8Array, o: { status?: number; contentType?: string } = {}): this {
    this.pages.set(url, { body, ...o });
    return this;
  }
  async get(url: string) {
    this.calls.push(url);
    const p = this.pages.get(url);
    if (!p) throw new NetworkDisabledError(url);
    const body = typeof p.body === 'string' ? new TextEncoder().encode(p.body) : p.body;
    return { status: p.status ?? 200, finalUrl: url, contentType: p.contentType ?? 'text/html; charset=utf-8', body };
  }
}

export class FakeCodeFiles implements CodeFiles {
  calls: Array<{ fileType: string; filename: string }> = [];
  async make(p: { fileType: string; filename: string; instructions: string }) {
    this.calls.push({ fileType: p.fileType, filename: p.filename });
    const mime = p.fileType === 'png' ? 'image/png' : p.fileType === 'csv' ? 'text/csv' : 'application/octet-stream';
    return { bytes: new TextEncoder().encode(`fake ${p.fileType}`), filename: p.filename, mime };
  }
}

/** Text/caption → one text block; everything else is rejected (the real MediaIngest is WP5's). */
export class FakeMediaIngest implements MediaIngest {
  async fromMessage(msg: Parameters<MediaIngest['fromMessage']>[0]) {
    const m = msg as { text?: string; caption?: string };
    const text = m.text ?? m.caption;
    if (text === undefined) return { rejected: 'fake media ingest: only text is supported' };
    return { blocks: [{ type: 'text' as const, text }], kind: 'text' as const, sttSeconds: 0, untrusted: false };
  }
}

export class FakeSearch implements SearchCapability {
  answer = 'Ramen Bar on Abay Ave is open until 23:00 today.';
  sources = [{ title: 'Ramen Bar — hours', url: 'https://example.com/ramen' }];
  calls: Array<{ kind: 'search' | 'open'; q: string; priority: string }> = [];
  async search(q: { query: string; priority: string }) {
    this.calls.push({ kind: 'search', q: q.query, priority: q.priority });
    return { answer: this.answer, sources: [...this.sources] };
  }
  async open(q: { url: string; question?: string | null; priority: string }) {
    this.calls.push({ kind: 'open', q: q.url, priority: q.priority });
    return { answer: `Page ${new URL(q.url).host}: ${this.answer}`, sources: [{ title: q.url, url: q.url }] };
  }
}

export class FakeVision implements VisionCapability {
  description = 'A screenshot of a calendar showing a meeting on Tuesday at 15:00.';
  calls = 0;
  async describe(_q?: Parameters<VisionCapability["describe"]>[0]) {
    this.calls++;
    return this.description;
  }
}

export class FakePdfText implements PdfTextCapability {
  async extract(bytes: Uint8Array, maxChars: number) {
    const text = new TextDecoder().decode(bytes);
    return { text: text.slice(0, maxChars), pages: 1, truncated: text.length > maxChars };
  }
}

export class FakeTts implements TtsCapability {
  calls: string[] = [];
  fail = false;
  async speak(text: string) {
    this.calls.push(text);
    if (this.fail) throw new Error('FakeTts: failure');
    // 'OggS' capture pattern + padding; not a playable stream (the real encoder is WP5's).
    return { ogg: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, ...new Array(22).fill(0)]), durationSec: Math.max(1, Math.round(text.length / 15)) };
  }
}

/** Scores ≥0.99 for obvious injections, 0.001 otherwise; `unavailable` → null (03 R5 "guard unavailable"). */
export class FakeGuard implements GuardCapability {
  unavailable = false;
  overrides = new Map<string, number>();
  calls: string[] = [];
  async score(text: string) {
    this.calls.push(text);
    if (this.unavailable) return null;
    for (const [needle, s] of this.overrides) if (text.includes(needle)) return s;
    return /ignore (all )?(previous|prior) instructions|игнорируй все предыдущие/i.test(text) ? 0.999 : 0.001;
  }
}

export class FakeLlmSentinel implements LlmSentinelCapability {
  verdict: { violation: boolean; rationale: string } | null = { violation: false, rationale: 'consistent with the owner request' };
  calls: Array<{ tool: string; input: string; ownerText: string; taint: string[] }> = [];
  async check(i: { tool: string; input: string; ownerText: string; taint: string[] }) {
    this.calls.push(i);
    return this.verdict;
  }
}

export class FakeLlmBudget implements LlmBudget {
  blocked = new Set<string>();
  allow(p: string) {
    return !this.blocked.has(p);
  }
  snapshot() {
    return { 'openai/gpt-oss-120b': { rpdUsed: 0, rpdLimit: 1000, tpmRemaining: 8000 } };
  }
}

export class FakeRateGovernor implements RateGovernor {
  acquired: Array<{ role: string; model: string; estTokens: number; priority: string }> = [];
  observed: string[] = [];
  async acquire(q: { role: string; model: string; estTokens: number; priority: string }) {
    this.acquired.push({ role: q.role, model: q.model, estTokens: q.estTokens, priority: q.priority });
    return { model: q.model };
  }
  observe(model: string) {
    this.observed.push(model);
  }
}

/** In-memory location_state: the last point per user, expiring 1 h after the update (or at the live period's end, if later). */
export class FakeLocation implements LocationService {
  rows = new Map<string, { lat: number; lon: number; accuracyM: number | null; updatedAt: number; liveUntil: number | null }>();
  private now: () => number;
  constructor(now: () => number = () => 0) {
    this.now = now;
  }
  set(userId: string, p: { lat: number; lon: number; accuracyM?: number; livePeriodSec?: number }) {
    const t = this.now();
    this.rows.set(userId, { lat: p.lat, lon: p.lon, accuracyM: p.accuracyM ?? null, updatedAt: t, liveUntil: p.livePeriodSec ? t + p.livePeriodSec * 1000 : null });
  }
  get(userId: string) {
    const r = this.rows.get(userId);
    if (!r) return null;
    if (this.now() > Math.max(r.updatedAt + 3_600_000, r.liveUntil ?? 0)) return null;
    return { ...r };
  }
  clear(userId: string) {
    this.rows.delete(userId);
  }
}

/**
 * Friend-mode (spec 05 B2/§E): an Embedder with controlled vectors. `set(text, vec)` pins the vector of an exact text
 * (the 'query: '/'passage: ' kind is ignored); other texts get the deterministic hashed bag-of-words vector of
 * capabilities/embedder.ts. `available = false` makes embed() resolve null (retrieval must degrade to lexical only).
 * Vectors are L2-normalized on the way out, so tests may pass raw directions like [1, 0, 0, 0].
 */
export class FakeEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  available = true;
  calls: Array<{ texts: string[]; kind: 'query' | 'passage' }> = [];
  private pinned = new Map<string, Float32Array>();
  private readonly base: Embedder;
  constructor(dim = 8) {
    this.dim = dim;
    this.model = `fake-${dim}`;
    this.base = createHashEmbedder(dim);
  }
  set(text: string, vec: readonly number[]): this {
    if (vec.length !== this.dim) throw new Error(`FakeEmbedder.set: want ${this.dim} dims, got ${vec.length}`);
    const v = Float32Array.from(vec);
    const n = Math.hypot(...v) || 1;
    this.pinned.set(text, v.map((x) => x / n));
    return this;
  }
  status(): 'ready' | 'unavailable' {
    return this.available ? 'ready' : 'unavailable';
  }
  async embed(texts: readonly string[], kind: 'query' | 'passage'): Promise<Float32Array[] | null> {
    this.calls.push({ texts: [...texts], kind });
    if (!this.available) return null;
    const rest = (await this.base.embed(texts, kind)) ?? [];
    return texts.map((t, i) => this.pinned.get(t)?.slice() ?? rest[i]!);
  }
}

export interface FakeCapabilities extends Capabilities {
  stt: FakeSTT; weather: FakeWeather; fx: FakeFx; geo: FakeGeo; safeFetch: FakeSafeFetch; codeFiles: FakeCodeFiles; media: FakeMediaIngest;
  search: FakeSearch; vision: FakeVision; pdfText: FakePdfText; tts: FakeTts; guard: FakeGuard; llmSentinel: FakeLlmSentinel; location: FakeLocation;
  embedder: FakeEmbedder;
  /** s07: scripted sites (test/harness/fakeBrowser.ts). */
  browser: FakeBrowser;
}
/** The provider factory for tests: every capability faked. `now` drives the location expiry (defaults to 0 = never expires in practice). */
export function createFakeCapabilities(now?: () => number): FakeCapabilities {
  return {
    stt: new FakeSTT(), weather: new FakeWeather(), fx: new FakeFx(), geo: new FakeGeo(), safeFetch: new FakeSafeFetch(), codeFiles: new FakeCodeFiles(), media: new FakeMediaIngest(),
    search: new FakeSearch(), vision: new FakeVision(), pdfText: new FakePdfText(), tts: new FakeTts(), guard: new FakeGuard(), llmSentinel: new FakeLlmSentinel(),
    location: new FakeLocation(now), embedder: new FakeEmbedder(), browser: new FakeBrowser([], now ?? (() => 0)),
  };
}

// ───────────────────────── storage fakes

export function createFakeKeyStore(): KeyStore & { deks: Map<string, { key: Uint8Array | null; owner: string }>; backups: string[] } {
  const deks = new Map<string, { key: Uint8Array | null; owner: string }>();
  const backups: string[] = [];
  return {
    path: ':memory:',
    kekVersion: 1,
    deks,
    getOrCreate(id, owner) {
      const d = deks.get(id);
      if (d) {
        if (!d.key) throw new DekDestroyedError(id);
        return d.key;
      }
      const key = new Uint8Array(randomBytes(32));
      deks.set(id, { key, owner });
      return key;
    },
    get(id) {
      const d = deks.get(id);
      if (!d) return undefined;
      if (!d.key) throw new DekDestroyedError(id);
      return d.key;
    },
    destroy(id) {
      const d = deks.get(id);
      deks.set(id, { key: null, owner: d?.owner ?? '?' });
    },
    destroyOwner(owner) {
      let n = 0;
      for (const [id, d] of deks) if (d.owner === owner && d.key) {
        deks.set(id, { key: null, owner });
        n++;
      }
      return n;
    },
    isDestroyed: (id) => deks.get(id)?.key === null,
    rewrap: () => deks.size,
    backups,
    async backup(destPath: string) {
      backups.push(destPath);
    },
    close() {},
  };
}

/**
 * DEK owner derived from the id (01 §4.4 DEK id conventions) — used only when seal() creates a DEK lazily. Epoch DEKs
 * cannot be attributed from their id ('conv:<id>' here); real code calls crypto.ensureDek(e:…, <owner>) first.
 */
export function dekOwner(dek: DekId): string {
  const [kind, a] = dek.split(':');
  if (kind === 'u' || kind === 'm') return a ?? 'sys';
  if (kind === 'g' || kind === 'mg') return `grp:${a}`;
  if (kind === 'b') return `biz:${a}`;
  if (kind === 'e') return `conv:${a}`;
  return 'sys';
}

/** AES-256-GCM envelope crypto over a KeyStore: 0x01 ‖ len(dek) ‖ dek ‖ iv(12) ‖ tag(16) ‖ ct (same layout as 01 §11.7). */
export function createFakeCrypto(ks: KeyStore, hashKey: Uint8Array): Crypto {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const c: Crypto = {
    seal(dek, plaintext, aad) {
      const key = ks.getOrCreate(dek, dekOwner(dek), 'data');
      const iv = randomBytes(12);
      const ci = createCipheriv('aes-256-gcm', key, iv);
      ci.setAAD(enc.encode(aad));
      const ct = Buffer.concat([ci.update(typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext), ci.final()]);
      const id = enc.encode(dek);
      return new Uint8Array(Buffer.concat([Buffer.from([1, id.length]), id, iv, ci.getAuthTag(), ct]));
    },
    open(ct, aad) {
      const b = Buffer.from(ct);
      if (b[0] !== 1) throw new Error('bad envelope version');
      const n = b[1]!;
      const dek = b.subarray(2, 2 + n).toString('utf8');
      const key = ks.get(dek);
      if (!key) throw new DekDestroyedError(dek);
      const iv = b.subarray(2 + n, 14 + n);
      const tag = b.subarray(14 + n, 30 + n);
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAAD(enc.encode(aad));
      d.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([d.update(b.subarray(30 + n)), d.final()]));
    },
    openText: (ct, aad) => dec.decode(c.open(ct, aad)),
    sealJson: (dek, v, aad) => c.seal(dek, JSON.stringify(v), aad),
    openJson: <T,>(ct: Uint8Array, aad: string) => JSON.parse(c.openText(ct, aad)) as T,
    hmac: (domain, data) => createHmac('sha256', hashKey).update(domain).update('\0').update(data).digest('hex'),
    destroyDek: (dek) => ks.destroy(dek),
    destroyOwner: (owner) => ks.destroyOwner(owner),
    isDestroyed: (dek) => ks.isDestroyed(dek),
    ensureDek: (dek, owner, purpose) => void ks.getOrCreate(dek, owner, purpose),
  };
  return c;
}

export function createMemoryKv(): KvRepo & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: <T,>(k: string) => map.get(k) as T | undefined, set: (k, v) => void map.set(k, structuredClone(v)) };
}

/** Core repos where only kv works; every other repo method throws NotBuiltError('fake', …). */
export function createFakeRepos(): CoreRepos {
  return {
    users: notImplemented('users'),
    conversations: notImplemented('conversations'),
    messages: notImplemented<MessagesRepo>('messages', { setValidator() {} }),
    inputs: notImplemented('inputs'),
    runs: notImplemented('runs'),
    kv: createMemoryKv(),
  };
}

/**
 * A full in-memory CoreRepos (WP1's contract) for tests of WP2–WP8 before WP1 merges, and for createTestApp's fallback.
 * Rows are copied on write and on read (content via structuredClone), so callers can never mutate stored state.
 * `messages` has no triggers: the grammar validator installed with setValidator runs on every append, in one "transaction".
 */
export function createMemoryCoreRepos(clock: Clock): CoreRepos {
  const now = () => clock.now();
  const clone = <T,>(v: T): T => structuredClone(v);

  // ── users (+ settings, consents, permissions)
  const users = new Map<string, UserRow>();
  const settings = new Map<string, UserSettings>();
  const consents: Array<{ id: string; userId: string; kind: string; subject: string | null; textVersion: string; via: string; grantedAt: number; revokedAt: number | null }> = [];
  const perms = new Map<string, 'none' | 'read' | 'draft' | 'act'>();
  const DEFAULT_SETTINGS: UserSettings = { nudgeBudget: 3, quietStart: '22:00', quietEnd: '08:00', briefTime: null, inboxCheckins: true, approvalExpiryMin: 1440, showTranscripts: true, homeCity: null, style: null };
  const needUser = (id: string) => {
    const u = users.get(id);
    if (!u) throw new Error(`memory repos: no user ${id}`);
    return u;
  };
  const usersRepo: UsersRepo = {
    getById: (id) => (users.has(id) ? { ...users.get(id)! } : undefined),
    getByTg: (tg) => {
      for (const u of users.values()) if (u.tgUserId === tg) return { ...u };
      return undefined;
    },
    upsertFromTelegram(u, o) {
      const existing = usersRepo.getByTg(u.id);
      if (existing) {
        const next: UserRow = { ...existing, firstName: u.first_name, username: u.username ?? null, languageCode: u.language_code ?? existing.languageCode, ...(o?.dmChatId !== undefined ? { dmChatId: o.dmChatId } : {}) };
        users.set(next.id, next);
        return { ...next };
      }
      const row: UserRow = {
        id: ulid(now()), tgUserId: u.id, dmChatId: o?.dmChatId ?? null, firstName: u.first_name, username: u.username ?? null, languageCode: u.language_code ?? null,
        tz: 'UTC', tzSource: 'default', personaName: 'Gora', personaStyle: 'friendly', plan: 'free', status: 'active', memoryConsent: null, incognitoUntil: null, memoryGen: 1,
        onboardingStep: 'consent', botBlocked: false, voiceReplies: false, proactiveLevel: 'normal', tzHintAt: null, createdAt: now(),
      };
      users.set(row.id, row);
      return { ...row };
    },
    update(id, patch) {
      users.set(id, { ...needUser(id), ...patch });
    },
    settings: (id) => clone(settings.get(id) ?? DEFAULT_SETTINGS),
    updateSettings(id, patch) {
      settings.set(id, { ...(settings.get(id) ?? DEFAULT_SETTINGS), ...clone(patch) });
    },
    list: (q) =>
      [...users.values()]
        .filter((u) => (q.afterId === undefined || u.id > q.afterId) && (!q.status || u.status === q.status))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, q.limit)
        .map((u) => ({ ...u })),
    *iterate(q = {}) {
      let afterId: string | undefined;
      for (;;) {
        const page = usersRepo.list({ ...(q.status ? { status: q.status } : {}), ...(afterId !== undefined ? { afterId } : {}), limit: q.batchSize ?? 200 });
        yield* page;
        if (page.length < (q.batchSize ?? 200)) return;
        afterId = page[page.length - 1]!.id;
      }
    },
    grantConsent(c) {
      const id = newId('cs', now());
      consents.push({ id, userId: c.userId, kind: c.kind, subject: c.subject ?? null, textVersion: c.textVersion, via: c.via, grantedAt: now(), revokedAt: null });
      return id;
    },
    revokeConsent(userId, kind, subject) {
      for (const c of consents) if (c.userId === userId && c.kind === kind && c.subject === (subject ?? null) && c.revokedAt === null) c.revokedAt = now();
    },
    hasConsent: (userId, kind, subject) => consents.some((c) => c.userId === userId && c.kind === kind && c.subject === (subject ?? null) && c.revokedAt === null),
    permissions: (userId) => ({ gmail: perms.get(`${userId}:gmail`) ?? 'none', gcal: perms.get(`${userId}:gcal`) ?? 'none' }),
    setPermission(userId, integration, level) {
      perms.set(`${userId}:${integration}`, level);
    },
  };

  // ── conversations (+ epochs)
  const convs = new Map<string, ConversationRow>();
  const epochs = new Map<string, EpochRow>(); // key `${conv}:${epoch}`
  const needConv = (id: string) => {
    const c = convs.get(id);
    if (!c) throw new Error(`memory repos: no conversation ${id}`);
    return c;
  };
  const newEpoch = (conversationId: string, epoch: number, reason: EpochRow['reason'], seedKind: EpochRow['seedKind'], taint: EpochRow['taint']): EpochRow => {
    const e: EpochRow = {
      conversationId, epoch, dekId: `e:${conversationId}:${epoch}`, reason, seedKind, handoffSummary: null, handoffMadeAt: null, taint: [...taint], inputTokensLast: 0,
      lastRequestAt: null, nextSeq: 1, startedAt: now(), closedAt: null, shreddedAt: null,
    };
    epochs.set(`${conversationId}:${epoch}`, e);
    return e;
  };
  const conversations: ConversationsRepo = {
    get: (id) => (convs.has(id) ? clone(convs.get(id)!) : undefined),
    byScopeKey: (k) => {
      for (const c of convs.values()) if (c.scopeKey === k) return clone(c);
      return undefined;
    },
    create(c) {
      for (const x of convs.values()) if (x.scopeKey === c.scopeKey) throw new Error(`UNIQUE constraint failed: conversations.scope_key (${c.scopeKey})`);
      const row: ConversationRow = { ...clone(c), id: newId('c', now()), epoch: 1, rotatePending: null, activeRunId: null, status: 'active', createdAt: now(), lastActivityAt: now() };
      convs.set(row.id, row);
      newEpoch(row.id, 1, 'initial', 'none', []);
      return clone(row);
    },
    update(id, patch) {
      convs.set(id, { ...needConv(id), ...clone(patch) });
    },
    casActiveRun(id, expected, next) {
      const c = needConv(id);
      if (c.activeRunId !== expected) return false;
      convs.set(id, { ...c, activeRunId: next });
      return true;
    },
    currentEpoch: (id) => clone(epochs.get(`${id}:${needConv(id).epoch}`)!),
    getEpoch: (id, epoch) => (epochs.has(`${id}:${epoch}`) ? clone(epochs.get(`${id}:${epoch}`)!) : undefined),
    startEpoch(id, reason, seedKind, taint) {
      const c = needConv(id);
      const prev = epochs.get(`${id}:${c.epoch}`);
      if (prev) prev.closedAt = now();
      const e = newEpoch(id, c.epoch + 1, reason, seedKind, taint);
      convs.set(id, { ...c, epoch: e.epoch });
      return clone(e);
    },
    updateEpoch(id, epoch, patch) {
      const e = epochs.get(`${id}:${epoch}`);
      if (!e) throw new Error(`memory repos: no epoch ${id}:${epoch}`);
      epochs.set(`${id}:${epoch}`, { ...e, ...clone(patch) });
    },
    /** `ms` is a cutoff instant: epochs closed at or before it and not yet shredded. */
    closedEpochsOlderThan: (ms) => [...epochs.values()].filter((e) => e.closedAt !== null && e.closedAt <= ms && e.shreddedAt === null).map((e) => ({ conversationId: e.conversationId, epoch: e.epoch })),
    listByUser: (userId, o) =>
      [...convs.values()]
        .filter((c) => c.userId === userId && (!o?.status || c.status === o.status))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .slice(0, o?.limit ?? 50)
        .map(clone),
    listByChat: (tgChatId, o) =>
      [...convs.values()]
        .filter((c) => c.tgChatId === tgChatId && (!o?.kind || c.kind === o.kind) && (!o?.status || c.status === o.status))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .slice(0, o?.limit ?? 200)
        .map(clone),
  };

  // ── messages (+ blobs)
  const msgs: MessageRow[] = [];
  const blobs = new Map<string, { mime: string; bytes: Uint8Array; ownerUserId: string | null; dek: string }>();
  const blobRefs = new Set<string>();
  let validator: Parameters<MessagesRepo['setValidator']>[0] | null = null;
  const epochRows = (c: string, e: number) => msgs.filter((m) => m.conversationId === c && m.epoch === e).sort((a, b) => a.seq - b.seq);
  const messages: MessagesRepo = {
    append(conversationId, epoch, rows) {
      const e = epochs.get(`${conversationId}:${epoch}`);
      if (!e) throw new Error(`memory repos: no epoch ${conversationId}:${epoch}`);
      if (e.shreddedAt !== null) throw new Error(`memory repos: epoch ${conversationId}:${epoch} is shredded`);
      validator?.(epochRows(conversationId, epoch).map(clone), rows.map((r) => ({ role: r.role, kind: r.kind, content: clone(r.content) })));
      const seqs: number[] = [];
      for (const r of rows) {
        const seq = e.nextSeq++;
        msgs.push({ conversationId, epoch, seq, role: r.role, kind: r.kind, content: clone(r.content), runId: r.runId ?? null, stopReason: r.stopReason ?? null, hasClientToolUse: r.hasClientToolUse ?? false, createdAt: now() });
        seqs.push(seq);
      }
      return seqs;
    },
    load: (c, e) => epochRows(c, e).map(clone),
    last: (c, e) => {
      const rows = epochRows(c, e);
      return rows.length ? clone(rows[rows.length - 1]!) : undefined;
    },
    setValidator(v) {
      validator = v;
    },
    putBlob(b) {
      const id = newId('b', now());
      blobs.set(id, { mime: b.mime, bytes: new Uint8Array(b.bytes), ownerUserId: b.ownerUserId, dek: b.dek });
      return id;
    },
    getBlob: (id) => {
      const b = blobs.get(id);
      return b ? { mime: b.mime, bytes: new Uint8Array(b.bytes) } : undefined;
    },
    refBlobs(conversationId, epoch, ids) {
      for (const id of ids) blobRefs.add(`${id}|${conversationId}|${epoch}`);
    },
  };

  // ── inputs (+ conv_events)
  const inputs: InputRow[] = [];
  const events: Array<{ id: string; conversationId: string; text: string; createdAt: number; deliveredRunId: string | null }> = [];
  const inputsRepo: InputsRepo = {
    add(i) {
      if (i.tgUpdateId !== null && i.tgUpdateId !== undefined) {
        const dup = inputs.find((x) => x.conversationId === i.conversationId && x.tgUpdateId === i.tgUpdateId && x.untrusted === i.untrusted);
        if (dup) return dup.id;
      }
      const row: InputRow = { ...clone(i), tgUpdateId: i.tgUpdateId ?? null, id: newId('in', now()), createdAt: now(), consumedRunId: null, consumedEpoch: null };
      inputs.push(row);
      return row.id;
    },
    pending: (c) => inputs.filter((i) => i.conversationId === c && i.consumedRunId === null).sort((a, b) => a.createdAt - b.createdAt).map(clone),
    markConsumed(ids, runId, epoch) {
      for (const i of inputs) if (ids.includes(i.id)) {
        i.consumedRunId = runId;
        i.consumedEpoch = epoch;
      }
    },
    ownerAuthoredSince: (c, since) => inputs.filter((i) => i.conversationId === c && i.author === 'owner' && !i.untrusted && i.createdAt > since).map(clone),
    deleteConsumedInEpoch(c, epoch) {
      let n = 0;
      for (let k = inputs.length - 1; k >= 0; k--) if (inputs[k]!.conversationId === c && inputs[k]!.consumedEpoch === epoch) {
        inputs.splice(k, 1);
        n++;
      }
      return n;
    },
    addEvent(conversationId, text) {
      events.push({ id: newId('ev', now()), conversationId, text, createdAt: now(), deliveredRunId: null });
    },
    takeEvents(conversationId, runId) {
      const out: string[] = [];
      for (const e of events) if (e.conversationId === conversationId && e.deliveredRunId === null) {
        e.deliveredRunId = runId;
        out.push(e.text);
      }
      return out;
    },
    get: (id) => {
      const i = inputs.find((x) => x.id === id);
      return i ? clone(i) : undefined;
    },
    byTgMessage: (c, chatId, messageId) => {
      const i = inputs.find((x) => x.conversationId === c && x.tgChatId === chatId && x.tgMessageId === messageId);
      return i ? clone(i) : undefined;
    },
    replaceUnconsumed(id, content) {
      const i = inputs.find((x) => x.id === id);
      if (!i || i.consumedRunId !== null) return false;
      i.content = clone(content);
      return true;
    },
    delete(id) {
      const k = inputs.findIndex((x) => x.id === id);
      if (k >= 0) inputs.splice(k, 1);
    },
    consumedBy: (runId) => inputs.filter((i) => i.consumedRunId === runId).sort((a, b) => a.createdAt - b.createdAt).map(clone),
  };

  // ── runs (+ waits, tool_calls, llm_calls, memory uses)
  const runs = new Map<string, RunRow>();
  const waits = new Set<string>(); // `${runId}|${token}`
  const toolCalls = new Map<string, ToolCallRow>();
  const llmCalls: Array<LlmCallRecord & { createdAt: number }> = [];
  const memUses = new Map<string, { runId: string; factId: string; rank: number }>();
  const needRun = (id: string) => {
    const r = runs.get(id);
    if (!r) throw new Error(`memory repos: no run ${id}`);
    return r;
  };
  const runsRepo: RunsRepo = {
    create(r) {
      const row: RunRow = {
        id: newId('run', now()), conversationId: r.conversationId, userId: r.userId, epoch: r.epoch, trigger: r.trigger, triggerRef: r.triggerRef, state: 'queued', priority: r.priority ?? 'interactive',
        phase: 'start', channel: r.channel, replyRef: clone(r.replyRef), draftId: null, wakeOn: [], wakeAt: null, notBefore: r.notBefore ?? null, turns: 0, continuations: 0,
        maxTokens: r.maxTokens, retries: 0, taint: [...(r.taint ?? [])], costMicros: 0, error: null, leaseUntil: null, createdAt: now(), visibleText: null, stopCategory: null,
      };
      runs.set(row.id, row);
      return clone(row);
    },
    get: (id) => (runs.has(id) ? clone(runs.get(id)!) : undefined),
    claim(id, leaseMs) {
      const r = runs.get(id);
      if (!r) return undefined;
      const t = now();
      const claimable = r.state === 'queued' || (r.state === 'retry_wait' && (r.notBefore ?? 0) <= t) || (r.state === 'running' && (r.leaseUntil ?? 0) < t);
      if (!claimable) return undefined;
      const next: RunRow = { ...r, state: 'running', leaseUntil: t + leaseMs };
      runs.set(id, next);
      return clone(next);
    },
    renewLease(id, leaseMs) {
      const r = needRun(id);
      runs.set(id, { ...r, leaseUntil: now() + leaseMs });
    },
    update(id, patch) {
      runs.set(id, { ...needRun(id), ...clone(patch) });
    },
    park(id, wakeOn, wakeAt) {
      runs.set(id, { ...needRun(id), state: 'parked', wakeOn: [...wakeOn], wakeAt, leaseUntil: null });
      for (const t of wakeOn) waits.add(`${id}|${t}`);
    },
    byWaitToken: (token) => [...runs.values()].filter((r) => r.state === 'parked' && waits.has(`${r.id}|${token}`)).map(clone),
    clearWaits(id) {
      for (const w of [...waits]) if (w.startsWith(`${id}|`)) waits.delete(w);
    },
    recoverable: (t) =>
      [...runs.values()]
        .filter((r) => (r.state === 'running' && (r.leaseUntil ?? 0) < t) || r.state === 'queued' || (r.state === 'retry_wait' && (r.notBefore ?? 0) <= t))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone),
    byDraft: (chatId, threadId, draftId) =>
      [...runs.values()]
        .filter((r) => (r.state === 'queued' || r.state === 'retry_wait') && r.draftId === draftId && r.replyRef.chatId === chatId && (r.replyRef.threadId ?? 0) === threadId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone),
    stageToolCalls(rows) {
      for (const r of rows) {
        if (toolCalls.has(r.toolUseId)) continue;
        toolCalls.set(r.toolUseId, { ...clone(r), actionClass: null, risk: null, decision: null, ruleId: null, status: 'staged', pendingActionId: null, result: null, isError: false });
      }
    },
    updateToolCall(toolUseId, patch) {
      const tc = toolCalls.get(toolUseId);
      if (!tc) throw new Error(`memory repos: no tool call ${toolUseId}`);
      toolCalls.set(toolUseId, { ...tc, ...clone(patch) });
    },
    toolCallsFor: (runId, assistantSeq) =>
      [...toolCalls.values()]
        .filter((t) => t.runId === runId && (assistantSeq === undefined || t.assistantSeq === assistantSeq))
        .sort((a, b) => a.assistantSeq - b.assistantSeq || a.ordinal - b.ordinal)
        .map(clone),
    recordLlmCall(c) {
      llmCalls.push({ ...clone(c), createdAt: now() });
    },
    recordMemoryUses(runId, factIds) {
      factIds.forEach((factId, i) => {
        if (!memUses.has(`${runId}|${factId}`)) memUses.set(`${runId}|${factId}`, { runId, factId, rank: i + 1 });
      });
    },
    memoryUses: (runId) => [...memUses.values()].filter((m) => m.runId === runId).sort((a, b) => a.rank - b.rank).map((m) => ({ factId: m.factId, rank: m.rank })),
    llmCallsFor: (runId) =>
      llmCalls
        .filter((c) => c.runId === runId)
        .map((c) => ({ purpose: c.purpose, modelRequested: c.modelRequested, modelServed: c.modelServed, servedByFallback: c.servedByFallback, stopReason: c.stopReason, refusalCategory: c.refusalCategory, createdAt: c.createdAt })),
    conversationsUsingFact: (factId) =>
      [...memUses.values()]
        .filter((m) => m.factId === factId && runs.has(m.runId))
        .map((m) => {
          const r = runs.get(m.runId)!;
          return { runId: r.id, conversationId: r.conversationId, epoch: r.epoch };
        }),
  };

  return { users: usersRepo, conversations, messages, inputs: inputsRepo, runs: runsRepo, kv: createMemoryKv() };
}

export function createFakeLedger(clock: Clock): Ledger & { entries: Array<LedgerEntry & { seq: number; ts: number }> } {
  const entries: Array<LedgerEntry & { seq: number; ts: number }> = [];
  return {
    entries,
    append(e) {
      const seq = entries.filter((x) => x.userId === e.userId).length + 1;
      entries.push({ ...e, seq, ts: clock.now() });
      return seq;
    },
    list(userId, q) {
      return entries.filter((x) => x.userId === userId && (!q.kinds || q.kinds.includes(x.kind))).slice(-q.limit).reverse();
    },
    verify: () => ({ ok: true }),
  };
}

export interface FakeQuotas extends QuotaService {
  used: Map<string, number>;
  limits: Partial<Record<QuotaKind, number>>;
  usage: Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; costMicros: number }>;
  refusals: Map<string, number>;
  cooldowns: Map<string, number>;
  counters: Map<'mission' | 'watcher', (userId: string) => number>;
}
/** No day boundary: counters accumulate until the test resets them. `mission`/`watcher` checks use the registered counters. */
export function createFakeQuotas(clock: Clock): FakeQuotas {
  const used = new Map<string, number>();
  const limits: Partial<Record<QuotaKind, number>> = {};
  const usage: FakeQuotas['usage'] = new Map();
  const refusals = new Map<string, number>();
  const cooldowns = new Map<string, number>();
  const counters: FakeQuotas['counters'] = new Map();
  const kinds: QuotaKind[] = ['turn', 'web_search', 'stt_seconds', 'file', 'guest_answer', 'mission', 'watcher', 'cost_micros', 'browser'];
  const usedOf = (userId: string, k: QuotaKind) => {
    const c = k === 'mission' || k === 'watcher' ? counters.get(k) : undefined;
    return c ? c(userId) : (used.get(`${userId}:${k}`) ?? 0);
  };
  return {
    used, limits, usage, refusals, cooldowns, counters,
    check(userId, k, amount = 1) {
      const u = usedOf(userId, k);
      const limit = limits[k] ?? Number.MAX_SAFE_INTEGER;
      return { ok: u + amount <= limit, used: u, limit, resetsAt: clock.now() + 86_400_000 };
    },
    consume(userId, k, amount = 1) {
      used.set(`${userId}:${k}`, (used.get(`${userId}:${k}`) ?? 0) + amount);
    },
    view: (userId) => Object.fromEntries(kinds.map((k) => [k, { used: usedOf(userId, k), limit: limits[k] ?? Number.MAX_SAFE_INTEGER }])) as ReturnType<QuotaService['view']>,
    rate: () => true,
    recordUsage(userId, u) {
      const cur = usage.get(userId) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 0 };
      usage.set(userId, { inputTokens: cur.inputTokens + u.inputTokens, outputTokens: cur.outputTokens + u.outputTokens, cacheReadTokens: cur.cacheReadTokens + u.cacheReadTokens, costMicros: cur.costMicros + u.costMicros });
      used.set(`${userId}:cost_micros`, (used.get(`${userId}:cost_micros`) ?? 0) + u.costMicros);
    },
    recordRefusal(userId) {
      const today = (refusals.get(userId) ?? 0) + 1;
      refusals.set(userId, today);
      if (today > 5) cooldowns.set(userId, clock.now() + 3_600_000);
      return { today, cooldownUntil: cooldowns.get(userId) ?? null };
    },
    cooldownUntil(userId) {
      const c = cooldowns.get(userId);
      return c !== undefined && c > clock.now() ? c : null;
    },
    registerCounter(k, fn) {
      if (counters.has(k)) throw new Error(`quota counter already registered: ${k}`);
      counters.set(k, fn);
    },
  };
}

export function createFakePrivacy(): PrivacyService {
  return {
    exportUser: async () => new TextEncoder().encode('{}'),
    deleteUser: async () => {},
    shredEpoch: async () => {},
    shredConversation: async () => {},
    retentionSweep: async () => {},
  };
}

// ───────────────────────── scheduler fake (in-memory, deterministic)

export function createFakeScheduler(clockOf: () => Clock): Scheduler & { jobs: Map<string, JobRow & { dedupeKey?: string; status: string }>; ran: JobRow[]; kinds(): JobKind[] } {
  const jobs = new Map<string, JobRow & { dedupeKey?: string; status: string }>();
  const handlers = new Map<JobKind, JobHandler>();
  const ran: JobRow[] = [];
  let seq = 0;
  let lastTickAt: number | null = null;
  return {
    kinds: () => [...handlers.keys()],
    health: () => ({ lastTickAt }),
    jobs,
    ran,
    schedule(j) {
      const existing = j.dedupeKey ? [...jobs.values()].find((x) => x.dedupeKey === j.dedupeKey && x.status === 'scheduled') : undefined;
      const id = existing?.id ?? `job_${++seq}`;
      jobs.set(id, { id, kind: j.kind, runAt: j.runAt, userId: j.userId ?? null, refId: j.refId ?? null, cron: j.cron ?? null, tz: j.tz ?? null, payload: j.payload ?? {}, attempts: 0, maxAttempts: j.maxAttempts ?? 5, status: 'scheduled', ...(j.dedupeKey ? { dedupeKey: j.dedupeKey } : {}) });
      return id;
    },
    cancel(idOrKey) {
      for (const j of jobs.values()) if (j.id === idOrKey || j.dedupeKey === idOrKey) j.status = 'cancelled';
    },
    register(kind, h) {
      if (handlers.has(kind)) throw new Error(`job handler already registered: ${kind}`);
      handlers.set(kind, h);
    },
    start() {},
    async stop() {},
    list(q) {
      return [...jobs.values()]
        .filter((j) => j.status === 'scheduled' && j.userId === q.userId && (!q.kinds || q.kinds.includes(j.kind)))
        .sort((a, b) => a.runAt - b.runAt)
        .slice(0, q.limit)
        .map((j) => ({ id: j.id, kind: j.kind, runAt: j.runAt, refId: j.refId, cron: j.cron, tz: j.tz }));
    },
    async tick() {
      const now = clockOf().now();
      const due = [...jobs.values()].filter((j) => j.status === 'scheduled' && j.runAt <= now).sort((a, b) => a.runAt - b.runAt);
      for (const j of due) {
        const h = handlers.get(j.kind);
        if (!h) continue;
        j.attempts++;
        ran.push({ ...j });
        const r = await h(j, { now, signal: new AbortController().signal });
        if (r.status === 'reschedule') j.runAt = r.runAt;
        else if (r.status === 'retry') j.runAt = now + 30_000;
        else j.status = r.status === 'done' ? 'done' : 'dead';
      }
      lastTickAt = clockOf().now();
      return due.length;
    },
  };
}

// ───────────────────────── LLM governance / transport fakes

export function createFakeGovernance(): LlmGovernance & { governor: FakeRateGovernor; budget: FakeLlmBudget } {
  return { governor: new FakeRateGovernor(), budget: new FakeLlmBudget() };
}

/** A transport that refuses to run: tests must inject a ScriptedTransport. */
export function createRefusingTransport(): LlmTransport {
  const no = async (): Promise<never> => {
    throw new NotBuiltError('fake', 'transport (inject a ScriptedTransport)');
  };
  return { mode: 'demo', stream: no, create: no, parse: async () => ({ parsed: null, stopReason: 'no_transport', usage: { ...ZERO_USAGE }, requestId: null }), files: { upload: no, download: no, delete: no } };
}

// ───────────────────────── module fakes

export interface FakeRunner extends AgentRunner {
  kicks: string[];
  kickOpts: Array<{ conversationId: string; replyRef?: RunRow['replyRef'] }>;
  events: Array<{ conversationId: string; type: string; priority?: string }>;
  wakes: string[];
  rotations: Array<{ conversationId: string; reason: string; excludeTexts: string[] }>;
}
export function createFakeRunner(): FakeRunner {
  const kicks: string[] = [];
  const kickOpts: FakeRunner['kickOpts'] = [];
  const events: FakeRunner['events'] = [];
  const wakes: string[] = [];
  const rotations: FakeRunner['rotations'] = [];
  let seq = 0;
  return {
    kicks,
    kickOpts,
    events,
    wakes,
    rotations,
    kick: (id, o) => {
      kicks.push(id);
      kickOpts.push({ conversationId: id, ...(o?.replyRef ? { replyRef: o.replyRef } : {}) });
    },
    startEventRun(conversationId, ev, o) {
      events.push({ conversationId, type: ev.type, ...(o.priority ? { priority: o.priority } : {}) });
      return `run_fake_${++seq}`;
    },
    requestRotation(conversationId, reason, o) {
      rotations.push({ conversationId, reason, excludeTexts: [...(o?.excludeTexts ?? [])] });
    },
    wake: async (token) => {
      wakes.push(token);
      return 0;
    },
    stopByDraft: async () => false,
    stopRun: async () => false,
    recover: async () => {},
    idle: async () => {},
    shutdown: async () => {},
  };
}

/** A no-op IntegrationService (nothing connected). `provider` echoes the one given (kept across testApp.restart()). */
export function createFakeIntegrations(publicUrl: string, provider: IntegrationProvider | null = null): IntegrationService & { connectCards: Array<{ userId: string; kind: string; chatId: number; threadId?: number; reason?: string }> } {
  const connectCards: Array<{ userId: string; kind: string; chatId: number; threadId?: number; reason?: string }> = [];
  return {
    provider,
    connectCards,
    devConnect: async (state) => new Response(`Connected (fake, ${state})`, { status: 200 }),
    sendConnectCard: async (userId, kind, chat, reason) => {
      connectCards.push({ userId, kind, chatId: chat.chatId, ...(chat.threadId !== undefined ? { threadId: chat.threadId } : {}), ...(reason !== undefined ? { reason } : {}) });
    },
    status: () => ({ gmail: { connected: false, level: 'none' }, gcal: { connected: false, level: 'none' } }),
    startConnect: async (_u, kind) => ({ url: `${publicUrl}/dev/fake-connect?state=fake_${kind}` }),
    oauthCallback: async () => new Response('Connected (fake)', { status: 200 }),
    mail: () => null,
    calendar: () => null,
    revoke: async () => {},
  };
}

// ── Telegram module fake: a real grammY Bot over the FakeTelegram transformer, minimal gateway parts.

export function createFakeOutbox(api: () => Bot['api']): Outbox & { queued: OutboxRequest[]; sent: Array<{ req: OutboxRequest; refs: SentRef[] }> } {
  const queued: OutboxRequest[] = [];
  const sent: Array<{ req: OutboxRequest; refs: SentRef[] }> = [];
  const seen = new Set<string>();
  const hooks = new Map<string, Array<(refId: string, s: SentRef[]) => void>>();
  const send = async (r: OutboxRequest): Promise<SentRef[]> => {
    const payload: Record<string, unknown> = { chat_id: r.chatId, ...(r.threadId ? { message_thread_id: r.threadId } : {}), ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}), ...(r.disableNotification ? { disable_notification: true } : {}), ...r.payload };
    if (r.markdown !== undefined && r.method === 'sendRichMessage' && !payload['rich_message']) payload['rich_message'] = { markdown: r.markdown, skip_entity_detection: true };
    const raw = api().raw as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const res = (await raw[r.method]!(payload)) as { message_id?: number } | true;
    const refs: SentRef[] = typeof res === 'object' && res && typeof res.message_id === 'number' ? [{ chatId: r.chatId, messageId: res.message_id, kind: r.method === 'sendRichMessage' ? 'rich' : 'plain' }] : [];
    sent.push({ req: r, refs });
    if (r.refKind && r.refId) for (const h of hooks.get(r.refKind) ?? []) h(r.refId, refs);
    return refs;
  };
  return {
    queued,
    sent,
    enqueue(r) {
      if (!seen.has(r.idempotencyKey)) {
        seen.add(r.idempotencyKey);
        queued.push(r);
      }
      return r.idempotencyKey;
    },
    sendNow: (r) => {
      seen.add(r.idempotencyKey);
      return send(r);
    },
    onSent(kind, hook) {
      hooks.set(kind, [...(hooks.get(kind) ?? []), hook]);
    },
    start() {},
    async stop() {},
    async flush() {
      let n = 0;
      while (queued.length) {
        await send(queued.shift()!);
        n++;
      }
      return n;
    },
  };
}

export function createFakeRenderer(api: () => Bot['api']): Renderer {
  const escape = (t: string) => t.replace(/([\\`*_[\]<>|~=$#])/g, '\\$1');
  return {
    sanitize: (md) => md.replace(/<tg-button[\s\S]*?<\/tg-button>/g, '').replace(/🔐/g, '🔒'),
    hygiene: (md) => md,
    split: (md) => [md],
    toEntities: (md) => [{ text: md, entities: [] }],
    card(spec) {
      const lines = [`${spec.icon} **${escape(spec.title)}**`, ...(spec.rows ?? []).map(([k, v]) => `${escape(k)}: ${escape(v)}`), ...(spec.lines ?? []), ...(spec.warnings ?? []).map((w) => `⚠ ${escape(w)}`)];
      if (spec.body) lines.push(`<details><summary>${escape(spec.body.label)}</summary>\n\n\`\`\`\n${spec.body.text.replace(/```/g, 'ˋˋˋ')}\n\`\`\`\n</details>`);
      if (spec.footerMarkdown) lines.push(spec.footerMarkdown);
      return { markdown: lines.join('\n'), replyMarkup: { inline_keyboard: spec.buttons } };
    },
    escape,
    tgTime: (unix, format, text) => `<tg-time unix="${unix}" format="${format}">${text}</tg-time>`,
    async sendMarkdown(t, md, o) {
      const m = await api().sendRichMessage(t.chatId, { markdown: md, skip_entity_detection: true }, { ...(t.threadId ? { message_thread_id: t.threadId } : {}), ...(o?.replyMarkup ? { reply_markup: o.replyMarkup } : {}), ...(o?.silent ? { disable_notification: true } : {}) });
      return [{ chatId: t.chatId, messageId: m.message_id, kind: 'rich' }];
    },
  };
}

/** Unauthenticated codec for boot tests only: 'kind:part:part|owner'. The real HMAC codec is WP2's. */
export function createFakeCodec(): CallbackCodec {
  return {
    encode(kind, parts, owner) {
      const s = `${kind}:${parts.join(':')}|${owner}`;
      if (Buffer.byteLength(s) > 64) throw new Error('callback_data > 64 bytes');
      return s;
    },
    decode(data, fromTgId) {
      const m = /^([a-z0-9]{2}):(.*)\|(\d+)$/.exec(data);
      if (!m) return { error: 'malformed' };
      const owner = Number(m[3]);
      if (owner !== 0 && owner !== fromTgId) return { error: 'not_owner' };
      return { kind: m[1] as CallbackKind, parts: m[2] ? m[2].split(':') : [] };
    },
  };
}

export function createMemoryLinks(): TgLinks & { rows: TgLinkRow[] } {
  const rows: TgLinkRow[] = [];
  return {
    rows,
    record(l) {
      const row: TgLinkRow = { space: 'bot', userId: null, conversationId: null, epoch: null, seq: null, runId: null, pendingActionId: null, nudgeId: null, jobId: null, ...l, part: l.part ?? 0 };
      const i = rows.findIndex((r) => r.space === row.space && r.chatId === row.chatId && r.messageId === row.messageId);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    },
    lookup: (chatId, messageId, space = 'bot') => rows.find((r) => r.chatId === chatId && r.messageId === messageId && r.space === space),
    byRun: (runId) => rows.filter((r) => r.runId === runId).sort((a, b) => a.part - b.part),
  };
}

export async function createFakeTelegramModule(s: Services, o: TelegramModuleOptions): Promise<TelegramModule> {
  const bot = new Bot(s.config.telegram.token ?? TEST_TOKEN, { botInfo: o.botInfo ?? TEST_BOT_INFO });
  for (const t of o.transformers ?? []) bot.api.config.use(t);
  const api = () => bot.api;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const files: TelegramFiles = {
    async download(fileId, maxBytes) {
      const f = await bot.api.getFile(fileId);
      if ((f.file_size ?? 0) > maxBytes) throw new Error('file too large');
      const res = await fetchImpl(`${s.config.telegram.apiRoot}/file/bot${bot.token}/${f.file_path}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, size: bytes.length, ext: (f.file_path ?? '').split('.').pop() ?? '' };
    },
  };
  const topics: TopicManager = { ensureFixed: async () => null, createMission: async () => null, setStatus: async () => {}, onUserTopicCreated() {}, kindOf: () => null, lookup: () => null };
  const info = o.botInfo ?? TEST_BOT_INFO;
  const outbox = createFakeOutbox(api);
  // Factory-time onSent registrations buffered by app.ts's pre-gateway are installed before anything can send.
  const installed = new Set<object>();
  const installSentHooks = () => {
    for (const h of o.sentHooks ?? []) if (!installed.has(h)) {
      installed.add(h);
      outbox.onSent(h.refKind, h.hook);
    }
  };
  installSentHooks();
  const origStart = outbox.start.bind(outbox);
  outbox.start = () => {
    installSentHooks();
    origStart();
  };
  const gateway = {
    api: bot.api,
    botInfo: info,
    flags: { topics: info.has_topics_enabled, guest: !!info.supports_guest_queries, business: info.can_connect_to_business, mainWebApp: info.has_main_web_app, usersCanCreateTopics: info.allows_users_to_create_topics },
    outbox,
    files,
    topics,
    render: createFakeRenderer(api),
    codec: createFakeCodec(),
    callbacks: o.callbacks ?? createCallbackRegistry(),
    links: createMemoryLinks(),
  };
  const handle = webhookCallback(bot, 'std/http', { secretToken: s.config.telegram.webhookSecret });
  return {
    gateway,
    bot,
    channels: createRecordingChannelFactory(),
    webhookHandler: (req) => handle(req),
    startIngress: async () => {},
    stopIngress: async () => {},
    dispatcher: { start() {}, stop: async () => {}, drain: async () => {}, lagMs: () => 0 },
  };
}

export function createFakeHttpApp(s: Services, tg: TelegramModule): Hono {
  const app = new Hono();
  // Same inputs as WP8's real /healthz (01 §12): db ok, last scheduler tick, inbox lag.
  app.get('/healthz', (c) => c.json({ ok: true, fake: true, profile: s.profile.id, lastTickAt: s.scheduler.health().lastTickAt, inboxLagMs: tg.dispatcher.lagMs() }));
  app.post('/tg/webhook', (c) => tg.webhookHandler(c.req.raw));
  return app;
}

// ───────────────────────── trust fakes (WP4 contracts)

/**
 * Tag neutralization + wrapper markup, with an optional guard: ≥0.9 replaces the whole text (one chunk), ≥0.5 marks it
 * suspicious (03 R5). No redaction beyond a trivial OTP rule — the real §11.6 table is WP4's.
 */
export function createFakeUntrusted(guard?: GuardCapability): UntrustedWrapper & { calls: Array<{ source: string; label: string }> } {
  const calls: Array<{ source: string; label: string }> = [];
  const redact = (t: string) => t.replace(/\b(code|otp|код)(\W{0,3})\d{4,8}\b/gi, '$1$2[code removed]');
  return {
    calls,
    redact,
    async wrap(p) {
      calls.push({ source: p.source, label: p.label });
      let body = neutralizeReservedTags(redact(p.text));
      const score = guard ? await guard.score(body) : null;
      let removedChunks = 0;
      if (score !== null && score >= 0.9) {
        body = '[removed: likely prompt injection]';
        removedChunks = 1;
      }
      const suspicious = score !== null && score >= 0.5;
      return { text: `<untrusted source="${escapeAttr(p.source)}" label="${escapeAttr(p.label)}"${suspicious ? ' suspicious="true"' : ''}>${body}</untrusted>`, suspicious, removedChunks };
    },
  };
}

export function createMemoryTrustedTargets(clock: Clock): TrustedTargetService & { rows: Map<string, { userId: string; hmac: string; kind: 'email' | 'gcal_attendee' | 'tg_chat' | 'biz_chat'; value: string; source: 'user_message' | 'memory' | 'approved_action' | 'miniapp' | 'business_chat'; createdAt: number }> } {
  const rows = new Map<string, { userId: string; hmac: string; kind: 'email' | 'gcal_attendee' | 'tg_chat' | 'biz_chat'; value: string; source: 'user_message' | 'memory' | 'approved_action' | 'miniapp' | 'business_chat'; createdAt: number }>();
  const hmacOf = (kind: string, value: string) => createHmac('sha256', 'fake-target').update(`${kind}:${value.trim().toLowerCase()}`).digest('hex');
  return {
    rows,
    list: (userId) => [...rows.values()].filter((r) => r.userId === userId).map(({ hmac, kind, value, source, createdAt }) => ({ hmac, kind, value, source, createdAt })),
    add(userId, t) {
      const hmac = hmacOf(t.kind, t.value);
      if (!rows.has(`${userId}|${hmac}`)) rows.set(`${userId}|${hmac}`, { userId, hmac, kind: t.kind, value: t.value, source: t.source, createdAt: clock.now() });
    },
    remove: (userId, hmac) => rows.delete(`${userId}|${hmac}`),
    isTrusted: (userId, kind, value) => rows.has(`${userId}|${hmacOf(kind, value)}`),
  };
}

// ───────────────────────── agent fakes (WP3 contracts)

/** conversation_toolkits + conversation_turns in memory (03 R3). `bumpTurn` is what WP3 does when a run consumes owner input. */
export function createMemoryToolkitState(): ToolkitState & { bumpTurn(conversationId: string): number } {
  const turns = new Map<string, number>();
  const loaded = new Map<string, Map<ToolkitId, number>>();
  const userTurn = (c: string) => turns.get(c) ?? 0;
  return {
    userTurn,
    bumpTurn(c) {
      turns.set(c, userTurn(c) + 1);
      return userTurn(c);
    },
    load(c, kit) {
      const expiresAfterTurn = userTurn(c) + 6;
      const m = loaded.get(c) ?? new Map<ToolkitId, number>();
      m.set(kit, expiresAfterTurn);
      loaded.set(c, m);
      return { expiresAfterTurn };
    },
    active(c) {
      const t = userTurn(c);
      const kits = [...(loaded.get(c) ?? new Map<ToolkitId, number>()).entries()].filter(([, exp]) => exp >= t).map(([k]) => k);
      return TOOLKIT_IDS.filter((k) => k === 'core' || kits.includes(k));
    },
  };
}

// ───────────────────────── surfaces fakes (WP7 contracts)

export function createRecordingNotices(): NoticeService & { calls: Array<{ op: 'quotaExceeded' | 'askTimezone' | 'timezoneSet'; userId: string; arg: unknown }> } {
  const calls: Array<{ op: 'quotaExceeded' | 'askTimezone' | 'timezoneSet'; userId: string; arg: unknown }> = [];
  return {
    calls,
    quotaExceeded: async (userId, k, chat) => void calls.push({ op: 'quotaExceeded', userId, arg: { k, ...chat } }),
    askTimezone: async (userId, chat) => void calls.push({ op: 'askTimezone', userId, arg: { ...chat } }),
    timezoneSet: async (userId, tz, source) => void calls.push({ op: 'timezoneSet', userId, arg: { tz, source } }),
  };
}

export function createMemoryDeepLinks(clock: Clock): DeepLinkService & { rows: Map<string, { kind: string; ownerTgId: number; payload: unknown; expiresAt: number; usedAt: number | null }> } {
  const rows = new Map<string, { kind: string; ownerTgId: number; payload: unknown; expiresAt: number; usedAt: number | null }>();
  return {
    rows,
    create(kind, ownerTgId, payload, ttlMs) {
      const token = randomBytes(12).toString('base64url');
      rows.set(token, { kind, ownerTgId, payload: structuredClone(payload), expiresAt: clock.now() + ttlMs, usedAt: null });
      return token;
    },
    consume(token, kind, byTgId) {
      const r = rows.get(token);
      if (!r || r.kind !== kind) return { error: 'not_found' };
      if (r.usedAt !== null) return { error: 'used' };
      if (clock.now() > r.expiresAt) return { error: 'expired' };
      if (byTgId !== undefined && byTgId !== r.ownerTgId) return { error: 'not_owner' };
      r.usedAt = clock.now();
      return { ownerTgId: r.ownerTgId, payload: structuredClone(r.payload) };
    },
  };
}

export function createMemoryChoices(): ChoiceService & { sets: Map<string, { conversationId: string; chatId: number; options: string[]; messageId: number | null }> } {
  const sets = new Map<string, { conversationId: string; chatId: number; options: string[]; messageId: number | null }>();
  let n = 0;
  return {
    sets,
    create(p) {
      const id = `cs${++n}`;
      sets.set(id, { conversationId: p.conversationId, chatId: p.chatId, options: [...p.options], messageId: null });
      return id;
    },
    attachMessage(setId, messageId) {
      const s = sets.get(setId);
      if (s) s.messageId = messageId;
    },
  };
}

export function createMemoryGroups(): GroupService & { gens: Map<number, number>; hints: Map<number, string> } {
  const gens = new Map<number, number>();
  const hints = new Map<number, string>();
  return {
    gens,
    hints,
    memoryGen: (chatId) => gens.get(chatId) ?? 1,
    bumpMemoryGen(chatId) {
      gens.set(chatId, (gens.get(chatId) ?? 1) + 1);
      return gens.get(chatId)!;
    },
    claimPrivateHint(chatId, day) {
      if (hints.get(chatId) === day) return false;
      hints.set(chatId, day);
      return true;
    },
  };
}

export function createRecordingGuests(): GuestService & { marks: Array<{ guestQueryId: string; status: string; inlineMessageId?: string }> } {
  const marks: Array<{ guestQueryId: string; status: string; inlineMessageId?: string }> = [];
  return { marks, mark: (guestQueryId, status, inlineMessageId) => void marks.push({ guestQueryId, status, ...(inlineMessageId ? { inlineMessageId } : {}) }) };
}

// ───────────────────────── channels (WP2 contract): recording, no Telegram calls

export interface RecordingChannel extends ReplyChannel { log: Array<{ op: string; arg?: unknown }>; run: RunRow; conv: ConversationRow; flushed: string[] }
/**
 * Every channel records its calls in `log`. Text of the current model call is pending until commitIteration();
 * resetIteration() and blockStart({index:-1,type:'retry'}) drop it; blockStart busy also logs a 'status' 'busy:<s>';
 * checkpoint() flushes the visible text into `flushed`. finalize() returns one fake SentRef.
 */
export function createRecordingChannelFactory(): ChannelFactory & { channels: RecordingChannel[] } {
  const channels: RecordingChannel[] = [];
  let messageId = 900_000;
  let draft = 0;
  return {
    channels,
    forRun(run, conv, onDraft) {
      let committed = '';
      let pending = '';
      const log: RecordingChannel['log'] = [];
      const flushed: string[] = [];
      const ch: RecordingChannel = {
        kind: run.channel,
        log,
        run,
        conv,
        flushed,
        get visibleText() {
          return committed + pending;
        },
        async begin() {
          log.push({ op: 'begin' });
          if (run.channel === 'dm_stream') onDraft(++draft);
        },
        text(d) {
          pending += d;
          log.push({ op: 'text', arg: d });
        },
        status(label) {
          log.push({ op: 'status', arg: label });
        },
        resetIteration() {
          pending = '';
          log.push({ op: 'resetIteration' });
        },
        blockStart(b) {
          log.push({ op: 'blockStart', arg: { ...b } });
          if (b.index === -1 && b.type === 'retry') pending = '';
          if (b.index === -1 && b.type === 'busy') log.push({ op: 'status', arg: `busy:${b.name ?? ''}` });
        },
        commitIteration() {
          committed += pending;
          pending = '';
          log.push({ op: 'commitIteration' });
        },
        async checkpoint() {
          const t = committed + pending;
          if (t) flushed.push(t);
          committed = '';
          pending = '';
          log.push({ op: 'checkpoint', arg: t });
          if (run.channel === 'dm_stream') onDraft(++draft);
        },
        async finalize(o) {
          log.push({ op: 'finalize', arg: { text: committed + pending, footerLines: [...o.footerLines], effects: o.effects.map((e) => e.kind) } });
          return [{ chatId: run.replyRef.chatId, messageId: ++messageId, kind: 'rich' }];
        },
        async stopped() {
          log.push({ op: 'stopped', arg: committed + pending });
        },
        async fail(message, retryButton) {
          log.push({ op: 'fail', arg: { message, retryButton } });
        },
      };
      channels.push(ch);
      return ch;
    },
  };
}

// ───────────────────────── tools (WP5 / WP4 contracts)

/** The JSON Schema of a tool input, as WP5 generates it (01 §6): z.toJSONSchema without $schema, keys canonicalized. */
export function toolInputSchema(spec: ToolSpec): Record<string, unknown> {
  const js = z.toJSONSchema(spec.input) as Record<string, unknown>;
  delete js['$schema'];
  return JSON.parse(canonicalJson(js)) as Record<string, unknown>;
}

/**
 * A registry over the given specs (name-sorted definitions, sha256 hashes). Toolset membership comes from `toolsets`
 * or, by default, from each spec's surfaces: FULL = every spec, GROUP = 'group', GUEST = 'guest', BIZ = 'biz_draft'.
 * Every FULL tool is in the `core` toolkit, so subset() returns the whole toolset.
 */
export function createStaticRegistry(specs: readonly ToolSpec[], toolsets?: Partial<Record<ToolsetId, string[]>>): ToolRegistry {
  const byName = new Map<string, ToolSpec>();
  for (const sp of specs) {
    if (byName.has(sp.name)) throw new Error(`duplicate tool name: ${sp.name}`);
    byName.set(sp.name, sp);
  }
  const sorted = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const surfaceOf: Record<ToolsetId, Surface | null> = { FULL: null, GROUP: 'group', GUEST: 'guest', BIZ: 'biz_draft' };
  const defsFor = (names: ReadonlySet<string>): ToolDefinitions => {
    const definitions = sorted
      .filter((sp) => names.has(sp.name))
      .map((sp) => ({ name: sp.name, description: sp.description, input_schema: toolInputSchema(sp), ...(sp.eagerInput ? { eager_input_streaming: true } : {}) }) as unknown as BetaToolUnion);
    return { definitions, hash: createHash('sha256').update(canonicalJson(definitions)).digest('hex').slice(0, 16), names };
  };
  const cache = new Map<ToolsetId, ToolDefinitions>();
  const toolset = (id: ToolsetId): ToolDefinitions => {
    let d = cache.get(id);
    if (!d) {
      const surface = surfaceOf[id];
      const names = new Set(toolsets?.[id] ?? sorted.filter((sp) => surface === null || sp.surfaces.includes(surface)).map((sp) => sp.name));
      d = defsFor(names);
      cache.set(id, d);
    }
    return d;
  };
  return {
    get: (name) => byName.get(name),
    all: () => sorted,
    toolset,
    toolkits: () => Object.fromEntries(TOOLKIT_IDS.map((k) => [k, k === 'core' ? [...toolset('FULL').names] : []])) as unknown as ReturnType<ToolRegistry['toolkits']>,
    subset: (id) => toolset(id),
  };
}

export function createEmptyRegistry(): ToolRegistry {
  return createStaticRegistry([]);
}

const SURFACE_OF: Record<ConversationRow['kind'], Surface> = { dm: 'dm', topic: 'topic', mission: 'mission', group: 'group', guest: 'guest', biz_draft: 'biz_draft' };

/**
 * An executor with no Sentinel, approvals or redaction (a WP4 stand-in for WP3/WP5/WP6/WP7 tests): stages tool_calls when
 * the repos allow it, zod-validates, executes in tool_use order and returns results in that order. `task_wait` is not
 * executed: the round parks on its `on` tokens (§5.6) and its result is left for the wake. Unknown tool → UNKNOWN_TOOL,
 * bad input → INVALID_INPUT, a throw → TOOL_FAILED (all is_error).
 */
export function createPassThroughExecutor(s: Services): ToolExecutor & { executed: Array<{ name: string; input: unknown; idemKey: string }> } {
  const executed: Array<{ name: string; input: unknown; idemKey: string }> = [];
  const tryRepo = <T,>(f: () => T): T | undefined => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  const errResult = (id: string, body: Record<string, unknown>): BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(body), is_error: true });

  async function runOne(run: RunRow, conv: ConversationRow, use: { id: string; name: string; input: unknown }, ch: ReplyChannel | null, signal: AbortSignal, effects: Effect[], taint: Set<string>): Promise<BetaToolResultBlockParam> {
    const spec = s.registry.get(use.name);
    if (!spec) return errResult(use.id, { error: 'UNKNOWN_TOOL' });
    const parsed = spec.input.safeParse(use.input);
    if (!parsed.success) return errResult(use.id, { error: 'INVALID_INPUT', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const user = run.userId ? tryRepo(() => s.repos.users.getById(run.userId!)) : undefined;
    const pushed: Effect[] = [];
    const ctx: ToolCtx = {
      toolUseId: use.id, runId: run.id, conversationId: conv.id, epoch: run.epoch, userId: run.userId, tgUserId: user?.tgUserId ?? null,
      surface: SURFACE_OF[conv.kind],
      scope: conv.kind === 'group' && conv.tgChatId !== null ? { kind: 'group', chatId: conv.tgChatId } : run.userId ? { kind: 'user', userId: run.userId } : null,
      tz: user?.tz ?? 'UTC', lang: user?.languageCode ?? 'en', now: s.clock.now(),
      chat: {
        chatId: run.replyRef.chatId,
        ...(run.replyRef.threadId !== undefined ? { threadId: run.replyRef.threadId } : {}),
        ...(run.replyRef.triggerMessageId !== undefined ? { triggerMessageId: run.replyRef.triggerMessageId } : {}),
        ...(run.replyRef.businessConnectionId !== undefined ? { businessConnectionId: run.replyRef.businessConnectionId } : {}),
      },
      ...(run.replyRef.missionId !== undefined ? { missionId: run.replyRef.missionId } : {}),
      taint: new Set(run.taint), signal, effects: { push: (e) => void pushed.push(e) }, services: s, log: s.log, idemKey: use.id, priority: run.priority,
    };
    ch?.status(spec.statusLabel(parsed.data, ctx.lang));
    tryRepo(() => s.repos.runs.updateToolCall(use.id, { status: 'executing', actionClass: spec.classify(parsed.data, ctx).actionClass }));
    try {
      executed.push({ name: spec.name, input: parsed.data, idemKey: ctx.idemKey });
      const out = await spec.execute(parsed.data, ctx);
      effects.push(...pushed, ...(out.effects ?? []));
      if (out.untrusted) taint.add(out.untrusted.source);
      else if (spec.outputTaint) taint.add(spec.outputTaint);
      tryRepo(() => s.repos.runs.updateToolCall(use.id, { status: out.isError ? 'error' : 'done', result: out.content, isError: !!out.isError }));
      return { type: 'tool_result', tool_use_id: use.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
    } catch (e) {
      tryRepo(() => s.repos.runs.updateToolCall(use.id, { status: 'error', isError: true }));
      return errResult(use.id, { error: 'TOOL_FAILED', message: errorMessage(e) });
    } finally {
      ch?.status(null);
    }
  }

  async function round(run: RunRow, conv: ConversationRow, uses: Array<{ id: string; name: string; input: unknown }>, ch: ReplyChannel | null, signal: AbortSignal): Promise<RoundOutcome> {
    const results: BetaToolResultBlockParam[] = [];
    const effects: Effect[] = [];
    const taint = new Set<string>();
    let park: RoundOutcome['park'] = null;
    for (const use of uses) {
      if (use.name === 'task_wait') {
        const inp = (use.input ?? {}) as { on?: string[]; timeout_hours?: number };
        park = { wakeOn: [...(inp.on ?? [])], wakeAt: typeof inp.timeout_hours === 'number' ? s.clock.now() + Math.round(inp.timeout_hours * 3_600_000) : null };
        tryRepo(() => s.repos.runs.updateToolCall(use.id, { status: 'waiting' }));
        continue;
      }
      results.push(await runOne(run, conv, use, ch, signal, effects, taint));
    }
    return { results, park, taintAdded: [...taint] as RoundOutcome['taintAdded'], effects };
  }

  return {
    executed,
    async processRound(run, conv, assistantSeq, uses, ch, signal) {
      tryRepo(() =>
        s.repos.runs.stageToolCalls(uses.map((u, ordinal) => ({ toolUseId: u.id, runId: run.id, conversationId: conv.id, epoch: run.epoch, userId: run.userId, assistantSeq, ordinal, name: u.name, input: u.input }))),
      );
      return round(run, conv, uses.map((u) => ({ id: u.id, name: u.name, input: u.input })), ch, signal);
    },
    async finishInterruptedRound(run, conv, assistantSeq) {
      const calls = tryRepo(() => s.repos.runs.toolCallsFor(run.id, assistantSeq)) ?? [];
      const results: BetaToolResultBlockParam[] = [];
      const effects: Effect[] = [];
      const taint = new Set<string>();
      let park: RoundOutcome['park'] = null;
      for (const c of calls) {
        if (c.status === 'done' || c.status === 'error') results.push({ type: 'tool_result', tool_use_id: c.toolUseId, content: String(c.result ?? ''), ...(c.isError ? { is_error: true } : {}) });
        else {
          const r = await round(run, conv, [{ id: c.toolUseId, name: c.name, input: c.input }], null, new AbortController().signal);
          results.push(...r.results);
          effects.push(...r.effects);
          r.taintAdded.forEach((t) => taint.add(t));
          park = park ?? r.park;
        }
      }
      return { results, park, taintAdded: [...taint] as RoundOutcome['taintAdded'], effects };
    },
    cancelUnstarted(runId, assistantSeq) {
      const calls = tryRepo(() => s.repos.runs.toolCallsFor(runId, assistantSeq)) ?? [];
      return calls
        .filter((c) => c.status === 'staged')
        .map((c) => {
          tryRepo(() => s.repos.runs.updateToolCall(c.toolUseId, { status: 'cancelled', isError: true }));
          return { type: 'tool_result' as const, tool_use_id: c.toolUseId, content: 'Cancelled by user before execution', is_error: true };
        });
    },
    async executeApproved() {
      return { status: 'failed', summary: 'the pass-through executor has no approvals' };
    },
  };
}

// ───────────────────────── i18n (WP7 contract)

/**
 * Echoes keys so tests can assert which string was used: t('nudge_do_button','en',{x:'y'}) → 'nudge_do_button(x=y)', t('stopped','ru') → 'stopped'.
 * `calls` records every lookup (key, resolved UiLang).
 */
export function createFakeStrings(): Strings & { calls: Array<{ key: StringKey; lang: 'en' | 'ru' }> } {
  const calls: Array<{ key: StringKey; lang: 'en' | 'ru' }> = [];
  return {
    calls,
    t(key: StringKey, lang: string | null | undefined, vars?: StringVars) {
      calls.push({ key, lang: uiLang(lang) });
      if (!vars || Object.keys(vars).length === 0) return key;
      return `${key}(${Object.keys(vars).sort().map((k) => `${k}=${vars[k]}`).join(',')})`;
    },
  };
}

// ───────────────────────── the no-op factory table (createTestApp's notBuiltFallback)

export const NOOP_FACTORIES: Factories = {
  createStrings: () => createFakeStrings(),
  openKeyStore: () => createFakeKeyStore(),
  createCrypto: (ks, hashKey) => createFakeCrypto(ks, hashKey),
  createCoreRepos: (_db, _crypto, clock) => createMemoryCoreRepos(clock),
  createLedger: (s) => createFakeLedger(s.clock),
  createQuotaService: (s) => createFakeQuotas(s.clock),
  createPrivacyService: () => createFakePrivacy(),
  createLlmGovernance: () => createFakeGovernance(),
  createTransport: () => createRefusingTransport(),
  createCapabilities: (_cfg, _fetch, s) => createFakeCapabilities(() => s.clock.now()),
  createIntegrationService: (s, provider) => createFakeIntegrations(s.config.publicUrl, provider ?? null),
  createToolRegistry: (_profile, external) => createStaticRegistry(external),
  createTrustModule: (s): TrustModule => ({
    sentinel: notImplemented('sentinel'),
    approvals: notImplemented<ApprovalService>('approvals', { listPending: () => [], get: () => undefined, reshowPending: async () => 0 }),
    executor: createPassThroughExecutor(s),
    undo: notImplemented('undo'),
    stepup: notImplemented('stepup'),
    untrusted: createFakeUntrusted(),
    grants: notImplemented<GrantService>('grants', { list: () => [] }),
    trustedTargets: createMemoryTrustedTargets(s.clock),
  }),
  createMemoryService: (): MemoryService => notImplemented('memory'),
  createScheduler: (s) => createFakeScheduler(() => s.clock),
  createReminderModule: (): ReminderModule => ({ reminders: notImplemented('reminders'), todos: notImplemented('todos') }),
  createProactiveModule: (): ProactiveModule => ({ nudges: notImplemented('nudges'), brief: notImplemented('brief'), commitments: notImplemented('commitments') }),
  createMissionModule: (): MissionModule => ({ missions: notImplemented('missions'), watchers: notImplemented('watchers') }),
  createProfileService: () => createFakeProfileService(),
  createBehaviourModule: (): BehaviourModule => ({ signals: createRecordingSignals(), policy: createFakePolicy() }),
  createGroupModule: (): GroupModule => ({ participation: createRecordingGroupAgent() }),
  createBrowserModule: (): BrowserModule => ({ tasks: { active: () => null, forMission: () => null, forConversation: () => null, list: () => [] } }),
  createAgentModule: (): AgentModule => ({
    runner: createFakeRunner(),
    conversations: notImplemented('conversations'),
    side: { triage: async () => null, extract: async () => null, importFacts: async () => [], topicTitle: async () => null, semanticCheck: async () => null, structured: async () => null },
    toolkits: createMemoryToolkitState(),
  }),
  createTelegramModule: (s, o) => createFakeTelegramModule(s, o),
  createBusinessModule: (): BusinessModule => ({ business: notImplemented('business'), registerHandlers() {} }),
  createSurfaces: (s): SurfacesModule => ({
    registerHandlers() {},
    payments: notImplemented('payments'),
    notices: createRecordingNotices(),
    deepLinks: createMemoryDeepLinks(s.clock),
    choices: createMemoryChoices(),
    groups: createMemoryGroups(),
    guests: createRecordingGuests(),
  }),
  createHttpApp: (s, tg) => createFakeHttpApp(s, tg),
};

// ───────────────────────── friend-mode fakes (spec 05)

export const EMPTY_PROFILE_CARD: ProfileCard = Object.freeze({
  summary: '', people: [], goals: [], preferences: [], style: { length: null, formality: null, emoji: null, language: null, humor: null }, current_context: [], open_threads: [],
}) as ProfileCard;

/** In-memory ProfileService: `put(userId, card)` sets the latest version; consolidate() records the call and returns the current view. */
export function createFakeProfileService(nowOf: () => number = () => 0): ProfileService & { views: Map<string, ProfileView>; consolidations: Array<{ userId: string; reason: string }>; put(userId: UserId, card: Partial<ProfileCard>): ProfileView } {
  const views = new Map<string, ProfileView>();
  const consolidations: Array<{ userId: string; reason: string }> = [];
  const put = (userId: UserId, card: Partial<ProfileCard>): ProfileView => {
    const prev = views.get(userId);
    const v: ProfileView = { userId, version: (prev?.version ?? 0) + 1, card: { ...EMPTY_PROFILE_CARD, ...prev?.card, ...card }, factCount: prev?.factCount ?? 0, createdAt: nowOf() };
    views.set(userId, v);
    return v;
  };
  return {
    views, consolidations, put,
    get: (userId) => views.get(userId) ?? null,
    async consolidate(userId, o) {
      consolidations.push({ userId, reason: o.reason });
      return views.get(userId) ?? null;
    },
    edit(userId, e) {
      const v = views.get(userId);
      if (!v) return null;
      const card: ProfileCard = structuredClone(v.card);
      if (e.field === 'summary') card.summary = e.op === 'delete' ? '' : e.text;
      else {
        const list = card[e.field] as unknown[];
        if (e.op === 'delete') list.splice(e.index, 1);
        else if (e.field === 'goals' || e.field === 'preferences') (list as string[])[e.index] = e.text;
        else if (e.field === 'people') (list as ProfileCard['people'])[e.index]!.notes = e.text;
        else if (e.field === 'current_context') (list as ProfileCard['current_context'])[e.index]!.text = e.text;
        else (list as ProfileCard['open_threads'])[e.index]!.what = e.text;
      }
      return put(userId, card);
    },
    dueThreads(userId, now) {
      const v = views.get(userId);
      if (!v) return [];
      return v.card.open_threads
        .map((t, index) => ({ ...t, index }))
        .filter((t) => t.follow_up_after_local !== null && Date.parse(`${t.follow_up_after_local.length === 10 ? t.follow_up_after_local + 'T00:00' : t.follow_up_after_local}:00Z`) <= now);
    },
  };
}

/** SignalsService that records every call (`.calls`); pActive / styleHints are settable. */
export function createRecordingSignals(): SignalsService & { calls: Array<{ op: string; userId: string; arg: unknown }>; active: Map<string, number>; hints: Map<string, StyleHints> } {
  const calls: Array<{ op: string; userId: string; arg: unknown }> = [];
  const last = new Map<string, number>();
  const active = new Map<string, number>();
  const hints = new Map<string, StyleHints>();
  const rec = (op: string) => (userId: string, arg: unknown) => void calls.push({ op, userId, arg });
  return {
    calls, active, hints,
    inbound(userId, m) {
      // never keep the text (C1 stores features only); the fake records its length like the real one would
      calls.push({ op: 'inbound', userId, arg: { at: m.at, length: m.text.length, replyToTgMessageId: m.replyToTgMessageId ?? null } });
      last.set(userId, m.at);
    },
    goraSent: rec('goraSent'),
    reaction: rec('reaction'),
    feedback: rec('feedback'),
    blocked: (userId, at) => void calls.push({ op: 'blocked', userId, arg: at }),
    lastInboundAt: (userId) => last.get(userId) ?? null,
    pActive: (userId) => active.get(userId) ?? 0,
    styleHints: (userId) => hints.get(userId) ?? null,
  };
}

/** ProactivePolicy fake: never sends; `decision` and `allow` are settable; ticks are recorded. */
export function createFakePolicy(): ProactivePolicy & { ticks: number[]; decision: Omit<ProactiveDecision, 'userId'>; allow: boolean } {
  const f = {
    ticks: [] as number[],
    decision: { send: false, reason: 'fake' } as Omit<ProactiveDecision, 'userId'>,
    allow: true,
    async tick(now: number) {
      f.ticks.push(now);
      return { considered: 0, sent: 0 };
    },
    decide: (userId: string): ProactiveDecision => ({ userId, ...f.decision }),
    canSendNow: () => f.allow,
    explain: () => undefined,
  };
  return f;
}

// ───────────────────────── s07 fakes (spec 07)

/**
 * A recording GroupParticipation (mention-only by default: `readsAll` false). Set `.reads = true` to exercise the
 * surface's participant path; `.named` is the name-address regex used by `addressedByName`.
 */
export function createRecordingGroupAgent(): GroupParticipation & {
  reads: boolean; named: RegExp; observed: GroupObservedMessage[]; joins: Array<{ chatId: number; lang?: string }>;
  reactions: Array<{ chatId: number; tgMessageId: number; emoji: readonly string[] }>; botMessages: Array<{ chatId: number; tgMessageId: number; text: string }>;
  chattiness: Map<number, GroupChattiness>; purged: Array<{ chatId: number; reason: string }>; catchupText: string | null;
} {
  const policy = (chatId: number): GroupPolicyView => ({
    chatId, chattiness: fake.chattiness.get(chatId) ?? 'normal', threshold: 1,
    arms: Object.fromEntries(GROUP_CHIME_KINDS.map((k) => [k, { alpha: 1, beta: 3 }])) as GroupPolicyView['arms'],
    lastChimeAt: null, chimesToday: 0, tz: null, readsAll: fake.reads,
  });
  const fake = {
    reads: false,
    named: /^\s*(гора|gora)\b/i,
    observed: [] as GroupObservedMessage[],
    joins: [] as Array<{ chatId: number; lang?: string }>,
    reactions: [] as Array<{ chatId: number; tgMessageId: number; emoji: readonly string[] }>,
    botMessages: [] as Array<{ chatId: number; tgMessageId: number; text: string }>,
    chattiness: new Map<number, GroupChattiness>(),
    purged: [] as Array<{ chatId: number; reason: string }>,
    catchupText: null as string | null,
    readsAll: () => fake.reads,
    onJoin: async (chatId: number, o: { lang?: string }) => void fake.joins.push({ chatId, ...(o.lang ? { lang: o.lang } : {}) }),
    observe: async (m: GroupObservedMessage) => void fake.observed.push(m),
    edits: [] as Array<{ chatId: number; tgMessageId: number; text: string }>,
    onEdited: async (p: { chatId: number; tgMessageId: number; text: string }) => void fake.edits.push({ chatId: p.chatId, tgMessageId: p.tgMessageId, text: p.text }),
    onReaction: (p: { chatId: number; tgMessageId: number; emoji: readonly string[] }) => void fake.reactions.push({ chatId: p.chatId, tgMessageId: p.tgMessageId, emoji: p.emoji }),
    onBotMessage: (p: { chatId: number; tgMessageId: number; text: string }) => void fake.botMessages.push({ chatId: p.chatId, tgMessageId: p.tgMessageId, text: p.text }),
    setChattiness: (chatId: number, level: GroupChattiness) => {
      fake.chattiness.set(chatId, level);
      return level;
    },
    addressedByName: (text: string) => fake.named.test(text),
    chattinessFromWords: () => null,
    catchup: async () => fake.catchupText,
    policy,
    purge: async (chatId: number, reason: 'forget' | 'left') => void fake.purged.push({ chatId, reason }),
    recentContext: (): string | null => null,
  };
  return fake;
}
