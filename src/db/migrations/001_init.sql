-- 001_init.sql (WP0): 01 §7.1 DDL + 03 R7 additions. Tables are STRICT; *_enc = AES-256-GCM envelopes; *_hmac = keyed HMACs.
-- WP0 deltas vs 01 §7.1 are marked "-- WP0:".
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
CREATE TABLE kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;

-- ───────── identity, settings, consent
CREATE TABLE users (
  id TEXT PRIMARY KEY, tg_user_id INTEGER NOT NULL UNIQUE, dm_chat_id INTEGER,
  first_name_enc BLOB, username TEXT, language_code TEXT,
  tz TEXT NOT NULL DEFAULT 'UTC',
  tz_source TEXT NOT NULL DEFAULT 'default' CHECK (tz_source IN ('miniapp','location','city','manual','default')),
  persona_name TEXT NOT NULL DEFAULT 'Gora',
  persona_style TEXT NOT NULL DEFAULT 'friendly' CHECK (persona_style IN ('friendly','concise','professional','coach')),
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','plus','pro')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','blocked','deleting')),
  memory_consent INTEGER CHECK (memory_consent IN (0,1)),
  incognito_until INTEGER, memory_gen INTEGER NOT NULL DEFAULT 1,
  onboarding_step TEXT NOT NULL DEFAULT 'consent', ref_source TEXT,
  bot_blocked INTEGER NOT NULL DEFAULT 0,
  voice_replies INTEGER NOT NULL DEFAULT 0 CHECK (voice_replies IN (0,1)),   -- WP0: 03 R4/R7 (/voice on|off)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seen_at INTEGER
) STRICT;

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nudge_budget INTEGER NOT NULL DEFAULT 3, quiet_start TEXT NOT NULL DEFAULT '22:00', quiet_end TEXT NOT NULL DEFAULT '08:00',
  brief_time TEXT, inbox_checkins INTEGER NOT NULL DEFAULT 1, approval_expiry_min INTEGER NOT NULL DEFAULT 1440,
  show_transcripts INTEGER NOT NULL DEFAULT 1,
  home_city_enc BLOB,                     -- WP0: UserSettings.homeCity, sealed JSON {name,lat,lon} under 'u:<userId>'
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE consents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('terms','memory','business_llm','business_llm_new_chats','import','location','inbox_checkins')),
  subject TEXT, text_version TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('callback','miniapp','command','blanket')),
  granted_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE INDEX consents_lookup ON consents(user_id, kind, subject);

CREATE TABLE permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration TEXT NOT NULL CHECK (integration IN ('gmail','gcal')),
  level TEXT NOT NULL CHECK (level IN ('none','read','draft','act')),
  updated_via TEXT NOT NULL CHECK (updated_via IN ('miniapp','callback','system')),
  updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, integration)
) STRICT;

CREATE TABLE stepup_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hmac TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER) STRICT;
CREATE TABLE stepup_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, method TEXT NOT NULL CHECK (method IN ('biometric','phrase')), expires_at INTEGER NOT NULL, used_at INTEGER) STRICT;

-- ───────── Telegram infrastructure
CREATE TABLE tg_updates (
  update_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, lane TEXT NOT NULL, payload_enc BLOB,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','done','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, error TEXT, received_at INTEGER NOT NULL, done_at INTEGER
) STRICT;
CREATE INDEX tg_updates_status ON tg_updates(status, received_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, user_id TEXT,
  chat_id INTEGER NOT NULL, thread_id INTEGER, business_connection_id TEXT,
  method TEXT NOT NULL, payload_enc BLOB, priority INTEGER NOT NULL DEFAULT 5,
  disable_notification INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL, ref_kind TEXT, ref_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','dead','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_message_ids TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
) STRICT;
CREATE INDEX outbox_due ON outbox(status, not_before, priority);

