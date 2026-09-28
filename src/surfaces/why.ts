// src/surfaces/why.ts (WP7a) — `/why` (01 F8): replying /why to a Gora message maps tg_links → the run and lists,
// deterministically (no LLM): the memories used (`[m12] vegetarian` + a Forget button each), the tools called with
// their queries and hosts, the sources, Sentinel decisions, the nudge reason, and the model that answered (including
// whether a fallback answered). Only the owner's own messages are explained.
import type { ChatRef, TgLinkRow, UserRow } from '../contracts/index.ts';
import { PROACTIVE_LOG_PREFIX } from '../contracts/behaviour.ts';
import { st } from './strings.ts';
import { cbBtn, errName, langOf, sendRich, type Keyboard, type Surf } from './util.ts';

const QUERY_KEYS = ['query', 'q', 'place', 'city', 'from', 'to', 'title', 'question'] as const;

function hostOf(u: string): string | null {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch {
    return null;
  }
}

/** URLs anywhere in a JSON-ish value (tool results, server tool result blocks, citations). */
export function collectUrls(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 8 || out.size >= 50 || v === null || v === undefined) return;
  if (typeof v === 'string') {
    for (const m of v.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) out.add(m[0]);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectUrls(x, out, depth + 1);
    return;
  }
  if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collectUrls(x, out, depth + 1);
}

/** "web_search: “weather almaty”" — only whitelisted, short input fields; hosts for urls; never bodies. */
export function describeToolCall(name: string, input: unknown): string {
  const parts: string[] = [];
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of QUERY_KEYS) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) parts.push(`“${v.trim().slice(0, 80)}”`);
    }
    if (typeof o['url'] === 'string') {
      const h = hostOf(o['url']);
      if (h) parts.push(h);
    }
  }
  return parts.length ? `${name}: ${parts.slice(0, 2).join(' · ')}` : name;
}

