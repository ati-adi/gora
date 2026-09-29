// groups/summary.ts (GR, spec 07 C3) — the group_summarize job: a rolling group summary (fast model, batched every 40
// messages or after 10 idle minutes) sealed into group_summaries, then the automatic group facts (plans, decisions,
// dates, stated preferences) saved into the GROUP memory scope with source 'user_message' / explicit false (spec 07 C3
// overrides 01 §9's explicit-only rule; memory/store.ts allows exactly this). Sensitive facts are never saved.
// Priority 'background' (JOB_LLM_PRIORITY pauses the job when llmBudget says no).
import type { FactKind, JobHandler, Scope } from '../contracts/index.ts';
import { looksSensitive } from '../kernel/sensitive.ts';
import { localDay } from '../kernel/timeMath.ts';
import type { GroupCtx } from './ctx.ts';
import { scriptLang } from './ctx.ts';
import { FACTS_SYSTEM, FactsSchema, factsUser, SUMMARY_SYSTEM, SummarySchema, summaryUser, transcript, withSummary } from './prompts.ts';

const BATCH_MAX = 200;

export function createSummary(g: GroupCtx) {
  const { s } = g;
  const L = () => s.config.limits;

  async function summarize(chatId: number, signal?: AbortSignal): Promise<'empty' | 'done'> {
    const sum = g.repo().summary(chatId);
    const batch = g.repo().after(chatId, sum?.coveredUntilAt ?? 0, BATCH_MAX);
    if (!batch.length) return 'empty';
    // the chat language from what members wrote in this batch
    let ru = 0;
    let en = 0;
    for (const m of batch) {
      if (m.kind === 'bot') continue;
      const l = scriptLang(m.text);
      if (l === 'ru') ru++;
      else if (l === 'en') en++;
    }
    if (ru + en >= 3) g.repo().updatePolicy(chatId, { lang: ru >= en ? 'ru' : 'en' });
    const lang = g.langOf(chatId);
    const tz = g.tzOf(chatId);
    const meta = { priority: 'background' as const, ...(signal ? { signal } : {}) };
    const lines = transcript(batch, { tz, ids: true, maxCharsPerLine: 500 });
    const sumIn = await s.untrusted.wrap({ source: 'group_member', label: 'group chat', text: withSummary(sum?.summary ?? null, lines, 1500), priority: 'background' });
    const r = await s.side.structured({ purpose: 'group_summary', role: 'fast', system: SUMMARY_SYSTEM, user: summaryUser({ wrapped: sumIn.text, lang }), schema: SummarySchema, maxTokens: 700 }, meta);

    // group facts (C3) from the members' messages of this batch
    const members = batch.filter((m) => m.kind !== 'bot');
    let saved = 0;
    if (members.length) {
      // facts come from the new messages only (the previous summary would re-extract old facts)
      const factsIn = sum?.summary ? await s.untrusted.wrap({ source: 'group_member', label: 'group chat', text: lines, priority: 'background' }) : sumIn;
      const f = await s.side.structured({ purpose: 'group_facts', role: 'fast', system: FACTS_SYSTEM, user: factsUser({ wrapped: factsIn.text, lang, localDate: localDay(s.clock.now(), tz ?? 'UTC') }), schema: FactsSchema, maxTokens: 600 }, meta);
      const ids = new Set(members.map((m) => m.tgMessageId));
      const scope: Scope = { kind: 'group', chatId };
      for (const fact of f?.facts ?? []) {
        if (fact.sensitive || looksSensitive(fact.text)) continue;
        const src = fact.source_message_id !== null && ids.has(fact.source_message_id) ? fact.source_message_id : null;
        try {
          const res = await s.memory.save(scope, {
            text: fact.text, kind: fact.kind as FactKind, sensitivity: 'normal', explicit: false, authorUserId: null,
            source: { kind: 'user_message', ...(src !== null ? { tgMessageId: src } : {}) },
            // s07 lead fix: an automatic group fact lives no longer than the messages it came from (C3 14-day retention)
            expiresAt: s.clock.now() + L().groupMessageRetentionDays * 86_400_000,
          });
          if (!('denied' in res)) saved++;
        } catch (e) {
          g.log().warn({ chatId, err: e instanceof Error ? e.name : 'error' }, 'groups: fact save failed');
        }
      }
    }
    const last = batch.at(-1)!;
    // Telegram dates have 1 s resolution: messages stored later within the batch's last second must not be skipped, so
    // the coverage ends just before that second (its few lines may be seen twice; never lost)
    g.repo().setSummary(chatId, { summary: r?.summary?.trim() ? r.summary.trim() : null, coveredUntilAt: last.at - 1, covered: batch.length, factsUntilAt: last.at - 1, coveredFromAt: batch[0]!.at });
    g.log().info({ chatId, messages: batch.length, facts: saved, summarized: !!r }, 'groups: summary batch');
    return 'done';
  }

  const job: JobHandler = async (jobRow, ctx) => {
    const chatId = Number(jobRow.payload['chatId']);
    if (!Number.isFinite(chatId)) return { status: 'done' };
    try {
      await summarize(chatId, ctx.signal);
    } catch (e) {
      const name = e instanceof Error ? e.name : 'error';
      if (name === 'TransientLlmError') return { status: 'retry', error: name };
      g.log().warn({ chatId, err: name }, 'groups: summary failed');
    }
    return { status: 'done' };
  };

  return { summarize, job };
}
