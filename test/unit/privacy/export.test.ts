// WP1 — /export JSON (01 §11.9): profile, settings, consents, ledger summaries, the visible text of the current epoch
// only, hook parts merged under hook.name, hook failures listed, no secrets/ciphertext, an 'export' ledger entry.
import { afterEach, describe, expect, it } from 'vitest';
import { createPrivacyService, EXPORT_FORMAT } from '../../../src/privacy/index.ts';
import { privEnv, seedUser, type PrivEnv } from './env.ts';

let p: PrivEnv;
afterEach(() => p?.dispose());

async function exportOf(userId: string) {
  const bytes = await createPrivacyService(p.s).exportUser(userId);
  expect(bytes).toBeInstanceOf(Uint8Array);
  const text = new TextDecoder().decode(bytes);
  return { text, json: JSON.parse(text) as Record<string, any> };
}

describe('exportUser (01 §11.9)', () => {
  it('contains profile, settings, consents, ledger summaries and the current epoch visible text', async () => {
    p = privEnv();
    const { u } = seedUser(p, 4242);
    const { json, text } = await exportOf(u.id);
    expect(json.format).toBe(EXPORT_FORMAT);
    expect(json.profile).toMatchObject({ telegramUserId: 4242, firstName: 'Ann', timeZone: 'UTC', plan: 'free' });
    expect(json.settings.nudgeBudget).toBe(2);
    expect(json.consents).toEqual([expect.objectContaining({ kind: 'terms', textVersion: 'v1', via: 'callback', revokedAt: null })]);
    expect(json.permissions).toEqual({ gmail: 'none', gcal: 'read' });
    expect(json.usage[0]).toMatchObject({ turns: 2 });
    expect(json.ledger.map((l: { summary: string }) => l.summary)).toEqual(['Memory on', 'Checked the weather']);
    expect(json.ledger[1]).not.toHaveProperty('detail');
    const conv = json.conversations[0];
    expect(conv.currentEpoch).toBe(2);
    expect(conv.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'current question' }),
      expect.objectContaining({ role: 'assistant', text: 'current answer' }),
    ]);
    expect(text).not.toContain('epoch one');
    // The export itself is recorded (after the snapshot).
    expect(p.s.ledger.list(u.id, { limit: 1 })[0]).toMatchObject({ kind: 'export', actor: 'user' });
  });

  it('merges hook parts under the hook name and lists failing hooks', async () => {
    p = privEnv();
    const { u } = seedUser(p);
    p.addHook({ name: 'memory', exportUser: async (uid, tg) => ({ facts: [{ text: 'likes tea', source: 'chat' }], who: uid === u.id && tg === u.tgUserId }) });
    p.addHook({ name: 'connections', exportUser: async () => { throw new Error('boom'); } });
    p.addHook({ name: 'profile', exportUser: async () => ({ clash: true }) });
    p.addHook({ name: 'nothing' });
    const { json } = await exportOf(u.id);
    expect(json.memory).toEqual({ facts: [{ text: 'likes tea', source: 'chat' }], who: true });
    expect(json.unavailable).toEqual(['connections']);
    expect(json.profile.telegramUserId).toBe(u.tgUserId); // a hook never overwrites WP1's sections
    expect(json.hook_profile).toEqual({ clash: true });
  });

  it('skips shredded content instead of failing, and rejects unknown users', async () => {
    p = privEnv();
    const { u, c } = seedUser(p);
    p.crypto.destroyDek(`e:${c.id}:2`);
    const { json } = await exportOf(u.id);
    expect(json.conversations[0].messages).toEqual([]);
    await expect(createPrivacyService(p.s).exportUser('nobody')).rejects.toThrow(/no such user/);
  });
});
