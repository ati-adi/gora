// WP5 — make_file on Groq (03 R4): csv|md|txt|json via parse (purpose make_file); png via code_interpreter;
// xlsx|docx|pdf → "Not available on the current model — I can make a CSV instead".
import { describe, expect, it } from 'vitest';
import { createGroqCodeFiles, GROQ_FILE_UNAVAILABLE, pngFromCompletion } from '../../../src/capabilities/codeFiles.groq.ts';
import { outputFileIds } from '../../../src/capabilities/codeFiles.ts';
import { createGroqCaller } from '../../../src/capabilities/groq/common.ts';
import { ScriptedTransport } from '../../harness/scriptedTransport.ts';
import { capEnv, fakeGroq } from './env.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const base = { userId: 'u1', inputs: [], signal: new AbortController().signal };

describe('codeFiles on Groq', () => {
  it('text types go through a make_file parse call; JSON is validated and pretty-printed', async () => {
    const g = fakeGroq(() => ({ choices: [] }));
    const env = capEnv({ groq: g.client, provider: 'groq' });
    const llm = new ScriptedTransport();
    (env.s as unknown as { transport: unknown }).transport = llm;
    llm.pushParse('make_file', { filename: 'x', content: 'a,b\n1,2\n' });
    llm.pushParse('make_file', { filename: 'x', content: '{"a":1}' });
    llm.pushParse('make_file', { filename: 'x', content: 'not json' });
    const cf = createGroqCodeFiles(env.s, createGroqCaller(env.s), () => 'openai/gpt-oss-20b');
    const csv = await cf.make({ ...base, fileType: 'csv', filename: '../data.CSV', instructions: 'table' });
    expect(csv).toMatchObject({ filename: 'data.csv', mime: 'text/csv' });
    expect(new TextDecoder().decode(csv.bytes)).toBe('a,b\n1,2\n');
    expect(llm.parseRequests[0]!.purpose).toBe('make_file');
    const json = await cf.make({ ...base, fileType: 'json', filename: 'cfg', instructions: 'json' });
    expect(new TextDecoder().decode(json.bytes)).toBe('{\n  "a": 1\n}\n');
    await expect(cf.make({ ...base, fileType: 'json', filename: 'cfg', instructions: 'json' })).rejects.toThrow(/invalid JSON/);
    for (const ft of ['xlsx', 'docx', 'pdf'] as const) await expect(cf.make({ ...base, fileType: ft, filename: 'x', instructions: 'y' })).rejects.toThrow(GROQ_FILE_UNAVAILABLE);
  });

  it('png: a code_interpreter sub-call; the chart comes from executed_tools[].code_results[].png', async () => {
    const g = fakeGroq(() => ({ choices: [{ message: { content: 'done', executed_tools: [{ code_results: [{ text: 'ok' }, { png: PNG.toString('base64') }] }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const env = capEnv({ groq: g.client, provider: 'groq' });
    const cf = createGroqCodeFiles(env.s, createGroqCaller(env.s), () => 'openai/gpt-oss-20b');
    const f = await cf.make({ ...base, fileType: 'png', filename: 'chart', instructions: 'bar chart of 1,2,3' });
    expect(f).toMatchObject({ filename: 'chart.png', mime: 'image/png' });
    expect(Buffer.from(f.bytes).equals(PNG)).toBe(true);
    expect(g.calls[0]!.body).toMatchObject({ tools: [{ type: 'code_interpreter' }], model: 'openai/gpt-oss-20b' });
    expect(pngFromCompletion({ choices: [{ message: { executed_tools: [] } }] })).toBeNull();
    expect(env.llmCalls[0]!.purpose).toBe('make_file');
  });

  it('anthropic output file ids are found in nested code execution results', () => {
    expect(outputFileIds([{ type: 'bash_code_execution_tool_result', content: { type: 'bash_code_execution_result', content: [{ type: 'bash_code_execution_output', file_id: 'f1' }, { type: 'bash_code_execution_output', file_id: 'f1' }] } }] as never)).toEqual(['f1']);
  });
});
