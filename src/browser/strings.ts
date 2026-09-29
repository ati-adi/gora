// browser/strings.ts (s07 BR) — module-private EN/RU texts of the browser agent (04 §2 i18n: text no other module
// needs stays local, the language chosen with uiLang). Friend mode (05): one short line, no lectures, no feature talk.
import { uiLang } from '../contracts/index.ts';

export type BrowserStrings = { [K in keyof typeof EN]: (typeof EN)[K] extends (...a: infer A) => string ? (...a: A) => string : string };

const EN = {
  act_done: 'finishing',
  step: (n: number, what: string) => `Step ${n}: ${what}…`,
  act_open: 'opening the site', act_snapshot: 'reading the page', act_click: 'clicking', act_type: 'filling in the form', act_select: 'picking an option',
  act_press: 'pressing a key', act_scroll: 'scrolling', act_back: 'going back', act_show: 'showing you the page',
  login: 'The site wants a login. I can go on without it — or here is the link if you want to sign in yourself.',
  login_continue: 'Continue without login', open_site: '🔗 Open the site',
  payment: (host: string) => `Almost there: the last step, payment, is yours — ${host}`,
  open_payment: '💳 Open payment',
  captcha: 'The site is asking to prove I am human — I can’t do that one. Want to try it yourself?',
  time_limit: 'I’ve been at it for 15 minutes. Keep going?',
  step_limit: 'That took a lot of steps. Keep going?',
  continue: '▶ Continue',
  unavailable: 'The browser is not available on this server right now.',
  busy: 'I’m already working on another site task — let me finish that one first.',
  started: 'On it — I’ll work on the site in a separate thread and ask before submitting anything.',
  shown: 'Here is the page',
  approval_next: 'The site receives this form and the action is committed',
  approval_next_pay: 'This would pay — I never pay; the payment step is yours',
  approval_title_click: 'Submit on the site',
  approval_title_type: 'Type on the site',
  approval_title_press: 'Submit the form',
  approval_title_open: 'Open another site',
  approval_next_open: 'The browser goes to this address (the site sees the whole URL)',
  row_site: 'Site', row_action: 'Action', row_next: 'What happens next', row_value: 'Text',
  action_click: (name: string) => `Press “${name}”`, action_press: 'Press Enter in the form', action_type: (name: string) => `Type into “${name}”`,
  action_open: (host: string) => `Open ${host}`,
};

const RU: BrowserStrings = {
  act_done: 'завершаю',
  step: (n: number, what: string) => `Шаг ${n}: ${what}…`,
  act_open: 'открываю сайт', act_snapshot: 'смотрю страницу', act_click: 'нажимаю', act_type: 'заполняю форму', act_select: 'выбираю вариант',
  act_press: 'нажимаю клавишу', act_scroll: 'листаю страницу', act_back: 'возвращаюсь назад', act_show: 'показываю страницу',
  login: 'Сайт просит войти. Могу продолжить без входа — или вот ссылка, если хочешь войти сам.',
  login_continue: 'Продолжить без входа', open_site: '🔗 Открыть сайт',
  payment: (host: string) => `Почти готово: последний шаг — оплата — за вами: ${host}`,
  open_payment: '💳 Перейти к оплате',
  captcha: 'Сайт просит доказать, что я не робот, — это я не смогу. Попробуешь сам?',
  time_limit: 'Вожусь уже 15 минут. Продолжать?',
  step_limit: 'Вышло много шагов. Продолжать?',
  continue: '▶ Продолжить',
  unavailable: 'Браузер сейчас недоступен на этом сервере.',
  busy: 'Я уже занята другим делом на сайте — дай сначала закончить его.',
  started: 'Взялась — поработаю на сайте в отдельной ветке и спрошу перед любой отправкой.',
  shown: 'Вот страница',
  approval_next: 'Сайт получит эту форму, и действие будет совершено',
  approval_next_pay: 'Это оплата — я никогда не плачу, этот шаг за вами',
  approval_title_click: 'Отправить на сайте',
  approval_title_type: 'Ввести на сайте',
  approval_title_press: 'Отправить форму',
  approval_title_open: 'Открыть другой сайт',
  approval_next_open: 'Браузер перейдёт по этому адресу (сайт увидит весь адрес)',
  row_site: 'Сайт', row_action: 'Действие', row_next: 'Что дальше', row_value: 'Текст',
  action_click: (name: string) => `Нажать «${name}»`, action_press: 'Нажать Enter в форме', action_type: (name: string) => `Ввести в «${name}»`,
  action_open: (host: string) => `Открыть ${host}`,
};

export function brStrings(lang: string | null | undefined): BrowserStrings {
  return uiLang(lang) === 'ru' ? RU : EN;
}
