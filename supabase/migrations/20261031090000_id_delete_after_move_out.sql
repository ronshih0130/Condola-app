-- Version 20261031090000.
ALTER TABLE leases ADD COLUMN IF NOT EXISTS moved_out_on date;
COMMENT ON COLUMN leases.moved_out_on IS
  'Actual move-out date; formed-lease ID retention starts at the later of terminated_on and moved_out_on, falling back to end_date when neither is set.';

CREATE OR REPLACE FUNCTION id_document_delete_after(p_lease_id uuid, p_org_id uuid, p_created_at timestamptz)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_move date;
  v_formed boolean;
BEGIN
  IF p_lease_id IS NOT NULL THEN
    SELECT coalesce(greatest(l.terminated_on, l.moved_out_on), l.end_date), true
      INTO v_move, v_formed
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
  IF v_formed AND v_move IS NOT NULL THEN
    RETURN v_move + id_document_keep_days();
  END IF;
  IF v_formed THEN
    RETURN DATE '9999-12-31';
  END IF;
  RETURN (timezone('Asia/Taipei', coalesce(p_created_at, now())))::date + id_document_keep_days();
END $$;

REVOKE ALL ON FUNCTION id_document_delete_after(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION id_document_delete_after(uuid, uuid, timestamptz) TO service_role;

DROP TRIGGER IF EXISTS trg_lease_refresh_id_delete_after ON leases;
CREATE TRIGGER trg_lease_refresh_id_delete_after
  AFTER UPDATE OF end_date, terminated_on, status, esign_status, signed_at, moved_out_on ON leases
  FOR EACH ROW EXECUTE FUNCTION fn_lease_refresh_id_delete_after();

UPDATE identity_documents AS doc
   SET delete_after = id_document_delete_after(doc.lease_id, doc.org_id, doc.created_at)
 WHERE doc.deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM leases l
      WHERE l.id = doc.lease_id
        AND l.moved_out_on IS NOT NULL
   );
