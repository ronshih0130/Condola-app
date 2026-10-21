-- Version 20261023150000.
-- Repair records (修繕紀錄), after 20261023090000.
-- 20261022180000 is tenant_id_check and is already recorded on staging; do not reuse it.
-- 20261023120000 is reserved by the bulk-import migration. Do not reuse it.
--
-- Schedule, completion, and a free-text vendor sit on the ticket. Cost already
-- has estimated_cost_minor / final_cost_minor. Status changes keep using
-- ticket_comments (status_from / status_to), which is the timeline.
-- Photos are ticket_attachments -> files in the private bucket
-- ticket-photos-private. Allowed types are JPEG, PNG, and WEBP. The storage
-- path must be org/<org_id>/tickets/<ticket_id>/<uuid>.(jpg|png|webp) for that
-- file's org and the attachment's ticket. The app checks magic bytes, uploads
-- and reads with signed URLs, and does not re-encode image bytes.
--
-- expenses.ticket_id is already a nullable FK. expense_id on the ticket is the
-- reverse nullable link and stays nullable. Opting in inserts one row with the
-- existing expense_status value draft. A voided row does not occupy the one
-- live expense per ticket. It does not post the ledger or add a status.

ALTER TABLE maintenance_tickets
  ADD COLUMN IF NOT EXISTS scheduled_on date,
  ADD COLUMN IF NOT EXISTS completed_on date,
  ADD COLUMN IF NOT EXISTS vendor_name text,
  ADD COLUMN IF NOT EXISTS expense_id uuid;

-- Simple FK: ON DELETE SET NULL on (org_id, expense_id) would also null org_id.
-- The trigger keeps the linked expense in the same firm.
ALTER TABLE maintenance_tickets DROP CONSTRAINT IF EXISTS maintenance_tickets_expense_fk;
ALTER TABLE maintenance_tickets
  ADD CONSTRAINT maintenance_tickets_expense_fk
  FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION fn_ticket_expense_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expense_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM expenses e WHERE e.id = NEW.expense_id AND e.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'expense org mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ticket_expense_org ON maintenance_tickets;
CREATE TRIGGER trg_ticket_expense_org
  BEFORE INSERT OR UPDATE OF expense_id, org_id ON maintenance_tickets
  FOR EACH ROW EXECUTE FUNCTION fn_ticket_expense_org();

ALTER TABLE maintenance_tickets DROP CONSTRAINT IF EXISTS maintenance_tickets_schedule_order;
ALTER TABLE maintenance_tickets
  ADD CONSTRAINT maintenance_tickets_schedule_order
  CHECK (scheduled_on IS NULL OR completed_on IS NULL OR completed_on >= scheduled_on);

ALTER TABLE maintenance_tickets DROP CONSTRAINT IF EXISTS maintenance_tickets_vendor_len;
ALTER TABLE maintenance_tickets
  ADD CONSTRAINT maintenance_tickets_vendor_len
  CHECK (vendor_name IS NULL OR char_length(vendor_name) BETWEEN 1 AND 80);

CREATE INDEX IF NOT EXISTS maintenance_tickets_property_created_idx
  ON maintenance_tickets (property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_tickets_expense_idx
  ON maintenance_tickets (expense_id) WHERE expense_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_ticket_idx
  ON expenses (ticket_id) WHERE ticket_id IS NOT NULL;
-- One live expense per ticket. Voided rows stay, so a later opt-in can insert a new draft.
CREATE UNIQUE INDEX IF NOT EXISTS expenses_one_live_ticket_idx
  ON expenses (ticket_id)
  WHERE ticket_id IS NOT NULL AND status <> 'void';

-- A ticket photo row cannot exceed the same cap the private bucket enforces.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_ticket_photo_cap;
ALTER TABLE files
  ADD CONSTRAINT files_ticket_photo_cap
  CHECK (
    storage_bucket <> 'ticket-photos-private'
    OR (
      size_bytes IS NOT NULL
      AND size_bytes > 0
      AND size_bytes <= 5242880
      AND mime_type IN ('image/jpeg', 'image/png', 'image/webp')
    )
  );

-- Path org segment is this file row. The ticket segment is checked when the
-- attachment is inserted, because files has no ticket_id column.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_ticket_photo_path;
ALTER TABLE files
  ADD CONSTRAINT files_ticket_photo_path
  CHECK (
    storage_bucket <> 'ticket-photos-private'
    OR storage_path ~* (
      '^org/' || org_id::text || '/tickets/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || id::text || '\.(jpg|png|webp)$'
    )
  );

CREATE OR REPLACE FUNCTION fn_ticket_photo_attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_path text;
  v_org uuid;
  v_bucket text;
BEGIN
  SELECT f.storage_path, f.org_id, f.storage_bucket
    INTO v_path, v_org, v_bucket
    FROM files f
   WHERE f.id = NEW.file_id;
  IF v_bucket IS DISTINCT FROM 'ticket-photos-private'
     OR v_org IS DISTINCT FROM NEW.org_id
     OR v_path !~* (
       '^org/' || NEW.org_id::text || '/tickets/' || NEW.ticket_id::text || '/'
       || NEW.file_id::text || '\.(jpg|png|webp)$'
     )
  THEN
    RAISE EXCEPTION 'ticket photo path' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ticket_photo_attachment ON ticket_attachments;
CREATE TRIGGER trg_ticket_photo_attachment
  BEFORE INSERT OR UPDATE OF file_id, ticket_id, org_id ON ticket_attachments
  FOR EACH ROW EXECUTE FUNCTION fn_ticket_photo_attachment();

-- Counts every attachment, including internal notes. Locks the ticket so two
-- inserts cannot both observe 7 and land on 9.
CREATE OR REPLACE FUNCTION fn_ticket_photo_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM maintenance_tickets WHERE id = NEW.ticket_id FOR UPDATE;
  IF (SELECT count(*) FROM ticket_attachments WHERE ticket_id = NEW.ticket_id) >= 8 THEN
    RAISE EXCEPTION 'ticket photo limit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ticket_photo_limit ON ticket_attachments;
CREATE TRIGGER trg_ticket_photo_limit
  BEFORE INSERT ON ticket_attachments
  FOR EACH ROW EXECUTE FUNCTION fn_ticket_photo_limit();

REVOKE ALL ON FUNCTION fn_ticket_photo_attachment() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_ticket_photo_limit() FROM PUBLIC;

-- A tenant sees a ticket they reported, or a staff-filed ticket on their lease.
-- They do not see another tenant's ticket, including on a different lease.
CREATE OR REPLACE FUNCTION app.tenant_owns_ticket(p_ticket uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM maintenance_tickets t
     WHERE t.id = p_ticket
       AND (
         t.reported_by_user = auth.uid()
         OR app.is_my_contact(t.reported_by_contact_id)
         OR (
           t.lease_id IS NOT NULL
           AND app.is_lease_tenant(t.lease_id)
           AND t.reported_by_contact_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM contacts c
              WHERE c.user_id = t.reported_by_user
                AND c.is_tenant
                AND c.archived_at IS NULL
                AND c.user_id IS DISTINCT FROM auth.uid()
           )
         )
       )
  );