CREATE TABLE tg_links (
  space TEXT NOT NULL DEFAULT 'bot',        -- 'bot' | 'biz:<connectionId>' (business chat ids are a separate namespace)
  chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  user_id TEXT, conversation_id TEXT, epoch INTEGER, seq INTEGER, run_id TEXT,
  pending_action_id TEXT, nudge_id TEXT, job_id TEXT, part INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('answer','card','nudge','status','reminder','brief','intro','file','venue','list','notice','onboarding','voice')),   -- WP0: + 'voice' (03 R4 voice replies)
  created_at INTEGER NOT NULL, PRIMARY KEY (space, chat_id, message_id)
) STRICT;
CREATE INDEX tg_links_run ON tg_links(run_id);

CREATE TABLE topics (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, thread_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inbox','today','mission','user')),
  base_name_enc BLOB NOT NULL, status_prefix TEXT NOT NULL DEFAULT '', icon_color INTEGER,
  is_name_implicit INTEGER NOT NULL DEFAULT 0, conversation_id TEXT, mission_id TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
) STRICT;
CREATE UNIQUE INDEX topics_fixed ON topics(user_id, kind) WHERE kind IN ('inbox','today');

-- ───────── Claude transcripts (append-only)
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('dm','topic','mission','group','guest','biz_draft')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  tg_chat_id INTEGER, thread_id INTEGER, business_connection_id TEXT,
  route TEXT NOT NULL CHECK (route IN ('chat','mission','group','guest','biz')),
  model TEXT NOT NULL, effort TEXT NOT NULL CHECK (effort IN ('low','medium','high')),
  toolset TEXT NOT NULL CHECK (toolset IN ('FULL','GROUP','GUEST','BIZ')),
  tools_hash TEXT NOT NULL, system_version TEXT NOT NULL, betas_json TEXT NOT NULL,
  context_mode TEXT NOT NULL DEFAULT 'system' CHECK (context_mode IN ('system','inline')),
  epoch INTEGER NOT NULL DEFAULT 1, rotate_pending TEXT, active_run_id TEXT,
  single_shot INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','purged')),
  created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL
) STRICT;
CREATE INDEX conversations_user ON conversations(user_id, status);

CREATE TABLE epochs (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, epoch INTEGER NOT NULL,
  dek_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('initial','idle','size','forget','upgrade','model_switch','context_exceeded','incognito_start','incognito_end','wipe','system_role_unsupported','user_new')),   -- WP0: + 'user_new' (plain /new)
  seed_kind TEXT NOT NULL DEFAULT 'none' CHECK (seed_kind IN ('none','handoff','deterministic')),
  handoff_summary_enc BLOB, handoff_made_at INTEGER, taint_json TEXT NOT NULL DEFAULT '[]',
  input_tokens_last INTEGER NOT NULL DEFAULT 0, last_request_at INTEGER, next_seq INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL, closed_at INTEGER, shredded_at INTEGER,
  PRIMARY KEY (conversation_id, epoch)
) STRICT;

CREATE TABLE shred_tokens (conversation_id TEXT NOT NULL, epoch INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, epoch)) STRICT;

CREATE TABLE messages (
  conversation_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  kind TEXT NOT NULL CHECK (kind IN ('user_input','event','seed','context','assistant','tool_results','synthetic')),
  content_enc BLOB NOT NULL,              -- exact BetaMessageParam JSON after the fallback echo; DEK = epoch DEK
  content_hmac TEXT NOT NULL, run_id TEXT, stop_reason TEXT,
  has_client_tool_use INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, epoch, seq),
  FOREIGN KEY (conversation_id, epoch) REFERENCES epochs(conversation_id, epoch)
) STRICT;
CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'append-only: messages'); END;
CREATE TRIGGER messages_delete_needs_shred BEFORE DELETE ON messages
  WHEN NOT EXISTS (SELECT 1 FROM shred_tokens s WHERE s.conversation_id = OLD.conversation_id AND s.epoch = OLD.epoch)
  BEGIN SELECT RAISE(ABORT, 'append-only: messages'); END;

