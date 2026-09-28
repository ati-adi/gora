// WP1 — 01 §15.2: the day boundary follows the user's tz; rate buckets; the cost cap. Plus plan limits, counters,
// refusal cooldown (§11.8), unknown users and the persisted fixed windows.
import { afterEach, describe, expect, it } from 'vitest';
import { PLANS } from '../../../src/config.ts';
import { COOLDOWN_MS, createQuotas, nextLocalMidnight } from '../../../src/billing/index.ts';
import { dbEnv, mkUser, type DbEnv } from './env.ts';

let e: DbEnv;
afterEach(() => e?.dispose());

function setup(now?: number) {
  e = dbEnv(now === undefined ? {} : { now });
  return createQuotas({ db: () => e.db, clock: () => e.clock });
}

describe('QuotaService (01 §11.8, §13)', () => {
  it('the quota day follows the user time zone, and resetsAt is the next local midnight', async () => {
    // 2026-09-28 18:30 UTC = 2026-09-28 23:30 in Asia/Almaty (UTC+5)
    const q = setup(Date.UTC(2026, 8, 28, 18, 30));
    const almaty = mkUser(e, { tz: 'Asia/Almaty' }).id;
    const utc = mkUser(e, { tz: 'UTC' }).id;
    q.consume(almaty, 'turn', 3);
    q.consume(utc, 'turn', 3);
    expect(q.day(almaty)).toBe('2026-09-28');
    expect(q.check(almaty, 'turn')).toMatchObject({ used: 3, limit: PLANS.free.turnsPerDay, ok: true, resetsAt: Date.UTC(2026, 8, 28, 19, 0) });
    await e.clock.advance(31 * 60_000); // 19:01 UTC → 00:01 in Almaty (new day), still the 28th in UTC
    expect(q.day(almaty)).toBe('2026-09-29');
    expect(q.check(almaty, 'turn').used).toBe(0);
    expect(q.check(utc, 'turn').used).toBe(3);
    expect(q.check(utc, 'turn').resetsAt).toBe(Date.UTC(2026, 8, 29, 0, 0));
  });

  it('nextLocalMidnight is DST-aware', () => {
    // Europe/Berlin leaves DST on 2026-10-25: midnight of the 26th is 23:00 UTC on the 25th.
    expect(nextLocalMidnight(Date.UTC(2026, 9, 25, 12), 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 23));
    expect(nextLocalMidnight(Date.UTC(2026, 9, 24, 12), 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 24, 22));
  });

  it('check/consume enforce the plan limit; plan upgrades apply at once', () => {
    const q = setup();
    const u = mkUser(e).id;
    q.consume(u, 'file', PLANS.free.filesPerDay - 1);
    expect(q.check(u, 'file').ok).toBe(true);
    expect(q.check(u, 'file', 2).ok).toBe(false);
    q.consume(u, 'file');
    expect(q.check(u, 'file')).toMatchObject({ ok: false, used: PLANS.free.filesPerDay, limit: PLANS.free.filesPerDay });
    e.repos.users.update(u, { plan: 'plus' });
    expect(q.check(u, 'file')).toMatchObject({ ok: true, limit: PLANS.plus.filesPerDay });
    q.consume(u, 'turn', 0);
    q.consume(u, 'turn', -5);
    expect(q.view(u).turn.used).toBe(0);
    // unknown users: nothing recorded, free limits reported
    q.consume('ghost', 'turn');
    expect(q.check('ghost', 'turn')).toMatchObject({ used: 0, limit: PLANS.free.turnsPerDay });
  });

  it('the daily cost cap reads recordUsage and blocks once reached', () => {
    const q = setup();
    const u = mkUser(e).id;
    const cap = PLANS.free.dailyCostCapMicros;
    q.recordUsage(u, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, costMicros: cap - 1 });
    expect(q.check(u, 'cost_micros', 0)).toMatchObject({ ok: true, used: cap - 1, limit: cap });
    expect(q.check(u, 'cost_micros', 1).ok).toBe(true);
    q.recordUsage(u, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 1 });
    expect(q.check(u, 'cost_micros', 1).ok).toBe(false);
    expect(q.check(u, 'cost_micros', 0).ok).toBe(true); // at the cap exactly, a zero-cost check passes…
    q.recordUsage(u, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 1 });
    expect(q.check(u, 'cost_micros', 0).ok).toBe(false); // …over it, nothing passes
    const row = e.db.prepare('SELECT input_tokens, output_tokens, cache_read_tokens FROM usage_daily WHERE user_id = ?').get(u);
    expect(row).toEqual({ input_tokens: 1000, output_tokens: 200, cache_read_tokens: 50 });
  });

  it('mission/watcher are live counts from the registered counters', () => {
    const q = setup();
    const u = mkUser(e).id;
    expect(q.check(u, 'mission').used).toBe(0);
    q.registerCounter('mission', () => 1);
    q.registerCounter('watcher', () => {
      throw new Error('boom');
    });
    expect(q.check(u, 'mission')).toMatchObject({ used: 1, ok: false, limit: PLANS.free.activeMissions });
    expect(q.check(u, 'watcher').used).toBe(0);
    q.registerCounter('mission', () => 0); // a second registration is ignored (the first one is kept)
    expect(q.check(u, 'mission').used).toBe(1);
    q.consume(u, 'mission'); // no-op
    expect(q.view(u).mission).toEqual({ used: 1, limit: PLANS.free.activeMissions });
  });

  it('rate(): short windows are in-memory token buckets (burst = limit, steady refill)', async () => {
    const q = setup();
    // 20/min with burst 10 ⇔ capacity 10 refilled over 30 s.
    const hits = Array.from({ length: 12 }, () => q.rate('msg:u1', 10, 30_000));
    expect(hits.filter(Boolean)).toHaveLength(10);
    expect(q.rate('msg:u2', 10, 30_000)).toBe(true); // keys are independent
    await e.clock.advance(3_000); // +1 token
    expect(q.rate('msg:u1', 10, 30_000)).toBe(true);
    expect(q.rate('msg:u1', 10, 30_000)).toBe(false);
    await e.clock.advance(60_000);
    expect(Array.from({ length: 11 }, () => q.rate('msg:u1', 10, 30_000)).filter(Boolean)).toHaveLength(10);
    // callbacks: 10/s
    expect(Array.from({ length: 11 }, () => q.rate('cb:u1', 10, 1000)).filter(Boolean)).toHaveLength(10);
    expect(q.rate('x', 0, 1000)).toBe(false);
  });

  it('rate(): windows ≥ 10 min are fixed windows persisted in rate_buckets (survive a restart)', async () => {
    const q = setup(Date.UTC(2026, 8, 28, 9, 0));
    const hour = 3_600_000;
    for (let i = 0; i < 10; i++) expect(q.rate('guest:caller:1', 10, hour)).toBe(true);
    expect(q.rate('guest:caller:1', 10, hour)).toBe(false);
    const q2 = createQuotas({ db: () => e.db, clock: () => e.clock }); // a restart: fresh memory, same DB
    expect(q2.rate('guest:caller:1', 10, hour)).toBe(false);
    await e.clock.advance(hour);
    expect(q2.rate('guest:caller:1', 10, hour)).toBe(true);
    expect(q2.pruneRateBuckets(e.clock.now())).toBe(0);
    expect(q2.pruneRateBuckets(e.clock.now() + 1)).toBe(1);
  });

  it('more than 5 refusals in a day start a 1 h cooldown', async () => {
    const q = setup();
    const u = mkUser(e).id;
    for (let i = 1; i <= 5; i++) expect(q.recordRefusal(u)).toEqual({ today: i, cooldownUntil: null });
    const sixth = q.recordRefusal(u);
    expect(sixth).toEqual({ today: 6, cooldownUntil: e.clock.now() + COOLDOWN_MS });
    expect(q.cooldownUntil(u)).toBe(sixth.cooldownUntil);
    // a 7th refusal does not extend it
    expect(q.recordRefusal(u).cooldownUntil).toBe(sixth.cooldownUntil);
    await e.clock.advance(COOLDOWN_MS);
    expect(q.cooldownUntil(u)).toBeNull();
    expect(q.recordRefusal('ghost')).toEqual({ today: 0, cooldownUntil: null });
  });
});
