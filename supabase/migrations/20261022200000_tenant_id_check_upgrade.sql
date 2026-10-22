-- Version 20261022200000.
-- Upgrade a database that already applied the earlier 20261022180000
-- (move-out-only delete_after, 5MB photo cap, no object cascade, purge via
-- auth.uid()) to the current tenant ID schema. Also safe after the current
-- 20261022180000: objects, constraints, and triggers are created only when
-- missing, then dropped and recreated where the body must change.

DO $$ BEGIN
  CREATE TYPE id_review_status AS ENUM ('pending_review', 'checked', 'returned');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE identity_documents
  ADD COLUMN IF NOT EXISTS review_status id_review_status NOT NULL DEFAULT 'pending_review',
  ADD COLUMN IF NOT EXISTS return_reason text,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_id uuid,
  ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delete_after date;

ALTER TABLE identity_documents DROP COLUMN IF EXISTS verified_by, DROP COLUMN IF EXISTS verified_at;

DROP TRIGGER IF EXISTS trg_id_document_delete_after ON identity_documents;
DROP TRIGGER IF EXISTS trg_lease_refresh_id_delete_after ON leases;
DROP TRIGGER IF EXISTS trg_link_orphan_id_document ON lease_parties;
-- Trigger functions depend on id_document_delete_after. Drop them before
-- either signature, or the drop fails on a database that already has one.
DROP FUNCTION IF EXISTS fn_id_document_delete_after();
DROP FUNCTION IF EXISTS fn_lease_refresh_id_delete_after();
DROP FUNCTION IF EXISTS fn_link_orphan_id_document();
DROP FUNCTION IF EXISTS id_document_delete_after(uuid);
DROP FUNCTION IF EXISTS id_document_delete_after(uuid, uuid, timestamptz);

CREATE OR REPLACE FUNCTION id_document_keep_days() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 90 $$;

-- Move-out + 90 only after the lease took effect. A planned end date on a
-- draft, unsigned, cancelled, or voided lease does not start that clock.
-- Replaces the previous body on databases that already applied 20261022180000.
CREATE OR REPLACE FUNCTION id_document_delete_after(p_lease_id uuid, p_org_id uuid, p_created_at timestamptz)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_move date;
  v_days integer;
  v_cap integer;
BEGIN
  v_cap := platform_max_id_retention_days();
  IF p_lease_id IS NOT NULL THEN
    SELECT coalesce(l.terminated_on, l.end_date)
      INTO v_move
      FROM leases l
     WHERE l.id = p_lease_id
       AND l.esign_status NOT IN ('voided', 'declined')
       AND (
         l.status IN ('active', 'ended', 'terminated')
         OR (
           l.status <> 'cancelled'
           AND l.status <> 'draft'
           AND (l.signed_at IS NOT NULL OR l.esign_status = 'fully_signed')
         )
       );
  END IF;
  IF v_move IS NOT NULL THEN
    RETURN v_move + id_document_keep_days();
  END IF;
  SELECT o.id_doc_retention_days INTO v_days FROM organizations o WHERE o.id = p_org_id;
  v_days := LEAST(coalesce(v_days, id_document_keep_days()), v_cap);
  IF v_days < 0 THEN
    v_days := 0;
  END IF;
  RETURN (timezone('Asia/Taipei', coalesce(p_created_at, now())))::date + v_days;
END $$;