CREATE TABLE blobs (id TEXT PRIMARY KEY, owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE, dek_id TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, bytes_enc BLOB NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE blob_refs (blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (blob_id, conversation_id, epoch)) STRICT;

CREATE TABLE conversation_inputs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tg_update_id INTEGER, tg_chat_id INTEGER, tg_message_id INTEGER, from_tg_user_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('text','voice','photo','document','forward','location','choice','command','event','guest','member')),
  author TEXT NOT NULL CHECK (author IN ('owner','member','peer','system')),
  content_enc BLOB NOT NULL,              -- BetaContentBlockParam[] JSON with '@blob:<id>' refs
  untrusted INTEGER NOT NULL DEFAULT 0, reply_to_card_id TEXT, created_at INTEGER NOT NULL,
  consumed_run_id TEXT, consumed_epoch INTEGER
) STRICT;
CREATE INDEX inputs_pending ON conversation_inputs(conversation_id, consumed_run_id, created_at);
-- WP0: ingest idempotency across update re-delivery (InputsRepo.add); one update may yield one trusted + one untrusted input.
CREATE UNIQUE INDEX inputs_update ON conversation_inputs(conversation_id, tg_update_id, untrusted) WHERE tg_update_id IS NOT NULL;
CREATE INDEX inputs_tg_message ON conversation_inputs(conversation_id, tg_chat_id, tg_message_id);   -- WP0: InputsRepo.byTgMessage (edits)

CREATE TABLE conv_events (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, text_enc BLOB NOT NULL, created_at INTEGER NOT NULL, delivered_run_id TEXT) STRICT;

-- ───────── runs, tools, LLM calls
CREATE TABLE runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT, epoch INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('user_input','event','wake','mission_start','guest','group','biz_draft','continue','resume')),
  trigger_ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','running','parked','retry_wait','done','refused','failed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'interactive' CHECK (priority IN ('interactive','approval','reminder','background','proactive')),   -- WP0: 03 R6
  phase TEXT NOT NULL DEFAULT 'start' CHECK (phase IN ('start','model','tools','finalize')),
  channel TEXT NOT NULL CHECK (channel IN ('dm_stream','notify','group','guest','biz_owner')),
  reply_ref_json TEXT NOT NULL, draft_id INTEGER, wake_at INTEGER, not_before INTEGER,
  turns INTEGER NOT NULL DEFAULT 0, continuations INTEGER NOT NULL DEFAULT 0, max_tokens INTEGER NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0, taint_json TEXT NOT NULL DEFAULT '[]', visible_text_enc BLOB,
  cost_micros INTEGER NOT NULL DEFAULT 0, stop_category TEXT, error TEXT, lease_until INTEGER,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
) STRICT;
CREATE INDEX runs_state ON runs(state, not_before);
CREATE INDEX runs_conv ON runs(conversation_id, state);
CREATE TABLE run_waits (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, token TEXT NOT NULL, PRIMARY KEY (run_id, token)) STRICT;
CREATE INDEX run_waits_token ON run_waits(token);

CREATE TABLE tool_calls (
  tool_use_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch INTEGER NOT NULL, user_id TEXT,
  assistant_seq INTEGER NOT NULL, ordinal INTEGER NOT NULL, name TEXT NOT NULL, action_class TEXT, risk INTEGER,
  input_enc BLOB NOT NULL, input_hmac TEXT NOT NULL,          -- epoch DEK
  decision TEXT CHECK (decision IN ('allow','deny','ask')), rule_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('staged','executing','done','error','denied','pending_approval','waiting','cancelled','unknown','executed_after_approval','declined_after_approval','expired')),
  pending_action_id TEXT, result_enc BLOB, is_error INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tool_calls_run ON tool_calls(run_id, assistant_seq, ordinal);

CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY, run_id TEXT, conversation_id TEXT, epoch INTEGER, user_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('main','handoff','side','make_file','search','vision','guard','sentinel','stt','tts')),  -- WP0: + Groq sub-calls (03 R6)
  request_hmac TEXT NOT NULL, model_requested TEXT NOT NULL, model_served TEXT,
  served_by_fallback INTEGER NOT NULL DEFAULT 0, stop_reason TEXT, refusal_category TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
  web_search_requests INTEGER NOT NULL DEFAULT 0, web_fetch_requests INTEGER NOT NULL DEFAULT 0,
  iterations_json TEXT, cost_micros INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, ttft_ms INTEGER,
  request_id TEXT, error_class TEXT, raw_enc BLOB, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX llm_calls_run ON llm_calls(run_id);
