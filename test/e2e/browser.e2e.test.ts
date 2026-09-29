// s07 BR e2e (spec 07 A6 + A3/A4): the browser agent through the whole app — browse_task in the owner's chat starts a
// browse mission; the scripted mission run drives the browser_* tools against FakeBrowser's scripted booking site.
// Asserted: the booking reaches the confirm page only after an approval card (preceded by a sendPhoto of the page) is
// tapped; Deny submits nothing; Stop closes the context; private IPs and the metadata beacon are refused; a login wall
// and a payment page park with one short line; an injected instruction never causes an unapproved submit; the snapshot
// stays under the groq-free cap; a restart reopens a fresh context at the saved URL; the daily quota refuses a 4th task.
import { afterEach, describe, expect, it } from 'vitest';
import type { TgCall } from '../harness/fakeTelegram.ts';
import { BOOKING_ORIGIN, bookingSite, longPageSite } from '../harness/fakeBrowser.ts';
import { say, turn } from '../harness/scriptedTransport.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { RU_USER } from '../harness/updates.ts';
import { lastApprovalId, RoutedTransport } from '../harness/s07-br.ts';
import { estimateTokens } from '../../src/kernel/tokens.ts';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const GOAL = 'Забронировать столик в Café Alma сегодня на 19:00 на имя Adi, 2 гостя';
const ASK = 'Забронируй столик в Café Alma сегодня на 19:00 на имя Adi, 2 гостя';

async function boot(o: { env?: Record<string, string> } = {}): Promise<{ t: TestApp; llm: RoutedTransport }> {
  const llm = new RoutedTransport();
  const app = await createTestApp({ llm, ...(o.env ? { env: o.env } : {}) });
  app.browser.addSite(bookingSite());
  return { t: app, llm };
}

/** The owner asks; the chat run calls browse_task and says one line. */
async function startTask(app: TestApp, llm: RoutedTransport, o: { user?: typeof RU_USER; goal?: string; startUrl?: string } = {}) {
  llm.push(turn().toolUse('browse_task', { goal: o.goal ?? GOAL, start_url: o.startUrl ?? `${BOOKING_ORIGIN}/` }, `toolu_bt_${llm.requests.length}`), say('Взялась!'));
  await app.userSends(ASK, { user: o.user ?? RU_USER });
  await app.settle();
}

const md = (c: TgCall): string => String(c.payload?.rich_message?.markdown ?? c.payload?.text ?? '').replace(/\\/g, '');
const buttons = (c: TgCall): Array<{ text: string; callback_data?: string; url?: string }> => (c.payload?.reply_markup?.inline_keyboard ?? []).flat();
const approvalCard = (app: TestApp): TgCall => {
  const c = [...app.tg.calls].reverse().find((x) => x.method === 'sendRichMessage' && md(x).includes('🔐'));
  if (!c) throw new Error('no approval card');
  return c;
};
const tapButton = async (app: TestApp, c: TgCall, pred: (b: { text: string; callback_data?: string }) => boolean, user = RU_USER) => {
  const b = buttons(c).find(pred);
  if (!b?.callback_data) throw new Error(`no such button in ${JSON.stringify(buttons(c))}`);
  await app.tap(b.callback_data, { user, messageId: Number((c.result as { message_id?: number } | undefined)?.message_id ?? 0) });
  await app.settle();
};
const userOf = (app: TestApp, tg = RU_USER.id) => app.s.repos.users.getByTg(tg)!;
const task = (app: TestApp, tg = RU_USER.id) => app.s.browserTasks.list(userOf(app, tg).id)[0]!;
const submitted = (app: TestApp) => app.browser.requests.some((r) => r.url.includes('/confirm'));

