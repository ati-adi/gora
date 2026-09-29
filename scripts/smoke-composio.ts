// scripts/smoke-composio.ts — opt-in LIVE smoke test of the real ComposioProvider (spec 07 B3, plan 08 §4.1).
//
//   LIVE=1 npm run smoke:composio                                   connect link for Google Calendar (prints it), then
//                                                                   polls the account every 5 s for ≤ 10 min until ACTIVE
//   LIVE=1 npm run smoke:composio -- --no-wait                      only print the link and the pending account id
//   LIVE=1 npm run smoke:composio -- --after-connect [--account ca_…]
//                                                                   tomorrow's events + free/busy for the smoke user
//   LIVE=1 npm run smoke:composio -- --after-connect --write        also creates ONE event "Gora smoke <iso>" (no
//                                                                   attendees, no Meet link), prints its id, DELETES it
//   LIVE=1 npm run smoke:composio -- --gmail                        Gmail connect link (the Gmail auth config is
//                                                                   resolved or created lazily, named gora-gmail)
//   LIVE=1 npm run smoke:composio -- --gmail --after-connect [--account ca_…]   searches for 1 message
//
// Needs COMPOSIO_API_KEY (a Platform project key, ak_…); uses COMPOSIO_AUTH_CONFIG_GCAL / _GMAIL when set, else finds or
// creates the auth config by name. SMOKE_TZ (default: this machine's zone) sets "tomorrow". PUBLIC_URL only shapes the
// callback URL (no Gora server needs to run: completion is detected by polling). It never touches ./data or ./keys,
// never prints the API key or message bodies, and exits 2 without LIVE=1. The smoke user is `smoke-<hmac>`; its
// Composio user_id is the provider's HMAC (keyed here by a hash of the API key, so it is stable per project).
import { createHash, createHmac } from 'node:crypto';
import type { CalEvent, IntegrationKind, Logger } from '../src/contracts/index.ts';
import { ComposioProvider, COMPOSIO_BASE } from '../src/integrations/composio.ts';
import { COMPOSIO_TOOLKIT } from '../src/integrations/composioMap.ts';
import { systemClock } from '../src/kernel/clock.ts';
import { addDaysToDate, isoWithOffset, wallTimeOf, zonedToInstant } from '../src/kernel/timeMath.ts';

const POLL_EVERY_MS = 5_000;
const POLL_FOR_MS = 10 * 60_000;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
const stderrLogger: Logger = {
  debug() {},
  info() {},
  warn: (o, m) => process.stderr.write(`warn: ${m ?? ''} ${JSON.stringify(o)}\n`),
  error: (o, m) => process.stderr.write(`error: ${m ?? ''} ${JSON.stringify(o)}\n`),
  child: () => stderrLogger,
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);
const sleep = (ms: number) => new Promise<void>((r) => systemClock().setTimeout(r, ms));

