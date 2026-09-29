-- 004 (spec 07 §D): browser agent, Google Calendar via Composio (link polling), Gora as a group participant.
-- Additive only: a live gora.db exists, so 001–003 are never edited and no existing table is rebuilt.
-- user-keyed tables join USER_DATA_TABLES; group-keyed tables join GROUP_DATA_TABLES (contracts/storage.ts).

-- ───────── use_toolkit (03 R3) gains the 'browser' toolkit (A2). SQLite cannot alter a CHECK, so this small derived
-- table (no triggers, nothing references it) is rebuilt in place; rows are kept.
CREATE TABLE conversation_toolkits_004 (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  toolkit TEXT NOT NULL CHECK (toolkit IN ('web','calendar','email','missions','secretary','files','account','browser')),
  expires_after_turn INTEGER NOT NULL, loaded_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, toolkit)
) STRICT;
INSERT INTO conversation_toolkits_004(conversation_id, toolkit, expires_after_turn, loaded_at)
  SELECT conversation_id, toolkit, expires_after_turn, loaded_at FROM conversation_toolkits;
DROP TABLE conversation_toolkits;
ALTER TABLE conversation_toolkits_004 RENAME TO conversation_toolkits;

-- ───────── quota (A4): browser tasks started per local day (QuotaKind 'browser')
ALTER TABLE usage_daily ADD COLUMN browser_tasks INTEGER NOT NULL DEFAULT 0;

