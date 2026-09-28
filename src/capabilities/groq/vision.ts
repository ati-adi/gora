// capabilities/groq/vision.ts (WP5) — image description on GROQ_MODEL_VISION (03 R4): reasoning_effort low, ≤ 3 images,
// "Describe precisely; transcribe all visible text verbatim". Descriptions are never cached in plaintext.
import type { VisionCapability } from '../../contracts/index.ts';
import type { GroqCaller } from './common.ts';

export const VISION_PROMPT = 'Describe precisely; transcribe all visible text verbatim.';
export const VISION_MAX_IMAGES = 3;
const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64');

interface Completion { choices: Array<{ message: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }

export function createGroqVision(caller: GroqCaller, model: () => string): VisionCapability {
  return {
    async describe(q) {
      const images = q.images.slice(0, VISION_MAX_IMAGES);
      if (!images.length) return '';
      const text = q.question?.trim() ? `${VISION_PROMPT}\nThen answer: ${q.question.trim().slice(0, 500)}` : VISION_PROMPT;
      const content = [{ type: 'text', text }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${b64(im.bytes)}` } }))];
      const data = await caller.run<Completion>({
        role: 'vision', model: model(), purpose: 'vision', estTokens: 1200 * images.length + 600, priority: q.priority ?? 'background', ...(q.meta ? { meta: q.meta } : {}),
        call: (c, served) =>
          c.chat.completions.create({ model: served, max_completion_tokens: 1024, reasoning_effort: 'low', messages: [{ role: 'user', content }] } as never).withResponse() as unknown as Promise<{ data: Completion; response: Response }>,
        usage: (d) => ({ inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0 }),
      });
      return (data.choices[0]?.message.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    },
  };
}
