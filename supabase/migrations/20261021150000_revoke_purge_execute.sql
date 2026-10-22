-- Version 20261021150000.
-- Production and staging already ran this revoke out of band.
-- PUBLIC, anon, and authenticated cannot execute the purge. service_role keeps EXECUTE.
-- REVOKE is a no-op when the grant is already gone. A database that has not
-- created the function yet skips it, so this file can run twice.

DO $$
BEGIN
  IF to_regprocedure('public.purge_due_identity_documents(integer)') IS NULL THEN
    RETURN;
  END IF;
  REVOKE EXECUTE ON FUNCTION public.purge_due_identity_documents(integer) FROM PUBLIC, anon, authenticated;
END $$;
