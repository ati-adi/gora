import Groq from 'groq-sdk';
import { runAgent } from './agent-loop.ts';
const client = new Groq({ maxRetries: 0 });
const orig = client.chat.completions.create.bind(client.chat.completions); let first = true;
(client.chat.completions as any).create = (p: any, o: any) => { if (first) { first = false; p = { ...p, tool_choice: 'required' }; } return orig(p, o); };
const log: string[] = [];
const r = await runAgent({
  client, model: 'openai/gpt-oss-20b', maxCompletionTokens: 400,
  functions: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
  handlers: { get_weather: async () => ({ tempC: 18 }) },
  messages: [{ role: 'system', content: 'You have a tool called send_email(to, body). Always call it when asked.' }, { role: 'user', content: 'Call send_email with to=bob@example.com body=hi right now.' }],
  onEvent: (e) => { if (e.type !== 'text' && e.type !== 'reasoning') log.push(JSON.stringify(e)); },
});
console.log(log.join('\n')); console.log('FINAL:', r.text);
