-- Version 20261030150700. Durable manager review for case collaboration.
-- Additive; existing links start unapproved.
-- Down: DROP TABLE IF EXISTS repair_vendor_job_shared_photos;
-- DROP INDEX IF EXISTS ticket_attachments_org_id_id_sharing;
-- DROP INDEX IF EXISTS repair_vendor_jobs_org_id_id_sharing;
-- ALTER TABLE repair_vendor_jobs DROP COLUMN IF EXISTS shared_description,
-- DROP COLUMN IF EXISTS sharing_approved_by,
-- DROP COLUMN IF EXISTS sharing_approved_at, DROP COLUMN IF EXISTS scope;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.repair_vendor_jobs
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'case_collaboration',
  ADD COLUMN IF NOT EXISTS sharing_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS sharing_approved_by uuid,
  ADD COLUMN IF NOT EXISTS shared_description text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.repair_vendor_jobs'::regclass
      AND conname = 'repair_vendor_jobs_scope_check'
  ) THEN
    ALTER TABLE public.repair_vendor_jobs
      ADD CONSTRAINT repair_vendor_jobs_scope_check
      CHECK (scope = 'case_collaboration');
  END IF;
END;
$$;

COMMENT ON COLUMN public.repair_vendor_jobs.shared_description IS
  'Manager-reviewed and redacted text; vendor links never expose the raw ticket description.';

-- These ordinary index builds are allowed only on small relations (including
-- TOAST): enforce a 32 MiB ceiling rather than assume production table sizes.
-- The transaction-local timeouts also bound lock acquisition and each build.
-- Larger installations must prepare these exact indexes CONCURRENTLY outside
-- a transaction before running this migration. Existing indexes skip the size
-- guard on replay, so subsequent table growth does not prevent replay.
DO $$
BEGIN
  IF to_regclass('public.repair_vendor_jobs_org_id_id_sharing') IS NULL
     AND pg_table_size('public.repair_vendor_jobs'::regclass) > 33554432 THEN
    RAISE EXCEPTION
      'Prepare repair_vendor_jobs_org_id_id_sharing CONCURRENTLY before migration 150700';
  END IF;
  IF to_regclass('public.ticket_attachments_org_id_id_sharing') IS NULL
     AND pg_table_size('public.ticket_attachments'::regclass) > 33554432 THEN
    RAISE EXCEPTION
      'Prepare ticket_attachments_org_id_id_sharing CONCURRENTLY before migration 150700';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS repair_vendor_jobs_org_id_id_sharing
  ON public.repair_vendor_jobs (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_attachments_org_id_id_sharing
  ON public.ticket_attachments (org_id, id);

CREATE TABLE IF NOT EXISTS public.repair_vendor_job_shared_photos (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attachment_id),
  FOREIGN KEY (org_id, job_id)
    REFERENCES public.repair_vendor_jobs(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, attachment_id)
    REFERENCES public.ticket_attachments(org_id, id) ON DELETE CASCADE
);

ALTER TABLE public.repair_vendor_job_shared_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repair_vendor_job_shared_photos FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.repair_vendor_job_shared_photos
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.repair_vendor_job_shared_photos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.repair_vendor_job_shared_photos TO service_role;

DROP POLICY IF EXISTS repair_vendor_job_shared_photos_read
  ON public.repair_vendor_job_shared_photos;
CREATE POLICY repair_vendor_job_shared_photos_read
  ON public.repair_vendor_job_shared_photos
  FOR SELECT TO authenticated USING (app.is_member(org_id));

COMMIT;
