// src/surfaces/commands.ts (WP7a; friend mode 05 A5) — private-chat command HANDLERS. The menu published to Telegram
// (telegram/commands.ts) lists only /memory and /settings; every handler below still works when typed:
// new, memory, ledger, tasks, approvals, pause, resume, incognito, import, nudges, quiet, settings, plan, privacy,
// export, deletemydata, paysupport, terms, help, voice (/start is onboarding's, /why is why.ts). All replies are
// code-built (no LLM); trust features are never gated by plan (01 §13).
import type { CallbackAnswer, CallbackCtx, ChatRef, Scope, UserRow } from '../contracts/index.ts';
import { memoryState } from '../contracts/index.ts';
import { formatDisplay, isValidTz } from '../kernel/timeMath.ts';
import { randomToken } from '../kernel/ids.ts';
import type { Onboarding } from './onboarding.ts';
import type { PaymentsModule } from './payments.ts';
import { st } from './strings.ts';
import { appUrl, botUsername, cbBtn, dmConversation, editCard, errName, langOf, sendRich, urlBtn, webAppBtn, type Keyboard, type Surf } from './util.ts';

export type PrivateCommand = 'new' | 'memory' | 'ledger' | 'tasks' | 'approvals' | 'pause' | 'resume' | 'incognito' | 'import' | 'nudges' | 'quiet' | 'settings' | 'plan' | 'privacy' | 'export' | 'deletemydata' | 'paysupport' | 'terms' | 'help' | 'voice';
export const PRIVATE_COMMANDS: readonly PrivateCommand[] = ['new', 'memory', 'ledger', 'tasks', 'approvals', 'pause', 'resume', 'incognito', 'import', 'nudges', 'quiet', 'settings', 'plan', 'privacy', 'export', 'deletemydata', 'paysupport', 'terms', 'help', 'voice'];
export const DELETE_CONFIRM_MS = 10 * 60_000;

export interface CommandCall { user: UserRow; args: string; chat: ChatRef; updateId: number; messageId: number }

/** '1h' | '30m' | '2h30m' | '90' (minutes) → ms; null when unparseable or outside 5 min … 7 days. */
export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  let ms = 0;
  if (/^\d+$/.test(t)) ms = Number(t) * 60_000;
  else {
    const re = /(\d+)\s*(d|h|m|ч|м|д)/g;
    let m: RegExpExecArray | null;
    let seen = '';
    while ((m = re.exec(t))) {
      const n = Number(m[1]);
      const u = m[2];
      ms += u === 'd' || u === 'д' ? n * 86_400_000 : u === 'h' || u === 'ч' ? n * 3_600_000 : n * 60_000;
      seen += m[0];
    }
    if (!seen || t.replace(/\s+/g, '') !== seen.replace(/\s+/g, '')) return null;
  }
  return ms >= 5 * 60_000 && ms <= 7 * 86_400_000 ? ms : null;
}

