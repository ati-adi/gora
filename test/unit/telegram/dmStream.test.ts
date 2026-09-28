// WP2 — dm_stream channel (01 §15.2): ≤ 1 draft per 700 ms; keep-alive at 15 s; status tail; the same draft_id across
// updates; a 400 on the rich draft moves to plain drafts with a new id; the 429 backoff; the finalize split; the fallback
// chain rich → entities → plain; Stop sends the partial plus ⏹. Plus 03 R1/R8 retry/busy block starts and R4 voice replies.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReplyChannel } from '../../../src/contracts/index.ts';
import { drafts, makeConv, makeEnv, makeRun, makeUser, step, type Env } from './helpers.ts';

let e: Env;
let draftIds: number[];
const open = (run = makeRun(), conv = makeConv()): ReplyChannel => e.mod.channels.forRun(run, conv, (d) => draftIds.push(d));
const fin = { footerLines: [], effects: [], allowedLinkHosts: new Set<string>(), allowedEmails: new Set<string>() };
const E400 = { error_code: 400, description: 'Bad Request: can\'t parse rich message' };
const E429 = { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } };

beforeEach(async () => {
  e = await makeEnv();
  draftIds = [];
});
afterEach(async () => {
  await e.close();
});

describe('dm_stream drafts (F2)', () => {
  it('starts with a rich Thinking… draft (can_stop, keep_on_stop) and reports the draft id', async () => {
    const ch = open(makeRun({ replyRef: { chatId: 1001, threadId: 77 } }));
    await ch.begin();
    const [first] = drafts(e.tg);
    expect(first!.method).toBe('sendRichMessageDraft');
    expect(first!.payload).toMatchObject({ chat_id: 1001, message_thread_id: 77, can_stop: true, keep_on_stop: true, rich_message: { markdown: '<tg-thinking>Thinking…</tg-thinking>' } });
    expect(first!.payload.draft_id).toBe(draftIds[0]);
    expect(draftIds[0]).toBeGreaterThan(0);
    expect(draftIds[0]).toBeLessThan(2 ** 31);
  });

  it('sends at most one draft per 700 ms, only on change, always with the same draft_id', async () => {
    const ch = open();
    await ch.begin();
    for (let i = 0; i < 40; i++) {
      ch.text(`word${i} `);
      await step(e.clock, 100);
    }
    await step(e.clock, 2000);
    const ds = drafts(e.tg);
    expect(ds.length).toBeGreaterThan(3);
    for (let i = 1; i < ds.length; i++) expect(ds[i]!.at - ds[i - 1]!.at).toBeGreaterThanOrEqual(700);
    expect(new Set(ds.map((d) => d.payload.draft_id))).toEqual(new Set([draftIds[0]]));
    const last = ds.at(-1)!.payload.rich_message.markdown as string;
    expect(last).toContain('word39');
    // nothing changes → no re-send until the keep-alive
    const n = ds.length;
    await step(e.clock, 5000, 500);
    expect(drafts(e.tg).length).toBe(n);
  });

  it('keeps the draft alive with a re-send every 15 s', async () => {
    const ch = open();
    await ch.begin();
    ch.text('Hello');
    await step(e.clock, 1000);
    const n = drafts(e.tg).length;
    await step(e.clock, 14_000, 500);
    expect(drafts(e.tg).length).toBe(n);
    await step(e.clock, 1500, 500);
    expect(drafts(e.tg).length).toBe(n + 1);
    expect(drafts(e.tg).at(-1)!.payload.rich_message.markdown).toContain('Hello');
  });

  it('shows the tool status as a <tg-thinking> tail', async () => {
    const ch = open();
    await ch.begin();
    ch.text('Let me check.');
    ch.status('Checking your calendar…');
    await step(e.clock, 1000);
    const md = drafts(e.tg).at(-1)!.payload.rich_message.markdown as string;
    expect(md.startsWith('Let me check.')).toBe(true);
    expect(md.endsWith('<tg-thinking>Checking your calendar…</tg-thinking>')).toBe(true);
  });

  it('never switches a draft_id from rich to plain: a 400 moves to sendMessageDraft with a NEW id and empty text', async () => {
    e.tg.failNext('sendRichMessageDraft', E400);
    const ch = open();
    await ch.begin();
    await step(e.clock, 100);
    const ds = drafts(e.tg);
    expect(ds[0]!.method).toBe('sendRichMessageDraft');
    expect(ds[1]!.method).toBe('sendMessageDraft');
    expect(ds[1]!.payload).toMatchObject({ text: '', can_stop: true, keep_on_stop: true });
    expect(ds[1]!.payload.draft_id).not.toBe(ds[0]!.payload.draft_id);
    expect(draftIds).toEqual([ds[0]!.payload.draft_id, ds[1]!.payload.draft_id]);
    ch.text('plain **text**');
    await step(e.clock, 1000);
    const later = drafts(e.tg).slice(2);
    expect(later.every((d) => d.method === 'sendMessageDraft' && d.payload.draft_id === ds[1]!.payload.draft_id)).toBe(true);
    expect(later.at(-1)!.payload.text).toBe('plain text');
  });

  it('falls back to typing actions every 4.5 s when plain drafts fail too', async () => {
    e.tg.failNext('sendRichMessageDraft', E400);
    e.tg.failNext('sendMessageDraft', E400);
    const ch = open();
    await ch.begin();
    ch.text('x');
    await step(e.clock, 10_000, 250);
    const actions = e.tg.callsOf('sendChatAction');
    expect(actions.length).toBeGreaterThanOrEqual(3);
    expect(actions[0]!.payload).toMatchObject({ chat_id: 1001, action: 'typing' });
    expect(actions[1]!.at - actions[0]!.at).toBe(4500);
    expect(drafts(e.tg).length).toBe(2);
  });

  it('⚠U3: a 429 doubles the interval (cap 3 s); three consecutive 429s stop drafts for the run', async () => {
    const ch = open();
    await ch.begin();
    e.tg.failNext('sendRichMessageDraft', E429, 1);
    ch.text('a');
    await step(e.clock, 800);
    ch.text('b');
    await step(e.clock, 3000);
    const ds = drafts(e.tg);
    // begin, the 429, then the retry ≥ 1400 ms after the 429
    expect(ds.length).toBeGreaterThanOrEqual(3);
    expect(ds[2]!.at - ds[1]!.at).toBeGreaterThanOrEqual(1400);
    // three in a row → typing only
    e.tg.failNext('sendRichMessageDraft', E429, 3);
    for (let i = 0; i < 6; i++) {
      ch.text(`c${i}`);
      await step(e.clock, 3100, 100);
    }
    const n = drafts(e.tg).length;
    ch.text('more');
    await step(e.clock, 10_000, 250);
    expect(drafts(e.tg).length).toBe(n);
    expect(e.tg.callsOf('sendChatAction').length).toBeGreaterThan(0);
    // the final message still goes out
    await ch.finalize(fin);
    expect(e.tg.byMethod('sendRichMessage').at(-1).rich_message.markdown).toContain('more');
  });

  it('03 R1/R8: a retry block start discards the partial text; busy shows the busy_retrying status', async () => {
    const ch = open();
    await ch.begin();
    ch.text('Good. ');
    ch.commitIteration();
    ch.text('half-baked');
    await step(e.clock, 800);
    ch.blockStart({ index: -1, type: 'retry' });
    expect(ch.visibleText).toBe('Good. ');
    await step(e.clock, 800);
    expect(drafts(e.tg).at(-1)!.payload.rich_message.markdown).not.toContain('half-baked');
    ch.blockStart({ index: -1, type: 'busy', name: '12' });
    await step(e.clock, 800);
    expect(drafts(e.tg).at(-1)!.payload.rich_message.markdown).toContain('<tg-thinking>busy_retrying(seconds=12)</tg-thinking>');
    ch.text('clean');
    await ch.finalize(fin);
    expect(e.tg.byMethod('sendRichMessage').at(-1).rich_message.markdown).toBe('Good. clean');
  });

  it('checkpoint() persists the visible text and later text uses a new draft_id', async () => {
    const ch = open();
    await ch.begin();
    ch.text('Before the card.');
    ch.commitIteration();
    await ch.checkpoint();
    expect(e.tg.byMethod('sendRichMessage').at(-1).rich_message.markdown).toBe('Before the card.');
    ch.text('After.');
    await step(e.clock, 1000);
    expect(draftIds).toHaveLength(2);
    expect(drafts(e.tg).at(-1)!.payload.draft_id).toBe(draftIds[1]);
    expect(drafts(e.tg).at(-1)!.payload.rich_message.markdown).toBe('After.');
    expect(ch.visibleText).toBe('Before the card.\n\nAfter.');
  });

  it('checkpoints automatically when the text passes 30 000 chars', async () => {
    const ch = open();
    await ch.begin();
    ch.text('x '.repeat(15_001));
    await step(e.clock, 1000);
    expect(e.tg.byMethod('sendRichMessage').length).toBeGreaterThanOrEqual(1);
    expect(draftIds).toHaveLength(2);
  });
});

