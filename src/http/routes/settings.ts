// http/routes/settings.ts (WP8) — Settings and TzDetect (01 §12, 03 R8):
//   GET   /api/settings                read   tz, language, persona, nudge budget (0..plan max) + per-kind prefs, quiet
//                                             hours, brief time, inbox check-ins, pause, voice replies, home city
//   PATCH /api/settings                write
//   GET   /api/settings/city?q=        read   city search for the home city (weather, brief)
//   POST  /api/settings/tz {tz}        write  TzDetect: sets users.tz (source 'miniapp'), re-anchors reminders and sends
//                                             one short confirmation line through NoticeService.timezoneSet
// Friend mode (spec 05 C5): GET/PATCH also carry proactiveLevel (writing first: off/less/normal/more), style (explicit
// reply-style overrides; null = learned) and the memory state; the same words-settings as settings_update.
import { z } from 'zod';
import type { NudgeKind, Services, UserRow, UserSettings } from '../../contracts/index.ts';
import { NUDGE_KINDS, memoryState } from '../../contracts/index.ts';
import { isValidTz } from '../../kernel/timeMath.ts';
import { auth, body, err, errName, fresh, ledger, query, safely, safelyAsync, type Api } from '../util.ts';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Tz = z.string().min(1).max(64).refine(isValidTz, 'unknown time zone');
const City = z.object({ name: z.string().trim().min(1).max(120), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const Patch = z.object({
  tz: Tz.optional(),
  language: z.enum(['en', 'ru']).optional(),
  personaName: z.string().trim().min(1).max(32).optional(),
  personaStyle: z.enum(['friendly', 'concise', 'professional', 'coach']).optional(),
  nudgeBudget: z.number().int().min(0).max(50).optional(),
  quietStart: HHMM.optional(),
  quietEnd: HHMM.optional(),
  briefTime: HHMM.nullable().optional(),
  inboxCheckins: z.boolean().optional(),
  approvalExpiryMin: z.number().int().min(5).max(1440).optional(),
  showTranscripts: z.boolean().optional(),
  paused: z.boolean().optional(),
  voiceReplies: z.boolean().optional(),
  homeCity: City.nullable().optional(),
  nudgePrefs: z.array(z.object({ kind: z.enum(NUDGE_KINDS as readonly [NudgeKind, ...NudgeKind[]]), muted: z.boolean() })).max(NUDGE_KINDS.length).optional(),
  proactiveLevel: z.enum(['off', 'less', 'normal', 'more']).optional(),
  style: z.object({ length: z.enum(['short', 'medium', 'long']).optional(), emoji: z.enum(['none', 'light', 'lots']).optional(), register: z.enum(['informal', 'formal']).optional() }).strict().nullable().optional(),
}).strict();
const TzBody = z.object({ tz: Tz });
const CityQ = z.object({ q: z.string().trim().min(2).max(120) });

export const INBOX_CHECKINS_TEXT_VERSION = 'inbox-v1';

function settingsOut(s: Services, u: UserRow) {
  const st: UserSettings = s.repos.users.settings(u.id);
  const prefs = safely(s, 'nudges.prefs', () => s.nudges.prefs(u.id), NUDGE_KINDS.map((k) => ({ kind: k, muted: false, snoozeUntil: null })));
  return {
    tz: u.tz, tzSource: u.tzSource, language: u.languageCode, personaName: u.personaName, personaStyle: u.personaStyle,
    proactiveLevel: u.proactiveLevel, memory: memoryState(u, s.clock.now()), style: st.style,
    paused: u.status === 'paused', voiceReplies: u.voiceReplies, voiceAvailable: s.config.features.voiceReplies,
    nudgeBudgetMax: s.config.plans[u.plan].nudgeBudgetMax,
    settings: st,
    nudgePrefs: prefs,
  };
}

/** users.tz + reminders re-anchored in the new zone. Returns whether anything changed. */
function applyTz(s: Services, u: UserRow, tz: string, source: UserRow['tzSource']): boolean {
  const changed = u.tz !== tz || u.tzSource !== source;
  s.repos.users.update(u.id, { tz, tzSource: source });
  if (u.tz !== tz) {
    try {
      s.reminders.rescheduleForTz(u.id, tz);
    } catch (x) {
      s.log.warn({ mod: 'http', err: errName(x) }, 'miniapp: rescheduleForTz failed');
    }
  }
  return changed;
}

export function registerSettings(api: Api, s: Services): void {
  api.get('/settings', (c) => c.json(settingsOut(s, auth(c).user)));

  api.get('/settings/city', async (c) => {
    const { user } = auth(c);
    const q = query(c, CityQ);
    if (!q.ok) return q.res;
    const places = await safelyAsync(s, 'geo.geocodeCity', () => s.caps.geo.geocodeCity(q.data.q, user.languageCode ?? 'en'), []);
    return c.json({ items: places.slice(0, 8).map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, country: p.country ?? null, tz: p.tz ?? null })) });
  });

  api.patch('/settings', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, Patch);
    if (!b.ok) return b.res;
    const p = b.data;
    const u = s.repos.users.getById(user.id) ?? user;
    const changed: string[] = [];

    if (p.nudgeBudget !== undefined && p.nudgeBudget > s.config.plans[u.plan].nudgeBudgetMax) return err(c, 422, 'nudge_budget_over_plan', { max: s.config.plans[u.plan].nudgeBudgetMax });
    if (p.voiceReplies === true && !s.config.features.voiceReplies) return err(c, 422, 'voice_unavailable');

    if (p.tz !== undefined && p.tz !== u.tz) {
      applyTz(s, u, p.tz, 'manual');
      changed.push('tz');
    }
    const userPatch: Partial<Omit<UserRow, 'id' | 'tgUserId' | 'createdAt'>> = {};
    if (p.language !== undefined) userPatch.languageCode = p.language;
    if (p.personaName !== undefined) userPatch.personaName = p.personaName;
    if (p.personaStyle !== undefined) userPatch.personaStyle = p.personaStyle;
    if (p.voiceReplies !== undefined) userPatch.voiceReplies = p.voiceReplies;
    if (p.paused !== undefined && (u.status === 'active' || u.status === 'paused')) userPatch.status = p.paused ? 'paused' : 'active';
    if (p.proactiveLevel !== undefined && p.proactiveLevel !== u.proactiveLevel) userPatch.proactiveLevel = p.proactiveLevel;
    if (Object.keys(userPatch).length) {
      s.repos.users.update(u.id, userPatch);
      changed.push(...Object.keys(userPatch));
    }

    const setPatch: Partial<UserSettings> = {};
    if (p.nudgeBudget !== undefined) setPatch.nudgeBudget = p.nudgeBudget;
    if (p.quietStart !== undefined) setPatch.quietStart = p.quietStart;
    if (p.quietEnd !== undefined) setPatch.quietEnd = p.quietEnd;
    if (p.briefTime !== undefined) setPatch.briefTime = p.briefTime;
    if (p.inboxCheckins !== undefined) setPatch.inboxCheckins = p.inboxCheckins;
    if (p.approvalExpiryMin !== undefined) setPatch.approvalExpiryMin = p.approvalExpiryMin;
    if (p.showTranscripts !== undefined) setPatch.showTranscripts = p.showTranscripts;
    if (p.homeCity !== undefined) setPatch.homeCity = p.homeCity;
    if (p.style !== undefined) {
      const clean = p.style ? Object.fromEntries(Object.entries(p.style).filter(([, v]) => v !== undefined)) : null;
      setPatch.style = clean && Object.keys(clean).length ? clean : null;
    }
    if (Object.keys(setPatch).length) {
      s.repos.users.updateSettings(u.id, setPatch);
      changed.push(...Object.keys(setPatch));
    }
    if (p.briefTime !== undefined) {
      try {
        s.brief.setDaily(u.id, p.briefTime);
      } catch (x) {
        s.log.warn({ mod: 'http', err: errName(x) }, 'miniapp: brief.setDaily failed');
      }
    }
    if (p.inboxCheckins !== undefined) {
      if (p.inboxCheckins) s.repos.users.grantConsent({ userId: u.id, kind: 'inbox_checkins', textVersion: INBOX_CHECKINS_TEXT_VERSION, via: 'miniapp' });
      else s.repos.users.revokeConsent(u.id, 'inbox_checkins');
    }
    // C5: explicit feedback for the behaviour model (the policy also reads proactive_level directly).
    const fb = userPatch.proactiveLevel === 'off' ? 'stop' : userPatch.proactiveLevel === 'less' ? 'less' : userPatch.proactiveLevel === 'more' ? 'more' : p.style !== undefined ? 'style' : null;
    if (fb) safely(s, 'signals.feedback', () => s.signals.feedback(u.id, { at: s.clock.now(), kind: fb }), undefined);
    if (p.nudgePrefs) {
      for (const np of p.nudgePrefs) s.nudges.setPref(u.id, np.kind, { muted: np.muted });
      changed.push('nudgePrefs');
    }

    if (userPatch.status !== undefined && userPatch.status !== u.status) {
      ledger(s, { userId: u.id, actor: 'user', kind: 'pause', summary: userPatch.status === 'paused' ? 'Paused (Mini App)' : 'Resumed (Mini App)', detail: { paused: userPatch.status === 'paused' } });
    }
    const other = changed.filter((k) => k !== 'status');
    // Keys only, never values (a persona name or city is user text).
    if (other.length) ledger(s, { userId: u.id, actor: 'user', kind: 'settings', summary: `Settings changed (Mini App): ${[...new Set(other)].join(', ')}`, detail: { keys: [...new Set(other)] } });
    return c.json(settingsOut(s, s.repos.users.getById(u.id) ?? u));
  });

  api.post('/settings/tz', async (c) => {
    const stale = fresh(s, c, 'write');
    if (stale) return stale;
    const { user } = auth(c);
    const b = await body(c, TzBody);
    if (!b.ok) return b.res;
    const u = s.repos.users.getById(user.id) ?? user;
    const firstTime = u.tzSource === 'default';
    const changed = applyTz(s, u, b.data.tz, 'miniapp');
    if (changed || firstTime) {
      ledger(s, { userId: u.id, actor: 'user', kind: 'settings', summary: 'Time zone set (Mini App)', detail: { keys: ['tz'], source: 'miniapp' } });
      try {
        await s.notices.timezoneSet(u.id, b.data.tz, 'miniapp');
      } catch (x) {
        s.log.warn({ mod: 'http', err: errName(x) }, 'miniapp: timezoneSet notice failed');
      }
    }
    return c.json({ tz: b.data.tz, confirmed: true });
  });
}
