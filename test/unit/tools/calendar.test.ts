// WP5 — calendar_* (01 §6, F9): classification by attendees, renderDiff, reconcile, undo, untrusted foreign events.
import { describe, expect, it } from 'vitest';
import type { ToolSpec } from '../../../src/contracts/index.ts';
import { CALENDAR_TOOLS, freeSlots } from '../../../src/tools/impl/calendar.ts';
import { createToolEnv } from './env.ts';

const T = (n: string) => CALENDAR_TOOLS.find((t) => t.name === n) as ToolSpec;

describe('calendar tools', () => {
  it('create: no attendees → write_self (draft) with Undo; attendees → send_external (act), bulk count, targets', async () => {
    const env = createToolEnv();
    const c = T('calendar_create_event');
    expect(c.classify(c.input.parse({ title: 'Gym', start_local: '2026-09-30T18:00' }), env.ctx())).toMatchObject({ actionClass: 'write_self', risk: 1, integration: 'gcal', requiredLevel: 'draft' });
    const withA = c.input.parse({ title: 'Sync', start_local: '2026-09-30T10:00', attendees: ['Anna@Example.com', 'b@example.com'] });
    expect(c.classify(withA, env.ctx())).toMatchObject({ actionClass: 'send_external', risk: 2, requiredLevel: 'act', bulkCount: 2 });
    const targets = await c.targets!(withA, env.ctx());
    expect(targets.map((t) => [t.kind, t.value])).toEqual([['gcal_attendee', 'anna@example.com'], ['gcal_attendee', 'b@example.com']]);

    const out = await env.run(c, { title: 'Gym', start_local: '2026-09-30T18:00', duration_min: 90 });
    expect(out.isError).toBeFalsy();
    const created = JSON.parse(out.content).created;
    expect(created.start).toBe('Wed 30 Sep, 18:00 (Asia/Almaty)');
    expect(created.end).toBe('Wed 30 Sep, 19:30 (Asia/Almaty)');
    expect(out.undo).toBeDefined();
    expect(out.ledger?.[0]?.kind).toBe('calendar_changed');
    await c.undo!(out.undo!.payload, env.ctx());
    expect(env.provider.events(env.user.id).find((e) => e.title === 'Gym')).toBeUndefined();
  });

  it('create is idempotent per idemKey and reconcile uses findByIdem', async () => {
    const env = createToolEnv();
    const c = T('calendar_create_event');
    const ctx = env.ctx({ idemKey: 'pa:ABC123' });
    expect(await c.reconcile!(c.input.parse({ title: 'Call', start_local: '2026-10-01T11:00', attendees: ['a@example.com'] }), ctx)).toBe('not_done');
    const i = { title: 'Call', start_local: '2026-10-01T11:00', attendees: ['a@example.com'] };
    const a = await env.run(c, i, ctx);
    const b = await env.run(c, i, ctx);
    expect(JSON.parse(a.content).created.id).toBe(JSON.parse(b.content).created.id);
    expect(a.undo).toBeUndefined(); // attendees: no Undo, it was asked
    expect(await c.reconcile!(c.input.parse(i), ctx)).toBe('done');
    expect(env.provider.events(env.user.id).filter((e) => e.title === 'Call')).toHaveLength(1);
  });

  it('create renderDiff shows exact time, zone and invite list', async () => {
    const env = createToolEnv();
    const c = T('calendar_create_event');
    const d = await c.renderDiff!(c.input.parse({ title: 'Sync', start_local: '2026-09-30T10:00', end_local: '2026-09-30T10:30', attendees: ['a@example.com'] }), env.ctx());
    expect(d.rows).toEqual(expect.arrayContaining([['When', 'Wed 30 Sep, 10:00 (Asia/Almaty) → Wed 30 Sep, 10:30 (Asia/Almaty)'], ['Zone', 'Asia/Almaty'], ['Invites', 'a@example.com']]));
    expect(d.targets.map((t) => t.value)).toEqual(['a@example.com']);
    const again = await c.renderDiff!(c.input.parse({ title: 'Sync', start_local: '2026-09-30T10:00', end_local: '2026-09-30T10:30', attendees: ['a@example.com'] }), env.ctx());
    expect(again).toEqual(d); // deterministic (TOCTOU recomputation)
  });

  it('update: own event without attendees → write_self with Undo restoring the previous version; unknown/attendees → ask', async () => {
    const env = createToolEnv();
    const u = T('calendar_update_event');
    // unknown event → conservative
    expect(u.classify(u.input.parse({ event_id: 'demo-e2', patch: { title: 'x' } }), env.ctx())).toMatchObject({ actionClass: 'send_external', requiredLevel: 'act' });
    await env.run(T('calendar_list_events'), { from_local: '2026-09-28T00:00', to_local: '2026-10-05T00:00' });
    expect(u.classify(u.input.parse({ event_id: 'demo-e2', patch: { title: 'x' } }), env.ctx())).toMatchObject({ actionClass: 'write_self', requiredLevel: 'draft' });
    expect(u.classify(u.input.parse({ event_id: 'demo-e1', patch: { title: 'x' } }), env.ctx())).toMatchObject({ actionClass: 'send_external', bulkCount: 2 });
    const diff = await u.renderDiff!(u.input.parse({ event_id: 'demo-e1', patch: { start_local: '2026-09-29T12:00' } }), env.ctx());
    expect(diff.rows.find((r) => r[0] === 'When')?.[1]).toContain('→');
    expect(diff.warnings.join(' ')).toMatch(/notified/);

    const before = env.provider.events(env.user.id).find((e) => e.id === 'demo-e2')!;
    const out = await env.run(u, { event_id: 'demo-e2', patch: { title: 'Dentist (moved)', start_local: '2026-09-29T16:00' } });
    expect(out.isError).toBeFalsy();
    const mid = env.provider.events(env.user.id).find((e) => e.id === 'demo-e2')!;
    expect(mid.title).toBe('Dentist (moved)');
    expect(Date.parse(mid.end) - Date.parse(mid.start)).toBe(Date.parse(before.end) - Date.parse(before.start)); // duration kept
    await u.undo!(out.undo!.payload, env.ctx());
    const after = env.provider.events(env.user.id).find((e) => e.id === 'demo-e2')!;
    expect([after.title, after.start, after.end]).toEqual([before.title, before.start, before.end]);
  });

  it('delete is destructive, never grantable, and idempotent', async () => {
    const env = createToolEnv();
    const del = T('calendar_delete_event');
    expect(del.classify({ event_id: 'demo-e1' }, env.ctx())).toMatchObject({ actionClass: 'destructive', risk: 3, grantable: false });
    const d = await del.renderDiff!({ event_id: 'demo-e1' }, env.ctx());
    expect(d.rows.find((r) => r[0] === 'Attendees')?.[1]).toContain('anna@example.com');
    expect((await env.run(del, { event_id: 'demo-e1' })).isError).toBeFalsy();
    expect((await env.run(del, { event_id: 'demo-e1' })).isError).toBeFalsy();
  });

  it('list wraps events organized by others as untrusted calendar content; respond asks', async () => {
    const env = createToolEnv();
    const out = await env.run(T('calendar_list_events'), { from_local: '2026-09-28T00:00', to_local: '2026-10-05T00:00' });
    expect(out.untrusted).toEqual({ source: 'calendar', label: 'calendar events' });
    expect(JSON.parse(out.content).events.length).toBe(3);
    const own = await env.run(T('calendar_list_events'), { from_local: '2026-09-29T00:00', to_local: '2026-09-29T23:59' });
    expect(own.untrusted).toBeUndefined();
    const r = T('calendar_respond_invite');
    expect(r.classify({ event_id: 'demo-e3', response: 'accepted' }, env.ctx())).toMatchObject({ actionClass: 'send_external', requiredLevel: 'act' });
    expect((await r.renderDiff!({ event_id: 'demo-e3', response: 'declined' }, env.ctx())).warnings[0]).toMatch(/organizer/);
  });

  it('not connected → clean NOT_CONNECTED error; free slots skip busy time', async () => {
    const env = createToolEnv({ connected: { gcal: false } });
    const out = await env.run(T('calendar_list_events'), { from_local: '2026-09-28T00:00', to_local: '2026-09-29T00:00' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('NOT_CONNECTED');
    const H = 3_600_000;
    const base = Date.UTC(2026, 8, 30, 3, 0); // 08:00 Almaty, Wednesday
    const slots = freeSlots(base, base + 12 * H, [{ start: base + 2 * H, end: base + 3 * H }], H, 'Asia/Almaty', true);
    expect(slots[0]).toEqual({ start: base + H, end: base + 2 * H }); // 09:00–10:00
    expect(slots[1]).toEqual({ start: base + 3 * H, end: base + 10 * H }); // 11:00–18:00
  });
});
