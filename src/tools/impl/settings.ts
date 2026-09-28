// tools/impl/settings.ts (WP5; friend mode 05 C5/B1) — settings_update (01 §6): never touches permissions, grants or
// connections. A tz change reschedules the owner's cron reminders and the brief. Friend mode adds settings by words:
// `proactive` (writing first: off/less/normal/more → users.proactive_level + a behaviour feedback signal), `style`
// (explicit reply-style overrides → user_settings.style_json) and `memory` on/off («не запоминай»: 05 removed the
// consent card, so this explicit owner choice is the one consent it touches, grant/revoke 'memory' desc-v1).
// Undo restores the previous values.
import { z } from 'zod';
import type { ToolCtx, ToolSpec, UserId, UserRow, UserSettings } from '../../contracts/index.ts';
import type { StyleOverrides } from '../../contracts/behaviour.ts';
import { PLANS } from '../../config.ts';
import { zHHmm, zTz } from '../schema.ts';
import { FULL_SURFACES, L, ownerOf, toolError } from './common.ts';

const input = z.object({
  nudge_budget: z.number().int().min(0).max(10).optional().describe('Proactive nudges per day (plan max applies)'),
  quiet_start: zHHmm.optional(),
  quiet_end: zHHmm.optional(),
  tz: zTz.optional(),
  brief_time: zHHmm.nullable().optional().describe('Morning brief time, null turns it off'),
  persona_name: z.string().min(1).max(30).optional(),
  persona_style: z.enum(['friendly', 'concise', 'professional', 'coach']).optional(),
  inbox_checkins: z.boolean().optional(),
  proactive: z.enum(['off', 'less', 'normal', 'more']).optional().describe('Writing first; "don’t text me first" → off'),
  style: z
    .object({ length: z.enum(['short', 'medium', 'long']).optional(), emoji: z.enum(['none', 'light', 'lots']).optional(), register: z.enum(['informal', 'formal']).optional() })
    .nullable()
    .optional()
    .describe('"be shorter" → length short; null = learned'),
  memory: z.enum(['on', 'off']).optional().describe('"don’t remember" → off'),
});
type In = z.infer<typeof input>;

interface Snapshot { user: Partial<Pick<UserRow, 'tz' | 'tzSource' | 'personaName' | 'personaStyle' | 'proactiveLevel' | 'memoryConsent'>>; settings: Partial<Pick<UserSettings, 'nudgeBudget' | 'quietStart' | 'quietEnd' | 'briefTime' | 'inboxCheckins' | 'style'>> }
interface UndoPayload { userId: UserId; before: Snapshot }

function diff(i: In): Snapshot {
  const user: Snapshot['user'] = {};
  const settings: Snapshot['settings'] = {};
  if (i.tz !== undefined) Object.assign(user, { tz: i.tz, tzSource: 'manual' as const });
  if (i.persona_name !== undefined) user.personaName = i.persona_name;
  if (i.persona_style !== undefined) user.personaStyle = i.persona_style;
  if (i.nudge_budget !== undefined) settings.nudgeBudget = i.nudge_budget;
  if (i.quiet_start !== undefined) settings.quietStart = i.quiet_start;
  if (i.quiet_end !== undefined) settings.quietEnd = i.quiet_end;
  if (i.brief_time !== undefined) settings.briefTime = i.brief_time;
  if (i.inbox_checkins !== undefined) settings.inboxCheckins = i.inbox_checkins;
  if (i.proactive !== undefined) user.proactiveLevel = i.proactive;
  if (i.memory !== undefined) user.memoryConsent = i.memory === 'on';
  if (i.style !== undefined) {
    const st = i.style ? Object.fromEntries(Object.entries(i.style).filter(([, v]) => v !== undefined)) : null;
    settings.style = st && Object.keys(st).length ? (st as StyleOverrides) : null;
  }
  return { user, settings };
}

/** The memory notice version (surfaces/onboarding.ts MEMORY_TEXT_VERSION): the bot description carries it (05 A1). */
const MEMORY_TEXT_VERSION = 'desc-v1';

function apply(ctx: ToolCtx, userId: UserId, snap: Snapshot, prevTz: string, prevBrief: string | null): void {
  const s = ctx.services;
  if (Object.keys(snap.user).length) s.repos.users.update(userId, snap.user);
  if (snap.user.memoryConsent !== undefined) {
    // false = the owner said "don't remember"; true / null (never asked → on) keep a memory consent row.
    const has = s.repos.users.hasConsent(userId, 'memory');
    if (snap.user.memoryConsent === false && has) s.repos.users.revokeConsent(userId, 'memory');
    else if (snap.user.memoryConsent !== false && !has) s.repos.users.grantConsent({ userId, kind: 'memory', textVersion: MEMORY_TEXT_VERSION, via: 'command' });
  }
  if (Object.keys(snap.settings).length) s.repos.users.updateSettings(userId, snap.settings);
  const tzChanged = snap.user.tz !== undefined && snap.user.tz !== prevTz;
  if (tzChanged) s.reminders.rescheduleForTz(userId, snap.user.tz as string);
  const brief = snap.settings.briefTime !== undefined ? snap.settings.briefTime : prevBrief;
  if (tzChanged || (snap.settings.briefTime !== undefined && snap.settings.briefTime !== prevBrief)) s.brief.setDaily(userId, brief);
}

