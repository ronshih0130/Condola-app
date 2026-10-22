-- Version 20261029140000.
-- The upload stores the consent notice version (sha256 of the notice text
-- shown) and the time the tenant consented. Both columns are nullable.
-- Existing rows stay null. No default and no constraint.

ALTER TABLE identity_documents
  ADD COLUMN IF NOT EXISTS consent_notice_sha text;

ALTER TABLE identity_documents
  ADD COLUMN IF NOT EXISTS consented_at timestamptz;
