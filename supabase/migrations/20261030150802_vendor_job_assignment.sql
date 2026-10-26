-- Version 20261030150802. Bind collaboration jobs to a contact.
-- Existing jobs have no proven contact identity and fail closed in enhanced mode.
-- Down: DROP TRIGGER IF EXISTS repair_vendor_assignment_changed ON public.maintenance_tickets;
-- DROP TRIGGER IF EXISTS repair_vendor_sharing_history ON public.repair_vendor_jobs;
-- DROP FUNCTION IF EXISTS app.revoke_reassigned_vendor_jobs();
-- DROP FUNCTION IF EXISTS app.record_vendor_sharing_history();
-- Archive repair_vendor_sharing_history before any destructive rollback.
-- ALTER TABLE public.repair_vendor_jobs DROP COLUMN IF EXISTS vendor_contact_id;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.repair_vendor_jobs
  ADD COLUMN IF NOT EXISTS vendor_contact_id uuid;

COMMENT ON COLUMN public.repair_vendor_jobs.vendor_contact_id IS
  'Contact selected at dispatch; never inferred from the current ticket assignee.';

-- Deliberately no cascading foreign keys: historical evidence must survive
-- deletion of a job, attachment, reviewer, or organization.
CREATE TABLE IF NOT EXISTS public.repair_vendor_sharing_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  job_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('approval', 'invalidation')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid,
  trigger_name text NOT NULL,
  reason text NOT NULL,
  reviewer_id uuid,
  reviewed_at timestamptz,
  reviewed_text text,
  attachment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  CHECK (
    event_type <> 'approval'
    OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.repair_vendor_sharing_history IS
  'Append-only approval revisions and authorization invalidations; selections are attachment identifiers at review time.';

CREATE INDEX IF NOT EXISTS repair_vendor_sharing_history_job
  ON public.repair_vendor_sharing_history (org_id, job_id, occurred_at, id);

ALTER TABLE public.repair_vendor_sharing_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repair_vendor_sharing_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.repair_vendor_sharing_history
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.repair_vendor_sharing_history
  TO authenticated, service_role;

DROP POLICY IF EXISTS repair_vendor_sharing_history_read
  ON public.repair_vendor_sharing_history;
CREATE POLICY repair_vendor_sharing_history_read
  ON public.repair_vendor_sharing_history
  FOR SELECT TO authenticated USING (app.is_member(org_id));

CREATE OR REPLACE FUNCTION app.reject_vendor_sharing_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Vendor sharing history is append-only'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION app.reject_vendor_sharing_history_mutation()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.reject_vendor_sharing_history_mutation()
  TO service_role;

DROP TRIGGER IF EXISTS repair_vendor_sharing_history_immutable
  ON public.repair_vendor_sharing_history;
CREATE TRIGGER repair_vendor_sharing_history_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.repair_vendor_sharing_history
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_vendor_sharing_history_mutation();

CREATE OR REPLACE FUNCTION app.record_vendor_sharing_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor uuid;
  invalidation_reason text;
BEGIN
  actor := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;

  -- Replacement/revocation clears only the live projection. Assignment changes
  -- invoke this trigger from the ticket trigger, before deleting live selections.
  IF (OLD.active AND NOT NEW.active)
     OR (OLD.sharing_approved_at IS NOT NULL
         AND NEW.sharing_approved_at IS NULL) THEN
    invalidation_reason := CASE
      WHEN pg_trigger_depth() > 1 THEN 'vendor_reassigned'
      WHEN OLD.active AND NOT NEW.active THEN 'job_deactivated'
      ELSE 'approval_cleared'
    END;

    INSERT INTO public.repair_vendor_sharing_history (
      org_id, ticket_id, job_id, event_type, actor_id, trigger_name, reason
    ) VALUES (
      OLD.org_id, OLD.ticket_id, OLD.id, 'invalidation', actor,
      CASE WHEN pg_trigger_depth() > 1
        THEN 'repair_vendor_assignment_changed' ELSE TG_NAME END,
      invalidation_reason
    );

    NEW.sharing_approved_at := NULL;
    NEW.sharing_approved_by := NULL;
    NEW.shared_description := NULL;

    DELETE FROM public.repair_vendor_job_shared_photos
     WHERE org_id = OLD.org_id AND job_id = OLD.id;
  END IF;

  -- approveVendorSharing installs the selected photos before updating these
  -- fields, so this snapshot includes the complete reviewed selection.
  IF NEW.sharing_approved_at IS NOT NULL
     AND ROW(NEW.sharing_approved_at, NEW.sharing_approved_by, NEW.shared_description)
         IS DISTINCT FROM
         ROW(OLD.sharing_approved_at, OLD.sharing_approved_by, OLD.shared_description) THEN
    IF OLD.sharing_approved_at IS NOT NULL THEN
      INSERT INTO public.repair_vendor_sharing_history (
        org_id, ticket_id, job_id, event_type, actor_id, trigger_name, reason
      ) VALUES (
        OLD.org_id, OLD.ticket_id, OLD.id, 'invalidation', actor,
        TG_NAME, 'approval_replaced'
      );
    END IF;

    INSERT INTO public.repair_vendor_sharing_history (
      org_id, ticket_id, job_id, event_type, actor_id, trigger_name, reason,
      reviewer_id, reviewed_at, reviewed_text, attachment_ids
    )
    SELECT NEW.org_id, NEW.ticket_id, NEW.id, 'approval', actor, TG_NAME,
           'manager_review', NEW.sharing_approved_by, NEW.sharing_approved_at,
           NEW.shared_description,
           coalesce(array_agg(s.attachment_id ORDER BY s.attachment_id)
             FILTER (WHERE s.attachment_id IS NOT NULL), '{}'::uuid[])
      FROM public.repair_vendor_job_shared_photos s
     WHERE s.org_id = NEW.org_id AND s.job_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.record_vendor_sharing_history()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.record_vendor_sharing_history() TO service_role;

DROP TRIGGER IF EXISTS repair_vendor_sharing_history ON public.repair_vendor_jobs;
CREATE TRIGGER repair_vendor_sharing_history
  BEFORE UPDATE ON public.repair_vendor_jobs
  FOR EACH ROW EXECUTE FUNCTION app.record_vendor_sharing_history();

CREATE OR REPLACE FUNCTION app.revoke_reassigned_vendor_jobs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Application assignment writers set this from both the kill switch and org flag.
  -- The ticket UPDATE already holds the ticket lock before these job locks.
  IF NEW.assigned_vendor_contact_id IS NOT DISTINCT FROM OLD.assigned_vendor_contact_id
     OR current_setting('app.vendor_link_reassignment', true) IS DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;

  PERFORM j.id
    FROM public.repair_vendor_jobs j
   WHERE j.org_id = NEW.org_id AND j.ticket_id = NEW.id
   ORDER BY j.id
   FOR UPDATE;

  -- The job trigger records invalidation and clears the live projection.
  -- Approval revisions remain immutable and are never updated or deleted.
  UPDATE public.repair_vendor_jobs j
     SET active = false,
         revoked_at = coalesce(j.revoked_at, clock_timestamp()),
         sharing_approved_at = NULL,
         sharing_approved_by = NULL,
         shared_description = NULL
   WHERE j.org_id = NEW.org_id AND j.ticket_id = NEW.id
     AND j.active
     AND (j.vendor_contact_id IS NULL
          OR j.vendor_contact_id IS DISTINCT FROM NEW.assigned_vendor_contact_id);

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.revoke_reassigned_vendor_jobs()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.revoke_reassigned_vendor_jobs() TO service_role;

DROP TRIGGER IF EXISTS repair_vendor_assignment_changed ON public.maintenance_tickets;
CREATE TRIGGER repair_vendor_assignment_changed
  AFTER UPDATE OF assigned_vendor_contact_id ON public.maintenance_tickets
  FOR EACH ROW EXECUTE FUNCTION app.revoke_reassigned_vendor_jobs();

COMMIT;
