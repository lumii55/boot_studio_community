-- Sign-in started from an allowed preview copy of the site (PREVIEW_SITE_URLS, e.g. the owner's phone at
-- http://localhost:8095/) returns there instead of SITE_URL. NULL = the public site.
ALTER TABLE oauth_states ADD COLUMN site_url TEXT;
