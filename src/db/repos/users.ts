// db/repos/users.ts (WP1) — users, user_settings, consents, permissions.
// first_name is sealed under 'u:<userId>' (AAD 'users|first_name_enc|<id>'); home_city under the same DEK.
import type { PermissionLevel, UserId } from '../../contracts/common.ts';
import type { ConsentKind, HomeCity, SqlValue, UserRow, UserSettings, UsersRepo } from '../../contracts/storage.ts';
import type { StyleOverrides } from '../../contracts/behaviour.ts';
import { newId, ulid } from '../../kernel/ids.ts';
import { isShredded } from '../crypto.ts';
import { b2i, has, i2b, num, numOrNull, strOrNull, type RepoCtx } from './common.ts';

export const DEFAULT_SETTINGS: Readonly<UserSettings> = Object.freeze({
  nudgeBudget: 3, quietStart: '22:00', quietEnd: '08:00', briefTime: null, inboxCheckins: true, approvalExpiryMin: 1440, showTranscripts: true, homeCity: null, style: null,
});

const userDek = (id: UserId) => `u:${id}`;
const aadFirstName = (id: UserId) => `users|first_name_enc|${id}`;
const aadHomeCity = (id: UserId) => `user_settings|home_city_enc|${id}`;

type Raw = Record<string, SqlValue>;

const STYLE_ENUMS: Readonly<Record<keyof StyleOverrides, readonly string[]>> = {
  length: ['short', 'medium', 'long'], emoji: ['none', 'light', 'lots'], register: ['informal', 'formal'],
};
/** Keeps only known keys with known enum values (style_json never holds free text). */
function cleanStyle(v: unknown): StyleOverrides {
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') {
    for (const [k, allowed] of Object.entries(STYLE_ENUMS)) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === 'string' && allowed.includes(x)) out[k] = x;
    }
  }
  return out as StyleOverrides;
}
function parseStyle(v: SqlValue): StyleOverrides | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const s = cleanStyle(JSON.parse(v));
    return Object.keys(s).length ? s : null;
  } catch {
    return null;
  }
}

