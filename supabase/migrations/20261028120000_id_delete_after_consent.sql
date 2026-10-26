-- Version 20261028120000.
-- Consent text: a formed lease is deleted 90 days after it ends (end_date, or
-- terminated_on when the lease ended early). A later change to that date moves
-- delete_after. An open-ended formed lease has not ended, so the upload clock
-- does not apply. A draft, unsigned, cancelled, voided, or missing lease is
-- deleted 90 days after the Taipei upload date. The firm retention setting
-- does not shorten or extend either clock.

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
    SELECT coalesce(l.terminated_on, l.end_date), true
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

UPDATE identity_documents
   SET delete_after = id_document_delete_after(lease_id, org_id, created_at)
 WHERE deleted_at IS NULL;
