-- B-059 / DO-3 單位分派（僅維修人員） (MGT-118-AC1…AC8; MGT-116-AC4/AC5/AC6 visibility; GS-24, GS-46; Round 7 frames
-- 「設定・單位分派」 and 「負責的單位・{名字}」). Tier 2. Forward-only:
--  * NEW app.b059_unit_assignments (one row per maintenance person × unit; RLS on, no application grants) and
--    NEW app.b059_assign_commands (request-id idempotency, B-091 pattern).
--  * NEW flag maint_unit_assign seeded OFF in platform_settings (never overwritten).
--  * NEW service-only VOLATILE SECURITY DEFINER gateways app.b059_assign_view / app.b059_assign_save
--    (search_path=pg_catalog,pg_temp; EXECUTE to service_role only). Admin/manager only (AC1, AC7); the target is a
--    maintenance member, or a pending maintenance invitation, of the same organization (AC2, GS-24 「邀請中」 rows).
--  * NEW statement-scoped STABLE definer helpers (b017_denied_orgs pattern: no argument, the caller's own rows only,
--    EXECUTE to authenticated so RLS can call them) and two NEW RESTRICTIVE policies: one on
--    public.maintenance_tickets and one on public.ticket_attachments. With the flag OFF the helpers return an empty
--    array and every row passes, so every existing query keeps its text and its result (flag-OFF parity).
--    With the flag ON for the organization, an active maintenance member sees (and can update) only tickets on
--    units assigned to them (AC3), plus any ticket explicitly assigned to them (assigned_member_id, AC5 / MGT-116-AC6).
--    Admins, managers, accountants, tenants, owners and service_role are never scoped (AC4).
-- No existing table, column, grant, policy, function or data is changed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE app.b059_unit_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  member_id uuid REFERENCES public.org_members (id) ON DELETE CASCADE,
  invitation_id uuid REFERENCES public.invitations (id) ON DELETE CASCADE,
  unit_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((member_id IS NULL) <> (invitation_id IS NULL)),
  FOREIGN KEY (org_id, unit_id) REFERENCES public.units (org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX b059_unit_assignments_member_unit_key ON app.b059_unit_assignments (org_id, member_id, unit_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX b059_unit_assignments_invite_unit_key ON app.b059_unit_assignments (org_id, invitation_id, unit_id) WHERE invitation_id IS NOT NULL;
CREATE INDEX b059_unit_assignments_member_idx ON app.b059_unit_assignments (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX b059_unit_assignments_invitation_idx ON app.b059_unit_assignments (invitation_id) WHERE invitation_id IS NOT NULL;
CREATE INDEX b059_unit_assignments_unit_idx ON app.b059_unit_assignments (unit_id);

-- Every request id is reserved with its outcome: a retry replays the stored result; another actor or payload under
-- the same id is a conflict and never writes.
CREATE TABLE app.b059_assign_commands (
  org_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  target_id uuid NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('saved','unchanged','invalid')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, request_id)
);

ALTER TABLE app.b059_unit_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b059_assign_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b059_unit_assignments, app.b059_assign_commands FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.platform_settings (key, value)
VALUES ('maint_unit_assign', '{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- The flag for one organization: org override true AND platform enabled AND the org in the allowlist.
-- Missing or malformed is OFF. Internal to the definers below (no grant).
CREATE FUNCTION app.b059_flag_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='maint_unit_assign'
  WHERE o.id=p_org AND o.feature_flags->'maint_unit_assign'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text))
$$;

-- RLS helpers (b017_denied_orgs pattern). No argument: only the caller's (auth.uid()) own memberships, so there is
-- no organization oracle. Each is one statement-scoped initplan in the policies below.
-- The organizations where the caller is an ACTIVE maintenance member and maint_unit_assign is ON. With the platform
-- row disabled (the seeded default) this is the empty array.
CREATE FUNCTION app.b059_scoped_orgs() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT m.org_id),ARRAY[]::uuid[])
 FROM public.platform_settings f
 JOIN public.org_members m ON m.user_id=auth.uid() AND m.role='maintenance' AND m.status='active'
 JOIN public.organizations o ON o.id=m.org_id
 WHERE f.key='maint_unit_assign' AND f.value->'enabled'='true'::jsonb
  AND jsonb_typeof(f.value->'allowed_org_ids')='array'
  AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
  AND o.feature_flags->'maint_unit_assign'='true'::jsonb