/** Scripts the mission up to the approval card on «Забронировать» (search → results → booking form → click submit). */
function scriptToCard(llm: RoutedTransport): void {
  llm.pushMission(
    turn().toolUse('browser_open', { url: `${BOOKING_ORIGIN}/` }, 'tm_open'),
    turn().toolUse('browser_type', { ref: 'e5', text: 'Café Alma', submit: true }, 'tm_search'),
    turn().toolUse('browser_click', { ref: 'e4' }, 'tm_pick'),
    turn().toolUse('browser_type', { ref: 'e3', text: 'Adi' }, 'tm_name'),
    turn().toolUse('browser_select', { ref: 'e5', value: '2' }, 'tm_guests'),
    turn().toolUse('browser_click', { ref: 'e6' }, 'tm_book'),
    (req) => turn().toolUse('task_wait', { on: [`approval:${lastApprovalId(req)}`], timeout_hours: 2 }, 'tm_wait'),
  );
}

describe('browser agent (spec 07 §A, e2e)', () => {
  it('books a table: search → results → form → approval card with a screenshot → approve → confirm → browser_done', async () => {
    const b = await boot();
    t = b.t;
    scriptToCard(b.llm);
    await startTask(t, b.llm);
    const u = userOf(t);
    const tk = task(t);
    expect(tk.status).toBe('running');
    expect(tk.missionId).toMatch(/^M/);
    const m = t.s.missions.get(tk.missionId!)!;
    // the chat got ONE short line; the site work happened in the mission run
    expect(b.llm.missionRemaining()).toBe(0);
    expect(t.browser.opened).toHaveLength(1);
    expect(t.browser.events.filter((e) => e.op === 'type').map((e) => e.text)).toEqual(['Café Alma', 'Adi']);
    expect(submitted(t)).toBe(false);
    // the approval card went to the mission thread, preceded by a sendPhoto of the page
    const card = approvalCard(t);
    const photoIdx = t.tg.calls.findIndex((c) => c.method === 'sendPhoto');
    expect(photoIdx).toBeGreaterThanOrEqual(0);
    expect(photoIdx).toBeLessThan(t.tg.calls.indexOf(card));
    if (m.threadId !== null) {
      expect(card.payload.message_thread_id).toBe(m.threadId);
      expect(t.tg.calls[photoIdx]!.payload.message_thread_id).toBe(m.threadId);
    }
    const text = md(card);
    expect(text).toContain('tables.example');
    expect(text).toContain('Adi');
    expect(text).toMatch(/Guests[^\n]*2/);
    expect(text).toContain('Забронировать');
    // the approval is not grantable (no 24 h / always button)
    expect(buttons(card).some((x) => x.callback_data?.includes(':y:d:'))).toBe(false);
    expect(t.s.missions.get(tk.missionId!)!.status).toBe('parked');

    // approve → the click runs once → the parked run wakes, sees the confirmation and finishes
    b.llm.pushMission(turn().toolUse('browser_snapshot', {}, 'tm_snap'), turn().toolUse('browser_done', { summary: 'Забронировано: Café Alma, 19:00, Adi, 2 гостя' }, 'tm_done')); // the mission ends: no further model call
    await tapButton(t, card, (x) => !!x.callback_data?.includes(':y:o:'));
    expect(submitted(t)).toBe(true);
    expect(t.browser.requests.find((r) => r.url.includes('/confirm'))!.url).toContain('name=Adi');
    expect(t.browser.requests.find((r) => r.url.includes('/confirm'))!.url).toContain('guests=2');
    expect(b.llm.missionRemaining()).toBe(0);
    expect(t.s.missions.get(tk.missionId!)!.status).toBe('done');
    expect(task(t).status).toBe('done');
    expect(t.browser.opened[0]!.closed).toBe(true);
    // the snapshot the model saw after the confirm is wrapped as untrusted web content
    const lastReq = JSON.stringify(b.llm.requests.at(-1)!.messages);
    expect(lastReq).toContain('untrusted source=\\"web\\"');
    // ledger: one browser_action per step, never the typed values
    const led = t.s.ledger.list(u.id, { kinds: ['browser_action'], limit: 100 });
    expect(led.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(led)).not.toContain('Adi');
  });

  it('Deny on the card: nothing is submitted, the mission finishes cleanly and the context is closed', async () => {
    const b = await boot();
    t = b.t;
    scriptToCard(b.llm);
    await startTask(t, b.llm);
    const tk = task(t);
    b.llm.pushMission(turn().toolUse('browser_done', { summary: 'Не бронирую — владелец отказался.' }, 'tm_done'));
    await tapButton(t, approvalCard(t), (x) => !!x.callback_data?.includes(':n:'));
    expect(submitted(t)).toBe(false);
    expect(t.browser.events.some((e) => e.op === 'click' && e.ref === 'e6')).toBe(false);
    expect(b.llm.missionRemaining()).toBe(0);
    expect(t.s.missions.get(tk.missionId!)!.status).toBe('done');
    expect(task(t).status).toBe('done');
    expect(t.browser.opened[0]!.closed).toBe(true);
  });

  it('Stop mid-task closes the context; a later tap on the stale card performs nothing', async () => {
    const b = await boot();
    t = b.t;
    scriptToCard(b.llm);
    await startTask(t, b.llm);
    const tk = task(t);
    const card = approvalCard(t);
    const missionCard = t.tg.calls.find((c) => buttons(c).some((x) => x.callback_data?.startsWith('ms:') && x.callback_data.includes(':stop')))!;
    await tapButton(t, missionCard, (x) => !!x.callback_data?.startsWith('ms:'));
    expect(t.s.missions.get(tk.missionId!)!.status).toBe('cancelled');
    expect(t.browser.opened[0]!.closed).toBe(true);
    expect(task(t).status).toBe('cancelled');
    const closedAt = t.browser.events.findIndex((e) => e.op === 'close');
    // the owner taps Approve on the old card afterwards: the task has ended, nothing is clicked
    await tapButton(t, card, (x) => !!x.callback_data?.includes(':y:o:'));
    expect(submitted(t)).toBe(false);
    expect(t.browser.events.slice(closedAt + 1).filter((e) => e.ok)).toEqual([]);
    expect(t.browser.opened).toHaveLength(1);
  });

  it('network guard: a private-IP URL and link are blocked, the metadata beacon subresource is refused', async () => {
    const b = await boot();
    t = b.t;
    b.llm.pushMission(
      turn().toolUse('browser_open', { url: 'http://10.0.0.5/admin' }, 'tm_priv'),
      turn().toolUse('browser_open', { url: `${BOOKING_ORIGIN}/` }, 'tm_home'),
      turn().toolUse('browser_click', { ref: 'e8' }, 'tm_admin'),
      turn().toolUse('browser_done', { summary: 'done' }, 'tm_done'),
    );
    await startTask(t, b.llm);
    const results = JSON.stringify(b.llm.requests.filter((r) => JSON.stringify(r.messages).includes('Browser task:')).at(-1)!.messages);
    expect(results).toMatch(/tm_priv[^}]*\\"error\\":\\"blocked\\"/);
    expect(results).toMatch(/tm_admin[^}]*\\"error\\":\\"blocked\\"/);
    const req = (frag: string) => t!.browser.requests.filter((r) => r.url.includes(frag));
    expect(req('10.0.0.5').every((r) => !r.allowed)).toBe(true);
    expect(req('10.0.0.5').length).toBeGreaterThanOrEqual(2);
    expect(req('169.254.169.254')).toEqual([expect.objectContaining({ kind: 'subresource', allowed: false })]);
    expect(req('app.js')).toEqual([expect.objectContaining({ allowed: true })]);
    expect(task(t).status).toBe('done');
  });

  it('login wall: parks with one short line and [Продолжить без входа]; the tap resumes the task', async () => {
    const b = await boot();
    t = b.t;
    b.llm.pushMission(
      turn().toolUse('browser_open', { url: `${BOOKING_ORIGIN}/login` }, 'tm_login'),
      turn().toolUse('task_wait', { on: ['user_input'], timeout_hours: 24 }, 'tm_wait'),
    );
    await startTask(t, b.llm);
    expect(task(t)).toMatchObject({ status: 'parked', parkReason: 'login' });
    const note = [...t.tg.calls].reverse().find((c) => buttons(c).some((x) => x.text === 'Продолжить без входа'))!;
    expect(md(note)).toContain('Сайт просит войти');
    expect(buttons(note).some((x) => x.url === `${BOOKING_ORIGIN}/login`)).toBe(true);
    // no credentials were typed, ever
    expect(t.browser.events.some((e) => e.op === 'type')).toBe(false);
    await t.advance(60_000);
    b.llm.pushMission(turn().toolUse('browser_open', { url: `${BOOKING_ORIGIN}/` }, 'tm_home'), turn().toolUse('browser_done', { summary: 'Без входа: нашла столики.' }, 'tm_done'));
    await tapButton(t, note, (x) => x.text === 'Продолжить без входа');
    expect(b.llm.missionRemaining()).toBe(0);
    const last = JSON.stringify(b.llm.requests.at(-1)!.messages);
    expect(last).toContain('Find a table'); // the resumed open returned the page, not another park
    expect(task(t).status).toBe('done');
  });

  it('payment page: no typing into card fields; parks with "the last step, payment, is yours" and the URL', async () => {
    const b = await boot();
    t = b.t;
    b.llm.pushMission(
      turn().toolUse('browser_open', { url: `${BOOKING_ORIGIN}/book?r=alma` }, 'tm_book'),
      turn().toolUse('browser_click', { ref: 'e7' }, 'tm_pay'),
      turn().toolUse('browser_type', { ref: 'e2', text: '4242 4242 4242 4242' }, 'tm_card'),
      turn().toolUse('browser_done', { summary: 'Оплата за вами.' }, 'tm_done'),
    );
    await startTask(t, b.llm);
    expect(t.browser.events.some((e) => e.op === 'type')).toBe(false);
    const note = [...t.tg.calls].reverse().find((c) => md(c).includes('оплата'))!;
    expect(md(note)).toContain('последний шаг — оплата — за вами');
    expect(md(note)).toContain('tables.example');
    expect(buttons(note).some((x) => x.url === `${BOOKING_ORIGIN}/pay`)).toBe(true);
    const results = JSON.stringify(b.llm.requests.at(-1)!.messages);
    expect(results).toMatch(/tm_card[^}]*parked/);
    expect(task(t).status).toBe('done');
    expect(t.browser.requests.some((r) => r.url.includes('/paid'))).toBe(false);
  });

  it('prompt injection in page text: an obedient model still cannot type third-party data or submit without approval', async () => {
    const b = await boot();
    t = b.t;
    b.llm.pushMission(
      turn().toolUse('browser_open', { url: `${BOOKING_ORIGIN}/` }, 'tm_open'),
      turn().toolUse('browser_type', { ref: 'e5', text: 'Café Alma', submit: true }, 'tm_search'),
      // the results page carries BOOKING_INJECTION; the scripted model "obeys" it
      turn().toolUse('browser_open', { url: `${BOOKING_ORIGIN}/book?r=alma` }, 'tm_inj_open'),
      turn().toolUse('browser_type', { ref: 'e3', text: 'Hacker' }, 'tm_inj_type'),
      turn().toolUse('browser_click', { ref: 'e6' }, 'tm_inj_click'),
      say('Готово.'),
    );
    await startTask(t, b.llm);
    // the injected page text reached the model only inside the untrusted wrapper
    const resultOf = (id: string): string => {
      for (const r of b.llm.requests) {
        for (const m of r.messages as Array<{ content: unknown }>) {
          for (const c of Array.isArray(m.content) ? m.content : []) {
            const x = c as { tool_use_id?: string; content?: unknown };
            if (x.tool_use_id === id) return typeof x.content === 'string' ? x.content : JSON.stringify(x.content);
          }
        }
      }
      return '';
    };
    const results = resultOf('tm_search');
    expect(results.startsWith('<untrusted source="web" label="tables.example"')).toBe(true);
    expect(results).toContain('Café Alma — tonight 19:00');
    expect(JSON.parse(resultOf('tm_inj_type'))).toMatchObject({ status: 'pending_approval', performed: false });
    expect(JSON.parse(resultOf('tm_inj_click'))).toMatchObject({ status: 'pending_approval', performed: false });
    expect(t.browser.events.some((e) => e.op === 'type' && e.text === 'Hacker')).toBe(false);
    expect(submitted(t)).toBe(false);
    const cards = t.tg.calls.filter((c) => c.method === 'sendRichMessage' && md(c).includes('🔐'));
    expect(cards).toHaveLength(2);
    expect(md(cards[0]!)).toContain('Hacker');
  });

  it('snapshot token cap: a very long page stays under 1,800 estimated tokens on groq-free', async () => {
    const b = await boot({ env: { LLM_PROVIDER: 'groq' } });
    t = b.t;
    expect(t.s.config.profile.id).toBe('groq-free');
    t.browser.addSite(longPageSite());
    b.llm.pushMission(turn().toolUse('browser_open', { url: 'https://long.example/' }, 'tm_long'), turn().toolUse('browser_done', { summary: 'ok' }, 'tm_done'));
    await startTask(t, b.llm, { goal: 'Найди на длинной странице пункт 7', startUrl: 'https://long.example/' });
    const req = b.llm.requests.find((r) => JSON.stringify(r.messages).includes('tm_long') && JSON.stringify(r.messages).includes('A very long page'))!;
    const msgs = req.messages as Array<{ content: unknown }>;
    const block = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => (c as { tool_use_id?: string }).tool_use_id === 'tm_long') as { content: string };
    const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    expect(text).toContain('Title: Long page');
    expect(text).toContain('not shown');
    expect(text).not.toContain('[…truncated]'); // inside the engine's Groq tool-result cap, never cut blindly
    expect(text.trimEnd().endsWith('</untrusted>')).toBe(true);
    expect(estimateTokens(text)).toBeLessThanOrEqual(1_800);
  });

  it('restart mid-task: the stale approval cannot run, and the task continues in a fresh context at the saved URL', async () => {
    const b = await boot();
    t = b.t;
    scriptToCard(b.llm);
    await startTask(t, b.llm);
    const card = approvalCard(t);
    t = await t.restart();
    expect(t.browser.opened[0]!.closed).toBe(true); // app.stop closed the context
    b.llm.pushMission(turn().toolUse('browser_snapshot', {}, 'tm_resnap'), turn().toolUse('browser_done', { summary: 'Страница открыта заново.' }, 'tm_done'));
    await tapButton(t, card, (x) => !!x.callback_data?.includes(':y:o:'));
    expect(submitted(t)).toBe(false); // the page state could not be re-checked: nothing was clicked
    expect(t.browser.opened).toHaveLength(2);
    expect(t.browser.opened[1]!.url).toBe(`${BOOKING_ORIGIN}/book?r=alma`);
    const last = JSON.stringify(b.llm.requests.at(-1)!.messages);
    expect(last).toContain('the browser was restarted');
    expect(task(t).status).toBe('done');
  });

  it('quota: the 4th browser task of the day on the free plan is refused with the plan notice', async () => {
    const b = await boot();
    t = b.t;
    b.llm.push(say('Привет!'));
    await t.userSends('привет', { user: RU_USER });
    await t.settle();
    const u = userOf(t);
    for (let i = 0; i < t.s.config.plans.free.browserTasksPerDay; i++) t.s.quotas.consume(u.id, 'browser');
    const kinds: string[] = [];
    const orig = t.s.notices.quotaExceeded.bind(t.s.notices);
    t.s.notices.quotaExceeded = async (userId, k, chat) => {
      kinds.push(k);
      await orig(userId, k, chat); // SURF.quota_browser exists (s07 lead): the notice renders, no error is swallowed
    };
    const before = t.tg.calls.length;
    await startTask(t, b.llm);
    expect(t.s.browserTasks.list(u.id)).toEqual([]);
    expect(t.s.missions.list(u.id)).toEqual([]);
    expect(kinds).toEqual(['browser']);
    expect(t.tg.calls.slice(before).some((c) => /задачи в браузере/.test(md(c)))).toBe(true);
    const res = JSON.stringify(b.llm.requests.at(-1)!.messages);
    expect(res).toContain('Blocked by policy (S06)');
    expect(t.browser.opened).toHaveLength(0);
  });
});
