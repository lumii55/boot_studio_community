-- Featured animations, chosen by the team, shown in the "Featured" filter of Explore.
ALTER TABLE animations ADD COLUMN featured_at INTEGER;
CREATE INDEX idx_animations_featured ON animations(status, featured_at DESC, id DESC) WHERE featured_at IS NOT NULL;
