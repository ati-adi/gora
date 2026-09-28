// capabilities/groq/guard.ts (WP5) — PromptGuard (03 R5): llama-prompt-guard-2-86m through chat completions with exactly
// one user message; the reply is a probability string. Chunking and kv caching are WP4's (trust/guard.ts): this scores one
// chunk (≤ 512 tokens; longer input is clipped to 1,500 chars). null = unavailable (no client, error, unparseable).
import type { GuardCapability, Logger } from '../../contracts/index.ts';
import { errorMessage } from '../../kernel/errors.ts';
import type { GroqCaller } from './common.ts';

export const GUARD_MAX_CHARS = 1500;
interface Completion { choices: Array<{ message: { content?: string | null } }>; usage?: { prompt_tokens?: number } }

export function parseGuardScore(content: string | null | undefined): number | null {
  const n = Number.parseFloat(String(content ?? '').trim());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function createGroqGuard(caller: GroqCaller, model: () => string, log: Logger): GuardCapability {
  return {
    async score(text, o = {}) {
      if (!caller.available()) return null;
      const chunk = text.slice(0, GUARD_MAX_CHARS);
      if (!chunk.trim()) return 0;
      try {
        const data = await caller.run<Completion>({
          role: 'guard', model: model(), purpose: 'guard', estTokens: Math.ceil(chunk.length / 3) + 8, priority: o.priority ?? 'background',
          meta: { userId: o.userId ?? null, runId: o.runId ?? null },
          call: (c, served) => c.chat.completions.create({ model: served, messages: [{ role: 'user', content: chunk }] } as never).withResponse() as unknown as Promise<{ data: Completion; response: Response }>,
          usage: (d) => ({ inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: 0 }),
        });
        return parseGuardScore(data.choices[0]?.message.content);
      } catch (e) {
        log.warn({ err: errorMessage(e) }, 'prompt guard unavailable');
        return null;
      }
    },
  };
}
