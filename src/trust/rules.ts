// trust/rules.ts (WP4) — 01 §11.1 Sentinel policy. PURE: no I/O, no clock (time comes from the snapshot).
// The first matching rule wins. Reasons are generic text (they are stored in sentinel_decisions and never carry
// content or recipients); card warnings may name where a recipient came from, never the recipient itself.
import type { ActionClass, Decision, PermissionLevel, ProposedAction, SentinelSnapshot, Target } from '../contracts/index.ts';
import { uiLang } from '../contracts/index.ts';

export interface RuleEnv {
  /** S02: the tool is allowed on this surface (spec.surfaces) and is in the conversation's toolset. */
  surfaceAllowed: boolean;
  /** Language of card warnings (a raw Telegram language_code is fine). */
  lang?: string | null;
}

const LEVELS: readonly PermissionLevel[] = ['none', 'read', 'draft', 'act'];
const READ_LIKE: ReadonlySet<ActionClass> = new Set(['read_public', 'read_private', 'ui', 'control']);
const FREE_CLASSES: ReadonlySet<ActionClass> = new Set(['read_public', 'read_private', 'ui', 'control', 'compute']);
/** Classes whose outcome leaves the owner's own space (S14 taint rule). */
const TAINT_SENSITIVE: ReadonlySet<ActionClass> = new Set(['send_external', 'destructive']);
/** S16 trust-ladder provenance. */
const LADDER_PROVENANCE: ReadonlySet<Target['provenance']> = new Set(['user', 'memory', 'approved']);

export const BULK_RECIPIENTS = 5;
export const BULK_ITEMS = 10;

function levelAtLeast(have: PermissionLevel, need: PermissionLevel): boolean {
  return LEVELS.indexOf(have) >= LEVELS.indexOf(need);
}

function isMemoryWrite(a: ProposedAction): boolean {
  // Forgetting is always allowed (it removes data); every other memory-class tool writes.
  return a.cls.actionClass === 'memory' && a.toolName !== 'memory_forget';
}

function untrustedWarning(t: Target, lang: string | null | undefined): string {
  const ru = uiLang(lang) === 'ru';
  const from = t.sourceLabel ?? (t.provenance === 'untrusted' ? (ru ? 'стороннего контента' : 'third-party content') : ru ? 'неизвестного источника' : 'an unknown source');
  return ru ? `⚠ Этот получатель взят из ${from}, а не от вас` : `⚠ This recipient came from ${from}, not from you`;
}

function allow(ruleId: string, reason: string, undo = false, grantId?: string): Decision {
  return { kind: 'allow', ruleId, reason, undo, ...(grantId ? { grantId } : {}) };
}
function deny(ruleId: string, code: Extract<Decision, { kind: 'deny' }>['code'], reason: string): Decision {
  return { kind: 'deny', ruleId, reason, code };
}
function ask(ruleId: string, reason: string, grantable: boolean, warnings: string[] = []): Decision {
  return { kind: 'ask', ruleId, reason, grantable, warnings };
}

/** The deny rules S01–S09; they win in both phases (propose and execute). */
function denyRules(a: ProposedAction, s: SentinelSnapshot, env: RuleEnv): Decision | null {
  const c = a.cls;
  // S01 — paused: only reads, UI and control run.
  if (s.userStatus === 'paused' && !READ_LIKE.has(c.actionClass)) return deny('S01', 'paused', 'The owner paused all actions');
  // S02 — surface / toolset.
  if (!env.surfaceAllowed) return deny('S02', 'surface', 'Tool not available on this surface');
  // S03 — integration not connected.
  if ((c.integration === 'gmail' || c.integration === 'gcal') && !s.connected[c.integration]) return deny('S03', 'not_connected', `${c.integration === 'gmail' ? 'Gmail' : 'Google Calendar'} is not connected`);
  // S04 — permission level below requiredLevel.
  if ((c.integration === 'gmail' || c.integration === 'gcal') && c.requiredLevel && !levelAtLeast(s.permissions[c.integration], c.requiredLevel)) {
    return deny('S04', 'permission', `Permission level is below ${c.requiredLevel}`);
  }
  // S05 — never in v1.
  if (c.actionClass === 'spend' || c.actionClass === 'account_admin' || c.risk >= 4) return deny('S05', 'forbidden_v1', 'Not supported in v1');
  // S06 — quota or the daily cost cap.
  if (c.quotaKind && !s.quotaOk(c.quotaKind)) return deny('S06', 'quota', 'Daily quota reached');
  if (!FREE_CLASSES.has(c.actionClass) && !s.quotaOk('cost_micros')) return deny('S06', 'quota', 'Daily cost cap reached');
  // S07 — business chats: consent, connection, rights and the 24 h window.
  if (c.integration === 'business' && (c.businessRef || s.business)) {
    const b = s.business;
    if (!b || !b.consented) return deny('S07', 'business', 'Chat is not enabled for the assistant');
    if (!b.enabled) return deny('S07', 'business', 'Business connection is disabled');
    if (c.actionClass === 'send_external' || c.actionClass === 'destructive') {
      if (!b.canReply) return deny('S07', 'business', 'No right to reply in this chat');
      if (!b.windowOpen) return deny('S07', 'business', 'The reply window is closed');
    }
  }
  // S08 — memory writes need memory on (spec 05 B1: on unless the owner turned it off) and no incognito.
  if (isMemoryWrite(a) && (!s.memoryConsent || s.incognito)) return deny('S08', 'memory_off', s.incognito ? 'Incognito is on' : 'Memory is off');
  // S09 — removed by spec 05 A6: an unconfirmed zone no longer blocks scheduling (tools run on the best-guess zone and
  // the reply carries one lazy "set my time zone" button). The code 'tz_unconfirmed' is never produced any more.
  return null;
}

