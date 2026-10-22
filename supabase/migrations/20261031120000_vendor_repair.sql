-- Version 20261031120000.
-- Vendor dispatch for one repair job.
-- Additive only: new tables, one nullable column, triggers.
-- No NOT NULL on existing columns, and no new constraint that older ticket
-- or expense writes would fail. ticket_attachments.vendor_job_id stays null
-- for every photo the current app inserts.
--
-- A vendor has no login. The raw token lives in repair_vendor_secrets.
-- RLS is on and forced, with no policies on that table. anon and
-- authenticated have no privileges and cannot execute the lookup.
-- service_role (BYPASSRLS) is the only granted role. The lookup returns a
-- row only when the token hash matches, the job is active, not revoked,
-- unexpired, and the firm still has vendor dispatch. Anything else is empty.

CREATE TABLE IF NOT EXISTS repair_vendor_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id            uuid NOT NULL,
  vendor_name          text NOT NULL CHECK (char_length(vendor_name) BETWEEN 1 AND 80),
  vendor_phone         text NOT NULL CHECK (vendor_phone ~ '^\+[1-9][0-9]{6,14}$'),
  contact_window       text NOT NULL CHECK (char_length(contact_window) BETWEEN 1 AND 160),
  token_hash           text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  active               boolean NOT NULL DEFAULT true,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  reported_at          timestamptz,
  reported_cost_minor  bigint CHECK (reported_cost_minor IS NULL OR reported_cost_minor > 0),
  confirmed_at         timestamptz,
  confirmed_by         uuid,
  expense_id           uuid,
  FOREIGN KEY (org_id, ticket_id) REFERENCES maintenance_tickets(org_id, id),
  CHECK (reported_at IS NOT NULL OR reported_cost_minor IS NULL),
  CHECK (confirmed_at IS NULL OR reported_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS repair_vendor_jobs_one_active
  ON repair_vendor_jobs (ticket_id)
  WHERE active;

CREATE INDEX IF NOT EXISTS repair_vendor_jobs_org_idx
  ON repair_vendor_jobs (org_id, created_at DESC);

ALTER TABLE repair_vendor_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_vendor_jobs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE repair_vendor_jobs FROM PUBLIC;
REVOKE ALL ON TABLE repair_vendor_jobs FROM anon;
REVOKE ALL ON TABLE repair_vendor_jobs FROM authenticated;
GRANT SELECT ON TABLE repair_vendor_jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE repair_vendor_jobs TO service_role;

DROP POLICY IF EXISTS repair_vendor_jobs_read ON repair_vendor_jobs;
CREATE POLICY repair_vendor_jobs_read ON repair_vendor_jobs
  FOR SELECT TO authenticated
  USING (app.is_member(org_id));

CREATE TABLE IF NOT EXISTS repair_vendor_secrets (
  job_id uuid PRIMARY KEY REFERENCES repair_vendor_jobs(id) ON DELETE CASCADE,
  token  text NOT NULL CHECK (char_length(token) >= 43)
);

ALTER TABLE repair_vendor_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_vendor_secrets FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE repair_vendor_secrets FROM PUBLIC;
REVOKE ALL ON TABLE repair_vendor_secrets FROM anon;
REVOKE ALL ON TABLE repair_vendor_secrets FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE repair_vendor_secrets TO service_role;
REVOKE ALL ON TABLE repair_vendor_secrets FROM CURRENT_USER;

-- Nullable. Older inserts leave it null and do not hit the new check.
ALTER TABLE ticket_attachments
  ADD COLUMN IF NOT EXISTS vendor_job_id uuid;

ALTER TABLE ticket_attachments DROP CONSTRAINT IF EXISTS ticket_attachments_vendor_job_fk;
ALTER TABLE ticket_attachments
  ADD CONSTRAINT ticket_attachments_vendor_job_fk
  FOREIGN KEY (vendor_job_id) REFERENCES repair_vendor_jobs(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION fn_vendor_job_photo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.vendor_job_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM repair_vendor_jobs j
     WHERE j.id = NEW.vendor_job_id
       AND j.ticket_id = NEW.ticket_id
       AND j.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'vendor job photo' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_vendor_job_photo ON ticket_attachments;
CREATE TRIGGER trg_vendor_job_photo
  BEFORE INSERT OR UPDATE OF vendor_job_id ON ticket_attachments
  FOR EACH ROW EXECUTE FUNCTION fn_vendor_job_photo();

REVOKE ALL ON FUNCTION fn_vendor_job_photo() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fn_vendor_job_photo() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_vendor_job_photo() TO service_role;

CREATE OR REPLACE FUNCTION app.drop_vendor_job_secret() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL OR NOT NEW.active OR NEW.expires_at <= now() THEN
    DELETE FROM repair_vendor_secrets WHERE job_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS repair_vendor_secrets_drop ON repair_vendor_jobs;
CREATE TRIGGER repair_vendor_secrets_drop
  AFTER UPDATE OF revoked_at, active, expires_at ON repair_vendor_jobs
  FOR EACH ROW EXECUTE FUNCTION app.drop_vendor_job_secret();

REVOKE ALL ON FUNCTION app.drop_vendor_job_secret() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.drop_vendor_job_secret() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.drop_vendor_job_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.drop_vendor_job_secret() TO service_role;

-- Sample company (sandbox) and beta firms. An explicit false turns it off.
CREATE OR REPLACE FUNCTION app.vendor_dispatch_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM organizations o
     WHERE o.id = p_org
       AND coalesce(o.feature_flags->>'vendor_dispatch', '') IS DISTINCT FROM 'false'
       AND (o.environment = 'sandbox' OR o.plan_tier = 'beta')
  );
$$;

-- Empty unless this hash is the one live, unrevoked, unexpired job and the
-- firm still has the flag. No phone, no token, no other job.
CREATE OR REPLACE FUNCTION app.open_vendor_job(p_token_hash text)
RETURNS TABLE (
  job_id uuid,
  org_id uuid,
  ticket_id uuid,
  vendor_name text,
  contact_window text,
  expires_at timestamptz,
  reported_at timestamptz,
  reported_cost_minor bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.id, j.org_id, j.ticket_id, j.vendor_name, j.contact_window, j.expires_at,
         j.reported_at, j.reported_cost_minor
    FROM repair_vendor_jobs j
   WHERE j.token_hash = p_token_hash
     AND j.active
     AND j.revoked_at IS NULL
     AND j.expires_at > now()
     AND app.vendor_dispatch_enabled(j.org_id);
$$;

REVOKE ALL ON FUNCTION app.vendor_dispatch_enabled(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.open_vendor_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.vendor_dispatch_enabled(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION app.open_vendor_job(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.vendor_dispatch_enabled(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.open_vendor_job(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.vendor_dispatch_enabled(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION app.open_vendor_job(text) TO service_role;
