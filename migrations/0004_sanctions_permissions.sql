-- Punishments, per-moderator permissions, internal notes, and richer notifications.

-- Moderator permissions (JSON list of action names). The owner implicitly has all of them.
ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]';
-- While a suspension runs the person cannot sign in or use the Community.
ALTER TABLE users ADD COLUMN suspended_until INTEGER;

CREATE TABLE sanctions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('warning', 'restrict', 'suspend', 'ban')),
  restrictions  TEXT NOT NULL DEFAULT '[]',        -- for 'restrict': upload, report, rate, profile
  hide_uploads  INTEGER NOT NULL DEFAULT 0,        -- for 'suspend'
  reason        TEXT NOT NULL DEFAULT '',
  actor_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  ends_at       INTEGER,                           -- NULL = permanent (or not applicable, for a warning)
  revoked_at    INTEGER,
  revoked_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  closed_at     INTEGER                            -- set when an expired suspension has been undone by the cron
);
CREATE INDEX idx_sanctions_user ON sanctions(user_id, created_at DESC);
CREATE INDEX idx_sanctions_active ON sanctions(kind, ends_at) WHERE revoked_at IS NULL;

CREATE TABLE mod_notes (
  id            TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL CHECK (target_type IN ('user', 'case')),
  target_id     TEXT NOT NULL,
  author_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_mod_notes_target ON mod_notes(target_type, target_id, created_at DESC);

-- Notifications gain two kinds (a punishment, and its end) and a small JSON payload. SQLite cannot change a CHECK
-- constraint in place, so the table is rebuilt with its rows.
CREATE TABLE notifications_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('follow', 'published', 'refused', 'remix', 'sanction', 'sanction_end')),
  actor_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  animation_id  TEXT REFERENCES animations(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL DEFAULT '',
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);
INSERT INTO notifications_new (id, user_id, kind, actor_id, animation_id, reason, created_at, read_at)
  SELECT id, user_id, kind, actor_id, animation_id, reason, created_at, read_at FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at);
