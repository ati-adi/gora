// browser/classify.ts (s07 BR, spec 07 A4) — Sentinel classes of the browser tools. Synchronous: it reads the task's
// last snapshot (built from session.lastState()) and never touches the page.
//  - reading and navigation: read_public (risk 0);
//  - typing: write_self when the text is owner-provided (it appears in the task's goal or constraints, or the owner's
//    own name / username); an email, phone, address or name that is NOT owner-provided — text lifted from a page, a
//    third party — is send_external (risk 3) and asks;
//  - a submit/commit (a commit-verb button, a non-search form submit, type {submit:true} or Enter in such a form):
//    send_external (risk 3) or spend (risk 4) when payment wording or a payment page is detected. Never grantable, and
//    in a web-tainted run S14 asks every time anyway. `spend` is refused outright in v1 (S05): the owner pays.
//  - password / payment fields: typing is refused by the tool itself (NO_CREDENTIALS / payment handover), so it is
//    classified write_self to avoid ever showing a card with a secret on it.
// s07 lead hardening (red team / skeptic):
//  - browser_press Enter AND Space are classified from the page's REAL focus (the aria `active` flag of the snapshot),
//    falling back to the tool's own bookkeeping; when neither is known, any commit control or commit form on the page
//    makes the key press a potential commit;
//  - personal data the owner gave is free to type only on a host the owner named (start_url, a domain in the goal or
//    their messages) or approved an action on — elsewhere it asks;
//  - browser_open to a new host after the task has read pages (a page could have asked for it: exfiltration through the
//    URL or even the DNS name) asks; the first site, owner-named hosts and hosts already on the task's path are free.
// The capability adds a network backstop under all of this: a non-GET form submit never leaves unless approved.
import type { Classification } from '../contracts/index.ts';
import { isPaymentAction, isPersonalField, isSubmitAction, pageHasCommit, submitsForm } from './detect.ts';
import type { BrowserSnapshot, RefInfo } from './snapshot.ts';

export const READ: Classification = { actionClass: 'read_public', risk: 0 };
const WRITE_SELF: Classification = { actionClass: 'write_self', risk: 1 };
const SEND: Classification = { actionClass: 'send_external', risk: 3, grantable: false };
const SPEND: Classification = { actionClass: 'spend', risk: 4, grantable: false };
/** Opening a host nobody on the owner's side chose, after pages were read (the URL itself can carry data out). */
const OPEN_NEW_HOST: Classification = { actionClass: 'send_external', risk: 2, grantable: false };

const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\s().-]*){7,}/;

export interface ClassifyEnv {
  /** The task's last snapshot (null before the first state()). */
  snap: BrowserSnapshot | null;
  /** The ref typed into / clicked last (the fallback when the page does not report its focus). */
  focus: string | null;
  /** Owner-provided text: the task goal + constraints + the owner's own messages + name / username. */
  ownerText: string;
  /**
   * Hosts on the owner's side: the start_url host, domains named in the goal / constraints / owner messages, and hosts
   * the owner approved an action on. Undefined = no host binding (pure classification in tests).
   */
  ownerHosts?: readonly string[];
  /** Hosts the task's browser already visited (its path through the site). */
  visitedHosts?: readonly string[];
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '').replace(/\.$/, '');
/** `host` is one of `hosts` or a subdomain of one. */
export function hostIn(host: string, hosts: readonly string[] | undefined): boolean {
  if (!host || !hosts?.length) return false;
  const h = bareHost(host);
  return hosts.some((x) => {
    const b = bareHost(x);
    return !!b && (h === b || h.endsWith(`.${b}`));
  });
}

/** Domain names written in owner text ("book at cafealma.kz"). */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24}|xn--[a-z0-9-]{2,20}))\b/gi)) out.add(m[1]!.toLowerCase());
  return [...out];
}