/**
 * 01 §11.1, first match wins. In phase 'execute' (the owner already tapped Approve on a card rendered from the same
 * stored input), only the deny rules S01–S09 can still stop the action (§5.6 "so /pause, revocations, quota and the
 * business window still win"); otherwise the result is allow A01.
 */
export function evaluateRules(a: ProposedAction, s: SentinelSnapshot, env: RuleEnv = { surfaceAllowed: true }): Decision {
  const d = denyRules(a, s, env);
  if (d) return d;
  const c = a.cls;
  if (a.phase === 'execute' && a.approvedPendingActionId) return allow('A01', 'Approved by the owner');

  const tainted = s.taint.size > 0;
  // S13's provenance warnings ride on EVERY ask (first match still decides the rule and grantability): a bulk send or
  // a destructive notify that includes an injected recipient must still tell the owner where that recipient came from.
  const doubtful = a.targets.filter((t) => t.provenance === 'untrusted' || t.provenance === 'unknown');
  const provWarnings = [...new Set(doubtful.map((t) => untrustedWarning(t, env.lang)))];
  // S10 — bulk.
  const bulkLimit = c.actionClass === 'send_external' ? BULK_RECIPIENTS : BULK_ITEMS;
  if (typeof c.bulkCount === 'number' && c.bulkCount > bulkLimit) return ask('S10', 'Bulk action', false, provWarnings);
  // S11 — destructive: once only, never grantable.
  if (c.actionClass === 'destructive') return ask('S11', 'Destructive action', false, provWarnings);
  // S12 — business sends are never grantable.
  if (c.integration === 'business' && c.actionClass === 'send_external') return ask('S12', 'Business reply', false, provWarnings);
  // S13 — recipients that did not come from the owner.
  if (doubtful.length) return ask('S13', 'Recipient not from the owner', false, provWarnings);
  // S14 — tainted run: sends and destructive actions always ask; every standing grant is ignored.
  if (tainted && TAINT_SENSITIVE.has(c.actionClass)) return ask('S14', 'Run contains third-party content', false);
  // S15 — a matching active grant for every target.
  if (a.targets.length > 0) {
    let firstGrant: string | undefined;
    const all = a.targets.every((t) => {
      const g = s.grants.find((x) => x.toolName === a.toolName && x.targetHmac === t.hmac && (x.expiresAt === null || x.expiresAt > s.now));
      if (g && !firstGrant) firstGrant = g.id;
      return !!g;
    });
    if (all && firstGrant) return allow('S15', 'Standing grant', false, firstGrant);
  }
  // S16 — sends ask; grantable (subject to the trust ladder, checked by approvals) when every target is trusted.
  if (c.actionClass === 'send_external') {
    const grantable = c.grantable !== false && a.targets.length > 0 && a.targets.every((t) => LADDER_PROVENANCE.has(t.provenance));
    return ask('S16', 'Sends to other people ask', grantable);
  }
  // S17 — own space, reversible.
  if (c.actionClass === 'write_self') return allow('S17', 'Own space, reversible', true);
  // S18 — reads, UI, control, compute.
  if (FREE_CLASSES.has(c.actionClass)) return allow('S18', c.actionClass === 'read_private' ? 'Private read' : 'No side effects');
  // S19 — memory (consent checked by S08).
  if (c.actionClass === 'memory') return allow('S19', 'Memory');
  // S99.
  return ask('S99', 'Needs approval', false);
}
