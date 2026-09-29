# s07-plan (planner + foundation) progress log

- [step 0] Started. Read spec 07 and 04 handbook.
- [step 1a] Playwright verified. playwright@1.63.0 (latest, exact) added to dependencies; `npx playwright install chromium`
  → default cache ~/Library/Caches/ms-playwright (chromium-1243 = Chrome for Testing 153.0.8010.12, chromium_headless_shell-1243).
  Probe in scratchpad/pw: launch 132 ms, goto example.com 200 in ~570 ms, page.ariaSnapshot({mode:'ai'}) (YAML with [ref=eN])
  and page.ariaSnapshotJSON({mode:'ai', boxes:true}) (nodes {role,name,ref,box,text,url,cursor,children}); action by
  page.locator('aria-ref=eN'); refs stable across snapshots; stale ref → timeout (use short action timeout);
  context.route('**/*') intercepts document+subresources, route.abort('blockedbyclient') → net::ERR_BLOCKED_BY_CLIENT;
  page.screenshot({type:'jpeg',quality:70}) 17.9 KB. GOTCHA: password field VALUES appear in clear in the aria snapshot and
  input type/autocomplete are not exposed → builder must mask via a DOM pass (input.type, autocomplete cc-*). 10 snapshots 7 ms.
- [step 1b] Composio verified from docs.composio.dev (raw .md: /toolkits/googlecalendar.md, /toolkits/gmail.md, /docs/authentication/manually-authenticating.md,
  /examples/harness-integration.md) + @composio/core 0.21.0 / @composio/client 2.0.0-rc.8 typings (REST v3.1 paths). Toolkit
  versions: googlecalendar 20260915_00 (50 tools), gmail 20260915_00 (62 tools). Key facts: POST /api/v3.1/connected_accounts/link
  {auth_config_id,user_id,callback_url} → 201 {link_token, redirect_url, expires_at, connected_account_id}; GET
  /api/v3.1/connected_accounts/{id} → {id,user_id,status: INITIALIZING|INITIATED|ACTIVE|FAILED|EXPIRED|INACTIVE|REVOKED,toolkit{slug},auth_config{id,is_composio_managed}};
  POST /api/v3.1/tools/execute/{slug} {connected_account_id,user_id,arguments,version?} → {data,error,successful,log_id}; omitted
  version = latest on v3.1. RSVP = GOOGLECALENDAR_PATCH_EVENT rsvp_response. Mismatch list in 08 §CAL.
- [step 2a] Foundation in progress: contracts (browser.ts, groups.ts new; tools/capabilities/services/scheduler/billing/ledger/llm/agent/
  integrations/storage extended), migration 004, config keys, stubs src/browser/{capability,tools,index}.ts + src/groups/{index,tools}.ts,
  missions onFinished → s.missionHooks, app.ts wiring, test/harness/fakeBrowser.ts. NOTE: spec 07 gained §B5 (lead-verified live facts:
  ak_ key on /api/v3, auth config ac_kB4OafdmH77M, find-or-create by name gora-<toolkit>); plan follows it.
- [step 2b] (resumed) typecheck clean; added importRules: playwright-runtime-import (only src/browser/playwright.ts), s07 table ownership (browser_tasks→src/browser/, integration_links→integrations, group_*→src/groups/), s07 modules in layout check.
- [step 2c] conversation_toolkits rebuilt in 004 (CHECK gains 'browser'); tests updated: contracts (catalog+BR/GR owners, 32 job kinds), migrations (004 on populated 003, GROUP_DATA_TABLES), testApp (factories, v4), registry wire guard 1185→1192. npm test 1080 green.
- [step 2d] e2e: privacy seeder maps from_tg_id; e2e 118 green, typecheck clean.
- [step 3a] Re-derived Composio mismatch facts from saved docs (scratchpad/composio/*.md) + @composio/core 0.21.0 d.mts: v3 omitting version → pinned 00000000_00 (!), v3.1 → latest; plan pins version 20260915_00 explicitly. Now surveying code for the 08 plan.
- [step 2e] contract ToolSpec.approvalAttachment (screenshot beside the approval card; executor edit belongs to BR). Decided: group auto-facts = memory source 'user_message', explicit false, created_by extractor, scope grp (GR edits memory/store.ts gate).
- [step 1a'] Playwright probe re-run OK (launch 127 ms, goto 200 @462 ms, ariaSnapshotJSON, route abort → ERR_BLOCKED_BY_CLIENT, jpeg 17.9 KB, closed @625 ms). Contract: SideCalls.structured purpose → StructuredPurpose (+5 group purposes).
- [step 2f] preloads: calendar words → 'calendar' even unconnected (+integration_connect in calendar kit); browse words → 'browser'. 004: browser_tasks.current_url_enc.
- [step 3b] Code survey done (integrations/service.ts, composio*.ts, surfaces/group.ts+handlers.ts, missions, trust executor/approvalCards, memory gate, side.structured, toolkits). Writing docs/spec/08-s07-plan.md.
- [step 3c] docs/spec/08-s07-plan.md written (§0 rules, §1 foundation+Playwright facts, §2 interface map, §3 BR, §4 CAL incl. 16 Composio mismatches + slug table, §5 GR, §6 integration, §7 decisions).
- [step 3d] package.json: smoke:composio script added. All gates green: typecheck, 1080 unit, 118 e2e. DONE.
