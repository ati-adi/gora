// http/routes/me.ts (WP8; friend mode 05) — GET /api/me (read): profile, plan, flags, memory state and proactive level
// (onboardingStep stays for old clients; it is always 'done' now), and the add-to-group link (spec 07 C6).
import type { Services, TelegramModule } from '../../contracts/index.ts';
import { memoryState } from '../../contracts/index.ts';
import { auth, langOf, safely, type Api } from '../util.ts';

export function registerMe(api: Api, s: Services, tg: TelegramModule): void {
  api.get('/me', (c) => {
    const { user: u, ageMs, startParam } = auth(c);
    const now = s.clock.now();
    const f = s.config.features;
    const botFlags = safely(s, 'botFlags', () => tg.gateway.flags, null);
    return c.json({
      user: {
        tgUserId: u.tgUserId, firstName: u.firstName, username: u.username, languageCode: u.languageCode, lang: langOf(u),
        tz: u.tz, tzSource: u.tzSource, plan: u.plan, status: u.status, paused: u.status === 'paused',
        memoryConsent: u.memoryConsent, memory: memoryState(u, now), proactiveLevel: u.proactiveLevel, incognitoUntil: u.incognitoUntil !== null && u.incognitoUntil > now ? u.incognitoUntil : null,
        onboardingStep: u.onboardingStep, personaName: u.personaName, personaStyle: u.personaStyle, voiceReplies: u.voiceReplies,
      },
      flags: {
        business: f.business, guest: f.guest, groups: f.groups, missions: f.missions, makeFile: f.makeFile, voiceReplies: f.voiceReplies,
        topics: botFlags?.topics ?? false,
      },
      bot: { username: safely(s, 'botInfo', () => tg.gateway.botInfo.username, null) },
      // spec 07 C6 (GR): the Home button [Добавить Гору в группу] — the startgroup picker, no admin rights requested
      addToGroupUrl: f.groups ? safely(s, 'botInfo', () => `https://t.me/${tg.gateway.botInfo.username}?startgroup=g&admin=`, null) : null,
      provider: { id: s.profile.id, transport: s.config.llm.transport },
      session: { ageSec: Math.floor(ageMs / 1000), startParam },
      now,
    });
  });
}
