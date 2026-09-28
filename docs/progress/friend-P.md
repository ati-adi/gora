# friend-P (persona, first contact, minimal UI) progress log

## Step 0: started 2026-09-29
- Read spec 05 fully and 06 §0-§3. Owned files per 06 §3.
- Baseline (before P edits): npm test 976/976, e2e 101/101.

## Step 1: design decisions (P)
- Best-guess tz lives in a new src/surfaces/tz.ts, applied on inbound DM (dm.ts) while tz_source='default' (users.tz updated, source stays 'default'): 1) last shared location → tzForPoint, 2) settings.homeCity (→ tzForPoint) or a city named in the profile card / profile facts (marker regex "live in X / живу в X" → geocode, rate-limited 6 h), 3) language default table. Tools then run on user.tz.
- Explicit city in a message ("I'm in X", "я в X", "живу в X") or a location share confirms tz silently (source city/location). Never intercepts the message (it still reaches the model). Only the city NAME is geocoded (never the message).
- Executor: S09 removed; after a successful reminder_create/reminder_manage/gcal write while tz_source='default', push ONE web_app button effect when tzHintAt null or > 7 d, then set tzHintAt.
- reminders/tools.ts: besides the ⏰ reaction, the TZ_UNCONFIRMED early error must go (A6: the tool succeeds on the best guess). Nobody else owns the file; noted as deviation.
- 'ob' callback: stays registered; everything answers "expired" except the /settings memory toggle (ob:mem:y|n:s).

## Step 2: core code DONE (not yet tested)
- users.ts INSERT onboarding_step='done'; onboarding.ts rewritten (first contact, /start one line, ob→expired except /settings memory toggle, tz: callbacks, lazy tz hint NoticeService, import await); new surfaces/tz.ts (best guess + silent city confirm); location.ts (👌 reaction, silent confirm, travel proposal); context.ts (no onboarding part); index.ts (no RunHook); dm.ts (firstContact + tz refresh); commands.ts (/memory friendly + web_app, /settings memoryState/proactive/style); why.ts (pl_ → proactivePolicy.explain); telegram/commands.ts (menu memory+settings, descriptions en/ru in hash); strings (+new keys; STRING_KEYS tz_hint_button); rules.ts (S08 via memoryEnabled in sentinel, S09 removed); executor (tz hint effect; tz_unconfirmed branch removed); settings tool (proactive/style/memory + feedback); reminders tool (🫡 reaction, TZ_UNCONFIRMED removed); engine footerLines (approvals only); agent/context.ts (memoryState, writes_first=); prompts rewritten (compact 697 est. tokens).
- Deviation: reminder ack emoji is 🫡, not ⏰ (⏰ is not a Telegram-allowed reaction → REACTION_INVALID).

## Step 3: HTTP + webapp + test updates
- http: GET /api/memory adds profile + memory state; PATCH /api/memory/profile (before /memory/:id); /api/me adds memory, proactiveLevel; /api/settings GET/PATCH proactiveLevel + style (+ feedback signal); tz POST no longer checks onboarding step. MEMORY_TEXT_VERSION desc-v1.
- webapp: Memory.tsx profile card (correct/delete), memory toggle = consent !== false; Settings.tsx "Gora and you" (name, writing first, reply length/emoji/tone with Auto); TzDetect closes after 1.2 s; i18n keys en+ru; me.ts fields.
- Tests updated (spec 05 changed behaviour): removed test/e2e/onboarding.e2e.test.ts (M1–M9 gone; replaced by friend-first-contact); dropped the ob:mem:y consent-tap setup line in flows/albumMerge/chatImportQuota/fallbackMissionReply/forwardedLocation/meTitleTaint/guest e2e; rewrote review proofs bizChatReplay, nameHijack, startBriefSpam, locationSwallowed; prompt.test.ts (markers, ≤700); requestBuilder wire fixture dm-basic.json system text; sentinel S09 cases → allow; reminders unit + e2e tz_unconfirmed cases → succeed on the guess.
- NOT mine: registry.test "core toolkit ≤ 1,100 tokens" fails at 1123 because M's memory_search about_me field (src/memory/tools.ts) grew it (settings_update is not in core).

## Step 4: new tests
- test/e2e/friend-first-contact.e2e.test.ts (7): /start en/ru one line no markup + no reset; first contact (3 msgs, reminder, 2 days) → only the lazy tz web_app button (+Undo), 🫡 reaction, consent desc-v1 once; lazy tz 1×/7 d and never after confirm; "I live in Almaty" silent confirm; settings words (proactive off → feedback stop; memory off + style short; Undo); no 🕶 / free-left footers.
- test/unit/surfaces/friend.test.ts (11): tz helpers, best-guess order, location silent confirm/travel proposal, menu+descriptions defs, syncCommands once per hash, consent once/declined never, legacy ob buttons expired, /memory, /settings + toggle, NoticeService hint.
- test/unit/trust/rules.friend.test.ts (3): S08 via memoryEnabled; S09 gone + executor tz hint effect; no hint for other/failed tools.
- test/unit/agent/context.test.ts (+2), prompt.test.ts (rewritten), why.e2e (+1 pl_), miniapp.e2e (+2 profile card / settings), webhook.e2e (menu memory+settings, descriptions once per hash).
- typecheck clean (server + webapp).

## FINAL (2026-09-29)
- typecheck clean (tsc server + webapp); npm test 1056/1056; test:e2e:strict 117/117 (includes the parallel M/B work present at run time).
- handlers.ts ownerOf → ob.firstContact for private commands (a command can be the first message).
- CROSS-SET REQUESTS / notes: see final report (tests outside P's list updated because spec 05 changed the behaviour; reminders/tools.ts TZ_UNCONFIRMED removal; STRING_KEYS tz_hint_button; why_now kept for B; M's about_me wording is in both prompts).
