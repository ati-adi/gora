import { describe, expect, it } from 'vitest';
import type { Classification, Decision, ProposedAction, SentinelSnapshot, Target } from '../../../src/contracts/index.ts';
import { evaluateRules } from '../../../src/trust/rules.ts';
import { consultLlmSentinel, shouldConsult } from '../../../src/trust/llmSentinel.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { nullLogger } from '../../../src/kernel/log.ts';
import { FakeLlmSentinel } from '../../harness/fakes.ts';

const NOW = 1_800_000_000_000;
const tgt = (value: string, provenance: Target['provenance'] = 'user', sourceLabel?: string): Target => ({ kind: 'email', value, hmac: `h:${value}`, provenance, ...(sourceLabel ? { sourceLabel } : {}) });

function snap(p: Partial<SentinelSnapshot> = {}): SentinelSnapshot {
  return {
    userStatus: 'active', memoryConsent: true, incognito: false, tzConfirmed: true,
    permissions: { gmail: 'act', gcal: 'act' }, connected: { gmail: true, gcal: true },
    grants: [], trustedTargetHmacs: new Set(), taint: new Set(), quotaOk: () => true, business: null, now: NOW, ...p,
  };
}
function act(cls: Partial<Classification> & Pick<Classification, 'actionClass'>, p: Partial<ProposedAction> = {}): ProposedAction {
  return { toolName: 'gmail_send_draft', toolUseId: 't1', cls: { risk: 1, ...cls }, targets: [], surface: 'dm', phase: 'propose', ...p };
}
const grant = (hmac: string, tool = 'gmail_send_draft', expiresAt: number | null = null) => ({ id: `g_${hmac}`, toolName: tool, targetHmac: hmac, scope: 'always' as const, expiresAt });
const send = (targets: Target[], extra: Partial<Classification> = {}) => act({ actionClass: 'send_external', risk: 2, integration: 'gmail', requiredLevel: 'act', ...extra }, { targets });

type Row = [string, ProposedAction, SentinelSnapshot, Partial<Decision> & { kind: Decision['kind']; ruleId: string }, { surfaceAllowed?: boolean }?];

