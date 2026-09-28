// REVIEW (proactive) — watchers keep running (fetches + semantic LLM calls) for owners who paused Gora or blocked the bot.
// watchers.ts check() never looks at the owner: no users.status / botBlocked check, and the watcher_check job keeps
// rescheduling. Every hash change of a semantic watcher spends a Groq 'background' call (1K RPD per model, shared by all
// users) whose only possible output — a watcher_hit nudge — is then dropped by NudgeGate step 1 ('inactive').
// Churned users (bot blocked) therefore burn the shared daily quota forever; at the 85 % mark llmBudget pauses ALL
// background work (memory extraction, business triage) for active users.
import { afterEach, describe, expect, it } from 'vitest';
import { createWp6bApp, type Wp6bApp } from '../../unit/proactive/wp6bHarness.ts';

const HOUR = 3_600_000;
const URL1 = 'https://news.example.com/concert';
let t: Wp6bApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('watchers of inactive owners', () => {
  it('a blocked-bot owner\'s semantic watcher still calls the LLM on every change', async () => {
    t = await createWp6bApp();
    const u = t.user();
    t.caps.safeFetch.set(URL1, '<p>v0</p>');
    await t.s.watchers.create({ userId: u.id, kind: 'page', target: URL1, condition: { type: 'semantic', description: 'a date for Almaty is announced' }, intervalMin: 360 });
    t.s.repos.users.update(u.id, { botBlocked: true }); // the owner blocked the bot (or: status 'paused')
    t.semantic.next = { met: false, summary: '' };
    for (let i = 1; i <= 4; i++) {
      t.caps.safeFetch.set(URL1, `<p>v${i} ${Date.now()}</p>`); // a page with a changing counter/timestamp
      await t.advance(6 * HOUR);
    }
    expect(t.semantic.calls).toBe(0); // actual: 4 LLM calls for a user who can never receive the result
  });
});
