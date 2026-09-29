// WP3 — 03 R3 engine side: ToolkitState over conversation_toolkits / conversation_turns (6-turn expiry), deterministic
// preloads, kits of tools called in history, and the active-set union.
import { describe, expect, it } from 'vitest';
import type { ToolkitId } from '../../../src/contracts/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { TOOLKIT_TTL_TURNS, createToolkitState, kitsOfTools, preloadKits, selectActiveKits } from '../../../src/agent/toolkits.ts';
import { openTmpDb } from '../../harness/tmpDb.ts';

function withConv<T>(fn: (db: ReturnType<typeof openTmpDb>['db']) => T): T {
  const t = openTmpDb();
  try {
    t.db.prepare(`INSERT INTO conversations (id, scope_key, kind, route, model, effort, toolset, tools_hash, system_version, betas_json, created_at, last_activity_at) VALUES ('c1','dm:1','dm','chat','groq:m','medium','FULL','h','v','[]',0,0)`).run();
    return fn(t.db);
  } finally {
    t.close();
    t.cleanup();
  }
}

describe('ToolkitState', () => {
  it('load() keeps a kit for 6 further user turns; active() always includes core', () => {
    withConv((db) => {
      const st = createToolkitState(db, new FakeClock());
      expect(st.active('c1')).toEqual(['core']);
      expect(st.userTurn('c1')).toBe(0);
      st.bumpTurn('c1');
      expect(st.load('c1', 'web')).toEqual({ expiresAfterTurn: 1 + TOOLKIT_TTL_TURNS });
      expect(st.active('c1')).toEqual(['core', 'web']);
      for (let i = 0; i < TOOLKIT_TTL_TURNS; i++) st.bumpTurn('c1');
      expect(st.userTurn('c1')).toBe(7);
      expect(st.active('c1')).toEqual(['core', 'web']);
      st.bumpTurn('c1');
      expect(st.active('c1')).toEqual(['core']);
      st.load('c1', 'calendar');
      st.load('c1', 'calendar'); // idempotent upsert
      expect(st.active('c1')).toEqual(['core', 'calendar']);
    });
  });
});

describe('preloads (03 R3)', () => {
  const base = { route: 'chat', hasPendingApproval: false, connected: { gmail: false, gcal: false } };
  it('a URL or search/price/news/weather words (en/ru) → web', () => {
    expect(preloadKits({ ...base, text: 'read https://example.com/a' })).toContain('web');
    expect(preloadKits({ ...base, text: 'какая погода завтра?' })).toContain('web');
    expect(preloadKits({ ...base, text: 'найди билеты' })).toContain('web');
    expect(preloadKits({ ...base, text: 'price of BTC' })).toContain('web');
    expect(preloadKits({ ...base, text: 'hello' })).toEqual([]);
  });
  it('pending approval → account; mission route → missions; connected integrations mentioned → calendar / email', () => {
    expect(preloadKits({ ...base, text: 'x', hasPendingApproval: true })).toEqual(['account']);
    expect(preloadKits({ ...base, text: 'x', route: 'mission' })).toEqual(['missions']);
    expect(preloadKits({ ...base, text: 'move my meeting', connected: { gmail: false, gcal: true } })).toEqual(['calendar']);
    // s07 B2: a calendar question preloads the calendar kit (with integration_connect) even when not connected
    expect(preloadKits({ ...base, text: 'move my meeting' })).toEqual(['calendar']);
    expect(preloadKits({ ...base, text: 'что у меня в календаре завтра?' })).toEqual(['calendar']);
    // s07 A2: acting on a website → browser
    expect(preloadKits({ ...base, text: 'забронируй столик в Alma на 19:00' })).toEqual(['browser']);
    expect(preloadKits({ ...base, text: 'please book me a table for two' })).toEqual(['browser']);
    expect(preloadKits({ ...base, text: 'a good book about history' })).toEqual([]);
    expect(preloadKits({ ...base, text: 'check my inbox', connected: { gmail: true, gcal: false } })).toEqual(['email']);
    expect(preloadKits({ ...base, text: 'проверь почту', connected: { gmail: true, gcal: false } })).toEqual(['email']);
  });
  it('history kits and the union', () => {
    const membership = { core: ['time_resolve'], web: ['web_search'], calendar: ['calendar_list_events'], email: ['gmail_search'], missions: [], secretary: [], files: ['make_file'], account: [], browser: [] } as Record<ToolkitId, string[]>;
    expect(kitsOfTools(membership, ['web_search', 'make_file'])).toEqual(['web', 'files']);
    expect(selectActiveKits({ loaded: ['core', 'email'], historyKits: ['web'], preloads: ['account', 'web'] })).toEqual(['core', 'web', 'email', 'account']);
  });
});
