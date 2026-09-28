// spec 05 set P — trust S08/S09 in friend mode: memory writes follow memoryEnabled (null consent = on; declined = off;
// incognito denies), S09 is gone (a guessed zone never blocks scheduling), and the executor adds ONE lazy tz web_app
// button to a successful time-dependent tool while tz_source = 'default', at most once per LIMITS.tzHintEveryMs.
import { afterEach, describe, expect, it } from 'vitest';
import type { BetaToolUseBlock, ProposedAction, ToolSpec } from '../../../src/contracts/index.ts';
import { evaluateRules } from '../../../src/trust/rules.ts';
import { makeEnv, fakeNoteTool, signal, use, type Env } from './env.ts';

let env: Env | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

const memWrite: ProposedAction = { toolName: 'memory_save', toolUseId: 't', cls: { actionClass: 'memory', risk: 1 }, targets: [], surface: 'dm', phase: 'propose' };
const reminderLike = (): ToolSpec => ({ ...fakeNoteTool(), name: 'reminder_create', surfaces: ['dm', 'topic', 'mission', 'group'] });

describe('S08 / S09 (05 B1, A6)', () => {
  it('S08: never asked (null) = on; declined = off; incognito denies', () => {
    env = makeEnv([]);
    const { s } = env;
    const on = env.addUser(1001, { memoryConsent: null });
    const off = env.addUser(1002, { memoryConsent: false });
    const inc = env.addUser(1003, { memoryConsent: null, incognitoUntil: env.clock.now() + 3_600_000 });
    const decide = (userId: string) => evaluateRules(memWrite, s.sentinel.snapshot(userId, null, memWrite), { surfaceAllowed: true });
    expect(s.sentinel.snapshot(on.id, null, memWrite).memoryConsent).toBe(true);
    expect(decide(on.id)).toMatchObject({ kind: 'allow', ruleId: 'S19' });
    expect(decide(off.id)).toMatchObject({ kind: 'deny', ruleId: 'S08', code: 'memory_off' });
    expect(decide(inc.id)).toMatchObject({ kind: 'deny', ruleId: 'S08', reason: 'Incognito is on' });
  });

  it('S09 is gone: a time-dependent write runs on the guessed zone and carries one lazy tz button, once per 7 days', async () => {
    env = makeEnv([reminderLike()]);
    const u = env.addUser(1001, { tzSource: 'default', tz: 'UTC' });
    const { conv, run } = env.addConv(u);
    const round = async (id: string) => {
      return env!.s.executor.processRound(run, conv, 1, [use(id, 'reminder_create', { text: 'x' })] as BetaToolUseBlock[], null as never, signal());
    };
    const tzButtons = (effects: Array<{ kind: string; rows?: unknown }>) => effects.filter((e) => e.kind === 'buttons' && JSON.stringify(e.rows).includes('screen=tz'));
    const o1 = await round('t1');
    expect(String(o1.results[0]!.content)).toBe('saved');
    expect(tzButtons(o1.effects)).toEqual([{ kind: 'buttons', rows: [[{ text: 'tz_hint_button', web_app: { url: 'https://gora.test/app/?screen=tz' } }]] }]);
    expect(env.repos.users.getById(u.id)!.tzHintAt).toBe(env.clock.now());
    expect(env.notices.tz).toEqual([]); // no deny side card any more
    expect(tzButtons((await round('t2')).effects)).toEqual([]);
    await env.clock.advance(7 * 86_400_000 + 1);
    expect(tzButtons((await round('t3')).effects)).toHaveLength(1);
    // a confirmed zone never gets the button
    env.repos.users.update(u.id, { tzSource: 'miniapp', tzHintAt: null });
    expect(tzButtons((await round('t4')).effects)).toEqual([]);
  });

  it('no hint for other tools, failed calls, or group surfaces', async () => {
    const failing: ToolSpec = { ...reminderLike(), name: 'reminder_manage', async execute() { return { content: 'nope', isError: true }; } };
    env = makeEnv([fakeNoteTool(), failing]);
    const u = env.addUser(1001, { tzSource: 'default', tz: 'UTC' });
    const { conv, run } = env.addConv(u);
    const out = await env.s.executor.processRound(run, conv, 1, [use('a', 'note_save', { text: 'x' }), use('b', 'reminder_manage', { text: 'y' })] as BetaToolUseBlock[], null as never, signal());
    expect(out.effects.filter((e) => e.kind === 'buttons')).toEqual([]);
    expect(env.repos.users.getById(u.id)!.tzHintAt).toBeNull();
  });
});
