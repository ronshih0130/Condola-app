-- One person can be both a tenant and an owner in the same firm.
-- contacts_org_user_uniq blocked a second contact from sharing user_id.
-- Dropping it is required. Each role still has one active contact per login.

DROP INDEX IF EXISTS contacts_org_user_uniq;

CREATE UNIQUE INDEX contacts_org_user_owner_uniq
  ON contacts (org_id, user_id)
  WHERE user_id IS NOT NULL AND is_owner AND archived_at IS NULL;

CREATE UNIQUE INDEX contacts_org_user_tenant_uniq
  ON contacts (org_id, user_id)
  WHERE user_id IS NOT NULL AND is_tenant AND archived_at IS NULL;
