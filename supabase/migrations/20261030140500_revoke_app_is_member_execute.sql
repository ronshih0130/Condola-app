-- app.is_member is SECURITY DEFINER and RLS policies call it as the session
-- user. PUBLIC includes anon, so the default EXECUTE grant lets the public
-- anon key call it. Remove that grant. authenticated and service_role keep
-- EXECUTE: policies run as authenticated, and service_role queries call it too.
--
-- Safe to re-run. REVOKE is a no-op when the grant is already gone, and
-- GRANT does not add a second copy of a privilege the role already has.

REVOKE EXECUTE ON FUNCTION app.is_member(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.is_member(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app.is_member(uuid) TO authenticated, service_role;