function describe(snap: Snapshot): string {
  const parts: string[] = [];
  const u = snap.user;
  const st = snap.settings;
  if (u.tz) parts.push(`time zone ${u.tz}`);
  if (u.personaName) parts.push(`name ${u.personaName}`);
  if (u.personaStyle) parts.push(`style ${u.personaStyle}`);
  if (st.nudgeBudget !== undefined) parts.push(`nudges ${st.nudgeBudget}/day`);
  if (st.quietStart || st.quietEnd) parts.push(`quiet hours ${st.quietStart ?? '…'}–${st.quietEnd ?? '…'}`);
  if (st.briefTime !== undefined) parts.push(st.briefTime ? `brief at ${st.briefTime}` : 'brief off');
  if (st.inboxCheckins !== undefined) parts.push(`inbox check-ins ${st.inboxCheckins ? 'on' : 'off'}`);
  if (u.proactiveLevel) parts.push(`writing first: ${u.proactiveLevel}`);
  if (u.memoryConsent !== undefined) parts.push(`memory ${u.memoryConsent === false ? 'off' : 'on'}`);
  if (st.style !== undefined) parts.push(st.style ? `style ${Object.entries(st.style).map(([k, v]) => `${k}=${v}`).join(' ')}` : 'style: learned');
  return parts.join(', ');
}

export const settingsTool: ToolSpec<In> = {
  name: 'settings_update',
  description: "Change the owner's settings when they ask in words: tz, quiet hours, brief, nudges, your name, writing first, reply style, memory.",
  input,
  surfaces: FULL_SURFACES,
  parallelSafe: false,
  classify: () => ({ actionClass: 'write_self', risk: 1 }),
  statusLabel: (_i, lang) => L(lang, '⚙️ Updating settings…', '⚙️ Меняю настройки…'),
  async execute(i, ctx) {
    const s = ctx.services;
    const userId = ownerOf(ctx);
    if (!userId || ctx.scope?.kind !== 'user') return toolError('NOT_ALLOWED', 'settings can only be changed by the owner in a private chat');
    const user = s.repos.users.getById(userId);
    if (!user) return toolError('NOT_FOUND', 'user not found');
    const cur = s.repos.users.settings(userId);
    const max = PLANS[user.plan].nudgeBudgetMax;
    if (i.nudge_budget !== undefined && i.nudge_budget > max) return toolError('PLAN_LIMIT', `nudge_budget must be 0..${max} on the ${user.plan} plan`);
    const next = diff(i);
    if (!Object.keys(next.user).length && !Object.keys(next.settings).length) return toolError('INVALID_INPUT', 'no setting was given');
    const before: Snapshot = { user: {}, settings: {} };
    for (const k of Object.keys(next.user) as Array<keyof Snapshot['user']>) (before.user as Record<string, unknown>)[k] = user[k];
    for (const k of Object.keys(next.settings) as Array<keyof Snapshot['settings']>) (before.settings as Record<string, unknown>)[k] = cur[k];
    apply(ctx, userId, next, user.tz, cur.briefTime);
    // C5: explicit feedback for the behaviour model (the policy also reads proactive_level directly).
    const fb = i.proactive === 'off' ? 'stop' : i.proactive === 'less' ? 'less' : i.proactive === 'more' ? 'more' : i.style !== undefined ? 'style' : null;
    if (fb) {
      try {
        s.signals.feedback(userId, { at: ctx.now, kind: fb });
      } catch (e) {
        ctx.log.warn({ err: e instanceof Error ? e.name : 'error' }, 'settings_update: feedback signal failed');
      }
    }
    if (i.memory !== undefined) {
      try {
        s.ledger.append({ userId, actor: 'user', kind: 'consent', summary: i.memory === 'on' ? 'Memory on (words)' : 'Memory off (words)', detail: { kind: 'memory', textVersion: MEMORY_TEXT_VERSION, granted: i.memory === 'on' }, toolUseId: ctx.toolUseId, ...(ctx.runId ? { runId: ctx.runId } : {}) });
      } catch {
        /* best effort */
      }
    }
    const what = describe(next);
    const payload: UndoPayload = { userId, before };
    return {
      content: `updated: ${what}`,
      undo: { payload, line: `⚙️ ${what}` },
      ledger: [{ kind: 'settings', summary: `settings updated: ${Object.keys({ ...next.user, ...next.settings }).join(', ')}`, runId: ctx.runId, toolUseId: ctx.toolUseId }],
    };
  },
  async undo(payload, ctx) {
    const p = payload as UndoPayload;
    const s = ctx.services;
    const user = s.repos.users.getById(p.userId);
    if (!user) return;
    apply(ctx, p.userId, p.before, user.tz, s.repos.users.settings(p.userId).briefTime);
  },
};
