-- Version 20261030150400. Reserve work-order job type fields (R&D job_types_v1). Additive, nullable/defaulted; FK to job_types, seed templates and backfill land in the 10/29 migration. Down: ALTER TABLE maintenance_tickets DROP COLUMN IF EXISTS type_fields, DROP COLUMN IF EXISTS job_type_code;

SET LOCAL lock_timeout = '5s';

ALTER TABLE maintenance_tickets
  ADD COLUMN IF NOT EXISTS job_type_code text NULL,
  ADD COLUMN IF NOT EXISTS type_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN maintenance_tickets.job_type_code IS 'Reserved: work-order job type code (cleaning, plumbing, electrical, ...). FK to job_types(code) and backfill decided in the 10/29 migration per job_types_v1 section 3. NULL = unspecified.';
COMMENT ON COLUMN maintenance_tickets.type_fields IS 'Reserved: per-job-type template field values (job_types.required_fields). Structure/version decided in the 10/29 migration.';
