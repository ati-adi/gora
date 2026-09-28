// INTEGRATION (F1): a mission run makes no further model call once its mission is done / failed / cancelled (a run that
// outlived Stop or mission_finish), and it ends with a non-budget stop category (no MISSION_BUDGET_MARK).
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { MissionService, ToolSpec } from '../../../src/contracts/index.ts';
import { MISSION_BUDGET_MARK, MISSION_ENDED_MARK } from '../../../src/agent/engine.ts';
import { notImplemented, NOOP_FACTORIES } from '../../harness/fakes.ts';
import { say, turn } from '../../harness/scriptedTransport.ts';
import type { TestApp } from '../../harness/testApp.ts';
import { agentApp } from '../agent/_app.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('mission run after the mission ended (F1)', () => {
  for (const ended of ['cancelled', 'done', 'failed'] as const) {
    it(`status ${ended} mid-run → no second model call, stopCategory system_stop`, async () => {
      const state = { status: 'active' as string };
      const flip: ToolSpec = {
        name: 'mission_report', description: 'test', input: z.object({}), surfaces: ['dm', 'topic', 'mission'], parallelSafe: true,
        classify: () => ({ actionClass: 'control', risk: 0 }), statusLabel: () => '',
        execute: async () => {
          state.status = ended; // Stop / mission_finish lands while the run is in its tool round
          return { content: 'ok' };
        },
      } as unknown as ToolSpec;
      const x = await agentApp({
        specs: [flip],
        factories: {
          createMissionModule: (s) => ({
            ...NOOP_FACTORIES.createMissionModule(s as never),
            missions: notImplemented<MissionService>('missions', { get: () => ({ status: state.status }) as never, chargeCost: () => ({ exhausted: false }) as never }),
          }),
        },
      });
      app = x.t;
      const conv = x.t.s.conversations.resolve({ kind: 'mission', missionId: 'MTEST01' }, { userId: x.user.id, tgChatId: 1001 });
      expect(conv.route).toBe('mission');
      x.t.llm.push(turn().toolUse('mission_report', {}).build(), say('SHOULD NOT BE SENT'));
      const runId = x.runner.startEventRun(conv.id, { type: 'mission_start', ref: 'MTEST01', body: 'go' }, { channel: 'notify', priority: 'background', replyRef: { chatId: 1001, missionId: 'MTEST01' } });
      await x.t.settle();
      const run = x.t.s.repos.runs.get(runId)!;
      expect(x.t.llm.requests).toHaveLength(1);
      expect(run.stopCategory).toBe('system_stop');
      const texts = JSON.stringify(x.t.s.repos.messages.load(conv.id, x.t.s.repos.conversations.get(conv.id)!.epoch).map((r) => r.content));
      expect(texts).toContain(MISSION_ENDED_MARK);
      expect(texts).not.toContain(MISSION_BUDGET_MARK);
    });
  }
});