$$;
-- Units assigned to the caller in a scoped organization: rows keyed by the caller's member row, and rows saved while
-- the caller was still an invitation that the caller has since accepted (GS-24: 邀請中 people can be assigned ahead).
CREATE FUNCTION app.b059_visible_units() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(array_agg(DISTINCT a.unit_id),ARRAY[]::uuid[])
 FROM app.b059_unit_assignments a
 WHERE a.org_id=ANY(app.b059_scoped_orgs())
  AND (EXISTS (SELECT 1 FROM public.org_members m WHERE m.id=a.member_id AND m.org_id=a.org_id AND m.user_id=auth.uid())
   OR EXISTS (SELECT 1 FROM public.invitations i WHERE i.id=a.invitation_id AND i.org_id=a.org_id
     AND i.status='accepted' AND i.accepted_by=auth.uid()))
$$;
-- The caller's own member rows in scoped organizations (a ticket explicitly assigned to them stays visible, AC5).
CREATE FUNCTION app.b059_own_members() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(array_agg(m.id),ARRAY[]::uuid[]) FROM public.org_members m
 WHERE m.user_id=auth.uid() AND m.org_id=ANY(app.b059_scoped_orgs())
$$;
-- Tickets in the caller's scoped organizations that the ticket policy shows them (photo rows follow their ticket).
-- Only rows the caller can already read through the ticket policy, so this is no oracle. Each array is read once.
CREATE FUNCTION app.b059_visible_tickets() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH v AS (SELECT app.b059_scoped_orgs() orgs, app.b059_visible_units() units, app.b059_own_members() members)
 SELECT coalesce(array_agg(t.id),ARRAY[]::uuid[]) FROM public.maintenance_tickets t CROSS JOIN v
 WHERE t.org_id=ANY(v.orgs)
  AND (coalesce(t.unit_id=ANY(v.units),false) OR coalesce(t.assigned_member_id=ANY(v.members),false))
$$;

-- MGT-118-AC3/AC4/AC5. Restrictive: it narrows the existing permissive policies for the scoped caller only.
-- A ticket with no unit (property-level) is visible only when it is explicitly assigned to the caller.
CREATE POLICY b059_maint_unit_scope ON public.maintenance_tickets AS RESTRICTIVE TO authenticated
 USING (NOT (org_id = ANY((SELECT app.b059_scoped_orgs())::uuid[]))
  OR coalesce(unit_id = ANY((SELECT app.b059_visible_units())::uuid[]),false)
  OR coalesce(assigned_member_id = ANY((SELECT app.b059_own_members())::uuid[]),false));
-- The photo rows of a ticket the caller cannot see (the by-id photo route). No sublink on ticket_attachments (B-017
-- 42P17 note): the STABLE definer calls are per row here; the first is the empty array while the flag is OFF, so
-- the second is never needed then.
CREATE POLICY b059_maint_unit_photo_scope ON public.ticket_attachments AS RESTRICTIVE TO authenticated
 USING (NOT (org_id = ANY(app.b059_scoped_orgs())) OR ticket_id = ANY(app.b059_visible_tickets()));

