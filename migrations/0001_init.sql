-- Boot Animation Studio community: initial schema.
--
-- Design rules (keep them):
--   * No triggers. All behaviour lives in the Worker code, where it is tested.
--   * Counters are recomputed from their source tables inside the same batch (no drift).
--   * Timestamps are Unix milliseconds. IDs are random base64url strings.

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  github_id         INTEGER NOT NULL UNIQUE,
  handle            TEXT NOT NULL UNIQUE,            -- GitHub login, lowercased
  display_name      TEXT NOT NULL DEFAULT '',
  bio               TEXT NOT NULL DEFAULT '',
  links             TEXT NOT NULL DEFAULT '[]',      -- JSON array of https URLs
  github_avatar_url TEXT NOT NULL DEFAULT '',
  avatar_media_id   TEXT,                            -- approved media only
  banner_media_id   TEXT,
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'owner')),
  trust             INTEGER NOT NULL DEFAULT 0,      -- 0 new, 1 established (auto-publish when clean)
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  github_created_at INTEGER NOT NULL DEFAULT 0,
  discord_id        TEXT UNIQUE,                     -- set by the owner for moderators
  followers_count   INTEGER NOT NULL DEFAULT 0,
  following_count   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,                     -- SHA-256 of the bearer token
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE oauth_states (
  state       TEXT PRIMARY KEY,
  return_to   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE auth_grants (
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE media (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('avatar', 'banner')),
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_media_owner ON media(owner_id, kind);

CREATE TABLE animations (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',          -- JSON array, also indexed in animation_tags
  license       TEXT NOT NULL,
  credits       TEXT NOT NULL DEFAULT '{}',          -- JSON: {manufacturer, original_author, detected_manufacturer}
  remix_of      TEXT REFERENCES animations(id) ON DELETE SET NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft', 'scanning', 'review', 'published', 'rejected', 'hidden', 'removed')),
  status_reason TEXT NOT NULL DEFAULT '',
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  has_preview   INTEGER NOT NULL DEFAULT 0,
  width         INTEGER NOT NULL DEFAULT 0,
  height        INTEGER NOT NULL DEFAULT 0,
  fps           INTEGER NOT NULL DEFAULT 0,
  frame_count   INTEGER NOT NULL DEFAULT 0,
  parts         INTEGER NOT NULL DEFAULT 0,
  has_audio     INTEGER NOT NULL DEFAULT 0,
  downloads     INTEGER NOT NULL DEFAULT 0,
  rating_sum    INTEGER NOT NULL DEFAULT 0,
  rating_count  INTEGER NOT NULL DEFAULT 0,
  score         REAL NOT NULL DEFAULT 0,             -- weighted (Bayesian) rating
  trending      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  published_at  INTEGER
);
-- One live copy of a file. Drafts and removed items don't block a re-upload.
CREATE UNIQUE INDEX idx_animations_sha ON animations(sha256) WHERE status NOT IN ('draft', 'removed');
CREATE INDEX idx_animations_owner ON animations(owner_id, created_at DESC);
CREATE INDEX idx_animations_new ON animations(status, published_at DESC, id DESC);
CREATE INDEX idx_animations_top ON animations(status, score DESC, id DESC);
CREATE INDEX idx_animations_trending ON animations(status, trending DESC, id DESC);
CREATE INDEX idx_animations_res ON animations(status, width, height);
CREATE INDEX idx_animations_remix ON animations(remix_of);

CREATE TABLE animation_tags (
  tag           TEXT NOT NULL,
  animation_id  TEXT NOT NULL REFERENCES animations(id) ON DELETE CASCADE,
  PRIMARY KEY (tag, animation_id)
);
CREATE INDEX idx_animation_tags_animation ON animation_tags(animation_id);

CREATE TABLE ratings (
  animation_id  TEXT NOT NULL REFERENCES animations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (animation_id, user_id)
);
CREATE INDEX idx_ratings_user ON ratings(user_id);

CREATE TABLE follows (
  follower_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id);

-- Download de-duplication: one count per viewer, animation and UTC day.
CREATE TABLE download_marks (
  animation_id  TEXT NOT NULL,
  day           INTEGER NOT NULL,
  viewer        TEXT NOT NULL,                       -- user id or salted hash of the IP
  PRIMARY KEY (animation_id, day, viewer)
);
CREATE TABLE animation_daily (
  animation_id  TEXT NOT NULL REFERENCES animations(id) ON DELETE CASCADE,
  day           INTEGER NOT NULL,
  downloads     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (animation_id, day)
);

CREATE TABLE reports (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL CHECK (target_type IN ('animation', 'user')),
  target_id     TEXT NOT NULL,
  reporter_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  category      TEXT NOT NULL,
  severity      INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_reports_once ON reports(case_id, reporter_id);
CREATE INDEX idx_reports_case ON reports(case_id);
CREATE INDEX idx_reports_reporter ON reports(reporter_id, created_at);

-- A case groups everything moderators need to decide about one target.
-- Panel tabs: mass (mass = 1), reports (report_count > 0), review (automatic checks / new uploaders).
CREATE TABLE cases (
  id            TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL CHECK (target_type IN ('animation', 'user', 'media')),
  target_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('review', 'automod', 'reports')),
  status        TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  report_count  INTEGER NOT NULL DEFAULT 0,
  max_severity  INTEGER NOT NULL DEFAULT 0,
  mass          INTEGER NOT NULL DEFAULT 0,
  auto_hidden   INTEGER NOT NULL DEFAULT 0,
  findings      TEXT NOT NULL DEFAULT '[]',          -- JSON from the automatic checks
  resolution    TEXT NOT NULL DEFAULT '',
  opened_at     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_cases_one_open ON cases(target_type, target_id) WHERE status = 'open';
CREATE INDEX idx_cases_queue ON cases(status, mass, report_count, max_severity DESC, updated_at DESC);

CREATE TABLE mod_actions (
  id            TEXT PRIMARY KEY,
  case_id       TEXT,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  actor_id      TEXT REFERENCES users(id) ON DELETE SET NULL,   -- NULL = automatic system action
  source        TEXT NOT NULL CHECK (source IN ('panel', 'discord', 'system')),
  action        TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_mod_actions_recent ON mod_actions(created_at DESC);
CREATE INDEX idx_mod_actions_case ON mod_actions(case_id);

CREATE TABLE discord_messages (
  case_id       TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL
);

CREATE TABLE pipeline_jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('animation', 'media', 'profile')),
  subject_id    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'running', 'done', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  result        TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_pipeline_status ON pipeline_jobs(status, updated_at);
CREATE INDEX idx_pipeline_subject ON pipeline_jobs(kind, subject_id);

CREATE TABLE rate_windows (
  key           TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('storage_used_bytes', '0'), ('uploads_paused', '0');