async function findActiveAccount(apiKey: string, composioUserId: string, kind: IntegrationKind): Promise<string | null> {
  // Best effort: GET /api/v3.1/connected_accounts filtered by user and toolkit (pass --account when this fails).
  const q = new URLSearchParams({ user_ids: composioUserId, toolkit_slugs: COMPOSIO_TOOLKIT[kind], statuses: 'ACTIVE' });
  const res = await globalThis.fetch(`${COMPOSIO_BASE}/api/v3.1/connected_accounts?${q}`, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
  if (!res.ok) {
    out(`listing connected accounts failed (HTTP ${res.status}); pass --account ca_…`);
    return null;
  }
  const j = (await res.json()) as { items?: Array<{ id?: string; status?: string }> };
  return (j.items ?? []).find((a) => a.status === 'ACTIVE' && a.id)?.id ?? null;
}

async function main(): Promise<number> {
  if (process.env['LIVE'] !== '1') {
    out('smoke:composio is opt-in: set LIVE=1 (and COMPOSIO_API_KEY). Nothing was called.');
    return 2;
  }
  const apiKey = process.env['COMPOSIO_API_KEY'];
  if (!apiKey) {
    out('COMPOSIO_API_KEY is not set.');
    return 2;
  }
  if (!apiKey.startsWith('ak_')) out('warning: COMPOSIO_API_KEY does not look like a Platform project key (ak_…); a ck_… key gets 401 code 801.');
  const hashKey = createHash('sha256').update(`gora-smoke|${apiKey}`).digest();
  const crypto = { hmac: (domain: string, data: string) => createHmac('sha256', hashKey).update(`${domain}|${data}`).digest('hex') };
  const clock = systemClock();
  const tz = process.env['SMOKE_TZ'] || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const authConfigs: Partial<Record<IntegrationKind, string>> = {
    ...(process.env['COMPOSIO_AUTH_CONFIG_GCAL'] ? { gcal: process.env['COMPOSIO_AUTH_CONFIG_GCAL'] } : {}),
    ...(process.env['COMPOSIO_AUTH_CONFIG_GMAIL'] ? { gmail: process.env['COMPOSIO_AUTH_CONFIG_GMAIL'] } : {}),
  };
  const provider = new ComposioProvider({ apiKey, fetchImpl: globalThis.fetch, clock, log: stderrLogger, crypto, authConfigs, tzOf: () => tz });
  const userId = `smoke-${crypto.hmac('smoke_user', 'owner').slice(0, 12)}`;
  const kind: IntegrationKind = flag('--gmail') ? 'gmail' : 'gcal';
  out(`smoke user ${userId} → Composio user_id ${provider.composioUserId(userId)} (toolkit ${COMPOSIO_TOOLKIT[kind]}, tz ${tz})`);

  if (!flag('--after-connect')) {
    const publicUrl = (process.env['PUBLIC_URL'] || 'https://example.com').replace(/\/+$/, '');
    const state = createHash('sha256').update(`${clock.now()}|${userId}`).digest('base64url').slice(0, 24);
    const link = await provider.connectLink(userId, kind, `${publicUrl}/oauth/callback?state=${state}`);
    out(`connect link: ${link.url}`);
    out(`pending account: ${link.pendingRef ?? '(none returned)'}${link.expiresAt ? `, link expires ${new Date(link.expiresAt).toISOString()}` : ''}`);
    if (flag('--no-wait') || !link.pendingRef) return 0;
    out('open the link and finish the Google consent; polling every 5 s for up to 10 min…');
    const deadline = clock.now() + POLL_FOR_MS;
    while (clock.now() < deadline) {
      await sleep(POLL_EVERY_MS);
      const st = await provider.connectionStatus(link.pendingRef, { userId, kind }).catch((e: unknown) => ({ status: 'error' as const, e }));
      if (st.status === 'active') {
        out(`connected ✓ account ${st.accountRef}. Next: LIVE=1 npm run smoke:composio -- ${kind === 'gmail' ? '--gmail ' : ''}--after-connect --account ${st.accountRef}`);
        return 0;
      }
      if (st.status === 'failed') {
        out(`connection failed (${st.reason})`);
        return 1;
      }
    }
    out('timed out after 10 min (still pending)');
    return 1;
  }

  const account = arg('--account') ?? (await findActiveAccount(apiKey, provider.composioUserId(userId), kind));
  if (!account) {
    out('no ACTIVE account for the smoke user; run the connect step first (or pass --account ca_…)');
    return 1;
  }
  const st = await provider.connectionStatus(account, { userId, kind });
  if (st.status !== 'active') {
    out(`account ${account} is not usable: ${st.status === 'failed' ? st.reason : 'pending'}`);
    return 1;
  }

  if (kind === 'gmail') {
    const hits = await provider.mail(userId, account).search({ query: 'in:inbox', maxResults: 1 });
    out(`gmail search: ${hits.length} message(s)${hits[0] ? ` (thread ${hits[0].threadId}, ${hits[0].subject.length} chars subject)` : ''}`);
    return 0;
  }

  const cal = provider.calendar(userId, account);
  const w = wallTimeOf(clock.now(), tz);
  const d = addDaysToDate(w.year, w.month, w.day, 1);
  const d2 = addDaysToDate(d.year, d.month, d.day, 1);
  const from = zonedToInstant({ ...d, hour: 0, minute: 0 }, tz).instant;
  const to = zonedToInstant({ ...d2, hour: 0, minute: 0 }, tz).instant;
  const range = { fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
  const events = await cal.list({ ...range, max: 20 });
  out(`tomorrow (${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}): ${events.length} event(s)`);
  for (const e of events) out(`  ${e.start} → ${e.end}  ${e.title.slice(0, 60)}${e.attendees.length ? ` (${e.attendees.length} attendees)` : ''}`);
  const busy = await cal.freeBusy(range);
  out(`free/busy: ${busy.length} busy interval(s)`);
  for (const b of busy) out(`  busy ${b.start} → ${b.end}`);

  if (flag('--write')) {
    const start = zonedToInstant({ ...d, hour: 23, minute: 0 }, tz).instant;
    const iso = new Date(clock.now()).toISOString();
    let made: CalEvent | null = null;
    try {
      made = await cal.create({ title: `Gora smoke ${iso}`, start: isoWithOffset(start, tz), end: isoWithOffset(start + 15 * 60_000, tz), tz, attendees: [] }, `smoke-${iso}`);
      out(`created event ${made.id} (${made.start})`);
      const again = await cal.findByIdem(`smoke-${iso}`);
      out(`findByIdem: ${again ? `found ${again.id}` : 'not found (yet)'}`);
    } finally {
      if (made?.id) {
        await cal.remove(made.id);
        out(`deleted event ${made.id}`);
      }
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    out(`smoke failed: ${e instanceof Error ? `${e.name}: ${e.message}` : 'error'}`);
    process.exit(1);
  },
);