-- The single-person shape the two gateways share: an ACTIVE maintenance member of p_org, or a PENDING maintenance
-- team invitation of p_org (AC2). Names as 團隊 shows them (display name, else email; an invitation by its email).
-- MGT-118-AC1/AC2/AC7 page reader. NULL when the flag is OFF. Admin/manager only (42501 otherwise).
-- p_target NULL: one row per maintenance person with the number of (non-archived) units assigned.
-- p_target set: that person and every non-archived unit of the organization with checked=true when assigned.
CREATE FUNCTION app.b059_assign_view(p_org uuid,p_live uuid,p_env text,p_session uuid,p_target uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; person record; result jsonb;
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
 IF NOT app.b059_flag_on(p_org) THEN RETURN NULL; END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active' FOR SHARE;
 IF member_role IS NULL OR member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_target IS NULL THEN
  WITH people AS (
   SELECT m.id, 'member'::text kind, coalesce(nullif(btrim(p.display_name),''),p.email::text,'') name, m.user_id
   FROM public.org_members m JOIN public.profiles p ON p.id=m.user_id
   WHERE m.org_id=p_org AND m.role='maintenance' AND m.status='active'
   UNION ALL
   SELECT i.id, 'invite', coalesce(i.email::text,i.phone_e164,''), NULL::uuid
   FROM public.invitations i
   WHERE i.org_id=p_org AND i.kind='team_member' AND i.role='maintenance' AND i.status='pending'
  )
  SELECT jsonb_build_object('people',coalesce(jsonb_agg(jsonb_build_object('id',pp.id,'kind',pp.kind,'name',pp.name,
    'units',(SELECT count(DISTINCT a.unit_id) FROM app.b059_unit_assignments a
      JOIN public.units u ON u.org_id=a.org_id AND u.id=a.unit_id AND u.archived_at IS NULL
      WHERE a.org_id=p_org AND (a.member_id=pp.id OR a.invitation_id=pp.id
       OR (pp.user_id IS NOT NULL AND a.invitation_id IN (SELECT i.id FROM public.invitations i
         WHERE i.org_id=p_org AND i.status='accepted' AND i.accepted_by=pp.user_id)))))
   ORDER BY pp.name, pp.id),'[]'::jsonb))
  INTO result FROM people pp;
  RETURN result;
 END IF;
 SELECT x.* INTO person FROM (
  SELECT m.id, 'member'::text kind, coalesce(nullif(btrim(p.display_name),''),p.email::text,'') name, m.user_id
  FROM public.org_members m JOIN public.profiles p ON p.id=m.user_id
  WHERE m.org_id=p_org AND m.id=p_target AND m.role='maintenance' AND m.status='active'
  UNION ALL
  SELECT i.id, 'invite', coalesce(i.email::text,i.phone_e164,''), NULL::uuid
  FROM public.invitations i
  WHERE i.org_id=p_org AND i.id=p_target AND i.kind='team_member' AND i.role='maintenance' AND i.status='pending'
 ) x;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('person',jsonb_build_object('id',person.id,'kind',person.kind,'name',person.name),
  'units',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'property',pr.name,'label',u.label,
     'checked',EXISTS (SELECT 1 FROM app.b059_unit_assignments a WHERE a.org_id=p_org AND a.unit_id=u.id
       AND (a.member_id=person.id OR a.invitation_id=person.id
        OR (person.user_id IS NOT NULL AND a.invitation_id IN (SELECT i.id FROM public.invitations i
          WHERE i.org_id=p_org AND i.status='accepted' AND i.accepted_by=person.user_id)))))
    ORDER BY pr.name, u.label, u.id)
   FROM public.units u JOIN public.properties pr ON pr.org_id=u.org_id AND pr.id=u.property_id AND pr.archived_at IS NULL
   WHERE u.org_id=p_org AND u.archived_at IS NULL),'[]'::jsonb))
 INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b059_assign_view(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b059_assign_view(uuid,uuid,text,uuid,uuid) TO service_role;

-- MGT-118-AC1/AC2/AC7/AC8 writer: replaces the person's unit set. Statuses: saved | unchanged | invalid | conflict |
-- disabled; a denial (session, role, target not a maintenance person of this org) raises 42501 and writes nothing.
-- Lock order: the session row, the actor's member row, the request id (advisory), the target's member or invitation
-- row (FOR NO KEY UPDATE: one writer per person), then the requested units (FOR SHARE). Admission decides on the
-- locked rows only. A reserved request id replays its stored result; another actor or payload is a conflict.
CREATE FUNCTION app.b059_assign_save(p_org uuid,p_live uuid,p_env text,p_session uuid,p_request uuid,
 p_target uuid,p_units uuid[])
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; target_kind text; target_user uuid; prior app.b059_assign_commands;
 fingerprint text; wanted uuid[]; current_set uuid[]; locked integer; outcome text; result jsonb;
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
 IF NOT app.b059_flag_on(p_org) THEN RETURN jsonb_build_object('status','disabled'); END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active' FOR SHARE;
 IF member_role IS NULL OR member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_request IS NULL OR p_target IS NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b059/assign/'||p_org::text||'/'||p_request::text,0));
 -- AC2: only a maintenance person of this organization (never a manager or accountant: B-017 is out of scope).
 SELECT 'member', m.user_id INTO target_kind, target_user FROM public.org_members m
 WHERE m.org_id=p_org AND m.id=p_target AND m.role='maintenance' AND m.status='active' FOR NO KEY UPDATE;
 IF NOT FOUND THEN
  SELECT 'invite', NULL INTO target_kind, target_user FROM public.invitations i
  WHERE i.org_id=p_org AND i.id=p_target AND i.kind='team_member' AND i.role='maintenance' AND i.status='pending'
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 -- The id is bound to the target and the raw unit list as sent (order and duplicates included).
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_target,to_jsonb(p_units))::text,'UTF8')),'hex');
 SELECT * INTO prior FROM app.b059_assign_commands c WHERE c.org_id=p_org AND c.request_id=p_request;
 IF FOUND THEN
  IF prior.actor_id IS DISTINCT FROM actor OR prior.target_id IS DISTINCT FROM p_target
    OR prior.payload_fingerprint IS DISTINCT FROM fingerprint THEN
   RETURN jsonb_build_object('status','conflict');
  END IF;
  RETURN prior.result || jsonb_build_object('replayed',true);
 END IF;
 IF p_units IS NOT NULL THEN
  SELECT count(*) INTO locked FROM (SELECT u.id FROM public.units u
   JOIN public.properties pr ON pr.org_id=u.org_id AND pr.id=u.property_id AND pr.archived_at IS NULL
   WHERE u.org_id=p_org AND u.id=ANY(p_units) AND u.archived_at IS NULL ORDER BY u.id FOR SHARE OF u) z;
 END IF;
 IF p_units IS NULL OR cardinality(p_units)>2000 OR array_position(p_units,NULL) IS NOT NULL
   OR (SELECT count(DISTINCT x) FROM unnest(p_units) x)<>cardinality(p_units) OR locked<>cardinality(p_units) THEN
  outcome:='invalid'; result:=jsonb_build_object('status','invalid');
 ELSE
  SELECT coalesce(array_agg(x ORDER BY x),ARRAY[]::uuid[]) INTO wanted FROM unnest(p_units) x;
  SELECT coalesce(array_agg(DISTINCT a.unit_id ORDER BY a.unit_id),ARRAY[]::uuid[]) INTO current_set
  FROM app.b059_unit_assignments a
  WHERE a.org_id=p_org AND (a.member_id=p_target OR a.invitation_id=p_target
   OR (target_user IS NOT NULL AND a.invitation_id IN (SELECT i.id FROM public.invitations i
     WHERE i.org_id=p_org AND i.status='accepted' AND i.accepted_by=target_user)));
  IF wanted=current_set THEN
   outcome:='unchanged'; result:=jsonb_build_object('status','unchanged','units',cardinality(wanted));
  ELSE
   -- Replace the person's set; rows saved on their accepted invitation move to the member row.
   DELETE FROM app.b059_unit_assignments a
   WHERE a.org_id=p_org AND (a.member_id=p_target OR a.invitation_id=p_target
    OR (target_user IS NOT NULL AND a.invitation_id IN (SELECT i.id FROM public.invitations i
      WHERE i.org_id=p_org AND i.status='accepted' AND i.accepted_by=target_user)));
   INSERT INTO app.b059_unit_assignments(org_id,member_id,invitation_id,unit_id,created_by)
   SELECT p_org, CASE WHEN target_kind='member' THEN p_target END, CASE WHEN target_kind='invite' THEN p_target END, x, actor
   FROM unnest(wanted) x;
   INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,old_row,new_row,
    changed_cols,reason,request_id,occurred_at)
   VALUES (p_org,actor,member_role,'b059_unit_assignments',p_target::text,'update','maint_unit_assign_saved',
    jsonb_build_object('target_kind',target_kind,'unit_ids',to_jsonb(current_set)),
    jsonb_build_object('target_kind',target_kind,'unit_ids',to_jsonb(wanted)),ARRAY['unit_ids'],
    'maint_unit_assign_saved',p_request::text,clock_timestamp());
   outcome:='saved'; result:=jsonb_build_object('status','saved','units',cardinality(wanted));
  END IF;
 END IF;
 INSERT INTO app.b059_assign_commands(org_id,request_id,actor_id,target_id,payload_fingerprint,outcome,result)
 VALUES (p_org,p_request,actor,p_target,fingerprint,outcome,result);
 RETURN result || jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON FUNCTION app.b059_assign_save(uuid,uuid,text,uuid,uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b059_assign_save(uuid,uuid,text,uuid,uuid,uuid,uuid[]) TO service_role;

REVOKE ALL ON FUNCTION app.b059_flag_on(uuid), app.b059_scoped_orgs(), app.b059_visible_units(),
 app.b059_own_members(), app.b059_visible_tickets() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b059_scoped_orgs(), app.b059_visible_units(), app.b059_own_members(),
 app.b059_visible_tickets() TO authenticated;
COMMIT;
