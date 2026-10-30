-- Version 20261030150500. Revoke PUBLIC execution of app helpers. Down: ops rollback uses GRANT EXECUTE ON FUNCTION ... TO PUBLIC on the same 11 signatures below.

SET LOCAL lock_timeout = '5s';

-- RLS policies TO authenticated call these helpers. tx() uses authenticated,
-- including portal tenant/owner users; svc() uses service_role.
-- public.tenant_lease_picker is read under authenticated; PostgreSQL checks
-- its function EXECUTE privileges against the querying user.
-- The SECURITY INVOKER trigger fn_notification_context calls
-- app.lease_context_prefix under authenticated or service_role writes.
-- Both roles need explicit grants, including the two previously NULL ACLs.
--
-- Extension-owned functions (btree_gist and citext in public, owned by
-- supabase_admin) and Supabase-managed schemas are deliberately left alone.
-- The global PUBLIC scan is the ops pre/post check; other functions are
-- reported with a NOTICE below.
-- Safe to re-run: repeated REVOKE and GRANT statements are no-ops.

REVOKE EXECUTE ON FUNCTION app.can_see_ticket(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.has_role(uuid, org_role[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.in_thread(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.income_expense_report(uuid, uuid, uuid, date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.is_lease_tenant(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.is_my_contact(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.is_property_owner(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.lease_context_prefix(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.my_contact_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.my_tenant_leases() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.tenant_of_property(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.can_see_ticket(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.has_role(uuid, org_role[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.in_thread(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.income_expense_report(uuid, uuid, uuid, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.is_lease_tenant(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.is_my_contact(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.is_property_owner(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.lease_context_prefix(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.my_contact_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.my_tenant_leases() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.tenant_of_property(uuid) TO authenticated, service_role;

DO $assert_function_privileges$
DECLARE
  offending text;
  helper_signatures text[] := ARRAY[
    'app.can_see_ticket(uuid)',
    'app.has_role(uuid, org_role[])',
    'app.in_thread(uuid)',
    'app.income_expense_report(uuid, uuid, uuid, date, date)',
    'app.is_lease_tenant(uuid)',
    'app.is_my_contact(uuid)',
    'app.is_property_owner(uuid)',
    'app.lease_context_prefix(uuid)',
    'app.my_contact_ids()',
    'app.my_tenant_leases()',
    'app.tenant_of_property(uuid)'
  ];
BEGIN
  SELECT string_agg(
    helpers.signature,
    ', ' ORDER BY helpers.signature
  )
  INTO offending
  FROM unnest(helper_signatures) AS helpers(signature)
  JOIN pg_proc AS p ON p.oid = helpers.signature::regprocedure
  WHERE EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  );

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'PUBLIC still has EXECUTE on: %', offending;
  END IF;

  SELECT string_agg(
    format('%s: %s', roles.role_name, helpers.signature),
    ', ' ORDER BY roles.role_name, helpers.signature
  )
  INTO offending
  FROM unnest(helper_signatures) AS helpers(signature)
  CROSS JOIN (VALUES
    ('authenticated'),
    ('service_role')
  ) AS roles(role_name)
  WHERE NOT has_function_privilege(
    roles.role_name, helpers.signature::regprocedure, 'EXECUTE'
  );

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Required role lacks EXECUTE on: %', offending;
  END IF;

  SELECT string_agg(
    format('%I.%I(%s)', n.nspname, p.proname,
      pg_get_function_identity_arguments(p.oid)),
    ', ' ORDER BY n.nspname, p.proname, p.oid
  )
  INTO offending
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('app', 'public')
    AND NOT (p.oid = ANY (helper_signatures::regprocedure[]))
    AND NOT EXISTS (
      SELECT 1
      FROM pg_depend AS d
      WHERE d.classid = 'pg_proc'::regclass
        AND d.objid = p.oid
        AND d.objsubid = 0
        AND d.deptype = 'e'
    )
    AND EXISTS (
      SELECT 1
      FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
      WHERE acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    );

  IF offending IS NOT NULL THEN
    RAISE NOTICE 'other functions with PUBLIC EXECUTE (not changed here): %', offending;
  END IF;
END;
$assert_function_privileges$;
