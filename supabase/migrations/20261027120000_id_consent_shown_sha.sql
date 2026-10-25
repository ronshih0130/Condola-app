-- Version 20261027120000.
-- The sha256 of the full notice and of the upload-page text the tenant was shown.
-- Nullable text, no default and no constraint, so a Worker that does not name
-- these columns still inserts and updates. Existing rows are not rewritten.
-- 20261026160000_id_consent_display_sha.sql is the same ALTER. This file still
-- adds the columns when that filename was skipped.

ALTER TABLE identity_documents
  ADD COLUMN IF NOT EXISTS consent_full_text_sha256 text;

ALTER TABLE identity_documents
  ADD COLUMN IF NOT EXISTS consent_upload_text_sha256 text;
