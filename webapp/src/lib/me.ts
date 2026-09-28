// webapp/src/lib/me.ts (WP8) — the signed-in user (GET /api/me), shared through context.
import { createContext, useContext } from 'react';

export interface Me {
  user: {
    tgUserId: number; firstName: string | null; username: string | null; languageCode: string | null; lang: 'en' | 'ru';
    tz: string; tzSource: string; plan: 'free' | 'plus' | 'pro'; status: string; paused: boolean; memoryConsent: boolean | null;
    incognitoUntil: number | null; onboardingStep: string; personaName: string; personaStyle: string; voiceReplies: boolean;
    /** Friend mode (spec 05): memory is on unless turned off (null consent = on); writing-first level. */
    memory: 'on' | 'off' | 'incognito'; proactiveLevel: 'off' | 'less' | 'normal' | 'more';
  };
  flags: { business: boolean; guest: boolean; groups: boolean; missions: boolean; makeFile: boolean; voiceReplies: boolean; topics: boolean };
  bot: { username: string | null };
  provider: { id: string; transport: string };
  session: { ageSec: number; startParam: string | null };
  now: number;
}

export const MeContext = createContext<{ me: Me; refresh: () => Promise<void> } | null>(null);

export function useMe(): { me: Me; refresh: () => Promise<void> } {
  const v = useContext(MeContext);
  if (!v) throw new Error('MeContext missing');
  return v;
}
