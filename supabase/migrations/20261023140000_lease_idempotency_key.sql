-- One client-generated key per lease create attempt.
-- Version 20261023140000, after 20261023090000_lease_deposit_override_check.sql.
--
-- A retry of 「建立租約並送出簽署」 sends the same UUID. The partial unique
-- index makes a second insert fail instead of creating another lease.
-- Existing rows and seeds leave the column null, and nulls are not unique.

ALTER TABLE leases ADD COLUMN idempotency_key text;

COMMENT ON COLUMN leases.idempotency_key IS
  'Client UUID for one create attempt. A second insert with the same org and key is rejected.';

CREATE UNIQUE INDEX leases_org_idempotency_key_uidx
  ON leases (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
