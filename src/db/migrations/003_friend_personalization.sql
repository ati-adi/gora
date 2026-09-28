-- 003 (spec 05 §D): friend mode and per-user personalization. Additive only: a live gora.db already exists, so 001/002
-- are never edited and no existing table is rebuilt. Every new table joins USER_DATA_TABLES (contracts/storage.ts).

-- ───────── users / settings
-- C5: proactive level set by words through settings_update ('off' never writes first; less ×1.5 τ; more ×0.7 τ).
ALTER TABLE users ADD COLUMN proactive_level TEXT NOT NULL DEFAULT 'normal' CHECK (proactive_level IN ('off','less','normal','more'));
-- A6: when the lazy "🕒 Set my time zone" button was last attached (at most once per 7 days while tz_source='default').
ALTER TABLE users ADD COLUMN tz_hint_at INTEGER;
-- C5 / B1: explicit style overrides {length?, emoji?, register?} (JSON of enums only; never message text).
ALTER TABLE user_settings ADD COLUMN style_json TEXT;

-- ───────── memory (B1, B3): importance 0–1 and an optional TTL for short-lived mood/context facts.
ALTER TABLE memory_facts ADD COLUMN importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1);
ALTER TABLE memory_facts ADD COLUMN expires_at INTEGER;
CREATE INDEX IF NOT EXISTS memory_expiry ON memory_facts(expires_at) WHERE expires_at IS NOT NULL;

-- B4: the profile card, one sealed row per version (latest = current). Sealed under the scope's memory DEK generation
-- ('m:<userId>:<dek_gen>', AAD 'user_profile|profile_enc|<userId>:<version>'), so a forget rotation shreds old versions.
CREATE TABLE user_profile (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  profile_enc BLOB NOT NULL,
  dek_gen INTEGER NOT NULL,
  fact_count INTEGER NOT NULL DEFAULT 0,          -- active facts when consolidated (the "after 15 new facts" trigger)
  reason TEXT NOT NULL DEFAULT 'nightly' CHECK (reason IN ('nightly','facts','forget','edit','manual')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, version)
) STRICT;

-- B2: one local embedding per fact (Float32 LE bytes, sealed like the fact text under 'm:<userId>:<dek_gen>' or
-- 'mg:<chatId>:<dek_gen>', AAD 'fact_embeddings|vec_enc|<fact_id>'). Derived data, still personal.
CREATE TABLE fact_embeddings (
  fact_id TEXT PRIMARY KEY REFERENCES memory_facts(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  dek_gen INTEGER NOT NULL,
  vec_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX fact_embeddings_scope ON fact_embeddings(scope, model);

-- ───────── behaviour (C1–C4)
-- C1: append-only signals (90-day retention). Features only: enums and numbers, never message text.
CREATE TABLE user_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inbound','gora_sent','reply','reaction','feedback','blocked','unblocked')),
  at INTEGER NOT NULL,
  local_hour INTEGER CHECK (local_hour IS NULL OR (local_hour >= 0 AND local_hour <= 23)),
  local_weekday INTEGER CHECK (local_weekday IS NULL OR (local_weekday >= 0 AND local_weekday <= 6)),
  length INTEGER, emoji INTEGER, lang TEXT, question INTEGER CHECK (question IS NULL OR question IN (0,1)),
  register TEXT CHECK (register IS NULL OR register IN ('informal','formal')),
  source TEXT,                                    -- gora_sent: 'proactive'|'nudge'|'brief'|'reminder'|…
  arm TEXT,                                       -- gora_sent/reply: '<content_type>|<gap_bucket>'
  ref_id TEXT,                                    -- proactive_log.id / nudge id
  latency_ms INTEGER,                             -- reply: ms since the Gora-initiated message
  value TEXT                                      -- reaction emoji / feedback enum
) STRICT;
CREATE INDEX user_signals_user ON user_signals(user_id, kind, at);
CREATE INDEX user_signals_at ON user_signals(at);

-- C2/C3: per-user rhythm histogram (7×24 Float64 LE, decayed) and style EMAs (JSON of numbers).
CREATE TABLE user_rhythm (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hist_blob BLOB NOT NULL,
  style_json TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

-- C4: Beta posteriors per (user, arm); arm = 'type:<content_type>' | 'gap:<gap_bucket>'.
CREATE TABLE proactive_arms (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  arm TEXT NOT NULL,
  alpha REAL NOT NULL,
  beta REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, arm)
) STRICT;

-- C4: every decision that reached composition (sent or vetoed). judge_reason sealed under 'u:<userId>'
-- (AAD 'proactive_log|judge_reason_enc|<id>'); reward is set once (1 replied ≤ 24 h, 0 otherwise).
CREATE TABLE proactive_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  arm TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('follow_up','useful','checkin','first_hint')),
  gap_bucket TEXT NOT NULL,
  score REAL NOT NULL,
  sent INTEGER NOT NULL CHECK (sent IN (0,1)),
  judge_reason_enc BLOB,
  tg_chat_id INTEGER, tg_message_id INTEGER,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  replied_at INTEGER,
  reward INTEGER CHECK (reward IS NULL OR reward IN (0,1))
) STRICT;
CREATE INDEX proactive_log_user ON proactive_log(user_id, created_at);
