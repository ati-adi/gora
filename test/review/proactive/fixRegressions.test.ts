// REVIEW (proactive) — extra regression tests written by the fixer for paths the original proofs did not cover:
// F5 (number_below and semantic beyond 20K chars; the bounded snapshot), F4 (Resume re-arms an 'active' watcher whose job
// died), F11 (a persistently failing semantic check pauses the watcher with a Resume notice), F8 (a topic-less mission
// card never invites a reply that cannot reach the mission), F9 (checks resume by themselves after unblock).
import { afterEach, describe, expect, it } from 'vitest';
import { LAST_VALUE_MAX_CHARS, snapshotValue, numberNear, containsText } from '../../../src/missions/watcherConditions.ts';
import { createWp6bApp, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

const HOUR = 3_600_000;
const URL1 = 'https://shop.example.com/listing';
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const filler = Array.from({ length: 500 }, (_, i) => `<p>Item ${i}: a long product description line padding the page</p>`).join('');
const md = (t: Wp6bApp) => t.tg.callsOf('sendRichMessage').map((c) => String((c.payload.rich_message as { markdown: string }).markdown).replace(/\\/g, ''));

describe('fixer regressions (proactive)', () => {
  it('F5: snapshotValue keeps the needle context of a long page, bounded', () => {
    const long = `${'x '.repeat(30_000)}Fare ALA-IST 231 USD ${'y '.repeat(30_000)}`;
    const snap = snapshotValue({ type: 'number_below', near_text: 'Fare ALA-IST', threshold: 200 }, long, 'page');
    expect(snap.length).toBeLessThanOrEqual(LAST_VALUE_MAX_CHARS);
    expect(numberNear(snap, 'Fare ALA-IST')).toBe(231);
    const c = snapshotValue({ type: 'contains', text: 'Fare ALA' }, long, 'page');
    expect(containsText(c, 'fare ala')).toBe(true);
    expect(snapshotValue({ type: 'absent', text: 'nowhere' }, long, 'page').length).toBe(LAST_VALUE_MAX_CHARS);
  });

  it('F5: number_below beyond 20K chars fires on the transition', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 9, 0) });
    const u = t.user();
    t.caps.safeFetch.set(URL1, `<html><body>${filler}<p>Fare ALA-IST: 231 USD</p></body></html>`);
    const { id } = await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'number_below', near_text: 'Fare ALA-IST', threshold: 200 }, intervalMin: 360 });
    t.caps.safeFetch.set(URL1, `<html><body>${filler}<p>Fare ALA-IST: 189 USD</p></body></html>`);
    await t.advance(6 * HOUR);
    expect(md(t).filter((m) => m.includes(`Watcher ${id}`))).toHaveLength(1);
  });

  it('F5: a semantic watcher gets the changed window even beyond 20K chars', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 9, 0) });
    const u = t.user();
    const seen: string[] = [];
    const side = t.s.side as { semanticCheck: (d: string, b: string, a: string) => Promise<{ met: boolean; summary: string } | null> };
    side.semanticCheck = async (_d, _b, after) => {
      seen.push(after);
      return { met: true, summary: 'Almaty date announced' };
    };
    t.caps.safeFetch.set(URL1, `<html><body>${filler}<p>Tour dates: TBA</p></body></html>`);
    await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'semantic', description: 'a date for Almaty is announced' }, intervalMin: 360 });
    t.caps.safeFetch.set(URL1, `<html><body>${filler}<p>Tour dates: Almaty 12 Dec</p></body></html>`);
    await t.advance(6 * HOUR);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Almaty 12 Dec');
  });

  it('F11: a semantic check that keeps failing pauses the watcher and offers Resume', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 9, 0) });
    const u = t.user();
    t.caps.safeFetch.set(URL1, '<p>Tour dates: TBA</p>');
    const { id } = await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'semantic', description: 'a date for Almaty is announced' }, intervalMin: 360 });
    t.caps.safeFetch.set(URL1, '<p>Tour dates: Almaty 12 Dec</p>');
    t.semantic.next = null;
    for (let i = 0; i < 6; i++) await t.advance(6 * HOUR);
    expect(t.s.watchers.list(u.id).find((w) => w.id === id)!.status).toBe('paused');
    expect(md(t).filter((m) => m.includes(`Watcher ${id}`) && m.includes('paused'))).toHaveLength(1);
    // Resume + the LLM works again → the pending change is evaluated (old hash kept) and reported.
    t.s.watchers.manage(id, u.id, 'resume');
    t.semantic.next = { met: true, summary: 'Almaty date announced' };
    await t.advance(12 * HOUR); // the hit may be deferred past quiet hours
    expect(t.s.watchers.list(u.id).find((w) => w.id === id)!.status).toBe('active');
    expect(md(t).some((m) => m.startsWith('💡') && m.includes(`Watcher ${id}`))).toBe(true);
  });

  it('F9: checks skip while the owner blocked the bot and resume after the unblock', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 9, 0) });
    const u = t.user();
    t.caps.safeFetch.set(URL1, '<p>v0</p>');
    await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'semantic', description: 'x' }, intervalMin: 360 });
    const fetches = t.caps.safeFetch.calls.length;
    t.s.repos.users.update(u.id, { botBlocked: true });
    t.caps.safeFetch.set(URL1, '<p>v1</p>');
    t.semantic.next = { met: false, summary: '' };
    await t.advance(12 * HOUR);
    expect({ fetches: t.caps.safeFetch.calls.length - fetches, calls: t.semantic.calls }).toEqual({ fetches: 0, calls: 0 });
    t.s.repos.users.update(u.id, { botBlocked: false });
    await t.advance(6 * HOUR);
    expect(t.semantic.calls).toBe(1);
  });

  it('F4: Resume on an "active" watcher whose job died re-arms it', async () => {
    t = await createWp6bApp({ now: Date.UTC(2026, 8, 28, 9, 0) });
    const u = t.user();
    t.caps.safeFetch.set(URL1, '<p>v0</p>');
    const { id } = await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'changed' }, intervalMin: 360 });
    t.s.scheduler.cancel(`wch:${id}`); // stands in for a dead-lettered job
    const before = t.caps.safeFetch.calls.length;
    await t.advance(12 * HOUR);
    expect(t.caps.safeFetch.calls.length).toBe(before);
    t.s.watchers.manage(id, u.id, 'resume');
    await t.advance(HOUR);
    expect(t.caps.safeFetch.calls.length).toBeGreaterThan(before);
  });

  it('F8: a topic-less mission card never says "reply here", and the run is told only replies to its own messages reach it', async () => {
    t = await createWp6bApp({ topics: false });
    const u = t.user();
    const { missionId } = await t.s.missions.start({ userId: u.id, tgUserId: u.tgUserId, title: 'Fares', goal: 'g', criteria: ['c'], taint: [] });
    await t.settle();
    await t.advance(10_000);
    expect(md(t).some((m) => m.includes('reply here to continue'))).toBe(false);
    const ev = t.runner.events.find((e) => e.type === 'mission_start' && e.body.includes(`Mission ${missionId}`))!;
    // integration F8: surfaces routes a main-DM reply to the mission's card / posts into 'mission:<id>'.
    expect(ev.body).toContain('only the owner\'s replies to this mission\'s own messages');
  });
});
