// INTEGRATION (F8): a fallback (topic-less) mission lives in the main DM as 'mission:<id>'. An owner reply in the main DM
// to the mission's status card (or anything its run sent) is routed to the mission conversation, so a run parked on
// task_wait(['user_input']) wakes. Other replies, and missions with a topic or no longer running, keep DM routing.
import { afterEach, describe, expect, it } from 'vitest';
import type { MissionModule, MissionService } from '../../../src/contracts/index.ts';
import { NOOP_FACTORIES, notImplemented } from '../../harness/fakes.ts';
import { TEST_USER, U } from '../../harness/updates.ts';
import { createSurfacesApp, lastButtons, type SurfacesTestApp } from '../../unit/surfaces/env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(mission: { threadId: number | null; status: string }) {
  const missions = (s: never): MissionModule => ({
    ...NOOP_FACTORIES.createMissionModule(s),
    missions: notImplemented<MissionService>('missions', { get: (id: string) => (id === 'MFALL01' ? ({ id, ...mission }) as never : undefined) }),
  });
  const app = await createSurfacesApp({ factories: { createMissionModule: missions as never } });
  t = app;
  await app.send(U.start());
  const user = app.s.repos.users.getByTg(TEST_USER.id)!;
  app.s.repos.users.update(user.id, { onboardingStep: 'done', tz: 'Asia/Almaty', tzSource: 'manual' });
  const dm = app.s.conversations.resolve({ kind: 'dm', tgUserId: TEST_USER.id }, { userId: user.id, tgChatId: TEST_USER.id });
  const mconv = app.s.conversations.resolve({ kind: 'mission', missionId: 'MFALL01' }, { userId: user.id, tgChatId: TEST_USER.id });
  app.s.telegram.links.record({ chatId: TEST_USER.id, messageId: 7_001, kind: 'status', userId: user.id, conversationId: mconv.id });
  app.s.telegram.links.record({ chatId: TEST_USER.id, messageId: 7_002, kind: 'answer', userId: user.id, conversationId: dm.id });
  return { app, dm, mconv };
}

describe('owner replies reach a topic-less mission (F8)', () => {
  it('a reply to the mission status card goes to mission:<id>; a reply to a DM answer stays in the DM', async () => {
    const { app, dm, mconv } = await setup({ threadId: null, status: 'parked' });
    await app.send(U.replyToCard('the 21st works for me', 7_001));
    expect(app.s.repos.inputs.pending(mconv.id)).toHaveLength(1);
    expect(app.s.repos.inputs.pending(dm.id)).toHaveLength(0);
    expect(app.runner.kicks.at(-1)).toBe(mconv.id);
    await app.send(U.replyToCard('and this one is for you', 7_002));
    expect(app.s.repos.inputs.pending(dm.id)).toHaveLength(1);
  });
  it('a mission with a topic, or one that already ended, keeps DM routing', async () => {
    for (const m of [{ threadId: 55, status: 'active' }, { threadId: null, status: 'cancelled' }]) {
      const { app, dm, mconv } = await setup(m);
      await app.send(U.replyToCard('hello', 7_001));
      expect(app.s.repos.inputs.pending(mconv.id)).toHaveLength(0);
      expect(app.s.repos.inputs.pending(dm.id)).toHaveLength(1);
      await app.close();
      t = null;
    }
  });
});
