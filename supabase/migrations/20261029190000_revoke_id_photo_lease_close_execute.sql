-- Version 20261029190000.
-- Privilege-only. public.fn_id_photo_drop_wm() and
-- public.fn_lease_close_end_date() are trigger functions from migrations
-- already on main (#9 ID watermark, 20261029160000_lease_close_end_date).
-- This branch may not create them. Where they exist, anon and PUBLIC can
-- still EXECUTE them, which exposes them through the Data API.
--
-- Firing a trigger does not check EXECUTE, so taking the grant away does
-- not change trigger behavior and stays compatible with the Worker that is
-- still serving. service_role is left as it is.
--
-- Guard with to_regprocedure, which reads pg_proc and returns null when the
-- function is absent, so this file no-ops on a database that does not have
-- them yet. REVOKE is a no-op when the grant is already gone. Safe to re-run.
-- No table is rewritten and no function body changes.

DO $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_id_photo_drop_wm()')
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.fn_id_photo_drop_wm() FROM PUBLIC, anon, authenticated;
  ELSE
    RAISE NOTICE 'skip missing function public.fn_id_photo_drop_wm()';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_lease_close_end_date()')
  ) THEN
    REVOKE EXECUTE ON FUNCTION public.fn_lease_close_end_date() FROM PUBLIC, anon, authenticated;
  ELSE
    RAISE NOTICE 'skip missing function public.fn_lease_close_end_date()';
  END IF;
END
$body$;
