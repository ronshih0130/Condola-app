-- Version 20261030150802. Bind collaboration jobs to a contact.
-- Existing jobs have no proven contact identity and fail closed in enhanced mode.
-- Down: DROP TRIGGER IF EXISTS repair_vendor_assignment_changed ON public.maintenance_tickets;
-- DROP FUNCTION IF EXISTS app.revoke_reassigned_vendor_jobs();
-- ALTER TABLE public.repair_vendor_jobs DROP COLUMN IF EXISTS vendor_contact_id;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.repair_vendor_jobs
  ADD COLUMN IF NOT EXISTS vendor_contact_id uuid;

COMMENT ON COLUMN public.repair_vendor_jobs.vendor_contact_id IS
  'Contact selected at dispatch; never inferred from the current ticket assignee.';

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

  WITH revoked AS (
    UPDATE public.repair_vendor_jobs j
       SET active = false,
           revoked_at = coalesce(j.revoked_at, clock_timestamp()),
           sharing_approved_at = NULL,
           sharing_approved_by = NULL,
           shared_description = NULL
     WHERE j.org_id = NEW.org_id AND j.ticket_id = NEW.id
       AND j.active
       AND (j.vendor_contact_id IS NULL
            OR j.vendor_contact_id IS DISTINCT FROM NEW.assigned_vendor_contact_id)
     RETURNING j.id
  )
  DELETE FROM public.repair_vendor_job_shared_photos s
   USING revoked r
   WHERE s.org_id = NEW.org_id AND s.job_id = r.id;

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
