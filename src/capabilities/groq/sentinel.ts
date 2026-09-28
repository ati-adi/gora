// capabilities/groq/sentinel.ts (WP5) — LLM Sentinel capability (03 R5): gpt-oss-safeguard-20b with the static policy
// (WP4's trust/llmSentinelPolicy.ts, passed in as `policy`) as the system message and the proposed call as JSON in the user
// message. Output {"violation":0|1,"rationale":…} validated with zod. Any error / invalid JSON / missing policy → null
// (the caller asks). The 3 s timeout is enforced by the caller (WP4).
import { z } from 'zod';
import type { LlmSentinelCapability, Logger } from '../../contracts/index.ts';
import { errorMessage } from '../../kernel/errors.ts';
import type { GroqCaller } from './common.ts';

const OUT = z.object({ violation: z.union([z.literal(0), z.literal(1), z.boolean()]), rationale: z.string().max(2000).optional().default('') });
interface Completion { choices: Array<{ message: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }

/** Pure parser (exported for tests): the first JSON object in the reply, validated. */
export function parseSentinelReply(content: string | null | undefined): { violation: boolean; rationale: string } | null {
  const s = String(content ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const r = OUT.safeParse(JSON.parse(s.slice(a, b + 1)));
    if (!r.success) return null;
    return { violation: r.data.violation === 1 || r.data.violation === true, rationale: r.data.rationale.replace(/\s+/g, ' ').trim().slice(0, 200) };
  } catch {
    return null;
  }
}

export function createGroqSentinel(caller: GroqCaller, model: () => string, policy: () => string | null, log: Logger): LlmSentinelCapability {
  return {
    async check(i) {
      const p = policy();
      if (!p || !caller.available()) return null;
      const user = JSON.stringify({ owner_request: i.ownerText.slice(0, 500), taint_sources: i.taint, proposed_call: { tool: i.tool, input: i.input.slice(0, 2000) } });
      try {
        const data = await caller.run<Completion>({
          role: 'sentinel', model: model(), purpose: 'sentinel', estTokens: Math.ceil((p.length + user.length) / 3) + 200, priority: i.priority ?? 'background', ...(i.meta ? { meta: i.meta } : {}),
          call: (c, served) =>
            c.chat.completions
              .create({
                model: served, max_completion_tokens: 800, reasoning_effort: 'low', include_reasoning: false, response_format: { type: 'json_object' },
                messages: [{ role: 'system', content: p }, { role: 'user', content: user }],
              } as never)
              .withResponse() as unknown as Promise<{ data: Completion; response: Response }>,
          usage: (d) => ({ inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0 }),
        });
        return parseSentinelReply(data.choices[0]?.message.content);
      } catch (e) {
        log.warn({ err: errorMessage(e), tool: i.tool }, 'llm sentinel call failed');
        return null;
      }
    },
  };
}
