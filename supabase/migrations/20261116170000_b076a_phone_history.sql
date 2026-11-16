-- B-076a (narrow first slice of B-076; the general 看紀錄 reader stays with B-073):
-- mgr-history-direct (Round 7 batch 4, MGT-76-AC3/AC12), 物件與租客 › {租客} › 改號紀錄.
-- ONE new migration-owned VOLATILE service-only SECURITY DEFINER read gateway; no table, grant, policy,
-- flag or data change. Admission: the selected env/live tuple, a live auth session, an active native
-- admin or manager membership of the live org (as app.b015_edit_context), the tenant_directory_edit
-- org + platform flag, and a tenant contact of this org. Rows come only from the generic audit log's
-- contacts updates whose phone_e164 changed with the B-015 reason 'tenant_directory_contact_edit',
-- joined to the B-015 edit command that changed it (role at the time) and the editor's profile name.
-- Numbers are masked here: a full number never leaves the database. Newest first, keyset paged.
-- OPEN: only B-015 staff edits are listed. Tenant self-edit, imports and future OTP changes record other
-- reasons (or none) and need their own mapping later.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE FUNCTION app.b076a_phone_history(p_org uuid,p_live uuid,p_env text,p_session uuid,p_contact uuid,
 p_after bigint DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; tz text; tenant text; place text; result jsonb;
 page_limit integer:=greatest(1,least(50,coalesce(p_limit,20)));
BEGIN
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT x.user_id INTO actor FROM public.auth_sessions x
 WHERE x.id=p_session AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id=p_live AND m.user_id=actor AND m.status::text='active' FOR SHARE;
 IF member_role IS NULL OR member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='tenant_directory_edit'
  WHERE o.id=p_org AND o.feature_flags->'tenant_directory_edit'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) THEN
  RETURN NULL;
 END IF;
 IF p_contact IS NULL OR (p_after IS NOT NULL AND p_after<1) THEN
  RAISE EXCEPTION 'Invalid phone history request' USING ERRCODE='22023'; END IF;
 -- Another org's contact, a missing, archived or non-tenant contact are indistinguishable (the tenant page's population).
 SELECT c.display_name INTO tenant FROM public.contacts c
 WHERE c.org_id=p_org AND c.id=p_contact AND c.is_tenant AND c.archived_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT o.timezone INTO tz FROM public.organizations o WHERE o.id=p_org;
 SELECT pr.name||' '||u.label||coalesce(' '||r.label,'') INTO place
 FROM public.lease_parties lp
 JOIN public.leases l ON l.org_id=lp.org_id AND l.id=lp.lease_id
 JOIN public.properties pr ON pr.org_id=l.org_id AND pr.id=l.property_id
 JOIN public.units u ON u.org_id=l.org_id AND u.id=l.unit_id
 LEFT JOIN public.rooms r ON r.org_id=l.org_id AND r.id=l.target_room_id
 WHERE lp.org_id=p_org AND lp.contact_id=p_contact AND l.status::text='active'
 ORDER BY l.created_at DESC,l.id DESC LIMIT 1;
 WITH h AS MATERIALIZED (
  SELECT a.id,a.occurred_at,cmd.actor_role,nullif(btrim(p.display_name),'') AS actor_name,
   a.old_row->>'phone_e164' AS old_phone,a.new_row->>'phone_e164' AS new_phone,
   row_number() OVER (ORDER BY a.id DESC) AS rn
  FROM public.audit_log a
  JOIN app.b015_edit_commands cmd ON cmd.org_id=a.org_id AND cmd.actor_id=a.actor_user_id
   AND cmd.request_id::text=a.request_id AND cmd.command_kind='edit' AND cmd.outcome='changed'
   AND cmd.scoped_contact_id=p_contact
  LEFT JOIN public.profiles p ON p.id=cmd.actor_id
  WHERE a.org_id=p_org AND a.table_name='contacts' AND a.row_id=p_contact::text AND a.action='update'
   AND a.reason='tenant_directory_contact_edit' AND 'phone_e164'=ANY(a.changed_cols)
   AND (p_after IS NULL OR a.id<p_after)
  ORDER BY a.id DESC
  LIMIT page_limit+1
 ), masked AS (
  -- Taiwan mobiles (+8869xxxxxxxx) read 09xx‑•••‑xxx as the frame draws them. Any other value shows its
  -- last three digits only when it has at least 8 digits (the tail is a strict minority); a shorter or
  -- digit-less value (legacy data, separators included) is fully masked. NULL or blank stays NULL.
  SELECT h.*,
   CASE WHEN h.old_phone IS NULL OR btrim(h.old_phone)='' THEN NULL
    WHEN h.old_phone ~ '^\+8869[0-9]{8}$' THEN '09'||substr(h.old_phone,6,2)||'‑•••‑'||right(h.old_phone,3)
    WHEN length(regexp_replace(h.old_phone,'[^0-9]','','g'))>=8
     THEN '•••‑•••‑'||right(regexp_replace(h.old_phone,'[^0-9]','','g'),3)
    ELSE '•••‑•••‑•••' END AS old_masked,
   CASE WHEN h.new_phone IS NULL OR btrim(h.new_phone)='' THEN NULL
    WHEN h.new_phone ~ '^\+8869[0-9]{8}$' THEN '09'||substr(h.new_phone,6,2)||'‑•••‑'||right(h.new_phone,3)
    WHEN length(regexp_replace(h.new_phone,'[^0-9]','','g'))>=8
     THEN '•••‑•••‑'||right(regexp_replace(h.new_phone,'[^0-9]','','g'),3)
    ELSE '•••‑•••‑•••' END AS new_masked
  FROM h
 )
 SELECT jsonb_build_object('tenant',tenant,'place',place,
  'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id::text,'occurredAt',x.occurred_at,
     'at',to_char(x.occurred_at AT TIME ZONE tz,'YYYY/MM/DD HH24:MI'),'status','direct',
     'actorRole',x.actor_role,'actorName',x.actor_name,'oldMasked',x.old_masked,'newMasked',x.new_masked) ORDER BY x.rn)
   FROM masked x WHERE x.rn<=page_limit),'[]'::jsonb),
  'next',(SELECT x.id::text FROM masked x WHERE x.rn=page_limit AND EXISTS (SELECT 1 FROM masked y WHERE y.rn>page_limit)))
 INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b076a_phone_history(uuid,uuid,text,uuid,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b076a_phone_history(uuid,uuid,text,uuid,uuid,bigint,integer) TO service_role;
COMMIT;