/** 'HH:MM-HH:MM' → ['HH:MM','HH:MM'] */
export function parseQuiet(s: string): [string, string] | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  const f = (h: number, mi: number) => `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  return [f(h1, m1), f(h2, m2)];
}

export interface Commands {
  run(cmd: PrivateCommand, c: CommandCall): Promise<void>;
  onDeleteCallback(c: CallbackCtx): Promise<CallbackAnswer>;
  privacyText(lang: string): string;
}

export function createCommands(surf: Surf, deps: { ob: Onboarding; payments: PaymentsModule }): Commands {
  const { s } = surf;
  const esc = (t: string) => s.telegram.render.escape(t);
  const userScope = (u: UserRow): Scope => ({ kind: 'user', userId: u.id });
  const reply = (c: CommandCall, md: string, o: { keyboard?: Keyboard; tag?: string } = {}) =>
    sendRich(surf, { ...c.chat, userId: c.user.id }, md, { idem: `cmd:${c.updateId}${o.tag ? ':' + o.tag : ''}`, ...(o.keyboard ? { keyboard: o.keyboard } : {}) });
  const time = (at: number, u: UserRow, fmt: 'wDT' | 'DT' | 'r' = 'wDT') => s.telegram.render.tgTime(Math.floor(at / 1000), fmt, formatDisplay(at, u.tz, langOf(u)));

  function privacyText(lang: string): string {
    const llm = s.config.profile.provider === 'groq' ? 'Groq' : 'Anthropic (Claude)';
    const sttName = s.config.providers.stt === 'openai' ? 'OpenAI' : s.config.providers.stt === 'groq' ? 'Groq' : '';
    const stt = sttName && sttName !== llm ? st('privacy_stt', lang, { stt: sttName }) : '';
    const integrations = s.config.providers.integrations === 'composio' ? st('privacy_integrations', lang) : '';
    return st('privacy', lang, { llm, stt, integrations });
  }

  const handlers: Record<PrivateCommand, (c: CommandCall) => Promise<void>> = {
    async new(c) {
      const lang = langOf(c.user);
      const wipe = /^wipe\b/i.test(c.args.trim());
      const conv = dmConversation(surf, c.user, c.chat.threadId);
      s.runner.requestRotation(conv.id, wipe ? 'wipe' : 'user_new');
      await reply(c, st(wipe ? 'new_wipe_done' : 'new_done', lang));
    },

    async memory(c) {
      // 05 A5/B5: a short friendly summary in chat + the Mini App Memory screen (profile card above the facts).
      const lang = langOf(c.user);
      const state = memoryState(c.user, s.clock.now());
      const lines: string[] = [`🧠 **${st('memory_title', lang)}**`];
      if (state !== 'on') lines.push(st(state === 'incognito' ? 'memory_incognito_note' : 'memory_off_note', lang));
      let any = false;
      try {
        const card = s.userProfile.get(c.user.id)?.card;
        if (card?.summary) {
          any = true;
          lines.push(esc(card.summary));
        }
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'cmd memory: profile failed');
      }
      try {
        const { items } = await s.memory.list(userScope(c.user), { limit: 10 });
        const active = items.filter((f) => f.status === 'active');
        if (active.length) {
          any = true;
          lines.push('', ...active.map((f) => `• ${esc(f.text.length > 160 ? f.text.slice(0, 159) + '…' : f.text)}`));
        }
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'cmd memory: list failed');
      }
      if (!any) lines.push(st('memory_empty', lang));
      lines.push('', st('memory_hint', lang));
      await reply(c, lines.join('\n'), { keyboard: [[webAppBtn(st('memory_open', lang), appUrl(surf, 'memory'))]] });
    },

    async ledger(c) {
      const lang = langOf(c.user);
      const rows = s.ledger.list(c.user.id, { limit: 10 });
      if (rows.length === 0) {
        await reply(c, st('ledger_empty', lang), { keyboard: [[webAppBtn(st('open_gora', lang), appUrl(surf, 'ledger'))]] });
        return;
      }
      const lines = [`📒 **${st('ledger_title', lang, { n: rows.length })}**`, ...rows.map((r) => `• ${time(r.ts, c.user, 'DT')} — ${esc(r.summary)}`)];
      await reply(c, lines.join('\n'), { keyboard: [[webAppBtn(st('open_gora', lang), appUrl(surf, 'ledger'))]] });
    },

    async tasks(c) {
      const lang = langOf(c.user);
      const scope = userScope(c.user);
      const lines: string[] = [`🎯 **${st('tasks_title', lang)}**`];
      let any = false;
      try {
        const rem = s.reminders.list(scope, false);
        if (rem.length) {
          any = true;
          lines.push('', `**${st('tasks_reminders', lang)}**`, ...rem.slice(0, 15).map((r) => `• ${esc(r.text)} — ${esc(r.display)}`));
        }
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'cmd tasks: reminders failed');
      }
      try {
        const todos = s.todos.apply(scope, c.user.id, { action: 'list' }).filter((t) => !t.done);
        if (todos.length) {
          any = true;
          lines.push('', `**${st('tasks_todos', lang)}**`, ...todos.slice(0, 15).map((t) => `☐ ${esc(t.text)}`));
        }
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'cmd tasks: todos failed');
      }
      try {
        const ms = s.missions.list(c.user.id, { active: true });
        if (ms.length) {
          any = true;
          lines.push('', `**${st('tasks_missions', lang)}**`, ...ms.slice(0, 10).map((m) => `• ${esc(m.title)} (${m.status})`));
        }
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'cmd tasks: missions failed');
      }
      if (!any) lines.push(st('tasks_empty', lang));
      await reply(c, lines.join('\n'), { keyboard: [[webAppBtn(st('open_gora', lang), appUrl(surf, 'tasks'))]] });
    },

    async approvals(c) {
      const lang = langOf(c.user);
      let n = 0;
      try {
        if (s.approvals.listPending(c.user.id).length > 0) n = await s.approvals.reshowPending(c.user.id, c.chat);
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'cmd approvals failed');
      }
      if (n === 0) await reply(c, st('approvals_none', lang));
    },

    async pause(c) {
      s.repos.users.update(c.user.id, { status: 'paused' });
      s.ledger.append({ userId: c.user.id, actor: 'user', kind: 'pause', summary: 'Paused (/pause)', detail: { paused: true } });
      await reply(c, st('pause_on', langOf(c.user)));
    },

    async resume(c) {
      s.repos.users.update(c.user.id, { status: 'active' });
      s.ledger.append({ userId: c.user.id, actor: 'user', kind: 'pause', summary: 'Resumed (/resume)', detail: { paused: false } });
      await reply(c, st('pause_off', langOf(c.user)));
    },

    async incognito(c) {
      const lang = langOf(c.user);
      const a = c.args.trim().toLowerCase();
      const conv = dmConversation(surf, c.user);
      // Same job key as memory/incognito.ts incognitoKey and the Mini App (http/routes/memory.ts setIncognito).
      const key = `incog:${c.user.id}`;
      if (a === 'off' || a === 'выкл') {
        if (c.user.incognitoUntil !== null) {
          s.repos.users.update(c.user.id, { incognitoUntil: null });
          // The incognito_end handler (WP6a) seals every conversation's extraction watermark and rotates the DM, topics,
          // missions and a DM that got /new during the window — not only this DM.
          s.scheduler.schedule({ kind: 'incognito_end', runAt: s.clock.now(), userId: c.user.id, refId: c.user.id, dedupeKey: key });
        }
        await reply(c, st('incognito_off', lang));
        return;
      }
      const ms = parseDuration(a || '1h');
      if (ms === null) {
        await reply(c, st('incognito_usage', lang));
        return;
      }
      const until = s.clock.now() + ms;
      const wasOn = c.user.incognitoUntil !== null && c.user.incognitoUntil > s.clock.now();
      s.repos.users.update(c.user.id, { incognitoUntil: until });
      s.scheduler.schedule({ kind: 'incognito_end', runAt: until, userId: c.user.id, refId: c.user.id, dedupeKey: key });
      if (!wasOn) s.runner.requestRotation(conv.id, 'incognito_start');
      await reply(c, st('incognito_on', lang, { time: time(until, c.user) }));
    },

    async import(c) {
      deps.ob.armImport(c.user);
      await reply(c, `${st('m5_text', langOf(c.user))}\n\n${st('import_armed', langOf(c.user))}`);
    },

    async nudges(c) {
      const lang = langOf(c.user);
      const set = s.repos.users.settings(c.user.id);
      const lines = [`💡 **${st('nudges_title', lang)}**`, st('nudges_budget', lang, { n: set.nudgeBudget, quiet: `${set.quietStart}–${set.quietEnd}` })];
      try {
        const muted = s.nudges.prefs(c.user.id).filter((p) => p.muted).map((p) => p.kind.replace(/_/g, ' '));
        lines.push(st('nudges_muted', lang, { kinds: muted.length ? muted.join(', ') : st('none', lang) }));
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'cmd nudges: prefs failed');
      }
      lines.push('', st('nudges_hint', lang));
      await reply(c, lines.join('\n'), { keyboard: [[webAppBtn(st('open_gora', lang), appUrl(surf, 'settings'))]] });
    },

    async quiet(c) {
      const lang = langOf(c.user);
      const q = parseQuiet(c.args);
      if (!q) {
        const set = s.repos.users.settings(c.user.id);
        await reply(c, st('quiet_show', lang, { start: set.quietStart, end: set.quietEnd }));
        return;
      }
      s.repos.users.updateSettings(c.user.id, { quietStart: q[0], quietEnd: q[1] });
      s.ledger.append({ userId: c.user.id, actor: 'user', kind: 'settings', summary: `Quiet hours ${q[0]}–${q[1]}`, detail: { quietStart: q[0], quietEnd: q[1] } });
      await reply(c, st('quiet_set', lang, { start: q[0], end: q[1] }));
    },

    async settings(c) {
      const lang = langOf(c.user);
      const m = /^(city|город)\s+(.{2,60})$/i.exec(c.args.trim());
      if (m) {
        await setCity(c, m[2]!.trim());
        return;
      }
      const tzm = /^(tz|timezone)\s+([A-Za-z_]+\/[A-Za-z_/+-]+|UTC)$/i.exec(c.args.trim());
      if (tzm && isValidTz(tzm[2]!)) {
        await deps.ob.setTimezone(c.user, tzm[2]!, 'manual');
        return;
      }
      const set = s.repos.users.settings(c.user.id);
      const onOff = (b: boolean) => st(b ? 'on' : 'off', lang);
      const mem = memoryState(c.user, s.clock.now());
      const style = set.style;
      const styleText = style && Object.keys(style).length
        ? [style.length ? st(`talk_length_${style.length}`, lang) : null, style.emoji ? st(`talk_emoji_${style.emoji}`, lang) : null, style.register ? st(`talk_register_${style.register}`, lang) : null].filter(Boolean).join(', ')
        : st('talk_learned', lang);
      const rows: Array<[string, string]> = [
        [st('settings_tz', lang), `${c.user.tz}${c.user.tzSource === 'default' ? ` (${st('tz_guessed', lang)})` : ''}`],
        [st('settings_city', lang), set.homeCity?.name ?? st('none', lang)],
        [st('settings_name', lang), c.user.personaName],
        [st('settings_memory', lang), st(`memory_state_${mem}`, lang)],
        [st('settings_proactive', lang), st(`proactive_${c.user.proactiveLevel}`, lang)],
        [st('settings_talk', lang), styleText],
        [st('settings_quiet', lang), `${set.quietStart}–${set.quietEnd}`],
        [st('settings_brief', lang), set.briefTime ?? st('off', lang)],
        [st('settings_voice', lang), onOff(c.user.voiceReplies)],
      ];
      const md = [`⚙️ **${st('settings_title', lang)}**`, ...rows.map(([k, v]) => `${esc(k)}: ${esc(v)}`), '', st('settings_hint', lang)].join('\n');
      const memOn = mem !== 'off';
      const kb: Keyboard = [
        [webAppBtn(st('open_gora', lang), appUrl(surf, 'settings'))],
        [memOn ? cbBtn(surf, st('settings_memory_toggle_off', lang), 'ob', ['mem', 'n', 's'], c.user.tgUserId) : cbBtn(surf, st('settings_memory_toggle_on', lang), 'ob', ['mem', 'y', 's'], c.user.tgUserId, 'success')],
        [cbBtn(surf, st('settings_tz', lang), 'tz', ['ch'], c.user.tgUserId)],
      ];
      // spec 07 C6: add Gora to a group — the startgroup picker, no admin rights requested
      if (s.config.features.groups) kb.push([urlBtn(st('add_to_group_button', lang), `https://t.me/${botUsername(surf)}?startgroup=g&admin=`)]);
      await reply(c, md, { keyboard: kb });
    },

    async plan(c) {
      await deps.payments.planCard(c.user, c.chat, `cmd:${c.updateId}`);
    },

    async privacy(c) {
      await reply(c, privacyText(langOf(c.user)));
    },

    async export(c) {
      const lang = langOf(c.user);
      try {
        const bytes = await s.privacy.exportUser(c.user.id);
        const blobId = s.repos.messages.putBlob({ ownerUserId: c.user.id, dek: `u:${c.user.id}`, mime: 'application/json', bytes });
        await s.telegram.outbox.sendNow({
          idempotencyKey: `cmd:${c.updateId}:doc`, userId: c.user.id, chatId: c.chat.chatId, ...(c.chat.threadId ? { threadId: c.chat.threadId } : {}),
          method: 'sendDocument', payload: { blob_id: blobId, filename: `gora-export-${new Date(s.clock.now()).toISOString().slice(0, 10)}.json`, caption: st('export_text', lang) },
        });
        s.ledger.append({ userId: c.user.id, actor: 'user', kind: 'export', summary: 'Data export (/export)', detail: { bytes: bytes.length } });
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'cmd export failed');
        await reply(c, st('something_wrong', lang));
      }
    },

    async deletemydata(c) {
      const lang = langOf(c.user);
      const nonce = randomToken(6);
      s.repos.kv.set(`dl:${c.user.id}`, { nonce, at: s.clock.now() });
      const kb: Keyboard = [[cbBtn(surf, st('delete_yes', lang), 'dl', ['y', nonce], c.user.tgUserId, 'danger'), cbBtn(surf, st('cancel', lang), 'dl', ['n'], c.user.tgUserId)]];
      await reply(c, st('delete_confirm', lang), { keyboard: kb });
    },

    async paysupport(c) {
      await reply(c, st('paysupport', langOf(c.user)));
    },
    async terms(c) {
      await reply(c, st('terms', langOf(c.user)));
    },
    async help(c) {
      await reply(c, st('help', langOf(c.user)));
    },

    async voice(c) {
      const lang = langOf(c.user);
      const a = c.args.trim().toLowerCase();
      if (!s.config.features.voiceReplies) {
        await reply(c, st('voice_unavailable', lang));
        return;
      }
      if (a === 'on' || a === 'вкл') {
        s.repos.users.update(c.user.id, { voiceReplies: true });
        s.ledger.append({ userId: c.user.id, actor: 'user', kind: 'settings', summary: 'Voice replies on', detail: { voiceReplies: true } });
        await reply(c, st('voice_on', lang));
      } else if (a === 'off' || a === 'выкл') {
        s.repos.users.update(c.user.id, { voiceReplies: false });
        s.ledger.append({ userId: c.user.id, actor: 'user', kind: 'settings', summary: 'Voice replies off', detail: { voiceReplies: false } });
        await reply(c, st('voice_off', lang));
      } else {
        await reply(c, st('voice_status', lang, { state: st(c.user.voiceReplies ? 'state_on' : 'state_off', lang) }));
      }
    },
  };

  async function setCity(c: CommandCall, name: string): Promise<void> {
    const lang = langOf(c.user);
    let places: Awaited<ReturnType<typeof s.caps.geo.geocodeCity>> = [];
    try {
      places = await s.caps.geo.geocodeCity(name, lang);
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'cmd settings city: geocode failed');
    }
    const hit = places[0];
    if (!hit) {
      await reply(c, st('tz_city_not_found', lang));
      return;
    }
    s.repos.users.updateSettings(c.user.id, { homeCity: { name: hit.name, lat: hit.lat, lon: hit.lon } });
    s.ledger.append({ userId: c.user.id, actor: 'user', kind: 'settings', summary: 'Home city set', detail: { city: hit.name } });
    await reply(c, st('city_set', lang, { city: esc(hit.name) }));
    if (hit.tz && isValidTz(hit.tz) && hit.tz !== c.user.tz) {
      await deps.ob.proposeTz(c.user, { tz: hit.tz, source: 'city', city: { name: hit.name, lat: hit.lat, lon: hit.lon } }, c.chat, `cmd:${c.updateId}:tz`);
    }
  }

  async function onDeleteCallback(c: CallbackCtx): Promise<CallbackAnswer> {
    const user = c.user;
    if (!user) return { text: st('start_first', null) };
    const lang = langOf(user);
    const at = c.message ? { chatId: c.message.chatId, messageId: c.message.messageId, userId: user.id } : null;
    const pending = s.repos.kv.get<{ nonce: string; at: number } | null>(`dl:${user.id}`);
    if (c.parts[0] === 'n') {
      s.repos.kv.set(`dl:${user.id}`, null);
      if (at) await editCard(surf, at, st('delete_canceled', lang), null, `dl:n:${at.chatId}:${at.messageId}`);
      return { text: st('delete_canceled', lang) };
    }
    if (c.parts[0] !== 'y' || !pending || pending.nonce !== c.parts[1] || s.clock.now() - pending.at > DELETE_CONFIRM_MS) {
      if (at) await editCard(surf, at, st('delete_expired', lang), null, `dl:x:${at.chatId}:${at.messageId}`);
      return { text: st('delete_expired', lang), alert: true };
    }
    s.repos.kv.set(`dl:${user.id}`, null);
    const chatId = user.dmChatId ?? user.tgUserId;
    if (at) await editCard(surf, at, st('delete_confirm', lang), null, `dl:y:${at.chatId}:${at.messageId}`);
    await s.privacy.deleteUser(user.id, 'user');
    // The user row is gone now: the confirmation carries no userId.
    await sendRich(surf, { chatId }, st('delete_done', lang), { idem: `dl:done:${c.callbackQueryId}` });
    return;
  }

  return {
    async run(cmd, c) {
      await handlers[cmd](c);
    },
    onDeleteCallback,
    privacyText,
  };
}
