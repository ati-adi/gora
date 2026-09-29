# s07-gate (integration lead) log

## Step 0 — start (2026-09-29)
- No prior log. Tree at 3118466 + uncommitted BR/CAL/GR work.

## Step 1 — reproduce
- typecheck clean at start.
- review proofs (vitest.review.config): 18 failing / 3 passing (all non-live findings reproduced).
- live proofs (LIVE_BROWSER=1, chromium-1243 in cache): 8 failing (redirect x2, commit x4, keystroke beacon, WebRTC).
- Plan (browser): route.fetch(maxRedirects:0) per hop + policy re-check; POST-navigation backstop unless approved (contract: action o.approved);
  WebRTC/WebTransport off (flag + init script); chromiumSandbox + scrubbed env; data:/non-http refused in browser_open/open;
  press classified from real focus (aria active) + Space; href=#/javascript:/same-page links = buttons; search-verb exemption only without personal fields;
  COMMIT_RE +записа/registration; mission context w/o user_model/memories/location for browse missions; ownerText w/o profile summary;
  browser_open to a new host after pages were read asks; personal owner data to a non-owner host asks; sweep keeps a waiting context (card expiry 2h);
  superseded card screenshot; cancelled mapping; ToolCtx.approval instead of 'pa:' prefix.
- Plan (groups): shred group convs on /forget всё + 14-day epoch rotation/shred for reads-all groups; summary covered_from_at (migration 005) + drop when older than 14d;
  auto group facts 14-day TTL + forgotten by /forget всё; caps kept on forget; negation-aware words; generation DEK g:<chat>:<n>; catch-up newest 150;
  group edits; catch-up 1h default; addressed msgs not open questions.
- Plan (CAL): contract resumeConversationId; pending-link reuse + cap; bearer link = accepted risk (documented).

## Step 2 — cross-set requests applied
- contracts/integrations.ts sendConnectCard chat.resumeConversationId (ConnectChat private type removed; tools + test use the contract type).
- contracts/groups.ts GroupParticipation.recentContext (surface no longer duck-types; recording fake returns null).
- SURF.quota_browser added. webapp Me.addToGroupUrl + i18n add_to_group_title/subtitle (Home no cast, no inline text).
- tsc clean.

## Step 3 — browser fixes (in progress)
- src/browser/egress.ts (new): per-context HTTP/CONNECT egress proxy, policy.check per request/redirect hop, connects only to
  policy.connectAddress (vetted, pinned) → redirects + DNS rebinding + WebRTC/TURN closed; proxy auth per context.
- playwright.ts: proxy bypass '<-loopback>', WebRTC UDP off + RTCPeerConnection/WebTransport removed (init script),
  chromiumSandbox (BROWSER_SANDBOX, default on) + scrubbed env, POST backstop (204, 'needs_approval'), top-level policy check in open().
- detect/classify: COMMIT_RE +записа/запиш/запись/registration/enrol; scripted links (#, javascript:, same page) = buttons;
  search-verb exemption void when the form has identity fields; press Enter/Space from real focus (aria active) else page-level;
  browser_open to a new host after pages were read asks (renderDiff); owner personal data only on owner hosts.
- tools: ctx.approvedAction (contract; executor sets only on approval path; 'pa:'/'undo:' tool_use ids rejected);
  approval card TTL 2h; sweep keeps waiting contexts BROWSER_KEEP_WAITING_MS; Stop → 'cancelled'.
- context.ts: browse missions (browserTasks.forConversation, contract) carry no profile/user_model/memories/open/location.
- executor: superseded/revised cards send the screenshot too.
- live proofs 10/10 green (B-COMMIT-4 → POST variant + accepted GET variant; B-DATA-1 → pinned residual + mitigation);
  BR live example.com green through the proxy with sandbox on. BR unit 75/75, BR e2e 10/10.
- tests added: test/review/s07/leadBrowserFixes.test.ts (9: proxy, connectAddress, env, classification, browse-mission
  context has no memories [was failing before the 'starting' fix], 'pa:' tool_use id refused); approvalAttachment +1
  (superseded card photo); browser e2e quota asserts the rendered notice (no .catch).
## Step 4 — groups (next)
- groups done: negation-aware words; caps kept on forget; generation DEK g:<chat>:<n> + orphan purge (surfaces sweep calls
  purge('left')); catch-up newest-150 window (repo.catchupWindow) + 1h default; addressed msgs excluded from chime signals;
  migration 005 group_summaries.covered_from_at + expireSummary in sweep; purge('forget') shreds group convs
  (ConversationsRepo.listByChat, contract) + transcript rotation (half window) / closed-epoch shred for reads-all groups;
  auto facts: TTL 14d + any member may forget extractor facts + honest partial reply (SURF group_forget_all_partial);
  group edits (GroupParticipation.onEdited contract, handlers edited_message for groups).
  tests: test/review/s07/leadGroupFixes.test.ts (4); proofs groupForgetTranscript(b) flipped to assert 0 rows; unit module tests updated.
## Step 5 — CAL (pending links)
- CAL: MAX_PENDING_LINKS_PER_USER=3 (oldest pending expire + stop polling); test/review/s07/leadCalFixes.test.ts.
- slow e2e: business "window closed" + friend-first-contact "two days" get { timeout: 60_000 }.
## Step 6 — full gates
- gates: typecheck clean; npm test 226 files / 1245 passed (10 skipped = live-only); e2e strict 29 / 143; build:webapp ok; sim ok;
  review proofs 13 files / 35; live Chromium proofs 10/10 + BR live 1/1; check-schema on scratch DB (5 migrations, 122 objects) OK.
## Step 7 — README / .env.example
- README: spec precedence 07; sections "Browser agent", "Google Calendar and Gmail via Composio", "Gora in group chats";
  scripts (smoke:composio), env (spec 07 keys), BotFather item 5 (group privacy OFF), architecture (browser/, groups/, 004/005).
  .env.example: FEATURE_BROWSER, FEATURE_GROUP_PARTICIPANT, COMPOSIO_AUTH_CONFIG_*, BROWSER_* (+ BROWSER_SANDBOX), smoke:composio.
- 04 handbook §10: s07 gate contract deltas documented.
## Step 8 — DONE (nothing committed; the lead commits)
Final gates: typecheck clean · npm test 226 files, 1245 passed, 10 skipped (LIVE_BROWSER-only) · e2e strict 29/143 ·
build:webapp ok · sim ok · review proofs 13 files/35 · live Chromium 10/10 + BR live 1/1 · check-schema scratch DB OK.
Refuted / accepted (with tests pinning the behaviour): GET form navigations (B-COMMIT-4b), keystroke beacons on scripted
pages (B-DATA-1 residual, source removed), Composio bearer link (documented in README).
