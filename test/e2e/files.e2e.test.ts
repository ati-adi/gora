// 01 §15.2 WP5 files e2e: make_file → sendDocument with a sanitized filename; Files API deletes for inputs and outputs.
import { afterEach, describe, expect, it } from 'vitest';
import type { BetaContentBlock, ReplyChannel, UserRow } from '../../src/contracts/index.ts';
import { createTestApp, type TestApp } from '../harness/testApp.ts';
import { turn } from '../harness/scriptedTransport.ts';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

function addUser(app: TestApp): UserRow {
  const u = app.s.repos.users.upsertFromTelegram({ id: 1001, first_name: 'Aigerim', language_code: 'en' }, { dmChatId: 1001 });
  app.s.repos.users.update(u.id, { tz: 'Asia/Almaty', tzSource: 'manual', onboardingStep: 'done', memoryConsent: true });
  app.s.repos.users.grantConsent({ userId: u.id, kind: 'terms', textVersion: 'v1', via: 'command' });
  return app.s.repos.users.getById(u.id)!;
}
const dm = (u: UserRow) => t.s.conversations.resolve({ kind: 'dm', tgUserId: u.tgUserId }, { userId: u.id, tgChatId: u.dmChatId! });

/** A create() turn whose code execution produced one output file. */
function codeTurn(fileId: string) {
  const b = turn().text('Created the file.').build();
  b.blocks.push({
    type: 'bash_code_execution_tool_result', tool_use_id: 'srvtoolu_1',
    content: { type: 'bash_code_execution_result', stdout: '', stderr: '', return_code: 0, content: [{ type: 'bash_code_execution_output', file_id: fileId }] },
  } as unknown as BetaContentBlock);
  return b;
}
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('files e2e', () => {
  it('make_file → sendDocument with a sanitized filename; the output is deleted from the Files API', async () => {
    t = await createTestApp();
    addUser(t);
    t.llm.files.outputs.set('file_out_1', { bytes: new Uint8Array([0x50, 0x4b, 3, 4]), filename: '/mnt/outputs/../report.xlsx', mime: XLSX });
    t.llm.push(turn().toolUse('make_file', { file_type: 'xlsx', filename: '../../etc/Budget<2026>?.xlsx', instructions: 'A budget table: rent 200000, food 90000.' }, 'toolu_mf1'));
    t.llm.push(codeTurn('file_out_1'));
    t.llm.push(turn().text('Here is your budget.'));
    await t.userSends('make me a budget spreadsheet');
    await t.settle();
    const docs = t.tg.byMethod('sendDocument');
    expect(docs).toHaveLength(1);
    const doc = docs[0] as { document?: { filename?: string } | string; chat_id?: number };
    const name = typeof doc.document === 'object' ? doc.document?.filename : JSON.stringify(doc);
    expect(name).toBe('report.xlsx');
    expect(t.llm.createRequests).toHaveLength(1);
    const req = t.llm.createRequests[0] as unknown as { tools: Array<{ type: string }>; system: string };
    expect(req.tools).toEqual([{ type: 'code_execution_20260120', name: 'code_execution' }]); // no web tools
    expect(req.system).toContain('Budget2026.xlsx');
    expect([...t.llm.files.deleted]).toEqual(['file_out_1']);
    expect(t.llm.callOpts.find((c) => c.kind === 'create')?.opts?.priority).toBe('interactive');
  });

  it('attachments are uploaded as container inputs; inputs and outputs are all deleted at once', async () => {
    t = await createTestApp();
    const u = addUser(t);
    const conv = dm(u);
    const blob = t.s.repos.messages.putBlob({ ownerUserId: u.id, dek: `u:${u.id}`, mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
    const inputId = t.s.repos.inputs.add({
      conversationId: conv.id, kind: 'photo', author: 'owner', untrusted: false,
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `@blob:${blob}` } }],
      tgUpdateId: null, tgChatId: 1001, tgMessageId: 9, fromTgUserId: 1001, replyToCardId: null,
    });
    t.llm.files.outputs.set('file_out_2', { bytes: new TextEncoder().encode('a,b\n1,2\n'), filename: 'table.csv', mime: 'text/csv' });
    t.llm.push(codeTurn('file_out_2'));
    const run = t.s.repos.runs.create({ conversationId: conv.id, userId: u.id, epoch: conv.epoch, trigger: 'user_input', triggerRef: null, channel: 'dm_stream', replyRef: { chatId: 1001, triggerMessageId: 3 }, maxTokens: 1000 });
    const r = await t.s.executor.processRound(run, conv, 1, [{ type: 'tool_use', id: 'toolu_mf2', name: 'make_file', input: { file_type: 'csv', filename: 'table', instructions: 'Transcribe the table in the photo.', attachment_input_ids: [inputId] } }], null as unknown as ReplyChannel, new AbortController().signal);
    expect(String(r.results[0]!.content)).toContain('table.csv');
    const uploaded = [...t.llm.files.uploaded.keys()];
    expect(uploaded).toHaveLength(1);
    const content = (t.llm.createRequests[0] as unknown as { messages: Array<{ content: Array<{ type: string; file_id?: string }> }> }).messages[0]!.content;
    expect(content[0]).toEqual({ type: 'container_upload', file_id: uploaded[0] });
    expect([...t.llm.files.deleted].sort()).toEqual([uploaded[0]!, 'file_out_2'].sort());
    const effects = (r as unknown as { effects?: Array<{ kind: string; filename?: string }> }).effects ?? [];
    expect(effects.some((e) => e.kind === 'document' && e.filename === 'table.csv')).toBe(true);
  });
});