export function createWhy(surf: Surf) {
  const { s } = surf;
  const esc = (t: string) => s.telegram.render.escape(t);

  async function explain(user: UserRow, chat: ChatRef, replyTo: { messageId: number } | null, idem: string): Promise<void> {
    const lang = langOf(user);
    const to = { ...chat, userId: user.id };
    if (!replyTo) {
      await sendRich(surf, to, st('why_usage', lang), { idem });
      return;
    }
    let link: TgLinkRow | undefined;
    try {
      link = s.telegram.links.lookup(chat.chatId, replyTo.messageId);
    } catch {
      link = undefined;
    }
    if (!link || (link.userId !== null && link.userId !== user.id)) {
      await sendRich(surf, to, st('why_unknown', lang), { idem });
      return;
    }
    const lines: string[] = [`🧠 **${st('why_title', lang)}**`];
    const kb: Keyboard = [];

    if (link.nudgeId?.startsWith(PROACTIVE_LOG_PREFIX)) {
      // 05 C4: a message Gora wrote first — the arm, gap, score and judge reason (never shown in the message itself).
      try {
        const x = link.userId === user.id ? s.proactivePolicy.explain(link.nudgeId) : undefined;
        if (x) {
          const reason = x.reason ? esc(x.reason.length > 200 ? x.reason.slice(0, 199) + '…' : x.reason) : '';
          lines.push(st('why_proactive', lang, { type: st(`proactive_type_${x.contentType}`, lang), gap: x.gapBucket, score: x.score.toFixed(2), reason }).trim());
        } else lines.push(st('why_unknown', lang));
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'why: proactive explain failed');
        lines.push(st('why_unknown', lang));
      }
      await sendRich(surf, to, lines.join('\n'), { idem });
      return;
    }
    if (link.nudgeId) {
      try {
        const n = s.nudges.get(link.nudgeId);
        if (n && n.userId === user.id) lines.push(st('why_nudge', lang, { why: esc(n.why) }));
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'why: nudge lookup failed');
      }
    }
    if (link.pendingActionId) {
      try {
        const pa = s.approvals.get(link.pendingActionId, user.id);
        if (pa) lines.push(st('why_approval', lang, { id: pa.id, title: esc(pa.title), status: pa.status }));
      } catch (e) {
        surf.log.warn({ err: errName(e) }, 'why: approval lookup failed');
      }
    }
    const run = link.runId ? s.repos.runs.get(link.runId) : undefined;
    if (!run) {
      if (link.jobId || link.kind === 'reminder') lines.push(st('why_reminder', lang));
      else if (lines.length === 1) lines.push(st('why_unknown', lang));
      await sendRich(surf, to, lines.join('\n'), { idem });
      return;
    }
    if (run.userId !== null && run.userId !== user.id) {
      await sendRich(surf, to, st('why_unknown', lang), { idem });
      return;
    }

    // Trigger
    if (run.trigger === 'user_input') lines.push(st('why_trigger_user', lang));
    else lines.push(st('why_trigger_event', lang, { what: esc(run.triggerRef?.split(':')[0] ?? run.trigger) }));

    // Memories used
    lines.push('', `**${st('why_memories', lang)}**`);
    try {
      const uses = s.repos.runs.memoryUses(run.id).sort((a, b) => a.rank - b.rank);
      const hits = uses.length ? s.memory.getMany({ kind: 'user', userId: user.id }, uses.map((u) => u.factId)) : [];
      if (hits.length === 0) lines.push(st('why_no_memories', lang));
      for (const h of hits) lines.push(`• [${h.id}] ${esc(h.text.length > 120 ? h.text.slice(0, 119) + '…' : h.text)}`);
      for (let i = 0; i < hits.length && i < 12; i += 3) kb.push(hits.slice(i, i + 3).map((h) => cbBtn(surf, st('forget_button', lang, { id: h.id }), 'mm', ['fg', h.id], user.tgUserId)));
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'why: memories failed');
      lines.push(st('why_no_memories', lang));
    }

    // Tools + sources
    const urls = new Set<string>();
    lines.push('', `**${st('why_tools', lang)}**`);
    try {
      const calls = s.repos.runs.toolCallsFor(run.id);
      if (calls.length === 0) lines.push(st('why_no_tools', lang));
      for (const c of calls.slice(0, 15)) {
        lines.push(`• ${esc(describeToolCall(c.name, c.input))}${c.status === 'denied' ? ' ✖' : c.status === 'pending_approval' ? ' ⏳' : ''}`);
        if (c.name === 'web_search' || c.name === 'web_fetch') collectUrls(c.result, urls);
      }
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'why: tool calls failed');
      lines.push(st('why_no_tools', lang));
    }
    try {
      const conv = s.repos.conversations.get(run.conversationId);
      if (conv) {
        for (const m of s.repos.messages.load(conv.id, run.epoch)) {
          if (m.runId !== run.id || m.role !== 'assistant' || !Array.isArray(m.content.content)) continue;
          for (const b of m.content.content as unknown as Array<Record<string, unknown>>) {
            const t = String(b['type'] ?? '');
            if (t === 'web_search_tool_result' || t === 'web_fetch_tool_result') collectUrls(b['content'], urls);
            else if (t === 'text' && Array.isArray(b['citations'])) collectUrls(b['citations'], urls);
            else if (t === 'server_tool_use') {
              const name = String(b['name'] ?? '');
              lines.push(`• ${esc(describeToolCall(name, b['input']))}`);
            }
          }
        }
      }
    } catch (e) {
      surf.log.debug({ err: errName(e) }, 'why: transcript unavailable (shredded?)');
    }
    const hosts = [...new Set([...urls].map(hostOf).filter((h): h is string => !!h))].slice(0, 8);
    if (hosts.length) lines.push('', `**${st('why_sources', lang)}**`, ...hosts.map((h) => `• ${esc(h)}`));

    // Sentinel decisions
    try {
      const ds = s.sentinel.decisionsFor(run.id);
      if (ds.length) {
        lines.push('', `**${st('why_decisions', lang)}**`);
        for (const d of ds.slice(0, 10)) lines.push(`• ${esc(d.toolName)}: ${d.decision} (${esc(d.ruleId)})${d.tainted ? ' ⚠' : ''}`);
      }
    } catch (e) {
      surf.log.debug({ err: errName(e) }, 'why: sentinel decisions unavailable');
    }
    if (run.taint.length) lines.push('', st('why_tainted', lang, { sources: run.taint.join(', ') }));

    // Model
    try {
      const calls = s.repos.runs.llmCallsFor(run.id).filter((c) => c.purpose === 'main');
      const last = calls[calls.length - 1];
      if (last) {
        const model = last.modelServed ?? last.modelRequested;
        const anyFallback = calls.some((c) => c.servedByFallback);
        lines.push('', st('why_model', lang, { model: anyFallback ? st('why_fallback', lang, { model: esc(model) }) : esc(model) }));
      }
    } catch (e) {
      surf.log.warn({ err: errName(e) }, 'why: llm calls failed');
    }
    await sendRich(surf, to, lines.join('\n'), { idem, ...(kb.length ? { keyboard: kb } : {}) });
  }

  return { explain };
}
export type Why = ReturnType<typeof createWhy>;
