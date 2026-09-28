# WP5 progress log
- [start] Read 04 handbook. Next: read contracts (tools, capabilities, integrations, services, llm), 01 §4 §6 §2 §11.5, 03 R3 R4 R5 R8.
- [plan] Read 04, contracts, 01 §4/§6/F3/F4/F9/§11.5/§15.2, 02, 03, research groq/capabilities, reference oggopus/websearch, Composio REST types (node_modules/@composio/client). Decisions:
  * Composio via REST v3.1 + fetchImpl (no SDK; avoids global fetch + `.execute(` rule). Slugs in composioMap.ts; unmapped -> "not supported by provider".
  * Groq caps (search/vision/tts/guard/sentinel/stt) in capabilities/groq/*, resolve s.groq lazily; no client -> unavailable (guard/sentinel null, others throw).
  * Sentinel policy: from check input `policy` field (CONTRACT REQUEST) or factory option; none -> null (fail closed).
  * No plaintext kv caching of vision/pdf content (privacy); guard scores cached in kv 'guard:<sha>'.
  * Registry: explicit toolset lists (toolsets.ts), toolkits.ts, serverTools.ts (anthropic only), use_toolkit only in toolkits mode.
  Order: tools/{schema,toolsets,toolkits,serverTools,registry,index} -> tools/impl/* -> capabilities/* -> integrations/* -> tests.
- [restart 1] Context lost; schema/toolsets/toolkits.ts exist (done). Re-reading contracts/specs. Next: registry/serverTools/index, impl/*, capabilities, integrations, tests.
- [restart 2] Context lost again; re-reading contracts. schema/toolsets/toolkits exist.
- [restart 3] Context lost again. Strategy: write files quickly, log after each file.
- [restart 4] Context lost again. Reading 04 + contracts compactly, then writing registry/index immediately.
## NOTES (for restarts; avoid re-reading big docs)
- Contracts read: tools.ts, capabilities.ts, integrations.ts, services.ts, llm.ts (ProviderProfile.provider/toolMode; CallMeta; Priority; RateGovernor.acquire/observe; GroqRole), agent.ts ToolkitState.load(convId,kit)->{expiresAfterTurn}.
- 01 §6 catalog = lines 1324-1386 of 01. 03 R3/R4/R5 = 03 lines 80-162. 04 handbook: §7 importRules (no fetch(, no Date.now/new Date(), timers via clock, no `.execute(`/.undo( outside executor, groq-sdk runtime import only in capabilities/groq/, SQL tables I own: connections, oauth_states, anthropic_files, location_state). Job I own: first_look. Callback I own: cn.
- Fakes: test/harness/fakes.ts createFakeCapabilities, createStaticRegistry, createFakeIntegrations, createMemoryToolkitState, createPassThroughExecutor; createTestApp({integrations?, factories?, env:{LLM_PROVIDER:'groq'}}).
- s.caps === s.capabilities; s.location; s.toolkits (WP3); s.choices (WP7) for offer_choices.
- [done] src/tools/serverTools.ts (BLOCKED_DOMAINS, isBlockedDomain, serverToolDefinitions(profile,toolset,{webFetchUrlSources})). Next: registry.ts + index.ts
- [done] registry.ts (buildToolRegistry), index.ts (createToolRegistry + wp5Tools; imports impl/{calendar:CALENDAR_TOOLS,gmail:GMAIL_TOOLS,fx:fxTool,connect:connectTool,ledger:ledgerTool,location:locationTool,makeFile:makeFileTool(profile),choices:choicesTool,react:reactTool,settings:settingsTool,place:placeTool,time:timeTool,useToolkit:useToolkitTool,weather:weatherTool,web:webSearchTool/webFetchTool}). Next: impl files (simple ones first: time, fx, react, choices, location, useToolkit).
- notes: permissions via s.repos.users.permissions(uid)/setPermission(uid,int,level,via). DDL connections(id,user_id,integration,provider,account_ref_enc,status pending|active|error|revoked,connected_at,last_used_at,revoked_at,created_at, UNIQUE(user_id,integration)); oauth_states(state,user_id,integration,return_chat_id,return_thread_id,created_at,expires_at,used_at); location_state(user_id,lat_enc,lon_enc,accuracy_m,live_until,updated_at,expires_at); anthropic_files(file_id,user_id,purpose code_input|code_output,created_at,deleted_at). Registry takes optional 3rd arg {webFetchUrlSources} -> CONTRACT REQUEST for app.ts. Foundation testApp.test.ts:137 expects registry.all()==[] -> will break (report).
- [done] impl/common.ts, time.ts, fx.ts, react.ts, location.ts, choices.ts, useToolkit.ts. Next: place, weather, settings, ledger, connect, web, makeFile, calendar, gmail
- [done] weather.ts, place.ts
- [done] settings.ts
- [done] ledger.ts
- [done] connect.ts, web.ts (precheckUrl, formatSearchResult). Next: makeFile, calendar, gmail
- [done] makeFile.ts. Next: calendar.ts, gmail.ts
- design: calendar classify is sync -> in-memory event memo (impl/calMemo.ts) filled by list/create/update/renderDiff; unknown event -> send_external/act (conservative). targets returned with hmac:'' provenance:'unknown' (WP4 provenance.ts recomputes). Executor wraps output & writes data_read ledger.
- [done] calMemo.ts, calendar.ts (freeSlots exported). Next: gmail.ts
- [done] gmail.ts. ALL tools written. Next: capabilities (safeFetch, weather, fx, geo, location, stt, pdfText, oggopus, groq/*, codeFiles(.groq), media, index)
- [done] capabilities/safeFetch.ts (isBlockedAddress, validateUrl, guardedLookup, createSafeFetch w/ injectable resolve/request)
- [done] capabilities/providers.ts (weather openmeteo+metno, fx erapi, geo openmeteo+photon+tzlookup, getJson)
- [done] capabilities/location.ts (+locationPrivacyHook)
- [done] capabilities/groq/common.ts (createGroqCaller: governor acquire/observe, recordLlmCall, quotas.recordUsage, mapGroqError). Next: groq/search,vision,guard,sentinel,tts,stt; oggopus; pdfText; codeFiles(+groq); media; index
- [done] groq/search.ts, vision.ts, guard.ts, sentinel.ts (policy injected; none -> null)
- [done] capabilities/oggopus.ts (parseWav, makeWav, concatWavs, pcmToOggOpus, wavToOggOpus, oggCrc32)
- [done] groq/tts.ts (splitForTts), groq/stt.ts (normalizeAudioFilename,isNoSpeech)
- [done] pdfText.ts, stt.ts (none/placeholder/openai). Next: codeFiles.ts (anthropic), codeFiles.groq.ts, media.ts, index.ts
- [done] codeFiles.groq.ts
- [done] codeFiles.ts (anthropic; anthropic_files tracking + privacy hook). Next: media.ts, capabilities/index.ts
- [done] media.ts (createMediaIngest, audioUploadName, formatDuration). Next: capabilities/index.ts
- [done] capabilities/demo.ts, capabilities/index.ts (opts.sentinelPolicy -> CONTRACT REQUEST). Next: integrations (fake provider, composio+composioMap, service w/ oauth_states/connections, cn callback, first_look job, connect card, devConnect, privacy hook)
- integrations plan: files src/integrations/{fakeFixtures.ts,fake.ts,repo.ts,service.ts,composioMap.ts,composio.ts,index.ts}. Service: startConnect->oauth_states(15min)+provider.connectLink(userId,kind,`${publicUrl}/oauth/callback?state=`); oauthCallback->completeConnection->connections upsert (account_ref_enc sealed u:<uid>, AAD connections|account_ref_enc|<id>), setPermission default 'draft' via system if none, ledger 'connection', DM "Connected ✓"+chips cn:<kind>:<level> (codec.encode('cn',[kind,level],tgUserId)), schedule first_look {kind} dedupe first_look:<uid>:<kind> runAt+5s; first_look job posts "I read: …" then s.runner.startEventRun(conv dm via s.conversations.resolve({kind:'dm',tgUserId}), {type:'first_look',body,untrusted}, {channel:'notify', replyRef:{chatId}, taint:['email'|'calendar'], priority:'interactive'}). devConnect only env!=production && provider.name==='fake'. Composio REST v3.1: base https://backend.composio.dev, header x-api-key; POST /api/v3.1/connected_accounts/link {auth_config_id,user_id,callback_url}->{redirect_url,connected_account_id}; auth_configs GET ?toolkit_slug=; POST /api/v3.1/tools/execute/{slug} {connected_account_id,user_id,arguments}->{data,error,successful}; DELETE /api/v3.1/connected_accounts/{id}.
- [done] integrations/fakeFixtures.ts, fake.ts (FakeIntegrationProvider{now}). Next: service.ts, composioMap.ts, composio.ts, index.ts
- [done] integrations/service.ts (createIntegrationServiceImpl; first_look job, cn callback, privacy hook, context providers capabilities+location). Next: composioMap.ts, composio.ts, index.ts, then TESTS
- [done] composioMap.ts, composio.ts, integrations/index.ts (fetchImpl opt -> CONTRACT REQUEST). NEXT: TESTS: test/unit/tools/*, test/unit/capabilities/*, test/e2e/{integrations,files}.e2e.test.ts; then importRules + foundation tests
- [done] test/unit/tools/registry.test.ts green (17). NOTE gap: whole core kit w/ real WP6a specs ~1.5k est tokens (WP6a tools ~1047 alone) > 1100 -> report. Next: timeResolve/gmail/calendar tests
- [done] env.ts, timeResolve.test.ts (5). Next: calendar.test.ts, gmail.test.ts, tools.test.ts (utilities)
- [done] calendar.test.ts (7), gmail.test.ts (5). Next: tools.test.ts utilities
- [done] tools.test.ts (15). All test/unit/tools green. Next: capabilities tests (safeFetch, stt, media, oggopus, groq caps, location, providers/demo)
- [done] safeFetch.test.ts (5) — found+fixed v4 mask sign bug & EBLOCKED code. Next: capabilities/env.ts + stt/media/groq/oggopus/location tests
- [done] capabilities/env.ts, stt.test.ts (5), media.test.ts (6). Next: groq.test.ts, oggopus.test.ts, providers.test.ts, location.test.ts, codeFiles.test.ts
- [done] groq.test.ts (8), oggopus.test.ts (2), providers.test.ts (6 incl. location). All unit capabilities green (32). Next: e2e files + integrations
- e2e plan: drive executor directly via t.s.executor.processRound(run, conv, 1, [tool_use], null, signal) like test/e2e/reminders.e2e.test.ts; conv via t.s.conversations.resolve. Writing test/e2e/integrations.e2e.test.ts
- [done] test/e2e/integrations.e2e.test.ts (2) green. Next: test/e2e/files.e2e.test.ts
- [done] test/e2e/files.e2e.test.ts (2) green (test attaches tg.channels: integration gap WP3/app.ts). Next: gates: typecheck, importRules/foundation, full vitest of my paths
- gates: typecheck clean for my paths; my 13 files/85 tests green. Checking importRules + whole unit suite for regressions caused by WP5
- [done] pdfText.test.ts (1), codeFiles.test.ts (3). FINAL: typecheck clean; 15 files / 89 tests green; whole unit suite only foundation failures (1 WP5-expected registry.all()==[]), e2e 21/21 green. Writing final answer.
