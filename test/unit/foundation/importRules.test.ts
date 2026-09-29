// Enforces the 01 §4.2 coding rules and the 03 R1 groq-sdk rule by grep over src/ (WP0).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface SrcFile { path: string; raw: string; code: string }
interface Violation { rule: string; path: string; line: number; text: string }

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mts)$/.test(e)) out.push(p);
  }
  return out;
}

/** Removes comments but keeps strings (SQL and import specifiers live in strings). Line structure is preserved. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && n === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]$|^$|\breturn$|\btypeof$/.test(out.replace(/\s+$/, ''))) {
        // regex literal: copy verbatim up to the closing unescaped '/' (character classes may contain '/')
        let j = i + 1;
        let inClass = false;
        while (j < src.length && src[j] !== '\n') {
          const d = src[j]!;
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
        out += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') mode = c;
      out += c;
      i++;
    } else if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      i++;
    } else if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i++;
    } else {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === mode) mode = 'code';
      i++;
    }
  }
  return out;
}

function load(dir = join(ROOT, 'src')): SrcFile[] {
  return walk(dir).map((abs) => {
    const raw = readFileSync(abs, 'utf8');
    return { path: relative(ROOT, abs).split(sep).join('/'), raw, code: stripComments(raw) };
  });
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
function grep(files: SrcFile[], rule: string, re: RegExp, allowed: (p: string) => boolean, field: 'code' | 'raw' = 'code'): Violation[] {
  const v: Violation[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const f of files) {
    if (allowed(f.path)) continue;
    for (const m of f[field].matchAll(g)) v.push({ rule, path: f.path, line: lineOf(f[field], m.index ?? 0), text: m[0].slice(0, 80) });
  }
  return v;
}
const only = (...ps: string[]) => (p: string) => ps.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
const none = () => false;

/** Runtime (non-type-only) imports / re-exports / dynamic imports / requires of a module (optionally any subpath). */
function runtimeImportRe(mod: string): RegExp {
  const m = mod.replace(/[/.@-]/g, (c) => `\\${c}`);
  const spec = `['"]${m}(?:\\/[^'"]*)?['"]`;
  return new RegExp(`(?:^|\\n)\\s*(?:import\\s+(?!type\\b)[^;]*?from\\s*${spec}|import\\s*${spec}|export\\s+(?!type\\b)[^;]*?from\\s*${spec})|import\\(\\s*${spec}|require\\(\\s*${spec}`);
}

// table → the directories/files allowed to write SQL against it (01 §7.2 + 03 R7)
const WP1 = ['src/db/repos/', 'src/db/keystore.ts', 'src/db/crypto.ts', 'src/ledger/', 'src/billing/', 'src/privacy/'];
const OWNERS: Record<string, string[]> = {};
const own = (dirs: string[], tables: string) => tables.split(/\s+/).filter(Boolean).forEach((t) => (OWNERS[t] = dirs));
own([...WP1, 'src/db/migrate.ts'], 'schema_migrations');
own(WP1, 'kv users user_settings consents permissions conversations epochs shred_tokens messages blobs blob_refs conversation_inputs conv_events runs run_waits tool_calls llm_calls run_memory_uses ledger usage_daily rate_buckets deletion_requests deks');
own(['src/telegram/'], 'tg_updates outbox tg_links topics');
own(['src/agent/'], 'conversation_toolkits conversation_turns llm_rate_daily');
own(['src/trust/'], 'pending_actions grants trusted_targets undo_tokens sentinel_decisions stepup_devices stepup_grants');
own(['src/tools/', 'src/capabilities/', 'src/integrations/'], 'connections oauth_states anthropic_files location_state');
own(['src/memory/', 'src/scheduler/', 'src/reminders/', 'src/proactive/', 'src/missions/'], 'memory_facts memory_fingerprints extraction_watermarks reminders todos todo_messages missions watchers jobs nudges nudge_prefs commitments');
// friend mode (spec 05 §D, migration 003)
own(['src/memory/'], 'user_profile fact_embeddings');
own(['src/behaviour/'], 'user_signals user_rhythm proactive_arms proactive_log');
own(['src/surfaces/'], 'business_connections business_chats business_messages business_drafts groups guest_invocations deeplink_tokens choice_sets subscriptions payments');
// s07 (spec 07 §D, migration 004): BR browser tasks, CAL pending connect links, GR group participant tables
own(['src/browser/'], 'browser_tasks');
own(['src/tools/', 'src/capabilities/', 'src/integrations/'], 'integration_links');
own(['src/groups/'], 'group_messages group_summaries group_policy');
// The deletion plan (contracts/storage.ts) and its executor (privacy/, WP1) legitimately name every table.
const SQL_EXEMPT = only('src/contracts/storage.ts', 'src/privacy/');

