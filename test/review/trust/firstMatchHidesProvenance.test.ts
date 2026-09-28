// REVIEW (trust) — rules.ts first-match order: S10 (bulk), S11 (destructive) and S12 (business) return an ask with
// `warnings: []` BEFORE S13 runs, so a card for a 6-recipient send (or an event cancellation notifying attendees) that
// includes a recipient lifted from an injected email carries NO "⚠ This recipient came from an email, not from you"
// warning. S13's warning is the owner's only signal that a recipient was injected; bulk sends are exactly where an
// extra injected address hides best. (The ask itself still happens; only the provenance warning is lost.)
import { describe, expect, it } from 'vitest';
import type { ProposedAction, SentinelSnapshot, Target } from '../../../src/contracts/index.ts';
import { evaluateRules } from '../../../src/trust/rules.ts';

const snap: SentinelSnapshot = {
  userStatus: 'active', memoryConsent: true, incognito: false, tzConfirmed: true, permissions: { gmail: 'act', gcal: 'act' },
  connected: { gmail: true, gcal: true }, grants: [], trustedTargetHmacs: new Set(), taint: new Set(['email']), quotaOk: () => true, business: null, now: 1,
};
const t = (v: string, p: Target['provenance'], sourceLabel?: string): Target => ({ kind: 'email', value: v, hmac: `h:${v}`, provenance: p, ...(sourceLabel ? { sourceLabel } : {}) });

describe('first-match order must not drop the S13 provenance warning', () => {
  it('bulk send (S10) with one injected recipient still warns about it', () => {
    const targets = [...['a', 'b', 'c', 'd', 'e'].map((x) => t(`${x}@team.com`, 'user')), t('x@evil.com', 'untrusted', 'an email')];
    const a: ProposedAction = { toolName: 'gmail_send_draft', toolUseId: 't', cls: { actionClass: 'send_external', risk: 2, integration: 'gmail', requiredLevel: 'act', bulkCount: 6 }, targets, surface: 'dm', phase: 'propose' };
    const d = evaluateRules(a, snap);
    expect(d.kind).toBe('ask');
    expect(d.kind === 'ask' ? d.warnings.join(' ') : '').toMatch(/an email, not from you/);
  });

  it('destructive action (S11) notifying an injected attendee still warns about it', () => {
    const a: ProposedAction = { toolName: 'calendar_delete_event', toolUseId: 't', cls: { actionClass: 'destructive', risk: 3, integration: 'gcal', requiredLevel: 'act' }, targets: [t('x@evil.com', 'untrusted', 'an email')], surface: 'dm', phase: 'propose' };
    const d = evaluateRules(a, snap);
    expect(d.kind === 'ask' ? d.warnings.join(' ') : '').toMatch(/not from you/);
  });
});
