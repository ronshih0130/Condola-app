-- Version 20261026160000.
-- New consents record the sha256 of the full text and the upload-page text
-- the tenant was shown. Existing rows are not rewritten.

ALTER TABLE identity_documents
  ADD COLUMN IF NOT EXISTS consent_full_text_sha256 text;

ALTER TABLE identity_documents
  ADD COLUMN IF NOT EXISTS consent_upload_text_sha256 text;
