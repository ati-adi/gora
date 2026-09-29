// src/surfaces/strings.ts (WP7a) — every UI string, English and Russian (01 §3: ru/uk/kk/be → Russian).
//  - CATALOG covers every contracts/i18n.ts STRING_KEYS entry (other WPs read it through `s.strings.t`).
//  - SURF holds the strings only surfaces uses (first contact, lazy tz, commands, groups, guest, payments, /why).
// Placeholders are `{name}`; a missing var stays as written (never throws).
import { STRING_KEYS, uiLang, type StringKey, type Strings, type StringVars, type UiLang } from '../contracts/index.ts';

export interface Pair { en: string; ru: string }

/** en + ru for every STRING_KEYS entry (same placeholders as the contract's reference text). */
export const CATALOG: Readonly<Record<StringKey, Pair>> = Object.freeze({
  // ── WP2 channels
  stopped: { en: '⏹ Stopped', ru: '⏹ Остановлено' },
  busy_retrying: { en: '⏳ Busy — retrying in {seconds}s', ru: '⏳ Занято — повтор через {seconds} с' },
  continue_button: { en: 'Continue ▶', ru: 'Продолжить ▶' },
  retry_button: { en: '↻ Retry', ru: '↻ Повторить' },
  listen_button: { en: '🔊 Listen', ru: '🔊 Послушать' },
  use_privately_button: { en: '🔒 Use Gora privately', ru: '🔒 Написать Gora лично' },
  continue_privately_button: { en: '🔒 Continue privately', ru: '🔒 Продолжить лично' },
  guest_placeholder: { en: '…', ru: '…' },
  slow_down: { en: 'Slow down a bit — I’m still on your last messages.', ru: 'Чуть помедленнее — я ещё разбираю ваши прошлые сообщения.' },
  // ── WP3 engine
  llm_busy: { en: 'Busy — retrying…', ru: 'Занято — пробую ещё раз…' },
  temp_error: { en: 'I couldn’t get an answer just now. Please try again in a moment.', ru: 'Сейчас не получилось ответить. Попробуйте ещё раз чуть позже.' },
  failed_ref: { en: 'Something went wrong on my side (ref {ref}).', ru: 'Что-то пошло не так на моей стороне (код {ref}).' },
  refusal: { en: 'I can’t help with that one.', ru: 'С этим я помочь не могу.' },
  refusal_cooldown: { en: 'Let’s take a short break — I’ll be back at {time}.', ru: 'Давайте сделаем небольшой перерыв — вернусь в {time}.' },
  prompt_budget: { en: 'That was too long for me to process — could you split it?', ru: 'Это слишком длинно для меня — можно разбить на части?' },
  too_long: { en: 'That answer got too long to finish. Ask me for a shorter version?', ru: 'Ответ получился слишком длинным. Попросите покороче?' },
  free_left: { en: '({n} free messages left today)', ru: '(сегодня осталось бесплатных сообщений: {n})' },
  step_cap: { en: '[step limit reached — the owner can tap Continue]', ru: '[достигнут лимит шагов — владелец может нажать «Продолжить»]' },
  no_reply_temp_error: { en: '[no reply: temporary error]', ru: '[нет ответа: временная ошибка]' },
  context_full: { en: '[context full — continuing in a fresh thread]', ru: '[контекст заполнен — продолжаю в новой ветке]' },
  declined: { en: '[declined]', ru: '[отклонено]' },
  // ── WP4 trust
  already_handled: { en: 'Already handled', ru: 'Уже обработано' },
  tap_the_card: { en: 'Tap the button on the card.', ru: 'Нажмите кнопку на карточке.' },
  approve_button: { en: '✅ Approve', ru: '✅ Одобрить' },
  approve_24h_button: { en: '✅ Approve for 24 h', ru: '✅ Одобрять 24 ч' },
  deny_button: { en: '✖ Deny', ru: '✖ Отклонить' },
  undo_button: { en: '↩ Undo', ru: '↩ Отменить' },
  approval_not_sent: { en: '✖ Not sent', ru: '✖ Не отправлено' },
  approval_expired: { en: '⌛ Expired', ru: '⌛ Истекло' },
  approval_superseded: { en: 'Superseded', ru: 'Заменено' },
  draft_changed: { en: 'Draft changed since you saw it — please review again', ru: 'Черновик изменился — проверьте ещё раз' },
  safety_check: { en: 'Safety check: {rationale}', ru: 'Проверка безопасности: {rationale}' },
  undone: { en: 'Undone ✓', ru: 'Отменено ✓' },
  undo_expired: { en: 'Too late to undo.', ru: 'Отменить уже нельзя.' },
  // ── WP5 tools / integrations
  connect_button: { en: 'Connect {service}', ru: 'Подключить {service}' },
  share_location_button: { en: '📍 Share location', ru: '📍 Отправить геопозицию' },
  // ── WP6 reminders / nudges / missions
  late: { en: '(late)', ru: '(с опозданием)' },
  missed: { en: '(missed)', ru: '(пропущено)' },
  done_button: { en: '✓ Done', ru: '✓ Готово' },
  snooze_10m_button: { en: '⏰ 10 min', ru: '⏰ 10 мин' },
  snooze_1h_button: { en: '⏰ 1 h', ru: '⏰ 1 ч' },
  tomorrow_button: { en: 'Tomorrow', ru: 'Завтра' },
  nudge_do_button: { en: 'Do it', ru: 'Сделать' },
  nudge_snooze_button: { en: 'Snooze', ru: 'Отложить' },
  nudge_never_button: { en: 'Never this kind', ru: 'Больше такое не присылать' },
  mission_stop_button: { en: '⏹ Stop mission', ru: '⏹ Остановить задачу' },
  mission_budget_exhausted: { en: 'Budget used up ({spent} of {budget}).', ru: 'Бюджет исчерпан ({spent} из {budget}).' },
  // ── WP7
  quota_exceeded: { en: 'You’ve used today’s {what} ({used}/{limit}). It resets {resets}.', ru: 'Сегодняшний лимит исчерпан: {what} ({used}/{limit}). Обновится {resets}.' },
  plans_button: { en: '⭐ Plans', ru: '⭐ Тарифы' },
  // ── friend mode (spec 05)
  tz_hint_button: { en: '🕒 Set my time zone', ru: '🕒 Уточнить пояс' },
} satisfies Record<StringKey, Pair>);

