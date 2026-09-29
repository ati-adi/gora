// Review s07 (skeptic, BR). Two failing proofs:
//  1. An approval card tapped more than 15 min after the page was last touched always fails: the browser_sweep closes
//     the "idle" context (src/browser/tasks.ts sweep: `t - task.updatedAt > browserMaxWallMs` → closeSession) even while
//     the mission is parked waiting for that very approval; executeApproved → freshDiff → approvalDiff throws "the
//     browser session is gone" (src/browser/tools.ts approvalDiff) → "Could not re-check the action". Nothing is booked
//     and the typed form is lost, although the card itself is valid for much longer.
//  2. The browser quota notice never reaches the owner: surfaces/payments.ts quotaExceeded looks up SURF['quota_browser'],
//     which does not exist → TypeError (the BR e2e test swallows it with .catch()).
import { afterEach, describe, expect, it } from 'vitest';
import type { TgCall } from '../../harness/fakeTelegram.ts';
import { BOOKING_ORIGIN, bookingSite } from '../../harness/fakeBrowser.ts';
import { say, turn } from '../../harness/scriptedTransport.ts';
import { createTestApp, type TestApp } from '../../harness/testApp.ts';
import { RU_USER } from '../../harness/updates.ts';
import { lastApprovalId, RoutedTransport } from '../../harness/s07-br.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const md = (c: TgCall): string => String(c.payload?.rich_message?.markdown ?? c.payload?.text ?? '').replace(/\\/g, '');
const buttons = (c: TgCall): Array<{ text: string; callback_data?: string }> => (c.payload?.reply_markup?.inline_keyboard ?? []).flat();

describe('s07 BR review', () => {
  it('an approval tapped 16 minutes after the card still performs the submit', async () => {
    const llm = new RoutedTransport();
    t = await createTestApp({ llm });
    t.browser.addSite(bookingSite());
    llm.pushMission(
      turn().toolUse('browser_open', { url: `${BOOKING_ORIGIN}/` }, 'tm_open'),
      turn().toolUse('browser_type', { ref: 'e5', text: 'Café Alma', submit: true }, 'tm_search'),
      turn().toolUse('browser_click', { ref: 'e4' }, 'tm_pick'),
      turn().toolUse('browser_type', { ref: 'e3', text: 'Adi' }, 'tm_name'),
      turn().toolUse('browser_select', { ref: 'e5', value: '2' }, 'tm_guests'),
      turn().toolUse('browser_click', { ref: 'e6' }, 'tm_book'),
      (req) => turn().toolUse('task_wait', { on: [`approval:${lastApprovalId(req)}`], timeout_hours: 2 }, 'tm_wait'),
    );
    llm.push(
      turn().toolUse('browse_task', { goal: 'Забронировать столик в Café Alma сегодня на 19:00 на имя Adi, 2 гостя', start_url: `${BOOKING_ORIGIN}/` }, 'toolu_bt_1'),
      say('Взялась!'),
    );
    await t.userSends('Забронируй столик в Café Alma сегодня на 19:00 на имя Adi, 2 гостя', { user: RU_USER });
    await t.settle();
    const card = [...t.tg.calls].reverse().find((x) => x.method === 'sendRichMessage' && md(x).includes('🔐'))!;
    expect(card).toBeDefined();

    // the owner looks at the card 16 minutes later (the card itself is still valid)
    await t.advance(16 * 60_000);
    llm.pushMission(turn().toolUse('browser_done', { summary: 'Забронировано' }, 'tm_done'));
    const yes = buttons(card).find((b) => b.callback_data?.includes(':y:o:'))!;
    await t.tap(yes.callback_data!, { user: RU_USER, messageId: Number((card.result as { message_id?: number } | undefined)?.message_id ?? 0) });
    await t.settle();
    // FAILS today: the sweep closed the context, so the approved click is "Could not re-check the action"
    expect(t.browser.requests.some((r) => r.url.includes('/confirm'))).toBe(true);
  });

  it('quotaExceeded(…, "browser") sends the plan notice instead of throwing', async () => {
    t = await createTestApp({});
    t.llm.push(say('Привет!'));
    await t.userSends('привет', { user: RU_USER });
    await t.settle();
    const u = t.s.repos.users.getByTg(RU_USER.id)!;
    for (let i = 0; i < t.s.config.plans.free.browserTasksPerDay; i++) t.s.quotas.consume(u.id, 'browser');
    const before = t.tg.calls.length;
    // FAILS today: TypeError (SURF.quota_browser is undefined)
    await t.s.notices.quotaExceeded(u.id, 'browser', { chatId: u.dmChatId ?? RU_USER.id });
    await t.settle();
    expect(t.tg.calls.slice(before).some((c) => /3\/3/.test(md(c)))).toBe(true);
  });
});
