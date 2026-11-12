-- Custom licenses: a name and an https link chosen by the uploader, plus whether remixes are allowed.
ALTER TABLE animations ADD COLUMN license_name TEXT;
ALTER TABLE animations ADD COLUMN license_url TEXT;
ALTER TABLE animations ADD COLUMN license_remix INTEGER;