const rows: Row[] = [
  ['S01 paused blocks a write', act({ actionClass: 'write_self' }), snap({ userStatus: 'paused' }), { kind: 'deny', ruleId: 'S01', code: 'paused' } as never],
  ['S01 paused still allows reads', act({ actionClass: 'read_private' }), snap({ userStatus: 'paused' }), { kind: 'allow', ruleId: 'S18' }],
  ['S02 surface', act({ actionClass: 'read_public' }), snap(), { kind: 'deny', ruleId: 'S02', code: 'surface' } as never, { surfaceAllowed: false }],
  ['S03 not connected', send([tgt('a@x.com')]), snap({ connected: { gmail: false, gcal: true } }), { kind: 'deny', ruleId: 'S03', code: 'not_connected' } as never],
  ['S04 permission below required', send([tgt('a@x.com')]), snap({ permissions: { gmail: 'draft', gcal: 'act' } }), { kind: 'deny', ruleId: 'S04', code: 'permission' } as never],
  ['S05 spend', act({ actionClass: 'spend' }), snap(), { kind: 'deny', ruleId: 'S05', code: 'forbidden_v1' } as never],
  ['S05 risk 4', act({ actionClass: 'write_self', risk: 4 }), snap(), { kind: 'deny', ruleId: 'S05' }],
  ['S06 quota', act({ actionClass: 'read_public', quotaKind: 'web_search' }), snap({ quotaOk: (k) => k !== 'web_search' }), { kind: 'deny', ruleId: 'S06', code: 'quota' } as never],
  ['S06 cost cap on a write', act({ actionClass: 'write_self' }), snap({ quotaOk: (k) => k !== 'cost_micros' }), { kind: 'deny', ruleId: 'S06' }],
  ['S07 business window closed', act({ actionClass: 'send_external', integration: 'business', businessRef: { connectionId: 'c', chatId: 1 } }), snap({ business: { consented: true, enabled: true, canReply: true, windowOpen: false } }), { kind: 'deny', ruleId: 'S07', code: 'business' } as never],
  ['S07 business not consented', act({ actionClass: 'send_external', integration: 'business', businessRef: { connectionId: 'c', chatId: 1 } }), snap({ business: null }), { kind: 'deny', ruleId: 'S07' }],
  ['S08 memory write while incognito', act({ actionClass: 'memory' }, { toolName: 'memory_save' }), snap({ incognito: true }), { kind: 'deny', ruleId: 'S08', code: 'memory_off' } as never],
  ['S08 forgetting is allowed while memory is off', act({ actionClass: 'memory' }, { toolName: 'memory_forget' }), snap({ memoryConsent: false }), { kind: 'allow', ruleId: 'S19' }],
  // spec 05 A6: S09 was removed — an unconfirmed (best-guess) zone no longer blocks scheduling.
  ['S09 removed: tz unconfirmed (reminder) is allowed', act({ actionClass: 'write_self' }, { toolName: 'reminder_create' }), snap({ tzConfirmed: false }), { kind: 'allow', ruleId: 'S17' }],
  ['S09 removed: tz unconfirmed (calendar write) is not denied', act({ actionClass: 'write_self', integration: 'gcal', requiredLevel: 'act' }, { toolName: 'calendar_create_event' }), snap({ tzConfirmed: false }), { kind: 'allow', ruleId: 'S17' }],
  ['S10 bulk recipients', send([tgt('a@x.com')], { bulkCount: 6 }), snap(), { kind: 'ask', ruleId: 'S10', grantable: false }],
  ['S11 destructive is once only', act({ actionClass: 'destructive', risk: 3 }), snap(), { kind: 'ask', ruleId: 'S11', grantable: false }],
  ['S12 business is never grantable', act({ actionClass: 'send_external', integration: 'business', businessRef: { connectionId: 'c', chatId: 1 } }, { toolName: 'business_draft_reply' }), snap({ business: { consented: true, enabled: true, canReply: true, windowOpen: true } }), { kind: 'ask', ruleId: 'S12', grantable: false }],
  ['S13 an untrusted target warns and is not grantable', send([tgt('x@evil.com', 'untrusted', 'an email')]), snap({ grants: [grant('h:x@evil.com')] }), { kind: 'ask', ruleId: 'S13', grantable: false }],
  ['S14 a tainted run ignores grants', send([tgt('a@x.com', 'memory')]), snap({ taint: new Set(['email']), grants: [grant('h:a@x.com')] }), { kind: 'ask', ruleId: 'S14', grantable: false }],
  ['S15 a matching grant for every target allows', send([tgt('a@x.com', 'memory')]), snap({ grants: [grant('h:a@x.com')] }), { kind: 'allow', ruleId: 'S15' }],
  ['S15 needs every target', send([tgt('a@x.com', 'memory'), tgt('b@x.com')]), snap({ grants: [grant('h:a@x.com')] }), { kind: 'ask', ruleId: 'S16' }],
  ['S15 expired grant does not count', send([tgt('a@x.com')]), snap({ grants: [grant('h:a@x.com', 'gmail_send_draft', NOW - 1)] }), { kind: 'ask', ruleId: 'S16' }],
  ['S16 send asks, grantable for trusted provenance', send([tgt('a@x.com', 'approved')]), snap(), { kind: 'ask', ruleId: 'S16', grantable: true }],
  ['S16 business_chat provenance is not ladder-eligible', send([tgt('a@x.com', 'business_chat')]), snap(), { kind: 'ask', ruleId: 'S16', grantable: false }],
  ['S17 write_self allows with undo', act({ actionClass: 'write_self' }, { toolName: 'todo_manage' }), snap(), { kind: 'allow', ruleId: 'S17', undo: true } as never],
  ['S18 compute', act({ actionClass: 'compute' }), snap(), { kind: 'allow', ruleId: 'S18' }],
  ['S19 memory with consent', act({ actionClass: 'memory' }, { toolName: 'memory_save' }), snap(), { kind: 'allow', ruleId: 'S19' }],
  ['execute phase: approved card allows (A01)', send([tgt('x@evil.com', 'untrusted')], {}), snap({ taint: new Set(['email']) }), { kind: 'allow', ruleId: 'A01' }],
  ['execute phase: /pause still wins', act({ actionClass: 'send_external', integration: 'gmail', requiredLevel: 'act' }, { phase: 'execute', approvedPendingActionId: 'ABC123' }), snap({ userStatus: 'paused' }), { kind: 'deny', ruleId: 'S01' }],
];
// the A01 row runs in phase execute
rows[28]![1] = { ...rows[28]![1], phase: 'execute', approvedPendingActionId: 'ABC123' };

