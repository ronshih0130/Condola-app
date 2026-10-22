-- Version 20261025140000.
-- A tenant photo is encrypted and stored here before the identity document row exists.
-- Finalize copies the ciphertext into id_document_objects in one transaction.
CREATE TABLE id_upload_slots (
  user_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  document_id uuid NOT NULL,
  slot text NOT NULL CHECK (slot IN ('front', 'back', 'selfie')),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  plain_size bigint NOT NULL CHECK (plain_size > 0 AND plain_size <= 819200),
  sha256 text NOT NULL,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lease_id, slot),
  CONSTRAINT id_upload_slots_ciphertext_cap CHECK (octet_length(ciphertext) > 0 AND octet_length(ciphertext) <= 819228)
);

ALTER TABLE id_upload_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON id_upload_slots FROM PUBLIC, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON id_upload_slots TO service_role;