export function scan(files: SrcFile[]): Violation[] {
  const v: Violation[] = [];
  // 1. no global fetch in src/ (adapters get fetchImpl by DI; main/app may hand globalThis.fetch over)
  v.push(...grep(files, 'no-global-fetch', /(?<![\w$.])fetch\s*\(/, none));
  v.push(...grep(files, 'no-global-fetch', /\bglobalThis\s*\.\s*fetch\b/, only('src/main.ts', 'src/app.ts')));
  v.push(...grep(files, 'no-global-fetch', /\bglobalThis\s*\[\s*['"`]fetch['"`]\s*\]/, none));
  // the bare identifier used as a value (`const f = fetch;`, `g(fetch)`, `{ fetch }`); `typeof fetch` in types is fine
  v.push(...grep(files, 'no-global-fetch', /(?<![\w$.])(?<!typeof\s{1,20})fetch\s*[;,)}]/, none));
  // 2. every timer through Clock; no Date.now() / new Date() / performance.now() / AbortSignal.timeout / node:timers outside the clock
  v.push(...grep(files, 'timers-via-clock', /(?<![\w$.])(?:setTimeout|setInterval|setImmediate)\s*\(/, only('src/kernel/clock.ts', 'src/contracts/')));
  v.push(...grep(files, 'timers-via-clock', /\bDate\.now\s*\(/, only('src/kernel/clock.ts')));
  v.push(...grep(files, 'timers-via-clock', /\bnew\s+Date\s*\(\s*\)/, only('src/kernel/clock.ts')));
  v.push(...grep(files, 'timers-via-clock', /\bperformance\s*\.\s*now\s*\(/, only('src/kernel/clock.ts')));
  v.push(...grep(files, 'timers-via-clock', /\bAbortSignal\s*\.\s*timeout\s*\(/, only('src/kernel/clock.ts')));
  v.push(...grep(files, 'timers-via-clock', /(?:from\s*|import\s*\(\s*|require\(\s*)['"](?:node:)?timers(?:\/promises)?['"]/, only('src/kernel/clock.ts')));
  // 3. only trust/executor.ts calls ToolSpec.execute / ToolSpec.undo (UndoService is referenced as `undo`, e.g. s.undo.undo(...))
  v.push(...grep(files, 'execute-only-in-executor', /\.execute\s*\(/, only('src/trust/executor.ts')));
  v.push(...grep(files, 'execute-only-in-executor', /(?<!\bundo)\.undo\s*\(/, only('src/trust/executor.ts')));
  // 4. only agent/transport.ts imports @anthropic-ai/sdk at runtime
  v.push(...grep(files, 'anthropic-sdk-runtime-import', runtimeImportRe('@anthropic-ai/sdk'), only('src/agent/transport.ts')));
  // 5. (03 R1) only agent/groq/*, capabilities/groq/* and kernel/groqClient.ts import groq-sdk at runtime; only groqClient constructs it
  v.push(...grep(files, 'groq-sdk-runtime-import', runtimeImportRe('groq-sdk'), only('src/agent/groq/', 'src/capabilities/groq/', 'src/kernel/groqClient.ts')));
  v.push(...grep(files, 'groq-client-construction', /\bnew\s+Groq\s*\(/, only('src/kernel/groqClient.ts')));
  // 6. only telegram/files.ts ever sees a Telegram file URL
  v.push(...grep(files, 'telegram-file-url', /api\.telegram\.org\/file|\/file\/bot/, only('src/telegram/files.ts'), 'raw'));
  // 7. erasable TypeScript only
  v.push(...grep(files, 'erasable-only', /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/, none));
  v.push(...grep(files, 'erasable-only', /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+[A-Za-z_$][\w$.]*\s*\{/, none));
  v.push(...grep(files, 'erasable-only', /constructor\s*\([^)]*\b(?:public|private|protected|readonly|override)\s+[A-Za-z_$]/, none));
  v.push(...grep(files, 'erasable-only', /(?:^|\n)\s*@[A-Za-z_$][\w$.]*\s*(?:\(|\n)/, none));
  v.push(...grep(files, 'erasable-only', /(?:^|\n)\s*(?:import\s+[A-Za-z_$][\w$]*\s*=\s*require|export\s*=)/, none));
  // 8. relative import specifiers end in .ts
  for (const f of files) {
    for (const m of f.code.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      if (!/\.(?:ts|tsx|json)$/.test(m[1]!)) v.push({ rule: 'ts-import-specifiers', path: f.path, line: lineOf(f.code, m.index ?? 0), text: m[0] });
    }
  }
  // 9. never await inside db.tx()
  v.push(...grep(files, 'no-await-in-tx', /\.tx\s*(?:<[^>]*>)?\s*\(\s*async\b/, none));
  // 10. never log message text, tokens or initData (keys that would carry them)
  v.push(...grep(files, 'no-secret-logging', /\.(?:debug|info|warn|error)\s*\(\s*\{[^}]*\b(?:initData|initDataRaw|botToken|apiKey|bot_token)\b/, none));
  // 12. (spec 05 §E) randomness only through the injectable Random (kernel/random.ts, s.random): never Math.random
  v.push(...grep(files, 'no-math-random', /\bMath\s*\.\s*random\b/, none));
  // 13. (spec 05 B2) only capabilities/embedder.ts loads @huggingface/transformers (lazily, never at boot)
  v.push(...grep(files, 'transformers-runtime-import', runtimeImportRe('@huggingface/transformers'), only('src/capabilities/embedder.ts')));
  // 14. (spec 07 A1) only browser/playwright.ts loads playwright (lazily, on the first openSession, never at boot)
  v.push(...grep(files, 'playwright-runtime-import', runtimeImportRe('playwright'), only('src/browser/playwright.ts')));
  v.push(...grep(files, 'playwright-runtime-import', runtimeImportRe('playwright-core'), only('src/browser/playwright.ts')));
  // 11. SQL for a table only in the owning WP's modules. Two detectors: upper-case keywords (any context), and any-case
  // keywords that need SQL context after the table name (so English like "remove it from users of the group" passes).
  const SQL_RES = [
    /\b(?:FROM|INTO|UPDATE|JOIN|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+([a-z_][a-z0-9_]*)\b/g,
    /\b(?:from|into|update|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:where|set|values|as|on|order|limit|group)\b|\s*\()/gi,
  ];
  for (const f of files) {
    if (SQL_EXEMPT(f.path)) continue;
    const seen = new Set<number>();
    for (const re of SQL_RES) {
      for (const m of f.code.matchAll(re)) {
        if (seen.has(m.index ?? 0)) continue;
        seen.add(m.index ?? 0);
        const owners = OWNERS[m[1]!.toLowerCase()];
        if (owners && !owners.some((o) => (o.endsWith('/') ? f.path.startsWith(o) : f.path === o))) v.push({ rule: 'sql-table-ownership', path: f.path, line: lineOf(f.code, m.index ?? 0), text: m[0] });
      }
    }
  }
  return v;
}

const fmt = (v: Violation[]) => v.map((x) => `${x.rule}: ${x.path}:${x.line}: ${x.text}`);

describe('import and coding rules (01 §4.2, 03 R1)', () => {
  const files = load();
  it('scans the whole src/ tree', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.path === 'src/app.ts')).toBe(true);
  });
  it('src/ has no violations', () => {
    expect(fmt(scan(files))).toEqual([]);
  });
  it('every WP stub/factory module exists (01 §4.2 layout)', () => {
    const paths = new Set(files.map((f) => f.path));
    for (const p of [
      'src/db/keystore.ts', 'src/db/crypto.ts', 'src/db/repos/index.ts', 'src/ledger/index.ts', 'src/billing/index.ts', 'src/privacy/index.ts', 'src/telegram/index.ts',
      'src/telegram/channels/index.ts', 'src/agent/index.ts', 'src/trust/index.ts', 'src/tools/index.ts', 'src/capabilities/index.ts', 'src/integrations/index.ts',
      'src/memory/index.ts', 'src/scheduler/index.ts', 'src/reminders/index.ts', 'src/proactive/index.ts', 'src/missions/index.ts', 'src/surfaces/index.ts', 'src/surfaces/business/index.ts', 'src/http/index.ts',
      'src/browser/index.ts', 'src/browser/capability.ts', 'src/browser/tools.ts', 'src/groups/index.ts', 'src/groups/tools.ts', // s07
    ]) expect(paths.has(p), p).toBe(true);
  });

  // The detectors themselves are tested on synthetic files so a rule cannot silently stop matching.
  const f = (path: string, raw: string): SrcFile => ({ path, raw, code: stripComments(raw) });
  const rulesFor = (path: string, raw: string) => scan([f(path, raw)]).map((x) => x.rule);
  it('detects global fetch, raw timers and Date.now', () => {
    expect(rulesFor('src/capabilities/weather.ts', `const r = await fetch(url);`)).toEqual(['no-global-fetch']);
    expect(rulesFor('src/capabilities/weather.ts', `const r = await this.fetchImpl(url); const x = s.fetch(u); // fetch( in a comment`)).toEqual([]);
    expect(rulesFor('src/capabilities/weather.ts', `const f = globalThis.fetch;`)).toEqual(['no-global-fetch']);
    expect(rulesFor('src/main.ts', `createApp({ fetchImpl: globalThis.fetch })`)).toEqual([]);
    expect(rulesFor('src/agent/engine.ts', `setTimeout(() => x(), 5); clock.setTimeout(f, 1); const t = Date.now();`)).toEqual(['timers-via-clock', 'timers-via-clock']);
  });
  it('detects the fetch and timer evasions (review of WP0)', () => {
    expect(rulesFor('src/capabilities/x.ts', `const f = fetch; f(url);`)).toEqual(['no-global-fetch']);
    expect(rulesFor('src/capabilities/x.ts', `useIt(fetch);`)).toEqual(['no-global-fetch']);
    expect(rulesFor('src/capabilities/x.ts', `createGroqClient({ apiKey, fetch });`)).toEqual(['no-global-fetch']);
    expect(rulesFor('src/capabilities/x.ts', `await globalThis['fetch'](url);`)).toEqual(['no-global-fetch']);
    expect(rulesFor('src/capabilities/x.ts', `function a(f: typeof fetch, g?: typeof fetch) {} const web_fetch = 1; o.fetch(u);`)).toEqual([]);
    expect(rulesFor('src/trust/llmSentinel.ts', `const s = AbortSignal.timeout(3000);`)).toEqual(['timers-via-clock']);
    expect(rulesFor('src/agent/engine.ts', `const d = new Date();`)).toEqual(['timers-via-clock']);
    expect(rulesFor('src/agent/engine.ts', `const d = new Date(ms).toISOString();`)).toEqual([]);
    expect(rulesFor('src/agent/engine.ts', `import { setTimeout as sleep } from 'node:timers/promises';`)).toEqual(['timers-via-clock']);
    expect(rulesFor('src/agent/engine.ts', `import { setInterval } from 'timers';`)).toEqual(['timers-via-clock']);
    expect(rulesFor('src/agent/engine.ts', `const t0 = performance.now();`)).toEqual(['timers-via-clock']);
    expect(rulesFor('src/kernel/clock.ts', `const t0 = performance.now(); const d = new Date(); AbortSignal.timeout(1);`)).toEqual([]);
  });
  it('detects execute/undo outside the executor', () => {
    expect(rulesFor('src/agent/engine.ts', `await spec.execute(input, ctx);`)).toEqual(['execute-only-in-executor']);
    expect(rulesFor('src/trust/executor.ts', `await spec.execute(input, ctx); await spec.undo(p, ctx);`)).toEqual([]);
    expect(rulesFor('src/trust/callbacks.ts', `await s.undo.undo(id, from);`)).toEqual([]);
    expect(rulesFor('src/surfaces/dm.ts', `await tool.undo(payload, ctx);`)).toEqual(['execute-only-in-executor']);
    expect(rulesFor('src/trust/approvals.ts', `await s.executor.executeApproved(id);`)).toEqual([]);
  });
  it('detects runtime SDK imports; type-only imports are fine', () => {
    expect(rulesFor('src/agent/engine.ts', `import Anthropic from '@anthropic-ai/sdk';`)).toEqual(['anthropic-sdk-runtime-import']);
    expect(rulesFor('src/agent/engine.ts', `import { type X } from '@anthropic-ai/sdk/resources/beta';`)).toEqual(['anthropic-sdk-runtime-import']);
    expect(rulesFor('src/agent/engine.ts', `const m = await import('@anthropic-ai/sdk');`)).toEqual(['anthropic-sdk-runtime-import']);
    expect(rulesFor('src/contracts/llm.ts', `import type Anthropic from '@anthropic-ai/sdk';\nimport type { A } from '@anthropic-ai/sdk/x';`)).toEqual([]);
    expect(rulesFor('src/agent/transport.ts', `import Anthropic from '@anthropic-ai/sdk';`)).toEqual([]);
    expect(rulesFor('src/capabilities/stt.ts', `import Groq, { toFile } from 'groq-sdk';`)).toEqual(['groq-sdk-runtime-import']);
    expect(rulesFor('src/capabilities/groq/stt.ts', `import { toFile } from 'groq-sdk';`)).toEqual([]);
    expect(rulesFor('src/agent/groq/transport.ts', `import { APIError } from 'groq-sdk'; const c = new Groq({});`)).toEqual(['groq-client-construction']);
    expect(rulesFor('src/kernel/groqClient.ts', `import Groq from 'groq-sdk'; new Groq({});`)).toEqual([]);
  });
  it('spec 05: no Math.random anywhere in src/, transformers only in capabilities/embedder.ts, friend tables owned', () => {
    expect(rulesFor('src/behaviour/policy.ts', 'const x = Math.random();')).toEqual(['no-math-random']);
    expect(rulesFor('src/kernel/random.ts', 'const x = Math . random();')).toEqual(['no-math-random']);
    expect(rulesFor('src/behaviour/policy.ts', 'const x = s.random.next();')).toEqual([]);
    expect(rulesFor('src/memory/store.ts', "const tf = await import('@huggingface/transformers');")).toEqual(['transformers-runtime-import']);
    expect(rulesFor('src/capabilities/embedder.ts', "const tf = await import('@huggingface/transformers');")).toEqual([]);
    expect(rulesFor('src/surfaces/dm.ts', 'db.prepare(`SELECT * FROM user_signals WHERE user_id = ?`)')).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/behaviour/repo.ts', 'db.prepare(`SELECT * FROM user_signals WHERE user_id = ?`)')).toEqual([]);
    expect(rulesFor('src/behaviour/repo.ts', 'db.prepare(`SELECT * FROM user_profile WHERE user_id = ?`)')).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/memory/profile.ts', 'db.prepare(`SELECT * FROM user_profile WHERE user_id = ?`)')).toEqual([]);
  });
  it('spec 07: playwright only in browser/playwright.ts; s07 tables owned', () => {
    expect(rulesFor('src/browser/tools.ts', "import { chromium } from 'playwright';")).toEqual(['playwright-runtime-import']);
    expect(rulesFor('src/browser/capability.ts', "const pw = await import('playwright');")).toEqual(['playwright-runtime-import']);
    expect(rulesFor('src/browser/capability.ts', "import type { Page } from 'playwright';")).toEqual([]);
    expect(rulesFor('src/browser/playwright.ts', "const pw = await import('playwright');")).toEqual([]);
    expect(rulesFor('src/surfaces/group.ts', 'db.prepare(`SELECT * FROM group_messages WHERE chat_id = ?`)')).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/groups/repo.ts', 'db.prepare(`SELECT * FROM group_messages WHERE chat_id = ?`)')).toEqual([]);
    expect(rulesFor('src/agent/x.ts', 'db.prepare(`UPDATE browser_tasks SET status = ?`)')).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/integrations/links.ts', 'db.prepare(`SELECT * FROM integration_links WHERE state = ?`)')).toEqual([]);
  });
  it('detects Telegram file URLs outside telegram/files.ts', () => {
    expect(rulesFor('src/capabilities/media.ts', "const u = `https://api.telegram.org/file/bot${t}/${p}`;")).toEqual(['telegram-file-url']);
    expect(rulesFor('src/telegram/files.ts', "const u = `${root}/file/bot${t}/${p}`;")).toEqual([]);
  });
  it('detects non-erasable syntax and bad import specifiers', () => {
    expect(rulesFor('src/x.ts', `export enum Color { Red }`)).toEqual(['erasable-only']);
    expect(rulesFor('src/x.ts', `export const enum Color { Red }`)).toEqual(['erasable-only']);
    expect(rulesFor('src/x.ts', `namespace Foo { export const a = 1; }`)).toEqual(['erasable-only']);
    expect(rulesFor('src/x.ts', `class A { constructor(private readonly db: Db) {} }`)).toEqual(['erasable-only']);
    expect(rulesFor('src/x.ts', `class A {\n  @Inject()\n  x = 1;\n}`)).toEqual(['erasable-only']);
    expect(rulesFor('src/x.ts', `class A { private x = 1; constructor(db: Db) { this.db = db; } }`)).toEqual([]);
    expect(rulesFor('src/x.ts', `import { a } from './a';\nimport type { B } from '../b.js';\nimport { c } from './c.ts';`)).toEqual(['ts-import-specifiers', 'ts-import-specifiers']);
  });
  it('detects await inside db.tx, secret logging and cross-WP SQL', () => {
    expect(rulesFor('src/memory/forget.ts', `db.tx(async () => { await x(); });`)).toEqual(['no-await-in-tx']);
    expect(rulesFor('src/http/auth.ts', `log.warn({ initData: raw }, 'bad');`)).toEqual(['no-secret-logging']);
    expect(rulesFor('src/surfaces/dm.ts', "db.prepare('SELECT * FROM users WHERE id = ?')")).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/db/repos/users.ts', "db.prepare('SELECT * FROM users WHERE id = ?')")).toEqual([]);
    expect(rulesFor('src/agent/groq/repo.ts', "db.prepare('INSERT INTO llm_rate_daily(model) VALUES (?)')")).toEqual([]);
    expect(rulesFor('src/trust/repo.ts', "db.prepare(`UPDATE pending_actions SET status = 'approved'`)")).toEqual([]);
    expect(rulesFor('src/surfaces/why.ts', "db.prepare(`SELECT * FROM pending_actions`)")).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/surfaces/strings.ts', "const s = 'Remove it from users of the group';")).toEqual([]);
    // lower-case SQL is caught too, once SQL context follows the table name
    expect(rulesFor('src/surfaces/dm.ts', "db.prepare('select * from users where id = ?')")).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/proactive/scan.ts', "db.prepare('insert into users(id) values (?)')")).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/agent/x.ts', "db.prepare('update pending_actions set status = ?')")).toEqual(['sql-table-ownership']);
    expect(rulesFor('src/surfaces/business/repo.ts', "db.prepare('select * from business_drafts where chat_id = ?')")).toEqual([]);
    expect(rulesFor('src/surfaces/dm.ts', "db.prepare('SELECT * FROM users WHERE id = ?')").length).toBe(1); // one violation, not one per detector
  });
});
