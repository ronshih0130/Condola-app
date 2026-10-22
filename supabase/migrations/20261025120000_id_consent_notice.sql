-- Version 20261025120000.
-- The tenant ID consent row records which privacy notice was accepted.

ALTER TABLE identity_documents
  ADD COLUMN IF NOT EXISTS consent_notice_sha256 text;