export function createUsersRepo(x: RepoCtx): UsersRepo {
  const { db, crypto, clock } = x;

  const openName = (r: Raw): string | null => {
    const b = r['first_name_enc'];
    if (!(b instanceof Uint8Array)) return null;
    try {
      return crypto.openText(b, aadFirstName(String(r['id'])));
    } catch (e) {
      if (isShredded(e)) return null;
      throw e;
    }
  };
  const toRow = (r: Raw): UserRow => ({
    id: String(r['id']),
    tgUserId: num(r['tg_user_id']),
    dmChatId: numOrNull(r['dm_chat_id']),
    firstName: openName(r),
    username: strOrNull(r['username']),
    languageCode: strOrNull(r['language_code']),
    tz: String(r['tz']),
    tzSource: r['tz_source'] as UserRow['tzSource'],
    personaName: String(r['persona_name']),
    personaStyle: r['persona_style'] as UserRow['personaStyle'],
    plan: r['plan'] as UserRow['plan'],
    status: r['status'] as UserRow['status'],
    memoryConsent: r['memory_consent'] === null ? null : i2b(r['memory_consent']),
    incognitoUntil: numOrNull(r['incognito_until']),
    memoryGen: num(r['memory_gen']),
    onboardingStep: r['onboarding_step'] as UserRow['onboardingStep'],
    botBlocked: i2b(r['bot_blocked']),
    voiceReplies: i2b(r['voice_replies']),
    proactiveLevel: (r['proactive_level'] ?? 'normal') as UserRow['proactiveLevel'],
    tzHintAt: numOrNull(r['tz_hint_at'] ?? null),
    createdAt: num(r['created_at']),
    lastSeenAt: numOrNull(r['last_seen_at'] ?? null),
  });

  const getById = (id: UserId) => {
    const r = db.prepare('SELECT * FROM users WHERE id = ?').get<Raw>(id);
    return r ? toRow(r) : undefined;
  };
  const getByTg = (tg: number) => {
    const r = db.prepare('SELECT * FROM users WHERE tg_user_id = ?').get<Raw>(tg);
    return r ? toRow(r) : undefined;
  };

  const ensureSettingsRow = (id: UserId) => {
    db.prepare('INSERT OR IGNORE INTO user_settings(user_id, updated_at) VALUES (?, ?)').run(id, clock.now());
  };

  const repo: UsersRepo = {
    getById,
    getByTg,
    upsertFromTelegram(u, o) {
      return db.tx(() => {
        const now = clock.now();
        const existing = db.prepare('SELECT id FROM users WHERE tg_user_id = ?').get<{ id: string }>(u.id);
        if (existing) {
          const id = existing.id;
          const pairs: Array<[string, SqlValue]> = [
            ['first_name_enc', crypto.seal(userDek(id), u.first_name, aadFirstName(id))],
            ['username', u.username ?? null],
            ['updated_at', now],
            ['last_seen_at', now],
          ];
          if (u.language_code) pairs.push(['language_code', u.language_code]);
          if (o?.dmChatId !== undefined) pairs.push(['dm_chat_id', o.dmChatId]);
          db.prepare(`UPDATE users SET ${pairs.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...pairs.map(([, v]) => v), id);
          return getById(id)!;
        }
        const id = ulid(now);
        db.prepare(
          `INSERT INTO users(id, tg_user_id, dm_chat_id, first_name_enc, username, language_code, ref_source, created_at, updated_at, last_seen_at, onboarding_step)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')`,
        ).run(id, u.id, o?.dmChatId ?? null, crypto.seal(userDek(id), u.first_name, aadFirstName(id)), u.username ?? null, u.language_code ?? null, o?.refSource ?? null, now, now, now);
        ensureSettingsRow(id);
        return getById(id)!;
      });
    },
    update(id, patch) {
      const p: Array<[string, SqlValue]> = [];
      if (has(patch, 'dmChatId')) p.push(['dm_chat_id', patch.dmChatId ?? null]);
      if (has(patch, 'firstName')) p.push(['first_name_enc', patch.firstName === null ? null : crypto.seal(userDek(id), patch.firstName!, aadFirstName(id))]);
      if (has(patch, 'username')) p.push(['username', patch.username ?? null]);
      if (has(patch, 'languageCode')) p.push(['language_code', patch.languageCode ?? null]);
      if (has(patch, 'tz')) p.push(['tz', patch.tz!]);
      if (has(patch, 'tzSource')) p.push(['tz_source', patch.tzSource!]);
      if (has(patch, 'personaName')) p.push(['persona_name', patch.personaName!]);
      if (has(patch, 'personaStyle')) p.push(['persona_style', patch.personaStyle!]);
      if (has(patch, 'plan')) p.push(['plan', patch.plan!]);
      if (has(patch, 'status')) p.push(['status', patch.status!]);
      if (has(patch, 'memoryConsent')) p.push(['memory_consent', patch.memoryConsent === null ? null : b2i(patch.memoryConsent)]);
      if (has(patch, 'incognitoUntil')) p.push(['incognito_until', patch.incognitoUntil ?? null]);
      if (has(patch, 'memoryGen')) p.push(['memory_gen', patch.memoryGen!]);
      if (has(patch, 'onboardingStep')) p.push(['onboarding_step', patch.onboardingStep!]);
      if (has(patch, 'botBlocked')) p.push(['bot_blocked', b2i(patch.botBlocked)]);
      if (has(patch, 'voiceReplies')) p.push(['voice_replies', b2i(patch.voiceReplies)]);
      if (has(patch, 'proactiveLevel')) p.push(['proactive_level', patch.proactiveLevel!]);
      if (Object.prototype.hasOwnProperty.call(patch, 'tzHintAt')) p.push(['tz_hint_at', patch.tzHintAt ?? null]);
      p.push(['updated_at', clock.now()]);
      const r = db.prepare(`UPDATE users SET ${p.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...p.map(([, v]) => v), id);
      if (Number(r.changes) === 0) throw new Error(`users.update: no user ${id}`);
    },
    settings(id) {
      const r = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get<Raw>(id);
      if (!r) return { ...DEFAULT_SETTINGS };
      let homeCity: HomeCity | null = null;
      const hc = r['home_city_enc'];
      if (hc instanceof Uint8Array) {
        try {
          homeCity = crypto.openJson<HomeCity>(hc, aadHomeCity(id));
        } catch (e) {
          if (!isShredded(e)) throw e;
        }
      }
      return {
        nudgeBudget: num(r['nudge_budget']),
        quietStart: String(r['quiet_start']),
        quietEnd: String(r['quiet_end']),
        briefTime: strOrNull(r['brief_time']),
        inboxCheckins: i2b(r['inbox_checkins']),
        approvalExpiryMin: num(r['approval_expiry_min']),
        showTranscripts: i2b(r['show_transcripts']),
        homeCity,
        style: parseStyle(r['style_json'] ?? null),
      };
    },
    updateSettings(id, patch) {
      db.tx(() => {
        ensureSettingsRow(id);
        const p: Array<[string, SqlValue]> = [];
        if (has(patch, 'nudgeBudget')) p.push(['nudge_budget', patch.nudgeBudget!]);
        if (has(patch, 'quietStart')) p.push(['quiet_start', patch.quietStart!]);
        if (has(patch, 'quietEnd')) p.push(['quiet_end', patch.quietEnd!]);
        if (Object.prototype.hasOwnProperty.call(patch, 'briefTime')) p.push(['brief_time', patch.briefTime ?? null]);
        if (has(patch, 'inboxCheckins')) p.push(['inbox_checkins', b2i(patch.inboxCheckins)]);
        if (has(patch, 'approvalExpiryMin')) p.push(['approval_expiry_min', patch.approvalExpiryMin!]);
        if (has(patch, 'showTranscripts')) p.push(['show_transcripts', b2i(patch.showTranscripts)]);
        if (Object.prototype.hasOwnProperty.call(patch, 'homeCity')) {
          const hc = patch.homeCity ?? null;
          p.push(['home_city_enc', hc === null ? null : crypto.sealJson(userDek(id), { name: hc.name, lat: hc.lat, lon: hc.lon }, aadHomeCity(id))]);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'style')) p.push(['style_json', patch.style ? JSON.stringify(cleanStyle(patch.style)) : null]);
        p.push(['updated_at', clock.now()]);
        db.prepare(`UPDATE user_settings SET ${p.map(([c]) => `${c} = ?`).join(', ')} WHERE user_id = ?`).run(...p.map(([, v]) => v), id);
      });
    },
    grantConsent(c) {
      const id = newId('cs', clock.now());
      db.prepare('INSERT INTO consents(id, user_id, kind, subject, text_version, via, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id, c.userId, c.kind, c.subject ?? null, c.textVersion, c.via, clock.now(),
      );
      return id;
    },
    revokeConsent(userId, kind, subject) {
      db.prepare('UPDATE consents SET revoked_at = ? WHERE user_id = ? AND kind = ? AND subject IS ? AND revoked_at IS NULL').run(clock.now(), userId, kind, subject ?? null);
    },
    hasConsent(userId: UserId, kind: ConsentKind, subject?: string) {
      return !!db.prepare('SELECT 1 AS x FROM consents WHERE user_id = ? AND kind = ? AND subject IS ? AND revoked_at IS NULL LIMIT 1').get(userId, kind, subject ?? null);
    },
    permissions(userId) {
      const out: Record<'gmail' | 'gcal', PermissionLevel> = { gmail: 'none', gcal: 'none' };
      for (const r of db.prepare('SELECT integration, level FROM permissions WHERE user_id = ?').all<{ integration: 'gmail' | 'gcal'; level: PermissionLevel }>(userId)) {
        out[r.integration] = r.level;
      }
      return out;
    },
    setPermission(userId, integration, level, via) {
      db.prepare(
        `INSERT INTO permissions(user_id, integration, level, updated_via, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, integration) DO UPDATE SET level = excluded.level, updated_via = excluded.updated_via, updated_at = excluded.updated_at`,
      ).run(userId, integration, level, via, clock.now());
    },
    list(q) {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (q.afterId !== undefined) {
        where.push('id > ?');
        params.push(q.afterId);
      }
      if (q.status) {
        where.push('status = ?');
        params.push(q.status);
      }
      const limit = Math.max(0, Math.floor(q.limit));
      const rows = db.prepare(`SELECT * FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC LIMIT ?`).all<Raw>(...params, limit);
      return rows.map(toRow);
    },
    *iterate(q = {}) {
      const size = Math.max(1, q.batchSize ?? 200);
      let afterId: string | undefined;
      for (;;) {
        const page = repo.list({ ...(q.status ? { status: q.status } : {}), ...(afterId !== undefined ? { afterId } : {}), limit: size });
        yield* page;
        if (page.length < size) return;
        afterId = page[page.length - 1]!.id;
      }
    },
  };
  return repo;
}
