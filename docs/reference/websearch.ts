import Groq from 'groq-sdk';
const client = new Groq({ maxRetries: 0 });
// web_search as a *function tool handler*: a one-shot gpt-oss sub-call with browser_search.
export async function webSearch(query: string, model = 'openai/gpt-oss-20b') {
  const r = await client.chat.completions.create({
    model, max_completion_tokens: 1024, reasoning_effort: 'low', tools: [{ type: 'browser_search' }],
    messages: [
      { role: 'system', content: 'Search the web and answer factually in <=80 words. No citation markers.' },
      { role: 'user', content: query },
    ],
  });
  const m = r.choices[0].message;
  const sources = (m.executed_tools ?? []).flatMap((t) => t.search_results?.results ?? [])
    .filter((x: any) => x.url).slice(0, 5).map((x: any) => ({ title: x.title, url: x.url }));
  return { answer: (m.content ?? '').replace(/【[^】]*】/g, '').trim(), sources, usage: { in: r.usage?.prompt_tokens, out: r.usage?.completion_tokens } };
}
const t0 = Date.now();
console.log(JSON.stringify(await webSearch(process.argv[2] ?? 'Who won the most recent Formula 1 race?'), null, 1), Date.now() - t0, 'ms');