CREATE OR REPLACE FUNCTION id_number_stored_mask(p_raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v text := upper(btrim(coalesce(p_raw, '')));
  n integer;
  stars integer;
  room integer;
  head integer;
  tail integer;
  tail_cap integer;
BEGIN
  n := char_length(v);
  IF n = 0 THEN
    RETURN NULL;
  END IF;
  tail_cap := CASE WHEN n < 8 THEN 2 ELSE 3 END;
  stars := greatest(3, n - 1 - tail_cap);
  room := greatest(0, n - stars);
  head := least(1, room);
  tail := least(tail_cap, greatest(0, room - head));
  IF head = 0 THEN
    RETURN repeat('*', stars);
  END IF;
  RETURN left(v, head) || repeat('*', stars) || CASE WHEN tail > 0 THEN right(v, tail) ELSE '' END;
END $$;

CREATE OR REPLACE FUNCTION dedupe_live_identity_documents() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY org_id, contact_id, coalesce(lease_id, '00000000-0000-0000-0000-000000000000'::uuid)
             ORDER BY created_at DESC, id DESC
           ) AS rn
      FROM identity_documents
     WHERE deleted_at IS NULL
  ),
  gone AS (
    UPDATE identity_documents d
       SET deleted_at = now()
      FROM ranked r
     WHERE d.id = r.id
       AND r.rn > 1
       AND d.deleted_at IS NULL
    RETURNING d.id
  )
  SELECT count(*)::integer INTO n FROM gone;
  RETURN coalesce(n, 0);
END $$;

-- Anything showing more than the first character and the last three is rewritten
-- before the trigger starts refusing it.
UPDATE identity_documents
   SET number_masked = id_number_stored_mask(number_masked)
 WHERE number_masked IS NOT NULL
   AND number_masked !~ '^[^*]{0,1}\*{2,}[^*]{0,3}$';

UPDATE export_jobs SET include_identity_documents = false WHERE include_identity_documents;

SELECT dedupe_live_identity_documents();