-- ───────── browser tasks (A2/A4, src/browser/). A task always runs as a mission (missions.id), one per user at a time.
-- Personal text is sealed under 'u:<userId>' with AAD 'browser_tasks|<column>|<id>'. current_host is a bare host name
-- (status card, ledger), never a path or query.
CREATE TABLE browser_tasks (
  id TEXT PRIMARY KEY,                                      -- 'bt' + ULID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id TEXT,                                          -- the mission running it (null only while 'starting')
  conversation_id TEXT,                                     -- the mission conversation
  status TEXT NOT NULL CHECK (status IN ('starting','running','parked','done','failed','cancelled','interrupted')),
  park_reason TEXT CHECK (park_reason IS NULL OR park_reason IN ('login','payment','time_limit','step_limit','approval','captcha','user')),
  goal_enc BLOB NOT NULL,
  start_url_enc BLOB,
  constraints_enc BLOB,
  current_host TEXT,
  current_url_enc BLOB,                                     -- last main-frame URL: crash recovery reopens a fresh context here
  steps INTEGER NOT NULL DEFAULT 0,                         -- model tool steps inside the mission (≤ 40)
  popups INTEGER NOT NULL DEFAULT 0,
  blocked_requests INTEGER NOT NULL DEFAULT 0,
  last_show_step INTEGER,                                   -- step of the last browser_show / vision describe (≤ 1 per 5 steps)
  result_url_enc BLOB,
  summary_enc BLOB,
  started_at INTEGER,
  deadline_at INTEGER,                                      -- started_at + 15 min wall clock (then park, offering to continue)
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX browser_tasks_user ON browser_tasks(user_id, status);
CREATE UNIQUE INDEX browser_tasks_mission ON browser_tasks(mission_id) WHERE mission_id IS NOT NULL;
-- A4: at most one concurrent browser task per user.
CREATE UNIQUE INDEX browser_tasks_one_active ON browser_tasks(user_id) WHERE status IN ('starting','running','parked');

-- ───────── Composio connect links (B1, src/integrations/). Polled every 5 s for 10 min after issue because the tunnel
-- URL can change and the OAuth callback may never arrive. `state` is the oauth_states row the link was issued for, so a
-- poll hit and a callback claim the same row exactly once. pending_ref_enc: the provider's pending connected-account id,
-- sealed under 'u:<userId>' (AAD 'integration_links|pending_ref_enc|<id>').
CREATE TABLE integration_links (
  id TEXT PRIMARY KEY,                                      -- 'il' + ULID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration TEXT NOT NULL CHECK (integration IN ('gmail','gcal')),
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  pending_ref_enc BLOB,
  status TEXT NOT NULL CHECK (status IN ('pending','active','failed','expired')),
  return_chat_id INTEGER NOT NULL,
  return_thread_id INTEGER,
  resume_conversation_id TEXT,                              -- B2: the conversation whose question resumes after "Готово ✓"
  next_poll_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  polls INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,                                          -- an error class ('http_5xx', 'timeout', …), never a payload
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;
CREATE INDEX integration_links_due ON integration_links(status, next_poll_at);
CREATE INDEX integration_links_user ON integration_links(user_id, integration, status);
CREATE UNIQUE INDEX integration_links_state ON integration_links(state);

-- ───────── groups (§C, src/groups/). Everything personal is sealed under the group DEK 'g:<chatId>' (owner
-- 'grp:<chatId>': destroyOwner covers it), AAD '<table>|<column>|<chatId>:<key>'.
-- C3: every group message the bot can read (privacy mode OFF), 14-day rolling retention; deleted on '/forget all', on
-- the bot-left purge (7-day grace) and, per member, on that member's /deletemydata (from_tg_id).
CREATE TABLE group_messages (
  chat_id INTEGER NOT NULL,
  tg_message_id INTEGER NOT NULL,
  thread_id INTEGER,
  from_tg_id INTEGER NOT NULL,                              -- the bot's own id for kind 'bot'
  sender_hmac TEXT NOT NULL,                                -- crypto.hmac('member', '<chatId>:<tgId>'): per-group pseudonym
  kind TEXT NOT NULL CHECK (kind IN ('text','caption','voice','bot')),
  addressed TEXT CHECK (addressed IS NULL OR addressed IN ('mention','reply','name','command')),
  reply_to_tg_message_id INTEGER,
  text_enc BLOB NOT NULL,
  sender_name_enc BLOB,
  chime_kind TEXT,                                          -- kind 'bot' only: the chime-in kind, null for an addressed reply
  at INTEGER NOT NULL,                                      -- Telegram message date (ms)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, tg_message_id)
) STRICT;
CREATE INDEX group_messages_chat_at ON group_messages(chat_id, at);
CREATE INDEX group_messages_from ON group_messages(from_tg_id, chat_id, at);
CREATE INDEX group_messages_created ON group_messages(created_at);

-- C3: the rolling group summary (fast model, batched every 40 messages or after 10 idle minutes); one current row per
-- chat. facts_until_at is the automatic group-fact extraction watermark.
CREATE TABLE group_summaries (
  chat_id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  summary_enc BLOB NOT NULL,
  covered_until_at INTEGER NOT NULL,
  pending_count INTEGER NOT NULL DEFAULT 0,                 -- messages stored since the last summary (the 40 trigger)
  facts_until_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

-- C4: per-group chime-in policy. arms_json holds numbers only ({"answer":[α,β],…}); caps counters; the one open
-- reward window (a chime-in awaiting a reaction or reply for 10 min).
CREATE TABLE group_policy (
  chat_id INTEGER PRIMARY KEY,
  chattiness TEXT NOT NULL DEFAULT 'normal' CHECK (chattiness IN ('quiet','less','normal','more')),
  threshold_adj REAL NOT NULL DEFAULT 0,                    -- learned offset added to the chattiness threshold
  arms_json TEXT NOT NULL DEFAULT '{}',
  reads_all INTEGER CHECK (reads_all IS NULL OR reads_all IN (0,1)),
  tz TEXT,
  lang TEXT,
  last_activity_at INTEGER,
  last_chime_at INTEGER,
  chimes_day TEXT,                                          -- local day (group tz) the counter belongs to
  chimes_today INTEGER NOT NULL DEFAULT 0,
  open_chime_tg_message_id INTEGER,
  open_chime_kind TEXT,
  open_chime_at INTEGER,
  join_line_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