$$;

CREATE OR REPLACE FUNCTION app.can_see_ticket(p_ticket uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM maintenance_tickets t
     WHERE t.id = p_ticket
       AND (
         app.is_member(t.org_id)
         OR app.is_property_owner(t.property_id)
         OR app.tenant_owns_ticket(t.id)
       )
  );
$$;

-- Opening timeline row. Tenant comment INSERT cannot set status_to, so this
-- definer writes the single "filed" event inside the caller's transaction.
CREATE OR REPLACE FUNCTION app.note_ticket_opened(p_ticket uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT t.org_id INTO v_org FROM maintenance_tickets t WHERE t.id = p_ticket;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM maintenance_tickets t WHERE t.id = p_ticket AND t.reported_by_user = auth.uid())
    OR app.is_member(v_org)
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO ticket_comments (org_id, ticket_id, author_user_id, status_to)
  SELECT v_org, p_ticket, auth.uid(), 'open'::ticket_status
   WHERE NOT EXISTS (
     SELECT 1 FROM ticket_comments c
      WHERE c.ticket_id = p_ticket AND c.status_from IS NULL AND c.status_to = 'open'
   );
END $$;

REVOKE ALL ON FUNCTION app.tenant_owns_ticket(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.note_ticket_opened(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_owns_ticket(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.note_ticket_opened(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS tenant_ticket_insert ON maintenance_tickets;
CREATE POLICY tenant_ticket_insert ON maintenance_tickets FOR INSERT TO authenticated
  WITH CHECK (
    lease_id IS NOT NULL
    AND app.is_lease_tenant(lease_id)
    AND reported_by_user = auth.uid()
    AND status = 'open'
    AND assigned_member_id IS NULL
    AND assigned_vendor_contact_id IS NULL
    AND vendor_name IS NULL
    AND estimated_cost_minor IS NULL
    AND final_cost_minor IS NULL
    AND currency IS NULL
    AND cost_bearer = 'undecided'
    AND scheduled_on IS NULL
    AND completed_on IS NULL
    AND expense_id IS NULL
    AND resolved_at IS NULL
    AND closed_at IS NULL
    AND owner_approval = 'not_required'
  );

-- Tenants comment and attach photos. Staff use the team policies.
-- Accountants can read tickets and cannot write them through the portal policies.
DROP POLICY IF EXISTS portal_comment_insert ON ticket_comments;
CREATE POLICY portal_comment_insert ON ticket_comments FOR INSERT TO authenticated
  WITH CHECK (
    NOT is_internal
    AND author_user_id = auth.uid()
    AND status_to IS NULL
    AND app.tenant_owns_ticket(ticket_id)
  );

-- Staff uploads are files.uploaded_by = the member. Tenants still need to read
-- those objects when the photo is on their ticket and is not internal.
DROP POLICY IF EXISTS portal_ticket_photo_read ON files;
CREATE POLICY portal_ticket_photo_read ON files FOR SELECT TO authenticated
  USING (
    storage_bucket = 'ticket-photos-private'
    AND EXISTS (
      SELECT 1 FROM ticket_attachments a
       WHERE a.file_id = files.id
         AND a.org_id = files.org_id
         AND NOT a.is_internal
         AND app.tenant_owns_ticket(a.ticket_id)
    )
  );

DROP POLICY IF EXISTS portal_ticket_att_insert ON ticket_attachments;
CREATE POLICY portal_ticket_att_insert ON ticket_attachments FOR INSERT TO authenticated
  WITH CHECK (
    NOT is_internal
    AND app.tenant_owns_ticket(ticket_id)
    AND EXISTS (
      SELECT 1 FROM files f
       WHERE f.id = file_id AND f.org_id = ticket_attachments.org_id AND f.uploaded_by = auth.uid()
         AND f.storage_bucket = 'ticket-photos-private'
    )
  );

-- Private bucket when this database is hosted Supabase. Local Postgres has no
-- storage schema; the files check constraint still caps the row.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO storage.buckets (id, name, "public", file_size_limit, allowed_mime_types)
  VALUES (
    'ticket-photos-private',
    'ticket-photos-private',
    false,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
  )
  ON CONFLICT (id) DO UPDATE
    SET "public" = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
END $$;
