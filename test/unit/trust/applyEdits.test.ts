import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../../src/trust/approvals.ts';

describe('applyEdits (Mini App edited fields → full tool input)', () => {
  it('merges only the editable fields into a copy of the stored input', () => {
    const orig = { to: ['a@x.com'], subject: 'Hi', body: 'Old', reply_to_thread_id: 't1' };
    const out = applyEdits('gmail_create_draft', orig, { body: 'New', to: ['b@x.com'], reply_to_thread_id: 'evil' });
    expect(out).toEqual({ to: ['b@x.com'], subject: 'Hi', body: 'New', reply_to_thread_id: 't1' });
    expect(orig.body).toBe('Old');
  });
  it('maps display fields to nested input paths', () => {
    expect(applyEdits('calendar_create_event', { title: 'A', start_local: '2026-10-01T10:00' }, { start: '2026-10-01T11:00' })).toEqual({ title: 'A', start_local: '2026-10-01T11:00' });
    expect(applyEdits('calendar_update_event', { event_id: 'e1', patch: { title: 'A' } }, { title: 'B', end: '2026-10-01T12:00' })).toEqual({ event_id: 'e1', patch: { title: 'B', end_local: '2026-10-01T12:00' } });
  });
  it('tools without editable fields ignore every edit', () => {
    expect(applyEdits('gmail_send_draft', { draft_id: 'd1' }, { body: 'x' })).toEqual({ draft_id: 'd1' });
  });
});
