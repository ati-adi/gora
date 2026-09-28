// WP3 — SideCalls over transport.parse: static prompts, default priority 'background', usage recorded with CallMeta,
// invented ids dropped, parse failures → null, transient errors propagate; the Groq handoff note is capped at 250 words.
import { describe, expect, it } from 'vitest';
import type { LlmCallRecord, Services } from '../../../src/contracts/index.ts';
import { PROVIDER_PROFILES } from '../../../src/config.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { TransientLlmError } from '../../../src/kernel/errors.ts';
import { createSideCalls, ExtractSchema } from '../../../src/agent/side.ts';
import { SIDE_PROMPTS } from '../../../src/agent/prompt/side.ts';
import { ScriptedTransport } from '../../harness/scriptedTransport.ts';

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

function services(transport = new ScriptedTransport()) {
  const calls: LlmCallRecord[] = [];
  const usage: Array<{ userId: string; costMicros: number }> = [];
  const s = {
    config: { profile: PROVIDER_PROFILES['groq-free'], anthropic: { sideModel: 'claude-haiku-5', pricingOverrides: null } },
    transport, log, clock: new FakeClock(),
    crypto: { hmac: (_d: string, v: string) => `h${v.length}` },
    repos: { runs: { recordLlmCall: (c: LlmCallRecord) => void calls.push(c) } },
    quotas: { recordUsage: (userId: string, u: { costMicros: number }) => void usage.push({ userId, costMicros: u.costMicros }) },
  } as unknown as Services;
  return { s, transport, calls, usage };
}

describe('SideCalls', () => {
  it('triage: static prompt, background priority by default, usage recorded against the user', async () => {
    const x = services();
    x.transport.pushParse('triage', { needs_reply: true, urgency: 2, summary: 'Asks about the invoice.', category: 'question', commitment: null });
    const side = createSideCalls(x.s);
    const r = await side.triage({ transcript: '<untrusted>…</untrusted>', peerName: 'Aida', nowLocal: '2026-09-28T14:00', lang: 'en' }, { userId: 'u1', conversationId: 'c1' });
    expect(r).toMatchObject({ needs_reply: true, urgency: 2 });
    expect(x.transport.parseRequests[0]!.system).toBe(SIDE_PROMPTS.triage);
    expect(x.transport.callOpts[0]).toEqual({ kind: 'parse', opts: { priority: 'background' } });
    expect(x.calls[0]).toMatchObject({ purpose: 'side', userId: 'u1', conversationId: 'c1', modelRequested: 'openai/gpt-oss-20b' });
    expect(x.usage[0]!.userId).toBe('u1');
  });

  it('extract: facts/commitments with invented source ids are dropped; unknown supersedes ids nulled', async () => {
    const x = services();
    x.transport.pushParse('extract', {
      facts: [
        { text: 'Vegetarian.', kind: 'preference', subject: null, sensitivity: 'normal', confidence: 0.9, source_input_id: 'in_1', supersedes_id: 'm_9', explicit: false },
        { text: 'Made up.', kind: 'fact', subject: null, sensitivity: 'normal', confidence: 0.5, source_input_id: 'in_404', supersedes_id: null, explicit: false },
      ],
      commitments: [{ text: 'Send the deck', direction: 'i_owe', counterpart: 'Anna', due_local: null, source_input_id: 'in_404' }],
    });
    const r = await createSideCalls(x.s).extract({ inputs: [{ id: 'in_1', text: 'I am vegetarian' }], existing: [{ id: 'm_1', text: 'x' }], nowLocal: 'n', lang: 'en' }, { priority: 'interactive' });
    expect(r!.facts).toHaveLength(1);
    expect(r!.facts[0]!.supersedes_id).toBeNull();
    expect(r!.commitments).toEqual([]);
    expect(x.transport.callOpts[0]!.opts).toEqual({ priority: 'interactive' });
  });

  it('extract (spec 05 B1): importance and ttl_days pass through; both optional for older answers', async () => {
    const x = services();
    x.transport.pushParse('extract', {
      facts: [
        { text: 'Tired this week.', kind: 'fact', subject: null, sensitivity: 'normal', confidence: 0.9, source_input_id: 'in_1', supersedes_id: null, explicit: false, importance: 0.3, ttl_days: 5 },
        { text: 'Sister Anna.', kind: 'person', subject: 'Anna', sensitivity: 'normal', confidence: 0.9, source_input_id: 'in_1', supersedes_id: null, explicit: false, importance: 0.9, ttl_days: null },
        { text: 'Old shape.', kind: 'fact', subject: null, sensitivity: 'normal', confidence: 0.9, source_input_id: 'in_1', supersedes_id: null, explicit: false },
      ],
      commitments: [],
    });
    const r = await createSideCalls(x.s).extract({ inputs: [{ id: 'in_1', text: 'x' }], existing: [], nowLocal: 'n', lang: 'en' });
    expect(r!.facts.map((f) => [f.importance, f.ttl_days])).toEqual([[0.3, 5], [0.9, null], [undefined, undefined]]);
    expect(x.transport.parseRequests[0]!.system).toContain('importance 0..1');
    expect(ExtractSchema.safeParse({ facts: [{ text: 'a', kind: 'fact', subject: null, sensitivity: 'normal', confidence: 1, source_input_id: 'i', supersedes_id: null, explicit: false, importance: 2 }], commitments: [] }).success).toBe(false);
  });

  it('title strips quotes and punctuation; null when unparsable; importFacts → [] on null', async () => {
    const x = services();
    x.transport.pushParse('title', { title: '"Tokyo trip."' });
    x.transport.pushParse('title', null);
    const side = createSideCalls(x.s);
    expect(await side.topicTitle('Plan my Tokyo trip', 'en')).toBe('Tokyo trip');
    expect(await side.topicTitle('???', 'en')).toBeNull();
    expect(await side.importFacts('notes', 'en')).toEqual([]);
  });

  it('transient errors propagate (a job can retry); other errors become null', async () => {
    const t = new ScriptedTransport();
    t.parse = async () => {
      throw new TransientLlmError('rate_limit');
    };
    await expect(createSideCalls(services(t).s).semanticCheck('price < 100', 'a', 'b')).rejects.toBeInstanceOf(TransientLlmError);
    const t2 = new ScriptedTransport();
    t2.parse = async () => {
      throw new Error('boom');
    };
    expect(await createSideCalls(services(t2).s).semanticCheck('x', 'a', 'b')).toBeNull();
  });

  it('handoffNote (Groq): purpose handoff, recorded as handoff, capped at 250 words; exclusions passed transiently', async () => {
    const x = services();
    x.transport.pushParse('handoff', { note: Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ') });
    const note = await createSideCalls(x.s).handoffNote('Owner: hi', ['likes green tea'], 'en', { userId: 'u1' });
    expect(note!.split(/\s+/).length).toBeLessThanOrEqual(251);
    expect(x.transport.parseRequests[0]!.user).toContain('exclude:\n- likes green tea');
    expect(x.calls[0]!.purpose).toBe('handoff');
  });
});
