-- Version 20261107133000. B-031 slice 3 UPLOAD_RECOVERY (flag upload_recovery, default OFF).
-- Additive only: a default-OFF platform setting, two private app tables and
-- SECURITY DEFINER gateways. No existing table, policy, grant or function changes.
-- Retry-safe ticket photos: a per-owner draft batch and one row per client file key,
-- unique on (org, batch, client key). Final submit inserts files/ticket_attachments
-- through the caller's existing RLS (never through these definers), exactly once.
-- Down: DROP FUNCTION app.b031_upload_*; DROP TABLE app.b031_upload_items, app.b031_upload_batches;
--       DELETE FROM public.platform_settings WHERE key = 'upload_recovery';
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key, value)
VALUES ('upload_recovery', '{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT (key) DO NOTHING;

-- One draft per owner and client batch key. The draft keeps the non-file field
-- (internal) and the per-file rows; submitted_at closes it.
CREATE TABLE app.b031_upload_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_batch_key uuid NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  UNIQUE (org_id, owner_user_id, client_batch_key),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id) ON DELETE CASCADE
);
CREATE INDEX b031_upload_batches_open_idx ON app.b031_upload_batches(org_id, ticket_id, owner_user_id)
  WHERE submitted_at IS NULL;

-- signed: a storage path was reserved for this client key (object may or may not exist).
-- uploaded: the server verified the stored object; not yet attached.
-- attached: final submit created the files + ticket_attachments rows.
CREATE TABLE app.b031_upload_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  client_key uuid NOT NULL,
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  state text NOT NULL DEFAULT 'signed' CHECK (state IN ('signed', 'uploaded', 'attached')),
  attachment_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, batch_id, client_key),
  FOREIGN KEY (org_id, batch_id) REFERENCES app.b031_upload_batches(org_id, id) ON DELETE CASCADE,
  CHECK ((state = 'attached') = (attachment_id IS NOT NULL))
);

REVOKE ALL ON app.b031_upload_batches, app.b031_upload_items FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE app.b031_upload_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b031_upload_items ENABLE ROW LEVEL SECURITY;

-- Strict flag: global enabled true + allowlisted org + org feature_flags true.
CREATE FUNCTION app.b031_upload_recovery_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id = p_org
     WHERE f.key = 'upload_recovery'
       AND jsonb_typeof(f.value) = 'object'
       AND f.value->'enabled' = 'true'::jsonb
       AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
       AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
       AND jsonb_typeof(o.feature_flags) = 'object'
       AND o.feature_flags->'upload_recovery' = 'true'::jsonb)
$$;
REVOKE ALL ON FUNCTION app.b031_upload_recovery_on(uuid) FROM PUBLIC, anon, authenticated, service_role;
-- db.query uses DATABASE_URL without SET ROLE (server connection), like b031_session_hardening_enabled.
GRANT EXECUTE ON FUNCTION app.b031_upload_recovery_on(uuid) TO service_role;

