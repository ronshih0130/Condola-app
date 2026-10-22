-- Version 20261021170000.
-- Live mode stays locked until we flip the flag. Idempotent.
-- Firms that already have live properties or leases (the staging QA org) are unlocked.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS live_enabled boolean NOT NULL DEFAULT false;

UPDATE organizations AS o
   SET live_enabled = true
 WHERE o.environment = 'live'
   AND o.live_enabled = false
   AND (
     EXISTS (SELECT 1 FROM properties p WHERE p.org_id = o.id)
     OR EXISTS (SELECT 1 FROM leases l WHERE l.org_id = o.id)
   );
