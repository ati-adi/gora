// Review proof (surfaces/onboarding, rate-limit blowup): while a user sits at onboarding step 'brief', EVERY `/start`
// re-shows M7 with force (onboarding.ts:307) and M7 always calls brief.run(user, {preview:true}) (onboarding.ts:158),
// which starts an interactive-priority LLM event run with calendar/email/weather reads (proactive/brief.ts:143).
// Event runs are exempt from the turn and cost quotas (agent/engine.ts:495 only checks trigger user_input|continue),
// and /start bypasses the surfaces DM rate limit (commands never reach dm.ts) — only the dispatcher's 20/min cap
// applies. One free user can therefore burn ~20 model runs per minute, unmetered: on Groq's free tier (30 RPM,
// 1K RPD per model) that starves every other user of the bot.
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_USER, U } from '../../harness/updates.ts';
import { createSurfacesApp, type SurfacesTestApp } from '../../unit/surfaces/env.ts';

let t: SurfacesTestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('/start while onboarding is at M7 (brief)', () => {
  // Friend mode (spec 05 A2/A3): /start is one line and never starts a brief preview run, whatever the legacy step.
  it('does not start a new (unmetered) brief preview run on every /start', async () => {
    const app = await createSurfacesApp();
    t = app;
    await app.send(U.start());
    const user = app.s.repos.users.getByTg(TEST_USER.id)!;
    app.s.repos.users.update(user.id, { onboardingStep: 'brief', tz: 'Asia/Almaty', tzSource: 'manual' });

    for (let i = 0; i < 10; i++) await app.send(U.start());
    expect(app.brief.runs.filter((r) => r.userId === user.id)).toHaveLength(0);
    expect(app.tg.calls.filter((c) => c.payload?.reply_markup)).toHaveLength(0);
  });
});
