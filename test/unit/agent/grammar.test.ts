// WP3 — transcript grammar G1–G9 (01 §5.3), each as a positive and a negative case.
import { describe, expect, it } from 'vitest';
import type { BetaMessageParam, MessageKind } from '../../../src/contracts/index.ts';
import { GrammarError, checkEpochGrammar, checkRunEnd, scrubG8, validateAppend } from '../../../src/agent/grammar.ts';
import { openTmpDb } from '../../harness/tmpDb.ts';

type R = { role: 'user' | 'assistant' | 'system'; kind: MessageKind; content: BetaMessageParam; stopReason?: string | null; runId?: string | null };
const u = (text: string, kind: MessageKind = 'user_input'): R => ({ role: 'user', kind, content: { role: 'user', content: [{ type: 'text', text }] } });
const sys = (text = '<gora_context v="1"></gora_context>'): R => ({ role: 'system', kind: 'context', content: { role: 'system', content: [{ type: 'text', text }] } as BetaMessageParam });
const a = (text: string, stopReason: string | null = 'end_turn'): R => ({ role: 'assistant', kind: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text }] }, stopReason });
const aTool = (...ids: string[]): R => ({
  role: 'assistant', kind: 'assistant', stopReason: 'tool_use',
  content: { role: 'assistant', content: [{ type: 'text', text: 'checking' }, ...ids.map((id) => ({ type: 'tool_use' as const, id, name: 'weather_get', input: {} }))] },
});
const results = (ids: string[], trailing?: string): R => ({
  role: 'user', kind: 'tool_results',
  content: { role: 'user', content: [...ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'ok' })), ...(trailing ? [{ type: 'text' as const, text: trailing }] : [])] },
});

const ok = (rows: R[]) => expect(checkEpochGrammar(rows as never)).toEqual([]);
const bad = (rows: R[], code: string) => expect(checkEpochGrammar(rows as never).join('\n')).toContain(code);

describe('grammar G1–G8', () => {
  it('G1: the first row of an epoch is a user row', () => {
    ok([u('hi'), a('hello')]);
    bad([a('hello')], 'G1');
  });
  it('G2: a system row follows a user-role row and precedes an assistant row (or is last)', () => {
    ok([u('hi'), sys(), a('hello')]);
    ok([u('hi'), sys()]);
    bad([u('hi'), a('x'), sys(), a('y')], 'G2');
    bad([u('hi'), sys(), u('again')], 'G2');
  });
  it('G3: tool_use is answered by exactly one tool_results row, in order, before other content', () => {
    ok([u('hi'), aTool('t1', 't2'), results(['t1', 't2'], '[Owner, 14:05]: also this'), a('done')]);
    bad([u('hi'), aTool('t1', 't2'), results(['t2', 't1']), a('done')], 'G3');
    bad([u('hi'), aTool('t1'), u('other')], 'G3');
    bad([u('hi'), a('x'), results(['t1'])], 'G3');
    const trailingThenResult: R = { role: 'user', kind: 'tool_results', content: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'x' }, { type: 'tool_result', tool_use_id: 't1', content: 'dup' }] } };
    bad([u('hi'), aTool('t1'), trailingThenResult], 'G3');
  });
  it('G4: two assistant rows only after pause_turn', () => {
    ok([u('hi'), a('part', 'pause_turn'), a('rest')]);
    bad([u('hi'), a('one'), a('two')], 'G4');
  });
  it('G5: user rows are never adjacent', () => {
    ok([u('a'), a('b'), u('c'), a('d')]);
    bad([u('a'), u('b')], 'G5');
  });
  it('G7: content is an array of blocks', () => {
    ok([u('a'), a('b')]);
    bad([{ role: 'user', kind: 'user_input', content: { role: 'user', content: 'plain string' } }], 'G7');
  });
  it('G8: no Telegram file URL and no bot token', () => {
    ok([u('see https://example.com/file.pdf'), a('ok')]);
    bad([u(`https://api.telegram.org/${'file'}/bot1/x.jpg`)], 'G8');
    bad([u('token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawx')], 'G8');
  });
  it('kind/role pairs are enforced', () => {
    bad([{ role: 'assistant', kind: 'user_input', content: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }], 'kind');
  });
  it('validateAppend throws GrammarError and checks against the existing tail', () => {
    expect(() => validateAppend([u('hi') as never], [a('ok')])).not.toThrow();
    expect(() => validateAppend([u('hi') as never], [u('again')])).toThrow(GrammarError);
  });
});

describe('G6 (run end) and G9 (append-only)', () => {
  it('G6: a finished run ends with an assistant row; a parked run with unanswered tool_use', () => {
    const rows = [{ ...u('hi'), runId: 'r1' }, { ...a('ok'), runId: 'r1' }];
    expect(checkRunEnd(rows, 'r1', false)).toBeNull();
    expect(checkRunEnd([{ ...u('hi'), runId: 'r1' }], 'r1', false)).toContain('G6');
    const parked = [{ ...u('hi'), runId: 'r2' }, { ...aTool('t1'), runId: 'r2' }];
    expect(checkRunEnd(parked, 'r2', true)).toBeNull();
    expect(checkRunEnd(parked, 'r2', false)).toContain('G6');
  });
  it('G9: UPDATE and DELETE on messages are blocked by triggers', () => {
    const t = openTmpDb();
    try {
      const names = t.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages'`).all<{ name: string }>().map((r) => r.name);
      expect(names.length).toBeGreaterThanOrEqual(2);
      const sqls = t.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages'`).all<{ sql: string }>().map((r) => r.sql.toUpperCase());
      expect(sqls.some((x) => x.includes('BEFORE UPDATE'))).toBe(true);
      expect(sqls.some((x) => x.includes('BEFORE DELETE') && x.includes('SHRED_TOKENS'))).toBe(true);
    } finally {
      t.close();
      t.cleanup();
    }
  });
});

describe('G8 scrub (review F8): third-party / model content never crashes an append', () => {
  it('replaces the Telegram file URL and bot-token-like strings; the scrubbed row passes validateAppend', () => {
    const tok = `bot123456789:${'A'.repeat(35)}`;
    const row = u(`see https://api.telegram.org/file/bot<token>/<file_path> and ${tok} and 987654321:${'b'.repeat(35)}`);
    expect(() => validateAppend([], [row])).toThrow(GrammarError);
    const clean = { ...row, content: scrubG8(row.content) };
    const json = JSON.stringify(clean.content);
    expect(json).not.toContain('api.telegram.org/file');
    expect(json).toContain('[telegram file url]');
    expect(json).toContain('[bot token]');
    expect(() => validateAppend([], [clean])).not.toThrow();
  });
  it('returns the same reference when nothing matches (no needless copies)', () => {
    const c = u('hello 12:30 https://core.telegram.org/bots/api').content;
    expect(scrubG8(c)).toBe(c);
  });
});
