-- Version 20261030150700. Durable manager review for case collaboration. Additive; existing links start unapproved. Down: DROP TABLE IF EXISTS repair_vendor_job_shared_photos; DROP INDEX IF EXISTS ticket_attachments_org_id_id_sharing; DROP INDEX IF EXISTS repair_vendor_jobs_org_id_id_sharing; ALTER TABLE repair_vendor_jobs DROP COLUMN IF EXISTS shared_description, DROP COLUMN IF EXISTS sharing_approved_by, DROP COLUMN IF EXISTS sharing_approved_at, DROP COLUMN IF EXISTS scope;

SET LOCAL lock_timeout = '5s';

ALTER TABLE repair_vendor_jobs
  ADD COLUMN scope text NOT NULL DEFAULT 'case_collaboration' CHECK (scope = 'case_collaboration'),
  ADD COLUMN sharing_approved_at timestamptz,
  ADD COLUMN sharing_approved_by uuid,
  ADD COLUMN shared_description text;

COMMENT ON COLUMN repair_vendor_jobs.shared_description IS 'Manager-reviewed and redacted text; vendor links never expose the raw ticket description.';

CREATE UNIQUE INDEX repair_vendor_jobs_org_id_id_sharing ON repair_vendor_jobs (org_id, id);
CREATE UNIQUE INDEX ticket_attachments_org_id_id_sharing ON ticket_attachments (org_id, id);

CREATE TABLE repair_vendor_job_shared_photos (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attachment_id),
  FOREIGN KEY (org_id, job_id) REFERENCES repair_vendor_jobs(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, attachment_id) REFERENCES ticket_attachments(org_id, id) ON DELETE CASCADE
);

ALTER TABLE repair_vendor_job_shared_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE repair_vendor_job_shared_photos FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE repair_vendor_job_shared_photos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE repair_vendor_job_shared_photos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE repair_vendor_job_shared_photos TO service_role;
CREATE POLICY repair_vendor_job_shared_photos_read ON repair_vendor_job_shared_photos
  FOR SELECT TO authenticated USING (app.is_member(org_id));
