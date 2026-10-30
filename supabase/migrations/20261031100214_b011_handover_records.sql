-- B-011 handover records. This migration does not implement deposit settlement.
INSERT INTO public.platform_settings (key, value, description)
VALUES ('handover_records', '{"enabled":false,"allowed_org_ids":[]}'::jsonb, 'Handover records rollout')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.handover_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('move_in','move_out')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, phase),
  UNIQUE (org_id, lease_id, id),
  FOREIGN KEY (org_id, lease_id) REFERENCES public.leases(org_id, id)
);
CREATE TABLE app.handover_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  record_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  note text NOT NULL CHECK (char_length(note) <= 4000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, revision),
  UNIQUE (org_id, lease_id, id),
  FOREIGN KEY (org_id, lease_id, record_id) REFERENCES app.handover_records(org_id, lease_id, id)
);
CREATE TABLE app.handover_upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  version_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 180),
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  storage_path text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','attached','discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  UNIQUE (org_id, lease_id, id),
  FOREIGN KEY (org_id, lease_id, version_id) REFERENCES app.handover_versions(org_id, lease_id, id)
);
CREATE TABLE app.handover_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  intent_id uuid NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 180),
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text NOT NULL UNIQUE,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, id),
  FOREIGN KEY (org_id, lease_id, intent_id) REFERENCES app.handover_upload_intents(org_id, lease_id, id)
);
CREATE TABLE app.handover_version_attachments (
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  version_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  PRIMARY KEY (version_id, attachment_id),
  FOREIGN KEY (org_id, lease_id, version_id) REFERENCES app.handover_versions(org_id, lease_id, id),
  FOREIGN KEY (org_id, lease_id, attachment_id) REFERENCES app.handover_attachments(org_id, lease_id, id)
);
CREATE TABLE app.handover_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  version_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('staff','tenant')),
  response text NOT NULL CHECK (response IN ('confirm','disagree')),
  note text NOT NULL CHECK (char_length(note) <= 2000),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, request_id),
  FOREIGN KEY (org_id, lease_id, version_id) REFERENCES app.handover_versions(org_id, lease_id, id)
);

-- Only server-side service code can access the private relation set. The
-- service connection and database owner are trusted; these are not public RPCs.
ALTER TABLE app.handover_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.handover_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.handover_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.handover_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.handover_version_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.handover_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.handover_records, app.handover_versions, app.handover_upload_intents,
  app.handover_attachments, app.handover_version_attachments, app.handover_replies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON app.handover_records, app.handover_versions, app.handover_attachments,
  app.handover_version_attachments, app.handover_replies TO service_role;
GRANT UPDATE (created_at) ON app.handover_records TO service_role; -- row locking only in the app gateway
GRANT SELECT, INSERT, UPDATE ON app.handover_upload_intents TO service_role;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, "public", file_size_limit, allowed_mime_types)
    VALUES ('handover-attachments-private', 'handover-attachments-private', false, 5242880,
      ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
    ON CONFLICT (id) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='handover-attachments-private'
      AND "public" IS FALSE AND file_size_limit = 5242880
      AND allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','application/pdf']) THEN
      RAISE EXCEPTION 'handover storage bucket has unsafe configuration' USING ERRCODE='23514';
    END IF;
  END IF;
END $$;

-- The service needs a column UPDATE grant to acquire a row lock, not to edit
-- the identity or timestamp of an existing record.
CREATE FUNCTION app.handover_record_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'handover record is immutable' USING ERRCODE='42501';
END $$;
CREATE TRIGGER handover_record_immutable BEFORE UPDATE ON app.handover_records
  FOR EACH ROW EXECUTE FUNCTION app.handover_record_immutable();
REVOKE ALL ON FUNCTION app.handover_record_immutable() FROM PUBLIC, anon, authenticated;

-- Reset preserves object keys independently of deleted demo records. Attempts
-- are append-only: success is not evidence that an earlier timed-out write can
-- no longer complete, so operators may safely repeat reconciliation.
CREATE TABLE app.handover_gc_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path text NOT NULL UNIQUE CHECK (storage_path ~ '^org/[0-9a-f-]{36}/handover/[0-9a-f-]{36}/[0-9a-f-]{36}(/sealed)?$'),
  reason text NOT NULL CHECK (reason='demo_reset'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.handover_gc_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tombstone_id uuid NOT NULL REFERENCES app.handover_gc_tombstones(id),
  outcome text NOT NULL CHECK (outcome IN ('delete_accepted','storage_unavailable')),
  attempted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.handover_gc_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.handover_gc_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.handover_gc_tombstones, app.handover_gc_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON app.handover_gc_tombstones, app.handover_gc_attempts TO service_role;
