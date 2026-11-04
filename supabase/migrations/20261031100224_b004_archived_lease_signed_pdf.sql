-- A signed PDF cannot be added to a lease whose property, unit, or room is archived.
-- The refusal happens before insert, so the replacement audit does not run.
-- Re-run keeps the same function and trigger.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION app.guard_archived_lease_signed_pdf()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.leases l
      JOIN public.properties p ON p.org_id = l.org_id AND p.id = l.property_id
      JOIN public.units u ON u.org_id = l.org_id AND u.id = l.unit_id
      LEFT JOIN public.rooms r ON r.org_id = l.org_id AND r.id = l.target_room_id
     WHERE l.org_id = NEW.org_id
       AND l.id = NEW.lease_id
       AND (p.archived_at IS NOT NULL OR u.archived_at IS NOT NULL OR r.archived_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'archived lease cannot receive a signed PDF' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.guard_archived_lease_signed_pdf() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_archived_lease_signed_pdf ON public.lease_signed_pdfs;
CREATE TRIGGER guard_archived_lease_signed_pdf
  BEFORE INSERT ON public.lease_signed_pdfs
  FOR EACH ROW
  EXECUTE FUNCTION app.guard_archived_lease_signed_pdf();
COMMIT;
