# friend-gate (integration lead) progress log

## Step 0 (2026-09-29): started
- Read spec 05, plan log, redteam + skeptic logs. 19 findings to handle + cross-set requests.
- Baseline: typecheck clean; npm test 14 failing (all test/review/friend proofs), 1057 passing.

## Step 1: fixes applied (in progress)
- kernel/sensitive.ts (new, shared looksSensitive, EN+RU health/fertility/mental/money/intimate stems, infix for therap/depress/fertil); compose.ts re-exports.
- proactive/signals.ts dates: sensitivity==='normal' && !looksSensitive (R1).
- behaviour: canSendNow hard stop (R3); retention keeps current gora_sent streak + sent first_hint rows (text dropped) (R2); lastInboundAt falls back to users.last_seen_at > created_at+60s (pre-003 users) (R13; UserRow.lastSeenAt optional); rhythm histogram stored in UTC bins (style_json.utc), read in current tz, legacy rows converted (R14); compose/judge: angle brackets neutralized inside <data>, draft in its own <draft> block (R7); deterministic veto of sensitive drafts + sensitive turns dropped (R8); assistant turns dropped from compose when the DM epoch is tainted (R10); first_hint for tz_source=default only within ±2h UTC of /start hour (R11).
- blocked: sentinel maps blocked→active, http auth allows blocked, my_chat_member member → status active (R15).
- forget: PrivacyHook.onForget (new, optional); behaviour scrubs proactive_log texts (fingerprints + topic overlap) and rotates the DM transcript; judge input also fingerprint-filtered (R4).
- profile: removals stored as token-HMAC signatures (never sent to LLM); card delete forgets supporting facts; forget carries removals/corrections via a tombstone version; TTL sweep scrubs card items the expired facts support (keep=1 version) (R5, R6, R9).
- why_now string removed (P request), freeze.test updated.
- R12: nudges record goraSent before the first await; reminders/fire.ts reports reminder_fire ('reminder') and checkin_fire ('checkin') for user-scope reminders.
- R16: surfaces/tz.ts citySaid (strong/weak), placeOk (PPL* + population ≥1000 strong / ≥15000 weak); weak only moves the guess (kv cache), strong confirms; GeoPlace gains featureCode/population (providers map Open-Meteo feature_code/population).
- R17: compact prompt line '"You messaged the owner first" = your own message' (699/700 est. tokens); prompt.test asserts both variants.
- Cross-set: NoticeService docs rewritten; LIMITS.memoryExtractDebounceMs removed; auth.test updated (blocked → 200).
- New regression file test/review/friend/gateFixes.test.ts (R10, R11, R12, R16): 6/6 green.
- nudges.e2e budget test: the 4th unrequested nudge after 4 unanswered is now 'dropped' (hard stop, R3); test writes an inbound first.
- scripts/sim.ts rewritten for the friend first contact (the M1–M9 onboarding sim tapped removed buttons).
- test/e2e/friend-day.e2e.test.ts (plan §6.3) written: /start → 5 msgs over 3 days → batched extract + ✍ → nightly card with open thread → Friday follow_up (1 msg) → reply reward 1 + event seen → about_me with /app/ link → forget → card rebuilt + proactive text scrubbed → scripted settings_update proactive off → no more sends.
- Found while writing it (own finding G1): the rhythm's weekday bins overfit sparse data (+ B's ">= weekly mean" filter) → a new owner had "active hours" only on weekdays they had written; Friday was all off_peak. Fix: behaviour/rhythm.ts rates() blends each bin 50/50 with the hour's weekly average (WEEKDAY_WEIGHT). All behaviour + B e2e tests still green.
- README (friend concept, how personalization works, dev-tunnel usage, env, architecture, rules) and .env.example (EMBEDDINGS_*, PROACTIVE_TAU) updated.
- scripts/check-schema.ts (new, read-only) for the deployment-risk finding: compares a gora.db schema with the migrations; verified on scratch DBs (match → 0; a 003 draft missing tz_hint_at → 1 with diff). NOT run against ./data (forbidden here) — owner action.
- No schema change needed by any fix (no 004).
- GATE (after all fixes): typecheck clean; npm test 1077/1077 (202 files, incl. test/review/**); test:e2e:strict 118/118 (26 files); build:webapp ok; sim ok (en + ru).
