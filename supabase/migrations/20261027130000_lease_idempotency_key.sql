-- Version 20261027130000, after 20261026120000_email_log.sql
-- and after 20261023180000.
--
-- One client UUID per lease create attempt. A retry of 「建立租約並送出簽署」
-- sends the same key and gets the first lease back instead of a second row.
--
-- Additive only. Staging is one database shared by every PR preview, and
-- older Workers still insert into leases without this column.
-- The column is nullable. There is no NOT NULL, no default that older code
-- must send, and no new CHECK or foreign key. Existing INSERT statements
-- leave the column null. Null keys stay out of the partial unique index,
-- so older rows and older Workers do not collide.

ALTER TABLE leases ADD COLUMN IF NOT EXISTS idempotency_key text;

COMMENT ON COLUMN leases.idempotency_key IS
  'Client UUID for one create attempt. A second insert with the same org and key is rejected. Null means the older two-minute same-room reuse.';

CREATE UNIQUE INDEX IF NOT EXISTS leases_org_idempotency_key_uidx
  ON leases (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