CREATE TABLE run_memory_uses (run_id TEXT NOT NULL, fact_id TEXT NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY (run_id, fact_id)) STRICT;
CREATE INDEX run_memory_uses_fact ON run_memory_uses(fact_id);

-- ───────── trust
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,                    -- 6-char Crockford base32
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT, run_id TEXT, tool_use_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1, supersedes_id TEXT,
  tool_name TEXT NOT NULL, action_class TEXT NOT NULL, risk INTEGER NOT NULL,
  targets_enc BLOB NOT NULL, target_hmacs_json TEXT NOT NULL,
  input_enc BLOB NOT NULL, input_hmac TEXT NOT NULL, diff_enc BLOB NOT NULL, diff_hmac TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]', grantable INTEGER NOT NULL DEFAULT 0, ladder_offer INTEGER NOT NULL DEFAULT 0,
  source_refs_json TEXT NOT NULL DEFAULT '[]',   -- e.g. ["bizmsg:<conn>:<chat>:<msgId>"]
  status TEXT NOT NULL CHECK (status IN ('pending','approved','executing','executed','denied','expired','superseded','voided','failed','unknown')),
  scope_chosen TEXT CHECK (scope_chosen IN ('once','24h','always')),
  card_chat_id INTEGER, card_thread_id INTEGER, card_message_id INTEGER,
  expires_at INTEGER NOT NULL, decided_at INTEGER, decided_by_tg_id INTEGER,
  decided_via TEXT CHECK (decided_via IN ('callback','miniapp','system')),
  result_enc BLOB, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX pending_actions_user ON pending_actions(user_id, status);
CREATE INDEX pending_actions_exp ON pending_actions(status, expires_at);

CREATE TABLE grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL, target_hmac TEXT NOT NULL, target_enc BLOB NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('24h','always')), expires_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0, created_from_action_id TEXT, stepup_grant_id TEXT,
  revoked_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX grants_lookup ON grants(user_id, tool_name, target_hmac);

CREATE TABLE trusted_targets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_hmac TEXT NOT NULL, target_enc BLOB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user_message','memory','approved_action','miniapp','business_chat')),
  source_ref TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, target_hmac)
) STRICT;

CREATE TABLE undo_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, payload_enc BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available','undone','expired','failed')),
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sentinel_decisions (
  id TEXT PRIMARY KEY, user_id TEXT, run_id TEXT, tool_use_id TEXT, pending_action_id TEXT,
  tool_name TEXT NOT NULL, action_class TEXT NOT NULL, risk INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny','ask')), rule_id TEXT NOT NULL,
  reason TEXT NOT NULL,                   -- generic text, never contains content or recipients
  tainted INTEGER NOT NULL, grant_id TEXT, phase TEXT NOT NULL CHECK (phase IN ('propose','execute')), created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER sd_no_update BEFORE UPDATE ON sentinel_decisions BEGIN SELECT RAISE(ABORT, 'append-only: sentinel_decisions'); END;
CREATE TRIGGER sd_delete_guard BEFORE DELETE ON sentinel_decisions
  WHEN NOT EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id AND u.status = 'deleting')
   AND OLD.created_at >= (CAST(strftime('%s','now') AS INTEGER) - 31536000) * 1000
  BEGIN SELECT RAISE(ABORT, 'append-only: sentinel_decisions'); END;

CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent','user','sentinel','system','scheduler')),
  kind TEXT NOT NULL, summary_enc BLOB NOT NULL, detail_enc BLOB,
  run_id TEXT, tool_use_id TEXT, pending_action_id TEXT, source_ref TEXT,
  prev_hmac TEXT NOT NULL, row_hmac TEXT NOT NULL,   -- per-user chain, keyed HMAC
  UNIQUE (user_id, seq)
) STRICT;
CREATE INDEX ledger_user_ts ON ledger(user_id, ts);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'append-only: ledger'); END;
CREATE TRIGGER ledger_delete_guard BEFORE DELETE ON ledger
  WHEN NOT EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.user_id AND u.status = 'deleting')
   AND OLD.ts >= (CAST(strftime('%s','now') AS INTEGER) - 31536000) * 1000
  BEGIN SELECT RAISE(ABORT, 'append-only: ledger'); END;

-- ───────── memory
CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,                    -- 'm' + 6 base36
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,   -- owner (user scope) or author (group scope)
  scope TEXT NOT NULL,                    -- 'user:<userId>' | 'grp:<chatId>'
  kind TEXT NOT NULL CHECK (kind IN ('profile','preference','person','relationship','goal','routine','date','fact','group_decision')),
  text_enc BLOB, subject_enc BLOB, quote_enc BLOB, dek_gen INTEGER NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal','sensitive')), confidence REAL NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active','pending_confirm','forgotten','superseded')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user_message','import','miniapp','tool_explicit','group_explicit')),
  source_conversation_id TEXT, source_input_id TEXT, source_tg_message_id INTEGER,
  created_by TEXT NOT NULL CHECK (created_by IN ('user','extractor','model_tool','import')),
  supersedes_id TEXT, use_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, forgotten_at INTEGER
) STRICT;
CREATE INDEX memory_scope ON memory_facts(scope, status);
CREATE TABLE memory_fingerprints (scope TEXT NOT NULL, fp_hmac TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (scope, fp_hmac)) STRICT;
CREATE TABLE extraction_watermarks (conversation_id TEXT PRIMARY KEY, last_input_created_at INTEGER NOT NULL, last_run_at INTEGER NOT NULL) STRICT;

-- ───────── reminders, to-dos, missions, watchers, jobs
CREATE TABLE reminders (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reminder','checkin','followup')), text_enc BLOB NOT NULL,
  target_chat_id INTEGER NOT NULL, target_thread_id INTEGER,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once','cron')), fire_at INTEGER, cron TEXT, tz TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','fired','done','snoozed','paused','cancelled')),
  job_id TEXT, source_tool_use_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX reminders_scope ON reminders(scope, status);
CREATE TABLE todos (id TEXT PRIMARY KEY, scope TEXT NOT NULL, author_user_id TEXT, text_enc BLOB NOT NULL, done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, created_at INTEGER NOT NULL, done_at INTEGER) STRICT;
CREATE INDEX todos_scope ON todos(scope, done, position);
CREATE TABLE todo_messages (scope TEXT NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, message_id)) STRICT;

CREATE TABLE missions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL,
  title_enc BLOB NOT NULL, goal_enc BLOB NOT NULL, criteria_enc BLOB NOT NULL, checklist_enc BLOB,
  status TEXT NOT NULL CHECK (status IN ('active','parked','done','failed','cancelled','budget_exhausted')),
  thread_id INTEGER, status_message_id INTEGER, budget_micros INTEGER NOT NULL, spent_micros INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER, taint_json TEXT NOT NULL DEFAULT '[]', last_report_at INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE TABLE watchers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, mission_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('page','inbox')), target_enc BLOB NOT NULL, condition_enc BLOB NOT NULL,
  interval_min INTEGER NOT NULL, next_check_at INTEGER NOT NULL, last_hash TEXT, last_value_enc BLOB,
  last_checked_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active','paused','done','cancelled')),
  thread_id INTEGER, job_id TEXT, created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, ref_id TEXT, run_at INTEGER NOT NULL, cron TEXT, tz TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',   -- ids and enums only
  status TEXT NOT NULL CHECK (status IN ('scheduled','leased','done','failed','dead','cancelled')),
  priority INTEGER NOT NULL DEFAULT 5, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT, dedupe_key TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX jobs_due ON jobs(status, run_at, priority);