describe('Sentinel rules S01–S99 (01 §11.1)', () => {
  for (const [name, a, s, want, env] of rows) {
    it(name, () => {
      const d = evaluateRules(a, s, { surfaceAllowed: env?.surfaceAllowed ?? true, lang: 'en' });
      expect(d).toMatchObject(want);
    });
  }

  it('S13 warning names the source, never the recipient', () => {
    const d = evaluateRules(send([tgt('x@evil.com', 'untrusted', 'an email')]), snap());
    expect(d.kind).toBe('ask');
    const w = d.kind === 'ask' ? d.warnings.join('\n') : '';
    expect(w).toContain('This recipient came from an email, not from you');
    expect(w).not.toContain('evil.com');
  });

  it('first match wins: paused beats not-connected', () => {
    const d = evaluateRules(send([tgt('a@x.com')]), snap({ userStatus: 'paused', connected: { gmail: false, gcal: false } }));
    expect(d.ruleId).toBe('S01');
  });

  it('S99 catches anything else', () => {
    const d = evaluateRules(act({ actionClass: 'weird' as never }), snap());
    expect(d).toMatchObject({ kind: 'ask', ruleId: 'S99' });
  });
});

describe('LLM Sentinel (03 R5): can only make decisions stricter', () => {
  const allow: Decision = { kind: 'allow', ruleId: 'S17', reason: 'x', undo: true };
  const base = { actionClass: 'write_self' as const, tainted: true, eventRun: false, tool: 'todo_manage', input: { a: 1 }, ownerText: 'add milk', taint: ['email' as const] };
  const deps = (cap: FakeLlmSentinel | undefined, enabled = true) => ({ cap, enabled, clock: new FakeClock(), log: nullLogger, safetyLine: (r: string) => `⚠ Safety check: ${r}` });

  it('is consulted only for allow + risky class + (tainted or event run)', () => {
    expect(shouldConsult({ decision: allow, actionClass: 'write_self', tainted: true, eventRun: false })).toBe(true);
    expect(shouldConsult({ decision: allow, actionClass: 'write_self', tainted: false, eventRun: true })).toBe(true);
    expect(shouldConsult({ decision: allow, actionClass: 'write_self', tainted: false, eventRun: false })).toBe(false);
    expect(shouldConsult({ decision: allow, actionClass: 'read_private', tainted: true, eventRun: false })).toBe(false);
  });

  it('violation → ask with a Safety check warning', async () => {
    const cap = new FakeLlmSentinel();
    cap.verdict = { violation: true, rationale: 'recipient not from owner' };
    const d = await consultLlmSentinel(deps(cap), { ...base, decision: allow });
    expect(d).toMatchObject({ kind: 'ask', grantable: false, warnings: ['⚠ Safety check: recipient not from owner'] });
  });

  it('null / error → ask; no violation → unchanged', async () => {
    const cap = new FakeLlmSentinel();
    cap.verdict = null;
    expect((await consultLlmSentinel(deps(cap), { ...base, decision: allow })).kind).toBe('ask');
    cap.verdict = { violation: false, rationale: 'ok' };
    expect(await consultLlmSentinel(deps(cap), { ...base, decision: allow })).toBe(allow);
  });

  it('never turns ask or deny into allow, and is off without a Groq key', async () => {
    const cap = new FakeLlmSentinel();
    const ask: Decision = { kind: 'ask', ruleId: 'S16', reason: 'x', grantable: true, warnings: [] };
    expect(await consultLlmSentinel(deps(cap), { ...base, decision: ask })).toBe(ask);
    cap.verdict = { violation: true, rationale: 'x' };
    expect(await consultLlmSentinel(deps(cap, false), { ...base, decision: allow })).toBe(allow);
    expect(cap.calls).toHaveLength(0);
  });

  it('times out after 3 s → ask', async () => {
    const clock = new FakeClock();
    const cap = { check: () => new Promise<never>(() => {}) };
    const p = consultLlmSentinel({ cap, enabled: true, clock, log: nullLogger, safetyLine: (r) => r }, { ...base, decision: allow });
    await clock.advance(3_000);
    expect((await p).kind).toBe('ask');
  });

  it('clips input to 2 000 and owner text to 500 chars', async () => {
    const cap = new FakeLlmSentinel();
    await consultLlmSentinel(deps(cap), { ...base, decision: allow, input: { t: 'x'.repeat(5000) }, ownerText: 'y'.repeat(900) });
    expect(cap.calls[0]!.input.length).toBe(2000);
    expect(cap.calls[0]!.ownerText.length).toBe(500);
  });
});