-- Same actor rule as the existing photo path: staff with tickets.update roles in the
-- pinned organization, or a tenant who owns the ticket. Internal only for staff.
CREATE FUNCTION app.b031_upload_actor_ok(p_org uuid, p_ticket uuid, p_internal boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR p_org IS NULL OR p_ticket IS NULL
    OR nullif(current_setting('app.active_org_id', true), '') IS DISTINCT FROM p_org::text
    OR NOT EXISTS (SELECT 1 FROM public.maintenance_tickets t WHERE t.id = p_ticket AND t.org_id = p_org) THEN
    RETURN false;
  END IF;
  IF app.has_role(p_org, ARRAY['admin', 'manager', 'maintenance']::public.org_role[]) THEN
    RETURN true;
  END IF;
  RETURN coalesce(p_internal, false) = false AND NOT app.is_member(p_org) AND app.tenant_owns_ticket(p_ticket);
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_actor_ok(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Resolve the caller's own batch by client key. Another user's key never resolves.
CREATE FUNCTION app.b031_upload_own_batch(p_org uuid, p_batch_key uuid, p_lock boolean)
RETURNS app.b031_upload_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b app.b031_upload_batches;
BEGIN
  IF NOT app.b031_upload_recovery_on(p_org) THEN
    RAISE EXCEPTION 'permission denied: upload recovery unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_lock THEN
    SELECT * INTO b FROM app.b031_upload_batches
     WHERE org_id = p_org AND owner_user_id = auth.uid() AND client_batch_key = p_batch_key FOR UPDATE;
  ELSE
    SELECT * INTO b FROM app.b031_upload_batches
     WHERE org_id = p_org AND owner_user_id = auth.uid() AND client_batch_key = p_batch_key;
  END IF;
  IF NOT FOUND OR NOT app.b031_upload_actor_ok(p_org, b.ticket_id, b.internal) THEN
    RAISE EXCEPTION 'permission denied: upload batch' USING ERRCODE = '42501';
  END IF;
  RETURN b;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_own_batch(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Open (or reopen) the caller's draft and record its non-file field.
CREATE FUNCTION app.b031_upload_open_batch(p_org uuid, p_ticket uuid, p_batch_key uuid, p_internal boolean)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b app.b031_upload_batches;
BEGIN
  IF NOT app.b031_upload_recovery_on(p_org) THEN
    RAISE EXCEPTION 'permission denied: upload recovery unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_batch_key IS NULL OR p_internal IS NULL OR NOT app.b031_upload_actor_ok(p_org, p_ticket, p_internal) THEN
    RAISE EXCEPTION 'permission denied: upload batch' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.b031_upload_batches(org_id, ticket_id, owner_user_id, client_batch_key, internal)
  VALUES (p_org, p_ticket, auth.uid(), p_batch_key, p_internal)
  ON CONFLICT (org_id, owner_user_id, client_batch_key) DO NOTHING;
  b := app.b031_upload_own_batch(p_org, p_batch_key, true);
  IF b.ticket_id <> p_ticket THEN
    RAISE EXCEPTION 'permission denied: upload batch' USING ERRCODE = '42501';
  END IF;
  IF b.submitted_at IS NULL AND b.internal <> p_internal THEN
    UPDATE app.b031_upload_batches SET internal = p_internal WHERE id = b.id;
  END IF;
  RETURN b.id;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_open_batch(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_upload_open_batch(uuid, uuid, uuid, boolean) TO authenticated;

-- Reserve one storage path per (org, batch, client key). A replay returns the
-- existing row and its original path; the proposed path is then discarded unused.
CREATE FUNCTION app.b031_upload_reserve(p_org uuid, p_batch_key uuid, p_client_key uuid, p_path text,
  p_file_name text, p_mime text, p_size bigint)
RETURNS TABLE(storage_path text, state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b app.b031_upload_batches; v_open integer; v_attached integer;
BEGIN
  b := app.b031_upload_own_batch(p_org, p_batch_key, true);
  IF p_client_key IS NULL THEN
    RAISE EXCEPTION 'permission denied: upload item' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT i.storage_path, i.state FROM app.b031_upload_items i
    WHERE i.org_id = b.org_id AND i.batch_id = b.id AND i.client_key = p_client_key;
  IF FOUND THEN RETURN; END IF;
  IF b.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'permission denied: upload batch submitted' USING ERRCODE = '42501';
  END IF;
  IF p_path IS NULL OR p_path !~* ('^org/' || b.org_id::text || '/tickets/' || b.ticket_id::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$') THEN
    RAISE EXCEPTION 'ticket photo path' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_attached FROM public.ticket_attachments a WHERE a.ticket_id = b.ticket_id;
  SELECT count(*) INTO v_open FROM app.b031_upload_items i WHERE i.batch_id = b.id AND i.state <> 'attached';
  IF v_attached + v_open >= 8 THEN
    RAISE EXCEPTION 'ticket photo limit' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.b031_upload_items(org_id, batch_id, client_key, storage_path, file_name, mime_type, size_bytes)
  VALUES (b.org_id, b.id, p_client_key, p_path, p_file_name, p_mime, p_size)
  ON CONFLICT (org_id, batch_id, client_key) DO NOTHING;
  RETURN QUERY SELECT i.storage_path, i.state FROM app.b031_upload_items i
    WHERE i.org_id = b.org_id AND i.batch_id = b.id AND i.client_key = p_client_key;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_reserve(uuid, uuid, uuid, text, text, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_upload_reserve(uuid, uuid, uuid, text, text, text, bigint) TO authenticated;

-- The caller's own draft items (for confirm, retry and draft restore).
CREATE FUNCTION app.b031_upload_items_for(p_org uuid, p_batch_key uuid)
RETURNS TABLE(ticket_id uuid, internal boolean, submitted boolean, client_key uuid, storage_path text,
  file_name text, mime_type text, size_bytes bigint, state text, attachment_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b app.b031_upload_batches;
BEGIN
  b := app.b031_upload_own_batch(p_org, p_batch_key, false);
  RETURN QUERY SELECT b.ticket_id, b.internal, b.submitted_at IS NOT NULL, i.client_key, i.storage_path,
      i.file_name, i.mime_type, i.size_bytes, i.state, i.attachment_id
    FROM app.b031_upload_items i WHERE i.org_id = b.org_id AND i.batch_id = b.id
    ORDER BY i.created_at, i.id;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_items_for(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_upload_items_for(uuid, uuid) TO authenticated;

-- Latest open draft of the caller for one ticket (draft restore after reload).
CREATE FUNCTION app.b031_upload_open_draft(p_org uuid, p_ticket uuid)
RETURNS TABLE(client_batch_key uuid, internal boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT app.b031_upload_recovery_on(p_org) OR NOT app.b031_upload_actor_ok(p_org, p_ticket, false) THEN
    RAISE EXCEPTION 'permission denied: upload batch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT b.client_batch_key, b.internal FROM app.b031_upload_batches b
    WHERE b.org_id = p_org AND b.ticket_id = p_ticket AND b.owner_user_id = auth.uid() AND b.submitted_at IS NULL
      AND EXISTS (SELECT 1 FROM app.b031_upload_items i WHERE i.batch_id = b.id)
    ORDER BY b.created_at DESC, b.id DESC LIMIT 1;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_open_draft(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_upload_open_draft(uuid, uuid) TO authenticated;

-- After the server verified the stored object. Idempotent; never regresses a state.
CREATE FUNCTION app.b031_upload_mark_uploaded(p_org uuid, p_batch_key uuid, p_client_key uuid, p_mime text, p_size bigint)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b app.b031_upload_batches; v_state text;
BEGIN
  b := app.b031_upload_own_batch(p_org, p_batch_key, true);
  UPDATE app.b031_upload_items i SET state = 'uploaded', mime_type = p_mime, size_bytes = p_size, updated_at = clock_timestamp()
   WHERE i.org_id = b.org_id AND i.batch_id = b.id AND i.client_key = p_client_key AND i.state = 'signed'
     AND b.submitted_at IS NULL;
  SELECT i.state INTO v_state FROM app.b031_upload_items i
   WHERE i.org_id = b.org_id AND i.batch_id = b.id AND i.client_key = p_client_key;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'permission denied: upload item' USING ERRCODE = '42501';
  END IF;
  RETURN v_state;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_mark_uploaded(uuid, uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_upload_mark_uploaded(uuid, uuid, uuid, text, bigint) TO authenticated;

-- Record one attachment the caller just inserted through RLS in this transaction.
-- The attachment must be this batch's ticket/org and point at this item's path.
CREATE FUNCTION app.b031_upload_mark_attached(p_org uuid, p_batch_key uuid, p_client_key uuid, p_attachment uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b app.b031_upload_batches;
BEGIN
  b := app.b031_upload_own_batch(p_org, p_batch_key, true);
  UPDATE app.b031_upload_items i SET state = 'attached', attachment_id = p_attachment, updated_at = clock_timestamp()
   WHERE i.org_id = b.org_id AND i.batch_id = b.id AND i.client_key = p_client_key AND i.state = 'uploaded'
     AND b.submitted_at IS NULL
     AND EXISTS (SELECT 1 FROM public.ticket_attachments a JOIN public.files f ON f.id = a.file_id AND f.org_id = a.org_id
                  WHERE a.id = p_attachment AND a.org_id = b.org_id AND a.ticket_id = b.ticket_id
                    AND f.storage_bucket = 'ticket-photos-private' AND f.storage_path = i.storage_path
                    AND f.uploaded_by = auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'permission denied: upload item' USING ERRCODE = '42501';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_mark_attached(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_upload_mark_attached(uuid, uuid, uuid, uuid) TO authenticated;

-- Final submit step 1: lock the caller's draft (serialises concurrent submits),
-- record the latest non-file field while open, report whether it already closed.
CREATE FUNCTION app.b031_upload_lock_batch(p_org uuid, p_batch_key uuid, p_internal boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b app.b031_upload_batches;
BEGIN
  b := app.b031_upload_own_batch(p_org, p_batch_key, true);
  IF b.submitted_at IS NOT NULL THEN RETURN true; END IF;
  IF p_internal IS NULL OR NOT app.b031_upload_actor_ok(p_org, b.ticket_id, p_internal) THEN
    RAISE EXCEPTION 'permission denied: upload batch' USING ERRCODE = '42501';
  END IF;
  IF b.internal <> p_internal THEN
    UPDATE app.b031_upload_batches SET internal = p_internal WHERE id = b.id;
  END IF;
  RETURN false;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_lock_batch(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_upload_lock_batch(uuid, uuid, boolean) TO authenticated;

-- Close the draft. Called last, in the same transaction as the attachments.
CREATE FUNCTION app.b031_upload_close_batch(p_org uuid, p_batch_key uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b app.b031_upload_batches;
BEGIN
  b := app.b031_upload_own_batch(p_org, p_batch_key, true);
  UPDATE app.b031_upload_batches SET submitted_at = clock_timestamp() WHERE id = b.id AND submitted_at IS NULL;
END
$$;
REVOKE ALL ON FUNCTION app.b031_upload_close_batch(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_upload_close_batch(uuid, uuid) TO authenticated;

COMMIT;
