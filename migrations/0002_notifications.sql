-- Notifications: things that happened to you (someone followed you, your upload was approved or refused,
-- someone published a remix of your animation). Old ones are removed after 60 days by the cron.
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('follow', 'published', 'refused', 'remix')),
  actor_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  animation_id  TEXT REFERENCES animations(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  read_at       INTEGER
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at);