describe('dm_stream finalize', () => {
  it('sanitizes, appends the code-built footer and Undo, and sends with skip_entity_detection', async () => {
    const u = makeUser(e.s);
    const ch = open(makeRun({ userId: u.id }), makeConv({ userId: u.id }));
    await ch.begin();
    ch.text('Done. See [site](https://evil.example/x) and [src](https://cited.example/a) 🔐');
    const refs = await ch.finalize({ ...fin, footerLines: ['✅ Reminder set'], effects: [{ kind: 'line', markdown: '⏰ Tue 15:00', undoId: 'u1' }], allowedLinkHosts: new Set(['cited.example']) });
    const call = e.tg.byMethod('sendRichMessage').at(-1);
    expect(call.rich_message.skip_entity_detection).toBe(true);
    expect(call.rich_message.markdown).toContain('site (link removed)');
    expect(call.rich_message.markdown).toContain('[src](https://cited.example/a)');
    expect(call.rich_message.markdown).toContain('🔒');
    expect(call.rich_message.markdown).toContain('✅ Reminder set\n⏰ Tue 15:00');
    const btn = call.reply_markup.inline_keyboard[0][0];
    expect(btn.text).toBe('undo_button');
    expect(e.s.telegram.codec.decode(btn.callback_data, 1001)).toEqual({ kind: 'ud', parts: ['u1'] });
    expect(refs).toHaveLength(1);
    expect(e.s.telegram.links.byRun('r_1').map((l) => l.kind)).toEqual(['answer']);
  });

  it('splits a long answer (> 450 blocks) into several rich messages, keyboard on the last', async () => {
    const ch = open();
    await ch.begin();
    ch.text(Array.from({ length: 600 }, (_, i) => `- item ${i}`).join('\n'));
    await ch.finalize({ ...fin, effects: [{ kind: 'buttons', rows: [[{ text: 'Continue ▶', callback_data: 'ct:x' }]] }] });
    const sends = e.tg.byMethod('sendRichMessage');
    expect(sends.length).toBe(2);
    expect(sends[0].reply_markup).toBeUndefined();
    expect(sends[1].reply_markup.inline_keyboard[0][0].text).toBe('Continue ▶');
    expect(sends[0].rich_message.markdown).toContain('item 0');
    expect(sends[1].rich_message.markdown).toContain('item 599');
  });

  it('falls back rich → entities → plain (⚠U18: any 400)', async () => {
    const ch1 = open(makeRun({ id: 'r_a' }));
    await ch1.begin();
    ch1.text('**bold** answer');
    e.tg.failNext('sendRichMessage', E400);
    await ch1.finalize(fin);
    const ent = e.tg.byMethod('sendMessage').at(-1);
    expect(ent.text).toBe('bold answer');
    expect(ent.entities).toEqual([{ type: 'bold', offset: 0, length: 4 }]);
    expect(ent.link_preview_options).toEqual({ is_disabled: true });

    const ch2 = open(makeRun({ id: 'r_b' }));
    await ch2.begin();
    ch2.text('**bold** again');
    e.tg.failNext('sendRichMessage', E400);
    e.tg.failNext('sendMessage', E400);
    await ch2.finalize(fin);
    const plain = e.tg.byMethod('sendMessage').at(-1);
    expect(plain.text).toBe('bold again');
    expect(plain.entities).toBeUndefined();
  });

  it('Stop sends the partial text plus ⏹ Stopped', async () => {
    const ch = open();
    await ch.begin();
    ch.text('The first half of');
    await ch.stopped();
    expect(e.tg.byMethod('sendRichMessage').at(-1).rich_message.markdown).toBe('The first half of\n\nstopped');
    // no more drafts after the stop
    const n = drafts(e.tg).length;
    ch.text('late');
    await step(e.clock, 20_000, 1000);
    expect(drafts(e.tg).length).toBe(n);
  });

  it('fail() keeps committed text, drops the failed call and offers ↻ Retry', async () => {
    const u = makeUser(e.s);
    const ch = open(makeRun({ userId: u.id }), makeConv({ userId: u.id }));
    await ch.begin();
    ch.text('Kept. ');
    ch.commitIteration();
    ch.text('lost');
    await ch.fail('Temporary error', true);
    const call = e.tg.byMethod('sendRichMessage').at(-1);
    expect(call.rich_message.markdown).toBe('Kept.\n\nTemporary error');
    expect(e.s.telegram.codec.decode(call.reply_markup.inline_keyboard[0][0].callback_data, 1001)).toEqual({ kind: 'ct', parts: ['c_1', 'r'] });
  });

  it('03 R4: a voice-started run with voice replies on also gets a voice reply; long answers get [🔊 Listen]', async () => {
    const u = makeUser(e.s);
    e.s.repos.users.update(u.id, { voiceReplies: true });
    const conv = makeConv({ userId: u.id });
    const inputId = e.s.repos.inputs.add({ conversationId: conv.id, kind: 'voice', author: 'owner', untrusted: false, content: [{ type: 'text', text: 'hi' }], tgUpdateId: 1, tgChatId: 1001, tgMessageId: 5, fromTgUserId: 1001, replyToCardId: null });
    e.s.repos.inputs.markConsumed([inputId], 'r_v', 1);
    const ch = open(makeRun({ id: 'r_v', userId: u.id, replyRef: { chatId: 1001, triggerMessageId: 5 } }), conv);
    await ch.begin();
    ch.text('It is **12°C** in Almaty.');
    await ch.finalize(fin);
    expect(e.caps.tts.calls).toEqual(['It is 12°C in Almaty.']);
    const voice = e.tg.byMethod('sendVoice').at(-1);
    expect(voice.chat_id).toBe(1001);
    expect(voice.reply_parameters).toMatchObject({ message_id: 5 });
    expect(e.s.telegram.links.byRun('r_v').map((l) => l.kind)).toEqual(['answer', 'voice']);

    e.s.repos.inputs.markConsumed([e.s.repos.inputs.add({ conversationId: conv.id, kind: 'voice', author: 'owner', untrusted: false, content: [], tgUpdateId: 2, tgChatId: 1001, tgMessageId: 6, fromTgUserId: 1001, replyToCardId: null })], 'r_w', 1);
    const ch2 = open(makeRun({ id: 'r_w', userId: u.id }), conv);
    await ch2.begin();
    ch2.text('word '.repeat(200));
    await ch2.finalize(fin);
    const last = e.tg.byMethod('sendRichMessage').at(-1);
    const listen = last.reply_markup.inline_keyboard.flat().find((b: { text: string }) => b.text === 'listen_button');
    expect(e.s.telegram.codec.decode(listen.callback_data, 1001)).toEqual({ kind: 'vo', parts: ['r_w'] });
    expect(e.caps.tts.calls).toHaveLength(1);
  });

  it('03 R4: TTS failure is silent and the text is still sent', async () => {
    const u = makeUser(e.s);
    e.s.repos.users.update(u.id, { voiceReplies: true });
    const conv = makeConv({ userId: u.id });
    e.s.repos.inputs.markConsumed([e.s.repos.inputs.add({ conversationId: conv.id, kind: 'voice', author: 'owner', untrusted: false, content: [], tgUpdateId: 3, tgChatId: 1001, tgMessageId: 7, fromTgUserId: 1001, replyToCardId: null })], 'r_f', 1);
    e.caps.tts.fail = true;
    const ch = open(makeRun({ id: 'r_f', userId: u.id }), conv);
    await ch.begin();
    ch.text('Short.');
    await ch.finalize(fin);
    expect(e.tg.byMethod('sendRichMessage').at(-1).rich_message.markdown).toBe('Short.');
    expect(e.tg.byMethod('sendVoice')).toHaveLength(0);
  });
});
