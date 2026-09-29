# s07-CAL (Composio fix-up + connect UX) progress log

- [step 0] Started. Read spec 07, plan 08 (§0, §1, §4). Surveying integrations code.
- [step 1] Survey done. Design: REST v3 auth_configs / v3.1 accounts+execute, HMAC user id, links.ts repo+poller, service finish() shared by callback+poll, resume via GoraEvent integration_connected; sendConnectCard dedupes (2 min) + resolves resume conv from chat (executor path) or a private chat.resumeConversationId (tools path).
- [step 2] composioMap.ts, composio.ts, links.ts (new), service.ts, fake.ts, index.ts, calendar.ts, connect.ts edited; harness test/harness/s07-cal.ts; composioBinding review test updated. Running suites.
- [step 3] e2e calendar-connect (5) + integrations e2e updated; unit composio.test.ts (20) green. Next: links.test.ts (poller, deadline, race, failed, retry, privacy, composio via service).
- [step 4] unit links.test.ts (7) green; typecheck clean in CAL files. Running full suites.
- [step 5] scripts/smoke-composio.ts (exit 2 without LIVE=1; verified). /api/connections exposes `pending` per integration; webapp Connections shows "ожидаю подключения…". Unit connectUx.test.ts (5). Integration unit total 32.
- CONTRACT REQUEST: `IntegrationService.sendConnectCard(userId, kind, chat, reason?)` — add `resumeConversationId?: string` to `chat` (CAL uses a private `ConnectChat` type exported from src/integrations/service.ts meanwhile; calendar.ts/connect.ts pass it). Optionally `startConnect(..., ret)` the same.
- [step 6] finish(): the poll job is cancelled only on the callback path. Gates: typecheck clean in all CAL files (remaining tsc errors are in BR/GR in-progress files), unit 1112/1112, e2e 123/123. DONE.
