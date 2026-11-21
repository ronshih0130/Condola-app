-- B-104 / PR-024(a): private, service-only reads of B-013 state.
-- CREATE (not replacement) leaves ownership with the migration role. No table
-- grants: callers authorize the vendor capability before invoking these helpers.
-- These are snapshot reads; ticket/job and gateway locks remain with the writers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION app.b104_current_repair_version(p_org uuid, p_ticket uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
 SELECT h.current_version_id
 FROM app.b013_estimate_heads AS h
 WHERE p_org IS NOT NULL AND p_ticket IS NOT NULL
   AND h.org_id = p_org AND h.ticket_id = p_ticket
$$;

-- Preserve the original actor/request lookup, including created_by NULL fallback.
-- This is a replay hint only: the existing gateway validates the full payload.
CREATE FUNCTION app.b104_vendor_command_exists(p_org uuid, p_job uuid, p_request uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
 SELECT EXISTS (
   SELECT 1 FROM app.b013_repair_commands AS c
   JOIN public.repair_vendor_jobs AS j
     ON j.org_id = c.org_id AND coalesce(j.created_by, j.id) = c.actor_id
   WHERE p_org IS NOT NULL AND p_job IS NOT NULL AND p_request IS NOT NULL
     AND j.org_id = p_org AND j.id = p_job AND c.request_id = p_request
 )
$$;

CREATE FUNCTION app.b104_vendor_latest_event(p_org uuid, p_ticket uuid, p_job uuid, p_version uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
 SELECT a.event_kind::text
 FROM app.b013_repair_appointments AS a
 WHERE p_org IS NOT NULL AND p_ticket IS NOT NULL AND p_job IS NOT NULL AND p_version IS NOT NULL
   AND a.org_id = p_org AND a.ticket_id = p_ticket
   AND a.repair_vendor_job_id = p_job AND a.version_id = p_version
 ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION app.b104_current_repair_version(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.b104_vendor_command_exists(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.b104_vendor_latest_event(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.b104_current_repair_version(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION app.b104_vendor_command_exists(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION app.b104_vendor_latest_event(uuid,uuid,uuid,uuid) TO service_role;
COMMIT;