/** Surfaces-only strings (not part of the cross-WP catalog). */
export const SURF = Object.freeze({
  // ── generic
  skip: { en: 'Skip', ru: 'Пропустить' },
  next: { en: 'Next ▶', ru: 'Дальше ▶' },
  cancel: { en: 'Cancel', ru: 'Отмена' },
  open_gora: { en: '📒 Open Gora', ru: '📒 Открыть Gora' },
  open_in_gora: { en: 'Open in Gora', ru: 'Открыть в Gora' },
  something_wrong: { en: 'Something went wrong. Please try again.', ru: 'Что-то пошло не так. Попробуйте ещё раз.' },
  button_invalid: { en: 'This button is no longer valid.', ru: 'Эта кнопка больше не работает.' },
  button_not_yours: { en: 'This button isn’t for you.', ru: 'Эта кнопка не для вас.' },
  button_expired: { en: 'This button has expired.', ru: 'Срок действия кнопки истёк.' },
  too_many_taps: { en: 'Too many taps — one moment.', ru: 'Слишком много нажатий — секунду.' },
  done_toast: { en: 'Done ✓', ru: 'Готово ✓' },
  start_first: { en: 'Please send /start first.', ru: 'Сначала отправьте /start.' },

  // ── first contact (spec 05 A2): exactly this one line, no buttons
  start_hello: { en: 'Hey! I’m Gora 🙂 What’s up?', ru: 'Привет! Я Гора 🙂 Рассказывай, что у тебя?' },
  // ── lazy time zone (spec 05 A6)
  tz_hint_line: { en: '🕒 For now I’m going by {tz}. Tap below if that’s not your zone.', ru: '🕒 Пока ориентируюсь на {tz}. Если пояс другой — нажми ниже.' },
  tz_guessed: { en: 'my guess', ru: 'примерно' },
  // ── memory / settings in friend mode (05 A5, B5, C5)
  memory_incognito_note: { en: 'Incognito is on — I’m not saving anything new right now.', ru: 'Включено инкогнито — сейчас ничего нового не запоминаю.' },
  memory_hint: { en: 'Say “forget …” anytime, or open the app to fix or delete anything.', ru: 'Скажи «забудь …» в любой момент или открой приложение, чтобы поправить или удалить.' },
  memory_open: { en: '🧠 Open memory', ru: '🧠 Открыть память' },
  memory_state_on: { en: 'on', ru: 'вкл' },
  memory_state_off: { en: 'off', ru: 'выкл' },
  memory_state_incognito: { en: 'incognito', ru: 'инкогнито' },
  settings_proactive: { en: 'Writing to you first', ru: 'Пишу первым' },
  proactive_off: { en: 'never', ru: 'никогда' },
  proactive_less: { en: 'rarely', ru: 'редко' },
  proactive_normal: { en: 'when it fits', ru: 'когда уместно' },
  proactive_more: { en: 'more often', ru: 'чаще' },
  settings_talk: { en: 'How I talk', ru: 'Как общаюсь' },
  talk_learned: { en: 'learned from you', ru: 'подстраиваюсь под тебя' },
  talk_length_short: { en: 'short', ru: 'коротко' },
  talk_length_medium: { en: 'medium', ru: 'средне' },
  talk_length_long: { en: 'detailed', ru: 'подробно' },
  talk_emoji_none: { en: 'no emoji', ru: 'без эмодзи' },
  talk_emoji_light: { en: 'a few emoji', ru: 'немного эмодзи' },
  talk_emoji_lots: { en: 'lots of emoji', ru: 'много эмодзи' },
  talk_register_informal: { en: 'casual', ru: 'на «ты»' },
  talk_register_formal: { en: 'formal', ru: 'на «вы»' },
  // ── /why on a message Gora wrote first (05 C4: the reason lives here, never in the message)
  why_proactive: { en: '💬 I wrote first: {type}, after {gap} of quiet (score {score}). {reason}', ru: '💬 Я написал первым: {type}, после паузы {gap} (оценка {score}). {reason}' },
  proactive_type_follow_up: { en: 'following up on something you mentioned', ru: 'продолжение того, о чём ты говорил' },
  proactive_type_useful: { en: 'something useful for you', ru: 'что-то полезное для тебя' },
  proactive_type_checkin: { en: 'a friendly check-in', ru: 'просто узнать, как ты' },
  proactive_type_first_hint: { en: 'a first hint of what I can do', ru: 'первая подсказка, что я умею' },

  // ── memory toggle, time zone, import (friend mode keeps only these from the old 01 §3 onboarding)
  mem_on_toast: { en: 'Memory on ✓', ru: 'Память включена ✓' },
  mem_off_toast: { en: 'Memory off', ru: 'Память выключена' },
  tz_guess: { en: 'Looks like {tz} — right?', ru: 'Похоже, это {tz} — верно?' },
  tz_guess_city: { en: 'Looks like {city}, {tz} — right?', ru: 'Похоже, это {city}, {tz} — верно?' },
  tz_yes: { en: '✅ Yes', ru: '✅ Да' },
  tz_no: { en: 'No, I’ll type my city', ru: 'Нет, напишу город' },
  tz_set: { en: '🕒 Time zone: {tz} ({offset}) ✓', ru: '🕒 Часовой пояс: {tz} ({offset}) ✓' },
  tz_type_city: { en: 'Type your city (for example: Almaty).', ru: 'Напиши свой город (например: Алматы).' },
  tz_city_not_found: { en: 'I couldn’t find that city — try another spelling.', ru: 'Не нашёл такой город — попробуй написать иначе.' },
  tz_unknown_point: { en: 'I couldn’t tell the time zone from that location. Type your city instead.', ru: 'По этой точке не понял часовой пояс. Напиши лучше город.' },
  tz_proposal_gone: { en: 'That suggestion expired — share your location or type your city again.', ru: 'Предложение устарело — отправь геопозицию или город ещё раз.' },
  m5_text: {
    en: 'Already told ChatGPT or Claude a lot about yourself? Ask it *“List everything you know about me as bullet points”* and paste it here — I’ll show each fact for you to approve.',
    ru: 'Уже много рассказали о себе ChatGPT или Claude? Попросите: *«Перечисли всё, что ты обо мне знаешь, списком»* — и вставьте ответ сюда. Я покажу каждый факт на одобрение.',
  },
  import_title: { en: 'Found {n} facts — keep the ones that are right', ru: 'Нашёл фактов: {n} — оставьте верные' },
  import_hint: { en: 'Tap ✓ or ✗ for each, then Save selected.', ru: 'Нажмите ✓ или ✗ у каждого, затем «Сохранить выбранное».' },
  import_save: { en: 'Save selected', ru: 'Сохранить выбранное' },
  import_none: { en: 'I couldn’t find any facts in that text.', ru: 'Не нашёл в этом тексте фактов.' },
  import_memory_off: { en: 'Memory is off, so I can’t import facts. Turn it on in /settings first.', ru: 'Память выключена, поэтому импорт невозможен. Сначала включите её в /settings.' },
  import_armed: { en: 'Paste the text now — I’ll show each fact for you to approve.', ru: 'Вставьте текст — я покажу каждый факт на одобрение.' },

  // ── deep links
  link_other: { en: 'This link was created for someone else.', ru: 'Эта ссылка создана для другого человека.' },
  link_expired: { en: 'This link has expired or was already used.', ru: 'Срок действия ссылки истёк, или она уже использована.' },

  // ── quota template (§13)
  quota_turn: { en: 'free messages', ru: 'бесплатные сообщения' },
  quota_web_search: { en: 'web searches', ru: 'веб-поиски' },
  quota_stt_seconds: { en: 'voice seconds', ru: 'секунды голосовых' },
  quota_file: { en: 'files', ru: 'файлы' },
  quota_guest_answer: { en: 'guest answers', ru: 'гостевые ответы' },
  quota_mission: { en: 'missions', ru: 'фоновые задачи' },
  quota_watcher: { en: 'watchers', ru: 'наблюдатели' },
  quota_browser: { en: 'browser tasks', ru: 'задачи в браузере' },
  quota_cost_micros: { en: 'usage budget', ru: 'бюджет использования' },
  quota_resets: { en: '{when} (00:00 {tz})', ru: '{when} (00:00 {tz})' },
  whats_included: { en: 'What’s included', ru: 'Что входит' },

  // ── plans & payments (F16, §13)
  plan_free: { en: 'Free', ru: 'Бесплатный' },
  plan_plus: { en: 'Plus', ru: 'Plus' },
  plan_pro: { en: 'Pro', ru: 'Pro' },
  plan_title: { en: 'Your plan: {plan}', ru: 'Ваш тариф: {plan}' },
  plan_until: { en: 'Active until {date}', ru: 'Действует до {date}' },
  plan_canceled_until: { en: 'Renewal canceled — active until {date}', ru: 'Продление отменено — действует до {date}' },
  plan_failed_grace: { en: 'Renewal failed — grace period until {date}', ru: 'Продление не прошло — льготный период до {date}' },
  plan_usage: { en: 'Today: {turns}/{turnsLimit} messages · {searches}/{searchLimit} searches · {files}/{fileLimit} files', ru: 'Сегодня: сообщения {turns}/{turnsLimit} · поиски {searches}/{searchLimit} · файлы {files}/{fileLimit}' },
  plan_offer: { en: '⭐ {plan} — {price} Stars / 30 days', ru: '⭐ {plan} — {price} звёзд / 30 дней' },
  plan_offer_line: { en: '**{plan}** · {price} ⭐/30 days: {turns} messages/day, {searches} searches/day, {missions} missions, {watchers} watchers', ru: '**{plan}** · {price} ⭐/30 дней: {turns} сообщений/день, {searches} поисков/день, задач: {missions}, наблюдателей: {watchers}' },
  plan_free_line: { en: '**Free** · {turns} messages/day, {searches} searches/day, {missions} mission, {watchers} watchers', ru: '**Бесплатный** · {turns} сообщений/день, {searches} поисков/день, задач: {missions}, наблюдателей: {watchers}' },
  plan_trust_note: { en: 'Approvals, Ledger, memory controls, export, delete and /why are free on every plan.', ru: 'Одобрения, журнал, управление памятью, экспорт, удаление и /why бесплатны на любом тарифе.' },
  plan_cancel_button: { en: 'Cancel renewal', ru: 'Отменить продление' },
  plan_pay_text: { en: 'Gora {plan} — {price} Stars for 30 days, renews monthly. Cancel anytime in /plan.', ru: 'Gora {plan} — {price} звёзд за 30 дней, продлевается ежемесячно. Отменить можно в /plan.' },
  plan_pay_button: { en: 'Pay ⭐ {price}', ru: 'Оплатить ⭐ {price}' },
  plan_already: { en: 'You already have {plan}.', ru: 'У вас уже {plan}.' },
  plan_no_sub: { en: 'You have no active subscription.', ru: 'У вас нет активной подписки.' },
  plan_canceled: { en: 'Renewal canceled — {plan} stays active until {date}.', ru: 'Продление отменено — {plan} действует до {date}.' },
  invoice_title: { en: 'Gora {plan}', ru: 'Gora {plan}' },
  invoice_desc: { en: '{turns} messages/day, {searches} web searches/day, {missions} missions, {watchers} watchers. 30 days, renews monthly.', ru: '{turns} сообщений/день, {searches} веб-поисков/день, задач: {missions}, наблюдателей: {watchers}. 30 дней, ежемесячное продление.' },
  invoice_label: { en: 'Gora {plan} · 30 days', ru: 'Gora {plan} · 30 дней' },
  precheck_invalid: { en: 'This invoice is no longer valid. Open /plan for a fresh one.', ru: 'Этот счёт больше не действителен. Откройте /plan, чтобы получить новый.' },
  pay_thanks: { en: '⭐ Thank you! Gora {plan} is active until {date}.', ru: '⭐ Спасибо! Gora {plan} действует до {date}.' },
  sub_renewed: { en: '✅ Gora {plan} renewed.', ru: '✅ Gora {plan} продлён.' },
  sub_canceled: { en: 'Your {plan} renewal is canceled. It stays active until {date}.', ru: 'Продление {plan} отменено. Тариф действует до {date}.' },
  sub_failed: { en: 'Your {plan} renewal didn’t go through. You keep {plan} until {date} — check your Stars balance to continue.', ru: 'Не удалось продлить {plan}. Тариф сохранится до {date} — проверьте баланс звёзд.' },
  sub_downgraded: { en: 'Your Gora {plan} plan has ended — you’re on Free now. /plan to renew.', ru: 'Тариф Gora {plan} закончился — теперь у вас бесплатный. Продлить — /plan.' },
  refunded: { en: 'Refunded {amount} Stars for Gora {plan}.', ru: 'Возвращено {amount} звёзд за Gora {plan}.' },
  paysupport: {
    en: '**Payments support**\n\nGora plans are paid in Telegram Stars and renew every 30 days. Cancel anytime with /plan → Cancel renewal; your plan stays active until the end of the period.\n\n**Refunds:** if something went wrong with a payment, reply here with a short description within 14 days — we refund unused periods in Stars. Telegram support cannot refund bot purchases; we can.',
    ru: '**Поддержка по оплате**\n\nТарифы Gora оплачиваются звёздами Telegram и продлеваются каждые 30 дней. Отменить можно в /plan → «Отменить продление»; тариф действует до конца оплаченного периода.\n\n**Возвраты:** если с оплатой что-то не так, опишите проблему здесь в течение 14 дней — мы вернём звёзды за неиспользованный период. Поддержка Telegram не возвращает покупки в ботах, а мы — да.',
  },
  terms: {
    en: '**Terms (short version)**\n\n• Gora is an AI assistant: it can be wrong, so check important facts.\n• It acts on your behalf only after you tap Approve on a card.\n• Paid plans are digital subscriptions in Telegram Stars, 30 days each; see /paysupport for refunds.\n• You own your data: /export to download it, /deletemydata to erase it. Details in /privacy.\n• Don’t use Gora for anything illegal or to harm others.',
    ru: '**Условия (кратко)**\n\n• Gora — ИИ-ассистент и может ошибаться: проверяйте важное.\n• Действует от вашего имени только после нажатия «Одобрить» на карточке.\n• Платные тарифы — цифровые подписки за звёзды Telegram на 30 дней; возвраты — /paysupport.\n• Данные принадлежат вам: /export — скачать, /deletemydata — удалить. Подробнее — /privacy.\n• Не используйте Gora для незаконных действий или во вред другим.',
  },

  // ── commands
  help: {
    en: '**What I can do**\nJust write or send a voice note, photo or PDF. I answer, research, remind and draft — and act only when you tap Approve.\n\n/new — start a fresh thread (/new wipe also shreds the old one)\n/memory — what I remember · /import — bring facts from ChatGPT/Claude\n/why — reply to any of my messages to see why I said it\n/ledger — everything I read and did · /approvals — waiting for your tap\n/tasks — reminders, to-dos, missions\n/pause · /resume — stop or allow actions\n/incognito 1h|off — nothing is remembered meanwhile\n/nudges · /quiet — unprompted messages and quiet hours\n/voice on|off — voice replies to voice notes\n/settings · /plan · /privacy · /export · /deletemydata\n/paysupport · /terms',
    ru: '**Что я умею**\nПросто пишите или отправляйте голосовые, фото и PDF. Я отвечаю, ищу, напоминаю и готовлю черновики — а действую только после «Одобрить».\n\n/new — начать новую ветку (/new wipe — ещё и стереть старую)\n/memory — что я помню · /import — перенести факты из ChatGPT/Claude\n/why — ответьте этим на моё сообщение, чтобы узнать почему\n/ledger — всё, что я читал и делал · /approvals — ждёт вашего нажатия\n/tasks — напоминания, списки, задачи\n/pause · /resume — запретить или разрешить действия\n/incognito 1h|off — на это время ничего не запоминаю\n/nudges · /quiet — сообщения без запроса и тихие часы\n/voice on|off — голосовые ответы на голосовые\n/settings · /plan · /privacy · /export · /deletemydata\n/paysupport · /terms',
  },
  new_done: { en: '🆕 Fresh start — your next message begins a new thread. Memory and reminders are unchanged.', ru: '🆕 Начинаем заново — следующее сообщение откроет новую ветку. Память и напоминания не меняются.' },
  new_wipe_done: { en: '🆕 Fresh start — the previous thread will be shredded, and facts learned from it forgotten.', ru: '🆕 Начинаем заново — прошлая ветка будет уничтожена, а факты из неё забыты.' },
  pause_on: { en: '⏸ Paused. I won’t take any action except reading until you send /resume.', ru: '⏸ Пауза. Пока не отправите /resume, я ничего не делаю, кроме чтения.' },
  pause_off: { en: '▶️ Resumed. Actions work again (with your approval as usual).', ru: '▶️ Продолжаем. Действия снова доступны (как обычно, с вашим одобрением).' },
  incognito_on: { en: '🕶 Incognito until {time}. I won’t remember anything from this stretch, and it will be shredded afterwards.', ru: '🕶 Инкогнито до {time}. Ничего из этого отрезка я не запомню, а потом он будет уничтожен.' },
  incognito_off: { en: '🕶 Incognito off.', ru: '🕶 Инкогнито выключено.' },
  incognito_usage: { en: 'Use /incognito 1h (or 30m, 2h…) or /incognito off.', ru: 'Используйте /incognito 1h (или 30m, 2h…) либо /incognito off.' },
  quiet_set: { en: '🌙 Quiet hours: {start}–{end}. I won’t message you unprompted then.', ru: '🌙 Тихие часы: {start}–{end}. В это время я не пишу без запроса.' },
  quiet_show: { en: '🌙 Quiet hours: {start}–{end}. Change with /quiet 22:00-08:00.', ru: '🌙 Тихие часы: {start}–{end}. Изменить: /quiet 22:00-08:00.' },
  voice_on: { en: '🔊 Voice replies on: I’ll answer your voice notes with a voice note (short answers).', ru: '🔊 Голосовые ответы включены: на голосовые буду отвечать голосом (короткие ответы).' },
  voice_off: { en: '🔇 Voice replies off.', ru: '🔇 Голосовые ответы выключены.' },
  voice_status: { en: 'Voice replies are {state}. Use /voice on or /voice off.', ru: 'Голосовые ответы: {state}. Используйте /voice on или /voice off.' },
  voice_unavailable: { en: 'Voice replies aren’t available right now.', ru: 'Голосовые ответы сейчас недоступны.' },
  state_on: { en: 'on', ru: 'включены' },
  state_off: { en: 'off', ru: 'выключены' },
  settings_title: { en: 'Settings', ru: 'Настройки' },
  settings_tz: { en: 'Time zone', ru: 'Часовой пояс' },
  settings_city: { en: 'Home city', ru: 'Город' },
  settings_name: { en: 'My name', ru: 'Моё имя' },
  settings_memory: { en: 'Memory', ru: 'Память' },
  settings_nudges: { en: 'Unprompted messages/day', ru: 'Сообщений без запроса в день' },
  settings_quiet: { en: 'Quiet hours', ru: 'Тихие часы' },
  settings_brief: { en: 'Morning brief', ru: 'Утренняя сводка' },
  settings_voice: { en: 'Voice replies', ru: 'Голосовые ответы' },
  settings_hint: { en: 'Or just tell me: “write shorter”, “don’t text me first”, “call yourself Nova”.', ru: 'Или просто скажи: «пиши короче», «не пиши мне первым», «зови себя Нова».' },
  settings_memory_toggle_on: { en: '🧠 Turn memory on', ru: '🧠 Включить память' },
  settings_memory_toggle_off: { en: '🕶 Turn memory off', ru: '🕶 Выключить память' },
  city_set: { en: '🏙 Home city: {city}.', ru: '🏙 Город: {city}.' },
  none: { en: 'none', ru: 'нет' },
  on: { en: 'on', ru: 'вкл' },
  off: { en: 'off', ru: 'выкл' },
  nudges_title: { en: 'Unprompted messages', ru: 'Сообщения без запроса' },
  nudges_budget: { en: 'Up to {n} a day, never during quiet hours ({quiet}).', ru: 'До {n} в день, никогда в тихие часы ({quiet}).' },
  nudges_muted: { en: 'Muted kinds: {kinds}', ru: 'Отключённые типы: {kinds}' },
  nudges_hint: { en: 'Tap “Never this kind” on any nudge to mute it, or adjust everything in the app.', ru: 'Нажмите «Больше такое не присылать» на любом сообщении или настройте всё в приложении.' },
  ledger_title: { en: 'Ledger — last {n} entries', ru: 'Журнал — последние {n} записей' },
  ledger_empty: { en: 'Your ledger is empty so far.', ru: 'Журнал пока пуст.' },
  ledger_when: { en: 'When', ru: 'Когда' },
  ledger_what: { en: 'What', ru: 'Что' },
  tasks_title: { en: 'Tasks', ru: 'Задачи' },
  tasks_reminders: { en: 'Reminders', ru: 'Напоминания' },
  tasks_todos: { en: 'To-dos', ru: 'Список дел' },
  tasks_missions: { en: 'Missions', ru: 'Фоновые задачи' },
  tasks_empty: { en: 'Nothing scheduled yet. Try “remind me to call mom tomorrow at 7”.', ru: 'Пока ничего не запланировано. Попробуйте: «напомни позвонить маме завтра в 7».' },
  approvals_none: { en: 'No approvals are waiting for you.', ru: 'Нет ничего, что ждёт вашего одобрения.' },
  memory_title: { en: 'What I remember', ru: 'Что я помню' },
  memory_empty: { en: 'I don’t remember anything about you yet.', ru: 'Я пока ничего о вас не помню.' },
  memory_off_note: { en: 'Memory is off — I’m not saving anything new.', ru: 'Память выключена — ничего нового не сохраняю.' },
  forget_button: { en: 'Forget {id}', ru: 'Забыть {id}' },
  privacy: {
    en: '**Privacy**\n\n**Processors:** {llm} (AI model; zero data retention requested where eligible){stt}{integrations}, Open-Meteo and MET Norway (weather), Photon (places). Coordinates are rounded before they leave.\n\n**Retention:** conversations until you delete them (closed threads are shredded after 90 days); guest answers 24 h; locations 1 h; secretary messages 30 days; the ledger 365 days.\n\n**Security:** everything is encrypted, and the keys are stored apart from the data. Forgetting shreds the keys. Forgotten text may stay in the model provider’s prompt cache for up to 1 h.\n\nYour data is never used for training. /export downloads everything; /deletemydata erases it.',
    ru: '**Конфиденциальность**\n\n**Обработчики:** {llm} (ИИ-модель; где возможно, запрошено нулевое хранение){stt}{integrations}, Open-Meteo и MET Norway (погода), Photon (места). Координаты округляются перед отправкой.\n\n**Сроки хранения:** переписка — пока вы её не удалите (закрытые ветки уничтожаются через 90 дней); гостевые ответы — 24 ч; геопозиция — 1 ч; сообщения секретаря — 30 дней; журнал — 365 дней.\n\n**Безопасность:** всё зашифровано, ключи хранятся отдельно от данных. «Забыть» уничтожает ключи. Забытый текст может оставаться в кэше промптов поставщика модели до 1 ч.\n\nВаши данные не используются для обучения. /export — скачать всё; /deletemydata — удалить.',
  },
  privacy_stt: { en: ', {stt} (voice transcription)', ru: ', {stt} (расшифровка голоса)' },
  privacy_integrations: { en: ', Composio (Gmail/Calendar connection)', ru: ', Composio (подключение Gmail/Календаря)' },
  export_text: { en: 'Your export is one JSON file with everything I store about you.', ru: 'Экспорт — один JSON-файл со всем, что я о вас храню.' },
  export_button: { en: '⬇️ Download', ru: '⬇️ Скачать' },
  delete_confirm: { en: '⚠️ This permanently deletes your memory, conversations, reminders, missions, connections and ledger. It can’t be undone. Your paid plan renewal is canceled.', ru: '⚠️ Это навсегда удалит память, переписку, напоминания, задачи, подключения и журнал. Отменить нельзя. Продление тарифа будет отменено.' },
  delete_yes: { en: 'Yes, delete everything', ru: 'Да, удалить всё' },
  delete_done: { en: 'Deleted. Telegram keeps this chat on your device — delete the chat to remove it there.', ru: 'Удалено. Telegram хранит этот чат на вашем устройстве — удалите чат, чтобы убрать его и там.' },
  delete_canceled: { en: 'Canceled — nothing was deleted.', ru: 'Отменено — ничего не удалено.' },
  delete_expired: { en: 'That confirmation expired. Send /deletemydata again.', ru: 'Подтверждение устарело. Отправьте /deletemydata ещё раз.' },
  unknown_command: { en: 'I don’t know that command. /help lists what I can do.', ru: 'Не знаю такой команды. /help покажет, что я умею.' },

  // ── /why (F8)
  why_usage: { en: 'Reply /why to one of my messages to see why I said it.', ru: 'Ответьте /why на моё сообщение, чтобы узнать, почему я так написал.' },
  why_unknown: { en: 'I have no record for that message.', ru: 'У меня нет записи об этом сообщении.' },
  why_title: { en: 'Why I sent this', ru: 'Почему я это отправил' },
  why_memories: { en: 'Memories used', ru: 'Использованные воспоминания' },
  why_no_memories: { en: 'No memories were used.', ru: 'Воспоминания не использовались.' },
  why_tools: { en: 'Tools', ru: 'Инструменты' },
  why_no_tools: { en: 'No tools were called.', ru: 'Инструменты не вызывались.' },
  why_sources: { en: 'Sources', ru: 'Источники' },
  why_decisions: { en: 'Safety decisions', ru: 'Решения проверки' },
  why_model: { en: 'Answered by: {model}', ru: 'Ответила модель: {model}' },
  why_fallback: { en: '{model} (a fallback model answered)', ru: '{model} (ответила резервная модель)' },
  why_nudge: { en: 'Sent unprompted — {why}', ru: 'Отправлено без запроса — {why}' },
  why_reminder: { en: 'A scheduled reminder — sent by the scheduler, no AI involved.', ru: 'Запланированное напоминание — отправлено планировщиком, без ИИ.' },
  why_approval: { en: 'Approval card {id}: {title} — {status}', ru: 'Карточка одобрения {id}: {title} — {status}' },
  why_trigger_user: { en: 'Started by your message.', ru: 'Запущено вашим сообщением.' },
  why_trigger_event: { en: 'Started by an event ({what}).', ru: 'Запущено событием ({what}).' },
  why_tainted: { en: 'External content was read in this run ({sources}), so nothing could be sent automatically.', ru: 'В этом запуске читался внешний контент ({sources}), поэтому ничего не отправлялось автоматически.' },

  // ── groups (F14, §10.3)
  group_intro: {
    en: '👋 Hi, I’m Gora. In this group I only read messages that mention @{bot}, reply to me, or are my commands — nothing else is read or stored.\n\nGroup memory (/remember, /groupmemory) is visible to all members. Nobody’s private memory is ever used here. For a private answer, use /me <question>.',
    ru: '👋 Привет, я Gora. В этой группе я читаю только сообщения с упоминанием @{bot}, ответы мне и мои команды — остальное не читается и не хранится.\n\nПамять группы (/remember, /groupmemory) видна всем участникам. Личная память участников здесь не используется. Для личного ответа — /me <вопрос>.',
  },
  group_break: { en: 'I’m taking a short break — too many requests here. Try again in a few minutes.', ru: 'Беру короткую паузу — здесь слишком много запросов. Попробуйте через несколько минут.' },
  group_help: { en: 'Mention @{bot} or reply to me to ask something. /remember <fact> saves to group memory (visible to all), /groupmemory lists it, /forget mN removes a fact, /me <question> answers you privately.', ru: 'Упомяните @{bot} или ответьте мне, чтобы спросить. /remember <факт> — в память группы (видна всем), /groupmemory — список, /forget mN — удалить факт, /me <вопрос> — личный ответ.' },
  group_remembered: { en: '📝 Saved to group memory ({id}). Everyone here can see it.', ru: '📝 Сохранено в память группы ({id}). Это видят все участники.' },
  group_remember_usage: { en: 'Use /remember <what to remember>.', ru: 'Используйте /remember <что запомнить>.' },
  group_remember_denied: { en: 'I couldn’t save that ({reason}).', ru: 'Не удалось сохранить ({reason}).' },
  group_memory_title: { en: 'Group memory', ru: 'Память группы' },
  group_memory_empty: { en: 'Group memory is empty. Add with /remember <fact>.', ru: 'Память группы пуста. Добавить: /remember <факт>.' },
  group_forget_usage: { en: 'Use /forget mN (see /groupmemory for ids).', ru: 'Используйте /forget mN (номера — в /groupmemory).' },
  group_forgotten: { en: 'Forgotten: {what}', ru: 'Забыто: {what}' },
  group_forget_none: { en: 'Nothing was forgotten — only the author or an admin can remove a fact.', ru: 'Ничего не забыто — удалить факт может только автор или админ.' },
  // ── group participant (spec 07 C4–C6, GR)
  group_quieter_ack: { en: 'Got it — I’ll chime in less 🤫', ru: 'Поняла — буду встревать реже 🤫' },
  group_quiet_ack: { en: 'Got it — I’ll only answer when you call me.', ru: 'Поняла — буду отвечать, только когда позовёте.' },
  group_louder_ack: { en: 'Okay, I’ll chime in more often 🙂', ru: 'Хорошо, буду подключаться чаще 🙂' },
  group_catchup_title: { en: 'While you were away in “{group}”:', ru: 'Пока вас не было в «{group}»:' },
  group_catchup_title_plain: { en: 'While you were away:', ru: 'Пока вас не было:' },
  group_catchup_none: { en: 'Nothing new since your last message 🙂', ru: 'С вашего последнего сообщения ничего нового 🙂' },
  group_catchup_dm: { en: '🔒 Sent you a catch-up in our DM', ru: '🔒 Прислала сводку в личку' },
  group_catchup_start: { en: '🔒 Tap to open our DM — the catch-up is waiting there.', ru: '🔒 Нажмите, чтобы открыть личный чат, — сводка будет там.' },
  group_forget_all: { en: 'Done — I’ve forgotten what I stored from this chat.', ru: 'Готово — забыла всё, что сохранила из этого чата.' },
  group_forget_all_partial: {
    en: 'Done — I’ve forgotten the messages and everything I noted myself. {n} note(s) added with /remember stay: their author or an admin can remove them (/groupmemory).',
    ru: 'Готово — забыла сообщения и всё, что записала сама. Осталось заметок, добавленных через /remember: {n} — их может удалить автор или админ (/groupmemory).',
  },
  add_to_group_button: { en: '➕ Add Gora to a group', ru: '➕ Добавить Гору в группу' },
  me_ack: { en: '🔒 Answered in our DM', ru: '🔒 Ответил в личных сообщениях' },
  me_public: { en: '🔒 I’ll answer in our DM', ru: '🔒 Отвечу в личных сообщениях' },
  me_start_button: { en: '🔒 Open our DM', ru: '🔒 Открыть личный чат' },
  me_start_hint: { en: '🔒 Tap to open our DM — I’ll answer there.', ru: '🔒 Нажмите, чтобы открыть личный чат, — отвечу там.' },
  me_usage: { en: 'Use /me <question> — I’ll answer you privately.', ru: 'Используйте /me <вопрос> — отвечу лично.' },
  me_from_group: { en: '(asked privately from a group chat)', ru: '(личный вопрос из группового чата)' },

  // ── guest (F13, §10.4)
  guest_limit: { en: 'Guest answers are paused for a bit — try again later, or message me directly.', ru: 'Гостевые ответы на время приостановлены — попробуйте позже или напишите мне лично.' },
  guest_limit_title: { en: 'Gora — limit reached', ru: 'Gora — лимит исчерпан' },

  // ── location

  // ── voice (03 R4)
  listen_unavailable: { en: 'Audio isn’t available for this message.', ru: 'Для этого сообщения аудио недоступно.' },
  listen_failed: { en: 'I couldn’t make audio right now.', ru: 'Сейчас не получилось озвучить.' },
  listen_toast: { en: '🔊 Coming up…', ru: '🔊 Сейчас…' },

  // ── choices / continue
  choice_used: { en: 'Already chosen', ru: 'Уже выбрано' },
  continue_toast: { en: 'Continuing…', ru: 'Продолжаю…' },
} satisfies Record<string, Pair>);

export type SurfKey = keyof typeof SURF;

/** Fills `{name}` placeholders; missing vars stay as written. */
export function fill(text: string, vars?: StringVars): string {
  if (!vars) return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

/** A surfaces-only string in the user's UI language. */
export function st(key: SurfKey, lang: string | null | undefined, vars?: StringVars): string {
  const pair = SURF[key];
  return fill(pair[uiLang(lang)], vars);
}

/** Pick by UiLang directly (for code paths that already resolved it). */
export function pick(pair: Pair, l: UiLang): string {
  return pair[l];
}

/** contracts/i18n.ts Strings: `t(key, lang, vars)`; lang via uiLang(); `{name}` placeholders from vars. */
export function createStrings(): Strings {
  return {
    t(key: StringKey, lang: string | null | undefined, vars?: StringVars): string {
      const pair = CATALOG[key];
      if (!pair) return STRING_KEYS[key]?.en ?? String(key);
      return fill(pair[uiLang(lang)], vars);
    },
  };
}