/** The URL browser_open will navigate to (a scheme-less input becomes https://). */
export function openTarget(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[«»“”"']/g, '').trim();
const digits = (s: string) => s.replace(/\D+/g, '');

/** The text came from the owner: it appears (normalised; phones by digits) in the goal, constraints or the owner's name. */
export function ownerProvided(text: string, ownerText: string): boolean {
  const t = norm(text);
  if (!t) return true;
  const o = norm(ownerText);
  if (o.includes(t)) return true;
  const d = digits(text);
  return d.length >= 7 && digits(ownerText).includes(d);
}

/** Personal data (A4): an email, a phone, or any text typed into a name / email / phone / address field. */
export function isPersonalData(text: string, ref: RefInfo | undefined): boolean {
  if (EMAIL_RE.test(text) || PHONE_RE.test(text)) return true;
  return isPersonalField(ref);
}

function commitClass(ref: RefInfo, snap: BrowserSnapshot): Classification {
  return isPaymentAction(ref, snap) ? SPEND : SEND;
}

export function classifyBrowserTool(tool: string, input: Record<string, unknown>, env: ClassifyEnv): Classification {
  const snap = env.snap;
  switch (tool) {
    case 'browser_click': {
      const ref = snap?.refs.get(String(input['ref'] ?? ''));
      if (!ref || !snap) return READ; // a stale ref fails in execute (take a new snapshot)
      return isSubmitAction(ref, snap) ? commitClass(ref, snap) : READ;
    }
    case 'browser_type': {
      const ref = snap?.refs.get(String(input['ref'] ?? ''));
      if (ref?.secret) return WRITE_SELF; // refused by the tool (no credentials / payment data, ever)
      const text = String(input['text'] ?? '');
      if (input['submit'] === true && ref && snap && submitsForm(snap, ref)) return commitClass(ref, snap);
      const personal = isPersonalData(text, ref);
      if (ownerProvided(text, env.ownerText)) {
        // the owner's own details go only where the owner sent them (a page cannot redirect them to another host)
        if (personal && env.ownerHosts !== undefined && snap?.host && !hostIn(snap.host, env.ownerHosts)) return SEND;
        return WRITE_SELF;
      }
      return personal ? SEND : WRITE_SELF;
    }
    case 'browser_select':
      return WRITE_SELF;
    case 'browser_press': {
      const key = input['key'];
      if (key !== 'Enter' && key !== 'Space') return READ;
      if (!snap) return READ; // execute re-checks against a fresh snapshot
      const real = [...snap.refs.values()].find((r) => r.focused);
      const ref = real ?? (env.focus ? snap.refs.get(env.focus) : undefined);
      if (!ref) {
        // the focus is unknown (e.g. an autofocused element the model never touched): assume the worst on commit pages
        if (!pageHasCommit(snap)) return READ;
        const pay = snap.flags.payment || [...snap.refs.values()].some((r) => isSubmitAction(r, snap) && isPaymentAction(r, snap));
        return pay ? SPEND : SEND;
      }
      if (ref.role === 'button' || ref.role === 'link' || ref.submit || ref.role === 'menuitem' || ref.role === 'option' || ref.role === 'checkbox' || ref.role === 'radio' || ref.role === 'switch' || ref.role === 'tab') {
        return isSubmitAction(ref, snap) ? commitClass(ref, snap) : READ;
      }
      if (key === 'Space') return READ; // a space typed into a field
      return submitsForm(snap, ref) ? commitClass(ref, snap) : READ;
    }
    case 'browser_open': {
      const url = openTarget(String(input['url'] ?? ''));
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        return READ; // refused in execute
      }
      if (env.ownerHosts === undefined) return READ;
      const pagesRead = !!snap || !!env.visitedHosts?.length;
      if (!pagesRead) return READ; // the task's first site (no page content has been read yet)
      if (hostIn(host, env.ownerHosts) || hostIn(host, env.visitedHosts)) return READ;
      return OPEN_NEW_HOST;
    }
    case 'browser_show':
      return { actionClass: 'ui', risk: 0 };
    case 'browser_done':
      return { actionClass: 'control', risk: 0 };
    default:
      return READ; // snapshot, scroll, back
  }
}