-- ───────── proactivity
CREATE TABLE nudges (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL, ref_id TEXT, why_enc BLOB NOT NULL, body_enc BLOB NOT NULL, score REAL NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low','normal','high')), counts_against_budget INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate','sent','deferred','dropped')), defer_until INTEGER,
  local_day TEXT, sent_at INTEGER, tg_chat_id INTEGER, tg_message_id INTEGER,
  outcome TEXT CHECK (outcome IN ('do','snooze','never','ignored','reaction_up','reaction_down')), outcome_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX nudges_day ON nudges(user_id, local_day, status);
CREATE INDEX nudges_dedupe ON nudges(user_id, dedupe_key, sent_at);
CREATE TABLE nudge_prefs (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, snooze_until INTEGER, weight REAL NOT NULL DEFAULT 1.0, ignored_streak INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, kind)) STRICT;
CREATE TABLE commitments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('dm','business')), business_connection_id TEXT, chat_id INTEGER,
  source_message_id INTEGER, source_input_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('i_owe','they_owe')), text_enc BLOB NOT NULL, counterpart_enc BLOB, due_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open','nudged','done','dismissed')), job_id TEXT, created_at INTEGER NOT NULL
) STRICT;

-- ───────── integrations & location
CREATE TABLE connections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration TEXT NOT NULL CHECK (integration IN ('gmail','gcal')), provider TEXT NOT NULL CHECK (provider IN ('fake','composio')),
  account_ref_enc BLOB, status TEXT NOT NULL CHECK (status IN ('pending','active','error','revoked')),
  connected_at INTEGER, last_used_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL, UNIQUE (user_id, integration)
) STRICT;
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, integration TEXT NOT NULL, return_chat_id INTEGER NOT NULL, return_thread_id INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER) STRICT;
CREATE TABLE anthropic_files (file_id TEXT PRIMARY KEY, user_id TEXT, purpose TEXT NOT NULL CHECK (purpose IN ('code_input','code_output')), created_at INTEGER NOT NULL, deleted_at INTEGER) STRICT;
CREATE TABLE location_state (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, lat_enc BLOB NOT NULL, lon_enc BLOB NOT NULL, accuracy_m REAL, live_until INTEGER, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;

-- ───────── business (Chat Automation)
CREATE TABLE business_connections (
  id TEXT PRIMARY KEY,                    -- Telegram business_connection_id
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tg_user_id INTEGER NOT NULL, user_chat_id INTEGER NOT NULL,
  rights_json TEXT NOT NULL,              -- raw BusinessBotRights (API field names; grammY types differ, see Appendix A)
  is_enabled INTEGER NOT NULL, ai_default TEXT NOT NULL DEFAULT 'off' CHECK (ai_default IN ('off','new_chats')),
  connected_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, disconnected_at INTEGER
) STRICT;
CREATE TABLE business_chats (
  connection_id TEXT NOT NULL REFERENCES business_connections(id) ON DELETE CASCADE, chat_id INTEGER NOT NULL,
  peer_user_id INTEGER, title_enc BLOB, ai_enabled INTEGER NOT NULL DEFAULT 0, consent_id TEXT,
  mode TEXT NOT NULL DEFAULT 'triage' CHECK (mode IN ('triage','draft')), tone_notes_enc BLOB,
  first_seen_at INTEGER NOT NULL, last_incoming_at INTEGER, last_owner_at INTEGER, unanswered_since INTEGER,
  window_expires_at INTEGER, last_triage_at INTEGER, priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, chat_id)
) STRICT;
CREATE TABLE business_messages (           -- rows exist ONLY for AI-enabled (consented) chats
  connection_id TEXT NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  from_owner INTEGER NOT NULL, via_bot INTEGER NOT NULL DEFAULT 0, date INTEGER NOT NULL,
  text_enc BLOB NOT NULL, media_kind TEXT, edited_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, chat_id, message_id),
  FOREIGN KEY (connection_id, chat_id) REFERENCES business_chats(connection_id, chat_id) ON DELETE CASCADE
) STRICT;

