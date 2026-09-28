// scripts/sim.ts — `npm run sim [-- --lang ru]`: prints the friend-mode first contact (spec 05 §A) exactly as a user
// would see it, against the offline fakes: FakeTelegram, a recording runner (no model call is ever made, so no tokens),
// the real surfaces module and strings, and the real storage in a temp directory.
// Output: one block per bot message (method, text, buttons), the bot menu and description, and a few state lines.
// Spec 05 A2/A3: /start is ONE line with no buttons, nothing is asked, and nothing is sent after a run.
import { U, RU_USER, TEST_USER } from '../test/harness/updates.ts';
import type { FakeGeo } from '../test/harness/fakes.ts';
import type { TestApp } from '../test/harness/testApp.ts';
import { createSurfacesApp, type SurfacesTestApp } from '../test/unit/surfaces/env.ts';

const lang = process.argv.includes('--lang') ? (process.argv[process.argv.indexOf('--lang') + 1] ?? 'en') : 'en';
const user = lang === 'ru' ? RU_USER : TEST_USER;
const out = (line = '') => process.stdout.write(line + '\n');

let printed = 0;
function flush(app: TestApp): void {
  const calls = app.tg.calls;
  for (; printed < calls.length; printed++) {
    const c = calls[printed]!;
    if (['answerCallbackQuery', 'getMe', 'createInvoiceLink', 'setMyCommands', 'setMyDescription', 'setMyShortDescription', 'setChatMenuButton'].includes(c.method)) continue;
    const text = String(c.payload?.rich_message?.markdown ?? c.payload?.text ?? '');
    const kb = (c.payload?.reply_markup?.inline_keyboard ?? []) as Array<Array<{ text: string; callback_data?: string; url?: string; web_app?: { url: string } }>>;
    if (c.method === 'setMessageReaction') {
      const r = (c.payload?.reaction as Array<{ emoji?: string }> | undefined)?.map((x) => x.emoji).join('') ?? '';
      out(`── reaction ${r} on the user's message`);
      out();
      continue;
    }
    out(`── ${c.method}${c.payload?.message_id ? ` #${c.payload.message_id}` : ''}`);
    if (text) for (const l of text.split('\n')) out(`   ${l}`);
    for (const row of kb) {
      out('   ' + row.map((b) => `[${b.text}${b.callback_data ? ` → ${b.callback_data.split('|')[0]}` : b.web_app ? ` → web_app ${b.web_app.url}` : b.url ? ` → ${b.url}` : ''}]`).join(' '));
    }
    out();
  }
}

async function say(app: SurfacesTestApp, text: string): Promise<void> {
  out(`>> user: ${text.length > 80 ? text.slice(0, 77) + '…' : text}`);
  out();
  await app.userSends(text, { user });
  await app.settle();
  flush(app);
}

async function main(): Promise<void> {
  const app = await createSurfacesApp();
  // the offline geocoder knows a few Latin names; give it the Cyrillic spelling the Russian run uses
  const geo = app.s.caps.geo as FakeGeo;
  if (geo.cities['almaty']) geo.cities['алматы'] = geo.cities['almaty'];
  try {
    out(`Gora friend first contact (${lang}) — offline fakes, no model calls`);
    out();
    const menu = app.tg.calls.filter((c) => c.method === 'setMyCommands').map((c) => (c.payload.commands as Array<{ command: string }>).map((x) => `/${x.command}`).join(' '));
    if (menu.length) out(`menu: ${[...new Set(menu)].join(' | ')}`);
    const desc = app.tg.calls.find((c) => c.method === 'setMyDescription' && (c.payload.language_code ?? 'en') === (lang === 'ru' ? 'ru' : 'en'));
    if (desc) out(`description (${lang}): ${String(desc.payload.description)}`);
    out();
    out('>> /start');
    out();
    await app.send(U.start(undefined, { user }));
    await app.settle();
    flush(app);
    const u = app.s.repos.users.getByTg(user.id)!;
    out(`   (onboarding_step = ${u.onboardingStep}; tz = ${u.tz} [${u.tzSource}]; nothing else is sent)`);
    out();
    await say(app, lang === 'ru' ? 'Привет! Посоветуй, что почитать на выходных' : 'Hey! Any book ideas for the weekend?');
    const consent = app.s.db.prepare(`SELECT text_version FROM consents WHERE user_id = ? AND kind = 'memory'`).get<{ text_version: string }>(u.id);
    out(`   (the message went to the agent — runner kicks: ${app.runner.kicks.length}; memory consent recorded silently: ${consent?.text_version ?? 'none'})`);
    out();
    await say(app, lang === 'ru' ? 'Кстати, я живу в Алматы' : 'By the way, I live in Almaty');
    const u2 = app.s.repos.users.getById(u.id)!;
    out(`   (time zone confirmed silently: ${u2.tz} [${u2.tzSource}])`);
    out();
    out('>> /start (again)');
    out();
    await app.send(U.start(undefined, { user }));
    await app.settle();
    flush(app);
    const u3 = app.s.repos.users.getById(u.id)!;
    out(`   (nothing reset: tz = ${u3.tz} [${u3.tzSource}]; model requests made: ${app.llm.requests.length})`);
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`sim failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
