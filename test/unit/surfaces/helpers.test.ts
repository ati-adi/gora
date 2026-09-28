// WP7a pure helpers: invoice payloads, durations, quiet hours, group triggers (§10.3), mention stripping, /why
// descriptions (no bodies), TTS text prep, UTC offsets, the reconcile schedule.
import { describe, expect, it } from 'vitest';
import type { Message } from 'grammy/types';
import { parseDuration, parseQuiet } from '../../../src/surfaces/commands.ts';
import { groupTrigger } from '../../../src/surfaces/group.ts';
import { stripMention } from '../../../src/surfaces/guest.ts';
import { nextReconcileAt } from '../../../src/surfaces/index.ts';
import { invoicePayload, parseInvoicePayload } from '../../../src/surfaces/payments.ts';
import { cutAt, plainOf, utcOffsetLabel } from '../../../src/surfaces/util.ts';
import { collectUrls, describeToolCall } from '../../../src/surfaces/why.ts';

const BOT = { id: 999, username: 'gora_test_bot' };
const gm = (text: string, extra: Partial<Message> = {}): Message => ({ message_id: 1, date: 0, chat: { id: -1, type: 'supergroup', title: 'G' }, from: { id: 1, is_bot: false, first_name: 'A' }, text, ...extra }) as Message;

describe('surfaces helpers', () => {
  it('invoice payload round-trips and rejects anything else', () => {
    expect(parseInvoicePayload(invoicePayload('plus', '01JABC'))).toEqual({ plan: 'plus', userId: '01JABC' });
    expect(parseInvoicePayload('sub:free:v1:01JABC')).toBeNull();
    expect(parseInvoicePayload('sub:pro:v2:01JABC')).toBeNull();
    expect(parseInvoicePayload('sub:pro:v1:')).toBeNull();
  });

  it('parses /incognito durations and /quiet ranges', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h30m')).toBe(9_000_000);
    expect(parseDuration('90')).toBe(5_400_000);
    expect(parseDuration('1m')).toBeNull();
    expect(parseDuration('30d')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
    expect(parseQuiet('22:00-08:00')).toEqual(['22:00', '08:00']);
    expect(parseQuiet('7:5-8:00')).toBeNull();
    expect(parseQuiet('25:00-08:00')).toBeNull();
  });

  it('group triggers: mention, text_mention, reply to the bot, our commands — nothing else', () => {
    expect(groupTrigger(gm('hello all'), BOT)).toBeNull();
    expect(groupTrigger(gm('@gora_test_bot hi', { entities: [{ type: 'mention', offset: 0, length: 14 }] }), BOT)).toEqual({ kind: 'mention' });
    expect(groupTrigger(gm('@someone hi', { entities: [{ type: 'mention', offset: 0, length: 8 }] }), BOT)).toBeNull();
    expect(groupTrigger(gm('Gora hi', { entities: [{ type: 'text_mention', offset: 0, length: 4, user: { id: 999, is_bot: true, first_name: 'Gora' } }] }), BOT)).toEqual({ kind: 'mention' });
    expect(groupTrigger(gm('yes', { reply_to_message: { message_id: 2, date: 0, chat: { id: -1, type: 'supergroup', title: 'G' }, from: { id: 999, is_bot: true, first_name: 'Gora' } } as Message['reply_to_message'] }), BOT)).toEqual({ kind: 'reply' });
    expect(groupTrigger(gm('/remember@gora_test_bot pizza fridays', { entities: [{ type: 'bot_command', offset: 0, length: 23 }] }), BOT)).toEqual({ kind: 'command', command: 'remember', args: 'pizza fridays' });
    expect(groupTrigger(gm('/remember@other_bot x', { entities: [{ type: 'bot_command', offset: 0, length: 19 }] }), BOT)).toBeNull();
  });

  it('strips the bot mention from a summon', () => {
    expect(stripMention('@gora_test_bot what is a fair split?', 'gora_test_bot')).toBe('what is a fair split?');
    expect(stripMention('so @GORA_TEST_BOT help', 'gora_test_bot')).toBe('so help');
  });

  it('/why describes tool calls by query and host only, never bodies', () => {
    expect(describeToolCall('web_search', { query: 'weather almaty' })).toBe('web_search: “weather almaty”');
    expect(describeToolCall('web_fetch', { url: 'https://www.example.com/a?b=1' })).toBe('web_fetch: example.com');
    expect(describeToolCall('gmail_create_draft', { to: ['a@b.c'], body: 'PRIVATE BODY' })).not.toContain('PRIVATE');
    const urls = new Set<string>();
    collectUrls({ results: [{ url: 'https://a.org/x' }, 'see https://b.net/y.'] }, urls);
    expect([...urls]).toEqual(['https://a.org/x', 'https://b.net/y.']);
  });

  it('TTS text prep and offsets', () => {
    expect(plainOf('**Hi** <tg-time unix="1">x</tg-time> [link](https://x.y)')).toBe('Hi x link');
    expect(cutAt('One. Two. Three.', 10)).toBe('One. Two.');
    expect(cutAt('short', 10)).toBe('short');
    expect(utcOffsetLabel(300)).toBe('UTC+5');
    expect(utcOffsetLabel(-210)).toBe('UTC−3:30');
    expect(utcOffsetLabel(0)).toBe('UTC');
  });

  it('reconcile runs daily at 03:10 UTC', () => {
    const now = Date.UTC(2026, 8, 28, 9, 0);
    expect(nextReconcileAt(now)).toBe(Date.UTC(2026, 8, 29, 3, 10));
    expect(nextReconcileAt(Date.UTC(2026, 8, 28, 1, 0))).toBe(Date.UTC(2026, 8, 28, 3, 10));
  });
});
