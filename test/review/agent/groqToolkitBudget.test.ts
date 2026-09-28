// PROOF (agent review): on groq-free the active-toolkit selection ignores the 5 200-token prompt budget. The tool schemas
// of core ∪ preloads (web + calendar + email from the owner's words, account from a pending approval) plus the compact
// system prompt already take ~4 700 of the 5 200 tokens, so ONE modest tool result (a calendar listing, ~750 tokens)
// plus the email-draft round make the hard ceiling (map.ts fitToBudget) throw prompt_budget: the run ends with "That was too long for me to
// process" after the tool already ran. Nothing in the request path drops or shrinks tool definitions (fitToBudget only
// drops history turns and truncates tool results; engine.ts toolsFor() adds kits without a budget).
// FIXED (agent fixer): engine.ts requestFor() budgets the kits (toolkits.ts droppableKits + fitKitsToBudget): kits not
// used by the current run are dropped (history-only, then preloads, then use_toolkit-loaded; never core / the run's kits /
// the route's kit) while what fitToBudget can never drop exceeds the ceiling. The model can re-load a kit by use_toolkit.
import { afterEach, describe, expect, it } from 'vitest';
import type { MainRequest, ToolkitId } from '../../../src/contracts/index.ts';
import { TOOLKIT_IDS } from '../../../src/contracts/tools.ts';
import { droppableKits, fitKitsToBudget, kitsOfTools, preloadKits, selectActiveKits } from '../../../src/agent/toolkits.ts';
import { systemTextFor } from '../../../src/agent/prompt/system.ts';
import { fitToBudget, translateRequest, estimateTranslated } from '../../../src/agent/groq/map.ts';
import { createTestApp } from '../../harness/testApp.ts';
import type { TestApp } from '../../harness/testApp.ts';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe('groq-free budget with realistic toolkits', () => {
  it('a Gmail+Calendar request with one pending approval survives a calendar lookup + an email draft (2 tool rounds)', async () => {
    app = await createTestApp({ env: { LLM_PROVIDER: 'groq' } });
    const s = app.s;
    const profile = s.config.profile;
    expect(profile.id).toBe('groq-free');
    const ask = 'Find a free slot for a meeting with Anna next week and email her the invite';
    const preloads = preloadKits({ text: ask, route: 'dm', hasPendingApproval: true, connected: { gmail: true, gcal: true } });
    const kits = selectActiveKits({ loaded: [], historyKits: [], preloads });
    const calTool = s.registry.toolkits().calendar[0]!;
    const mailTool = s.registry.toolkits().email[0]!;
    const context = '<gora_context v="1">\nnow: 2026-09-28T14:03+05:00 (Mon) tz=Asia/Almaty tz_source=miniapp\nowner: name=Aigerim lang=en plan=free memory=on\nagent: name=Gora style=friendly\nsurface: dm\n</gora_context>';
    const events = Array.from({ length: 12 }, (_, i) => `- ${i + 9}:00–${i + 10}:00 "Team sync ${i}" with anna@example.com, room B${i}`).join('\n');
    const build = (k: readonly ToolkitId[]) => ({
      model: `groq:${profile.models.main}`, max_tokens: 1_200,
      system: [{ type: 'text', text: systemTextFor(profile.systemVariant) }],
      tools: s.registry.subset('FULL', k).definitions,
      messages: [
        { role: 'user', content: [{ type: 'text', text: ask }] },
        { role: 'system', content: [{ type: 'text', text: context }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'fc_1', name: calTool, input: { from: '2026-10-05', to: '2026-10-09' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc_1', content: events.repeat(2) }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Tuesday 15:00 is free.' }, { type: 'tool_use', id: 'fc_2', name: mailTool, input: { to: 'anna@example.com', subject: 'Meeting Tuesday 15:00', body: 'Hi Anna, does Tuesday 15:00 work for you? Aigerim' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc_2', content: JSON.stringify({ status: 'pending_approval', approval_id: 'A7K2QX', summary: 'send email → anna@example.com' }) }] },
      ],
      output_config: { effort: 'low' },
    }) as unknown as MainRequest;
    const runKits = kitsOfTools(s.registry.toolkits(), [calTool, mailTool]);
    const droppable = droppableKits({ active: kits, loaded: [], preloads, runKits });
    expect(droppable).not.toContain('core');
    expect(droppable).not.toContain('calendar');
    expect(droppable).not.toContain('email');
    const { req, dropped } = fitKitsToBudget({ kits, droppable, build, maxPromptTokens: profile.maxPromptTokens, maxOutputTokens: profile.maxOutputTokens });
    const t = translateRequest(req, { mediaText: () => '', maxOutputTokens: profile.maxOutputTokens });
    console.log('kits', kits.join(','), 'dropped', dropped.join(','), 'tool tokens', estimateTranslated({ messages: [], tools: t.tools }), 'total', estimateTranslated(t));
    expect(() => fitToBudget(t, profile.maxPromptTokens)).not.toThrow();
    expect(t.toolNames).toContain(calTool);
    expect(t.toolNames).toContain(mailTool);
    expect(t.toolNames).toContain('use_toolkit'); // a dropped kit can be re-loaded
  });

  it('worst case: every kit active from history, nothing used by the current run → the request fits', async () => {
    app = await createTestApp({ env: { LLM_PROVIDER: 'groq' } });
    const s = app.s;
    const profile = s.config.profile;
    const all = [...TOOLKIT_IDS];
    const build = (k: readonly ToolkitId[]) => ({
      model: `groq:${profile.models.main}`, max_tokens: 1_200, system: [{ type: 'text', text: systemTextFor(profile.systemVariant) }],
      tools: s.registry.subset('FULL', k).definitions,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what should I do today?' }] }], output_config: { effort: 'low' },
    }) as unknown as MainRequest;
    const droppable = droppableKits({ active: all, loaded: ['web'], preloads: ['calendar'], runKits: [] });
    expect(droppable[droppable.length - 1]).toBe('web'); // use_toolkit-loaded kits are dropped last
    const { req } = fitKitsToBudget({ kits: all, droppable, build, maxPromptTokens: profile.maxPromptTokens, maxOutputTokens: profile.maxOutputTokens });
    const t = translateRequest(req, { mediaText: () => '', maxOutputTokens: profile.maxOutputTokens });
    expect(estimateTranslated(t)).toBeLessThanOrEqual(profile.maxPromptTokens);
  });
});
