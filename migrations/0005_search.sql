-- Accent-free search text (filled by the Worker; NULL means "not computed yet", the cron fills those).
ALTER TABLE animations ADD COLUMN search_text TEXT;
ALTER TABLE users ADD COLUMN search_name TEXT;
