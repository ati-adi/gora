// WP3 — the fallback (non-streaming) reply channel used until app.ts attaches the Telegram ChannelFactory, and the demo
// transport (no LLM key, never in production).
import { describe, expect, it } from 'vitest';
import type { ConversationRow, MainRequest, RunRow, Services } from '../../../src/contracts/index.ts';
import { FakeClock } from '../../../src/kernel/clock.ts';
import { createFallbackChannelFactory } from '../../../src/agent/fallbackChannel.ts';
import { DEMO_NOTICE_EN, DEMO_NOTICE_RU, createDemoTransport } from '../../../src/agent/demoTransport.ts';

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };

function setup(channel: RunRow['channel'] = 'dm_stream') {
  const sent: Array<{ target: Record<string, unknown>; md: string; markup?: unknown }> = [];
  const s = {
    log,
    strings: { t: (k: string) => k },
    repos: { users: { getById: () => ({ languageCode: 'en' }) } },
    telegram: {
      render: {
        sanitize: (md: string) => md.replace(/\[([^\]]+)\]\(https?:\/\/evil\.example[^)]*\)/g, '$1'),
        sendMarkdown: async (target: Record<string, unknown>, md: string, o?: { replyMarkup?: unknown }) => {
          sent.push({ target, md, ...(o?.replyMarkup ? { markup: o.replyMarkup } : {}) });
          return [{ chatId: 1001, messageId: sent.length, kind: 'rich' as const }];
        },
      },
    },
  } as unknown as Services;
  const run = { id: 'r1', userId: 'u1', channel, replyRef: { chatId: 1001, triggerMessageId: 55 } } as unknown as RunRow;
  const ch = createFallbackChannelFactory(s).forRun(run, { kind: 'dm' } as ConversationRow, () => {});
  return { ch, sent };
}

describe('fallback channel', () => {
  it('buffers text, drops reset/retry text, sends ONE sanitized final message with footer and buttons', async () => {
    const { ch, sent } = setup();
    await ch.begin();
    ch.text('discarded');
    ch.resetIteration();
    ch.text('Hello ');
    ch.commitIteration();
    ch.text('partial');
    ch.blockStart({ index: -1, type: 'retry' });
    ch.text('see [x](https://evil.example/a)');
    expect(ch.visibleText).toBe('Hello see [x](https://evil.example/a)');
    const refs = await ch.finalize({ footerLines: ['⏳ Send email (A1)'], effects: [{ kind: 'line', markdown: '✅ Reminder set' }, { kind: 'buttons', rows: [[{ text: 'Continue ▶', callback_data: 'ct:c1' }]] }], allowedLinkHosts: new Set(), allowedEmails: new Set() });
    expect(refs).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.md).toBe('Hello see x\n\n✅ Reminder set\n\n⏳ Send email (A1)');
    expect(sent[0]!.target).toMatchObject({ chatId: 1001, replyTo: 55 });
    expect(sent[0]!.markup).toEqual({ inline_keyboard: [[{ text: 'Continue ▶', callback_data: 'ct:c1' }]] });
  });
  it('stopped() sends the partial plus the stopped string; guest/biz channels stay silent', async () => {
    const a = setup();
    a.ch.text('half');
    await a.ch.stopped();
    expect(a.sent[0]!.md).toBe('half\n\nstopped');
    const g = setup('guest');
    g.ch.text('x');
    expect(await g.ch.finalize({ footerLines: [], effects: [], allowedLinkHosts: new Set(), allowedEmails: new Set() })).toEqual([]);
    expect(g.sent).toEqual([]);
  });
});

describe('demo transport', () => {
  const req = (text: string) => ({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }) as unknown as MainRequest;
  it('streams a deterministic notice in the user language; parse → null; never tool calls', async () => {
    const t = createDemoTransport(new FakeClock());
    const out: string[] = [];
    const r = await t.stream(req('hello'), { onText: (d) => void out.push(d) }, new AbortController().signal);
    expect(out.join('')).toBe(DEMO_NOTICE_EN);
    expect(r.message.stop_reason).toBe('end_turn');
    expect((await t.create(req('привет'))).message.content[0]).toMatchObject({ text: DEMO_NOTICE_RU });
    expect((await t.parse({ purpose: 'title', system: 's', user: 'u', schema: {} as never })).parsed).toBeNull();
    expect(t.mode).toBe('demo');
  });
});