-- WP0: biz_draft conversation ↔ the business messages it included (§10.1 deleted_business_messages → shred those drafts). WP7-owned.
CREATE TABLE business_drafts (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL, chat_id INTEGER NOT NULL,
  message_ids_json TEXT NOT NULL,         -- JSON array of business message_ids included in the drafting transcript
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX business_drafts_chat ON business_drafts(connection_id, chat_id);

-- ───────── groups, guest, deep links, choices
CREATE TABLE groups (
  chat_id INTEGER PRIMARY KEY, title_enc BLOB, type TEXT NOT NULL,
  bot_status TEXT NOT NULL CHECK (bot_status IN ('member','administrator','left','kicked')),
  added_by_tg_id INTEGER, intro_message_id INTEGER, memory_gen INTEGER NOT NULL DEFAULT 1,
  last_private_hint_day TEXT, created_at INTEGER NOT NULL, left_at INTEGER
) STRICT;
CREATE TABLE guest_invocations (
  guest_query_id TEXT PRIMARY KEY, caller_tg_id INTEGER NOT NULL, chat_ref_hmac TEXT NOT NULL, inline_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('received','placeholder','answered','edited','failed','rate_limited')), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE deeplink_tokens (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('guest','me','export')), owner_tg_id INTEGER NOT NULL,
  payload_enc BLOB, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
) STRICT;
CREATE TABLE choice_sets (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, conversation_id TEXT NOT NULL, options_enc BLOB NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER) STRICT;

-- ───────── billing, usage, limits, privacy ops
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, plan TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','canceled','failed','expired')), invoice_payload TEXT NOT NULL,
  telegram_payment_charge_id TEXT NOT NULL, is_recurring INTEGER NOT NULL, period_end INTEGER NOT NULL, grace_until INTEGER, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE payments (                    -- no FK so the row survives pseudonymization
  telegram_payment_charge_id TEXT PRIMARY KEY, user_ref TEXT NOT NULL, invoice_payload TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XTR', total_amount INTEGER NOT NULL, is_recurring INTEGER NOT NULL DEFAULT 0,
  is_first_recurring INTEGER NOT NULL DEFAULT 0, subscription_expiration_date INTEGER, refunded_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,   -- owner-local date
  turns INTEGER NOT NULL DEFAULT 0, web_searches INTEGER NOT NULL DEFAULT 0, stt_seconds INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0, guest_answers INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
  nudges_sent INTEGER NOT NULL DEFAULT 0, refusals INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day)
) STRICT;
CREATE TABLE rate_buckets (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL) STRICT;
CREATE TABLE deletion_requests (
  id TEXT PRIMARY KEY, user_ref TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('account','conversation','memory_all')),
  target_ref TEXT, status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
  requested_at INTEGER NOT NULL, completed_at INTEGER, error TEXT
) STRICT;

-- ───────── 03 R7 additions (WP0 DDL; repos owned by WP3)
-- use_toolkit (03 R3): toolkits loaded into a conversation; expires after the given user-turn counter value.
CREATE TABLE conversation_toolkits (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  toolkit TEXT NOT NULL CHECK (toolkit IN ('web','calendar','email','missions','secretary','files','account')),
  expires_after_turn INTEGER NOT NULL, loaded_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, toolkit)
) STRICT;

-- WP0: per-conversation user-turn counter for toolkit expiry (03 R3 "loaded in the last 6 user turns"); WP3-owned.
CREATE TABLE conversation_turns (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_turns INTEGER NOT NULL DEFAULT 0
) STRICT;

-- RateGovernor daily counters (03 R6), per model per UTC day.
CREATE TABLE llm_rate_daily (
  model TEXT NOT NULL, day_utc TEXT NOT NULL,             -- 'YYYY-MM-DD'
  requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
  rpd_limit INTEGER, reset_at INTEGER, updated_at INTEGER NOT NULL,   -- WP0: + rpd_limit/reset_at/updated_at (header-observed limits)
  PRIMARY KEY (model, day_utc)
) STRICT;
-- kv keys reserved by 03 R7: 'vision:<sha256>', 'pdf:<sha256>', 'guard:<sha256>' (kv table above).

INSERT INTO schema_migrations(version, applied_at) VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