CREATE OR REPLACE FUNCTION fn_id_document_delete_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.delete_after := id_document_delete_after(NEW.lease_id, NEW.org_id, NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_id_document_delete_after
  BEFORE INSERT OR UPDATE OF lease_id ON identity_documents
  FOR EACH ROW EXECUTE FUNCTION fn_id_document_delete_after();

CREATE OR REPLACE FUNCTION fn_lease_refresh_id_delete_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE identity_documents AS doc
     SET delete_after = id_document_delete_after(doc.lease_id, doc.org_id, doc.created_at)
   WHERE doc.lease_id = NEW.id
     AND doc.deleted_at IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lease_refresh_id_delete_after
  AFTER UPDATE OF end_date, terminated_on, status, esign_status, signed_at ON leases
  FOR EACH ROW EXECUTE FUNCTION fn_lease_refresh_id_delete_after();

CREATE OR REPLACE FUNCTION fn_link_orphan_id_document() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.role = 'primary' THEN
    UPDATE identity_documents AS doc
       SET lease_id = NEW.lease_id
     WHERE doc.org_id = NEW.org_id
       AND doc.contact_id = NEW.contact_id
       AND doc.lease_id IS NULL
       AND doc.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM identity_documents AS existing
          WHERE existing.org_id = NEW.org_id
            AND existing.contact_id = NEW.contact_id
            AND existing.lease_id = NEW.lease_id
            AND existing.deleted_at IS NULL
       );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_link_orphan_id_document
  AFTER INSERT ON lease_parties
  FOR EACH ROW EXECUTE FUNCTION fn_link_orphan_id_document();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_documents_org_id_uniq') THEN
    ALTER TABLE identity_documents ADD CONSTRAINT identity_documents_org_id_uniq UNIQUE (org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_documents_lease_fk') THEN
    ALTER TABLE identity_documents
      ADD CONSTRAINT identity_documents_lease_fk
      FOREIGN KEY (org_id, lease_id) REFERENCES leases (org_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_documents_returned_ck') THEN
    ALTER TABLE identity_documents
      ADD CONSTRAINT identity_documents_returned_ck
      CHECK (review_status <> 'returned' OR (return_reason IS NOT NULL AND length(btrim(return_reason)) > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_documents_checked_ck') THEN
    ALTER TABLE identity_documents
      ADD CONSTRAINT identity_documents_checked_ck
      CHECK (review_status <> 'checked' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'identity_documents_masked_ck') THEN
    ALTER TABLE identity_documents
      ADD CONSTRAINT identity_documents_masked_ck
      CHECK (number_masked IS NULL OR number_masked LIKE '%*%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'export_jobs_no_identity_documents') THEN
    ALTER TABLE export_jobs
      ADD CONSTRAINT export_jobs_no_identity_documents CHECK (include_identity_documents = false);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS identity_documents_current_idx
  ON identity_documents (org_id, contact_id, coalesce(lease_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS identity_documents_lease_idx ON identity_documents (lease_id) WHERE lease_id IS NOT NULL;

-- At most the first character and the last three may be visible. Stars fill the middle.
CREATE OR REPLACE FUNCTION fn_id_number_masked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.number_masked IS NOT NULL AND NEW.number_masked !~ '^[^*]{0,1}\*{2,}[^*]{0,3}$' THEN
    RAISE EXCEPTION 'identity number must be stored masked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_identity_documents_masked ON identity_documents;
CREATE TRIGGER trg_identity_documents_masked
  BEFORE INSERT OR UPDATE OF number_masked ON identity_documents
  FOR EACH ROW EXECUTE FUNCTION fn_id_number_masked();

-- Rows stored under the old 5MB cap are flagged and their bytes removed first,
-- so the tighter check never fails the migration.
UPDATE identity_documents d
   SET deleted_at = coalesce(d.deleted_at, now()),
       storage_path = CASE
         WHEN d.storage_path LIKE 'purged/%' THEN d.storage_path
         ELSE 'purged/' || d.id::text
       END
 WHERE EXISTS (
        SELECT 1 FROM identity_document_photos p
         WHERE p.document_id = d.id AND p.size_bytes > 819200
      )
    OR EXISTS (
        SELECT 1
          FROM identity_document_photos p
          JOIN id_document_objects o ON o.bucket = p.storage_bucket AND o.path = p.storage_path
         WHERE p.document_id = d.id AND o.byte_size > 819228
      );

DELETE FROM id_document_objects o
 WHERE o.byte_size > 819228
    OR EXISTS (
      SELECT 1 FROM identity_document_photos p
       WHERE p.storage_bucket = o.bucket
         AND p.storage_path = o.path
         AND p.size_bytes > 819200
    );

DELETE FROM identity_document_photos WHERE size_bytes > 819200;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'identity_document_photos'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%size_bytes%'
  LOOP
    EXECUTE format('ALTER TABLE identity_document_photos DROP CONSTRAINT %I', r.conname);
  END LOOP;
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'id_document_objects'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%byte_size%'
  LOOP
    EXECUTE format('ALTER TABLE id_document_objects DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE identity_document_photos
  ADD CONSTRAINT identity_document_photos_size_bytes_check
  CHECK (size_bytes > 0 AND size_bytes <= 819200);
ALTER TABLE id_document_objects
  ADD CONSTRAINT id_document_objects_byte_size_check
  CHECK (byte_size > 0 AND byte_size <= 819228);

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.confdeltype
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
     WHERE t.relname = 'id_document_objects'
       AND ref.relname = 'identity_document_photos'
       AND c.contype = 'f'
       AND c.confdeltype IS DISTINCT FROM 'c'
  LOOP
    EXECUTE format('ALTER TABLE id_document_objects DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
     WHERE t.relname = 'id_document_objects'
       AND ref.relname = 'identity_document_photos'
       AND c.contype = 'f'
       AND c.confdeltype = 'c'
  ) THEN
    DELETE FROM id_document_objects o
     WHERE NOT EXISTS (
       SELECT 1 FROM identity_document_photos p
        WHERE p.storage_bucket = o.bucket AND p.storage_path = o.path
     );
    ALTER TABLE id_document_objects
      ADD CONSTRAINT id_document_objects_photo_fk
      FOREIGN KEY (bucket, path) REFERENCES identity_document_photos (storage_bucket, storage_path) ON DELETE CASCADE;
  END IF;
END $$;

DROP POLICY IF EXISTS idphoto_team ON identity_document_photos;
DROP POLICY IF EXISTS idphoto_self ON identity_document_photos;
CREATE POLICY idphoto_team ON identity_document_photos FOR SELECT TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY idphoto_self ON identity_document_photos FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM identity_documents d
     WHERE d.id = document_id AND d.deleted_at IS NULL AND app.is_my_contact(d.contact_id)
  ));

DROP POLICY IF EXISTS iddoc_self_insert ON identity_documents;
CREATE POLICY iddoc_self_insert ON identity_documents FOR INSERT TO authenticated
  WITH CHECK (
    app.is_my_contact(contact_id)
    AND created_by = auth.uid()
    AND review_status = 'pending_review'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND is_sample = false
    AND deleted_at IS NULL
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON identity_document_photos, id_document_objects TO service_role;
GRANT SELECT ON identity_document_photos TO authenticated;
REVOKE ALL ON id_document_objects FROM PUBLIC, authenticated;
REVOKE INSERT, UPDATE, DELETE ON identity_document_photos FROM authenticated;

-- A previous copy of this file refused new back photos. Front, back, and selfie
-- are all accepted again. Drop that trigger when this file is re-applied.
DROP TRIGGER IF EXISTS trg_id_photo_reject_back ON identity_document_photos;
DROP FUNCTION IF EXISTS fn_id_photo_reject_back();

-- Every row, not only the ones the old function left NULL.
UPDATE identity_documents
   SET delete_after = id_document_delete_after(lease_id, org_id, created_at);
ALTER TABLE identity_documents ALTER COLUMN delete_after SET NOT NULL;

-- Purge shreds private objects once delete_after has passed, and also shreds
-- bytes still attached to a soft-deleted row (dedupe sets deleted_at and used
-- to leave those photos out of this view forever).
CREATE OR REPLACE VIEW id_documents_due_for_purge WITH (security_invoker = true) AS
SELECT d.id AS document_id, d.org_id, d.contact_id, d.doc_type, d.storage_bucket, d.storage_path, d.encryption_key_ref,
       coalesce(l.terminated_on, l.end_date) AS closed_on,
       l.deposit_settled_at AS last_deposit_settled_at,
       id_document_keep_days()::smallint AS retention_days,
       d.delete_after AS due_on
  FROM identity_documents d
  LEFT JOIN leases l ON l.id = d.lease_id
 WHERE (
        d.deleted_at IS NULL AND d.delete_after <= current_date
      ) OR (
        d.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM identity_document_photos p WHERE p.document_id = d.id)
      );
CREATE OR REPLACE FUNCTION purge_due_identity_documents(p_limit integer DEFAULT 500)
RETURNS TABLE (document_id uuid, storage_bucket text, storage_path text, encryption_key_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DROP TABLE IF EXISTS pg_temp.id_purge_batch;
  CREATE TEMP TABLE id_purge_batch (
    document_id uuid,
    org_id uuid,
    storage_bucket text,
    storage_path text,
    encryption_key_ref text
  ) ON COMMIT DROP;

  -- Lock the candidate rows and recheck the deadline against the locked version.
  -- A lease date that moved forward, or a row another worker already took, is skipped.
  INSERT INTO pg_temp.id_purge_batch
  SELECT d.id, d.org_id, d.storage_bucket, d.storage_path, d.encryption_key_ref
    FROM identity_documents d
   WHERE (
          d.deleted_at IS NULL AND d.delete_after <= current_date
        ) OR (
          d.deleted_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM identity_document_photos p WHERE p.document_id = d.id)
        )
   ORDER BY d.delete_after NULLS FIRST, d.id
   LIMIT p_limit
     FOR UPDATE OF d SKIP LOCKED;

  INSERT INTO pg_temp.id_purge_batch (document_id, org_id, storage_bucket, storage_path, encryption_key_ref)
  SELECT b.document_id, b.org_id, p.storage_bucket, p.storage_path, b.encryption_key_ref
    FROM pg_temp.id_purge_batch b
    JOIN identity_document_photos p ON p.document_id = b.document_id
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_temp.id_purge_batch already
      WHERE already.storage_bucket = p.storage_bucket AND already.storage_path = p.storage_path
   );

  DELETE FROM id_document_objects o
   USING pg_temp.id_purge_batch b
   WHERE o.bucket = b.storage_bucket AND o.path = b.storage_path;

  DELETE FROM identity_document_photos p
   USING pg_temp.id_purge_batch b
   WHERE p.document_id = b.document_id;

  UPDATE identity_documents d
     SET deleted_at = coalesce(d.deleted_at, now()),
         storage_path = 'purged/' || d.id::text
    FROM pg_temp.id_purge_batch b
   WHERE d.id = b.document_id;

  INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
  SELECT DISTINCT b.org_id, b.document_id, NULL::uuid, 'retention_purge'
    FROM pg_temp.id_purge_batch b;

  INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row)
  SELECT DISTINCT b.org_id, NULL::uuid, 'system', 'identity_documents', b.document_id::text, 'update'::audit_action,
         'id_document_purged', jsonb_build_object('documentId', b.document_id, 'purpose', 'retention_purge')
    FROM pg_temp.id_purge_batch b;

  RETURN QUERY
  SELECT DISTINCT b.document_id, b.storage_bucket, b.storage_path, b.encryption_key_ref
    FROM pg_temp.id_purge_batch b;
END $$;

-- Access log is append-only. Deleting a document may remove that document's
-- rows. One statement can delete many documents (a lease, contact, or org
-- cascade). Those BEFORE row triggers all run before the access-log cascade,
-- so the allow-list has to keep every id from the statement, not only the last.
-- The setting is transaction-local and dies at COMMIT.
-- The allow-list is not enough: any session can set the same GUC. The parent
-- identity_documents row must also be gone. ON DELETE CASCADE runs after that
-- row is removed, which is the document being deleted. A live parent still
-- blocks the delete. SECURITY DEFINER so row security cannot hide the parent.
CREATE OR REPLACE FUNCTION fn_id_access_log_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed text[] := string_to_array(coalesce(current_setting('app.allow_id_access_log_delete', true), ''), ',');
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.document_id::text = ANY (allowed)
     AND NOT EXISTS (SELECT 1 FROM public.identity_documents d WHERE d.id = OLD.document_id)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'identity_document_access_log is append-only: % not allowed (post a reversal / superseding row instead)', TG_OP
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS trg_identity_document_access_log_append_only ON identity_document_access_log;
CREATE TRIGGER trg_identity_document_access_log_append_only
  BEFORE UPDATE OR DELETE ON identity_document_access_log
  FOR EACH ROW EXECUTE FUNCTION fn_id_access_log_guard();

CREATE OR REPLACE FUNCTION fn_id_document_allow_log_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := string_to_array(coalesce(nullif(current_setting('app.allow_id_access_log_delete', true), ''), ''), ',');
BEGIN
  IF NOT (OLD.id::text = ANY (allowed)) THEN
    allowed := array_append(array_remove(allowed, ''), OLD.id::text);
    PERFORM set_config('app.allow_id_access_log_delete', array_to_string(allowed, ','), true);
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_id_document_allow_log_delete ON identity_documents;
CREATE TRIGGER trg_id_document_allow_log_delete
  BEFORE DELETE ON identity_documents
  FOR EACH ROW EXECUTE FUNCTION fn_id_document_allow_log_delete();

REVOKE ALL ON FUNCTION id_number_stored_mask(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION dedupe_live_identity_documents() FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_due_identity_documents(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION id_document_delete_after(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_link_orphan_id_document() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_id_document_delete_after() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fn_lease_refresh_id_delete_after() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION id_number_stored_mask(text), dedupe_live_identity_documents() TO service_role;
GRANT EXECUTE ON FUNCTION purge_due_identity_documents(integer),
  id_document_delete_after(uuid, uuid, timestamptz),
  fn_link_orphan_id_document(),
  fn_id_document_delete_after(),
  fn_lease_refresh_id_delete_after()
  TO service_role;
