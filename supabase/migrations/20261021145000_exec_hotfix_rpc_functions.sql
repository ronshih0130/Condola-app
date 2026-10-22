-- Applied to prod manually on 2026-10-21 and recorded here for parity.
-- Covers both hotfixes from that day, including purge_due_identity_documents.
-- 20261018120000_schema.sql revoked EXECUTE from PUBLIC and authenticated, not anon.
-- Default privileges still grant anon. GRANT and REVOKE are idempotent.
-- Skip a function that is not on a fresh database yet.

DO $$
BEGIN
  IF to_regprocedure('public.line_lease_picker(uuid, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.line_lease_picker(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT  EXECUTE ON FUNCTION public.line_lease_picker(uuid, text) TO service_role;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.fn_invoice_recalc(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.fn_invoice_recalc(uuid) FROM PUBLIC, anon;
    GRANT  EXECUTE ON FUNCTION public.fn_invoice_recalc(uuid) TO authenticated, service_role;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.post_reversal(uuid, text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.post_reversal(uuid, text) FROM PUBLIC, anon;
    GRANT  EXECUTE ON FUNCTION public.post_reversal(uuid, text) TO authenticated, service_role;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.purge_due_identity_documents(integer)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.purge_due_identity_documents(integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.purge_due_identity_documents(integer) TO service_role;
  END IF;
END $$;
