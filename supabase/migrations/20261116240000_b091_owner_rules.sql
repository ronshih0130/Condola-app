-- B-091 OWN-RULE (OWN-34-AC3/AC4, OWN-36, MGT-130-AC2 amended; Ron's owner round 2026-11-15, grill Q4/Q4b = A):
-- the owner's 授權規則 storage (the renewal rule), its activity log and the staff-side read of each change.
-- Additive, forward-only: two NEW tables (RLS on, no application grants), three NEW migration-owned VOLATILE
-- service-only SECURITY DEFINER gateways (search_path=pg_catalog,pg_temp; EXECUTE to service_role only) and the
-- NEW flag owner_rules seeded OFF without overwriting. No existing object, grant, policy or data changes.
-- The repair limit is NOT here: it stays the existing B-021 owner repair policy (OWN-34-AC2). Screens are B-094.
-- Renewal rule values: delegate_notify 「交給管理方，只要通知我」 (the default when nothing is stored),
-- delegate_unless_lower 「租金不降就交給管理方，要降價才問我」, ask_every_time 「每次都問我」.
-- One rule per owner contact per company (OWN-34-AC3; per-unit rules are out of scope). The owner is the actor's
-- single owner contact in this company that currently owns a non-archived property there (PR-015 org-local rule).
-- Nothing is sent outside the app: the staff "{屋主}改了授權規則" notice reads the change log (b091_staff_rule_changes).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Append-only revisions: the activity log of every change (OWN-34-AC4).
CREATE TABLE app.b091_owner_rule_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  org_id uuid NOT NULL,
  owner_contact_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  renewal_rule text NOT NULL CHECK (renewal_rule IN ('delegate_notify','delegate_unless_lower','ask_every_time')),
  previous_rule text NOT NULL CHECK (previous_rule IN ('delegate_notify','delegate_unless_lower','ask_every_time')),
  request_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (renewal_rule <> previous_rule),
  UNIQUE (org_id, owner_contact_id, revision),
  UNIQUE (org_id, request_id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts (org_id, id)
);
CREATE INDEX b091_owner_rule_revisions_org_seq_idx ON app.b091_owner_rule_revisions (org_id, seq DESC);

-- Every request id is reserved with its outcome (saved, unchanged, stale, invalid): a retry replays the stored
-- result; another actor or payload under the same id is a conflict and never writes.
CREATE TABLE app.b091_owner_rule_commands (
  org_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  owner_contact_id uuid NOT NULL,
  requested_rule text,
  expected_revision integer,
  outcome text NOT NULL CHECK (outcome IN ('saved','unchanged','stale','invalid')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, request_id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts (org_id, id)
);

ALTER TABLE app.b091_owner_rule_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b091_owner_rule_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b091_owner_rule_revisions, app.b091_owner_rule_commands FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app.b091_owner_rule_revisions_seq_seq FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.platform_settings (key, value)
VALUES ('owner_rules', '{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- OWN-34-AC3/AC4 writer (owner app). Statuses: saved | unchanged | stale | invalid | conflict | disabled.
-- Denials raise 42501 and write nothing.
-- Lock order: the request id first (reserved), then every row the admission and the insert depend on (the session,
-- the company and the flag row, the actor's owner contacts, their property_owners and properties), and only then
-- the full admission check. Every wait happens before admission; nothing after it waits (the inserts' FK target,
-- the owner contact, is already locked FOR UPDATE, which also serialises writers for one owner).
CREATE FUNCTION app.b091_owner_rule_set(p_org uuid,p_live uuid,p_env text,p_session uuid,p_request uuid,
 p_rule text,p_expected_revision integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; owner_id uuid; owners integer; prior app.b091_owner_rule_commands; cur record; result jsonb;
 outcome text; new_rev integer; rev_id uuid;
BEGIN
 IF p_org IS NULL OR p_request IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b091/owner-rule/'||p_org::text||'/'||p_request::text,0));
 -- Row locks (waits happen here, before any admission decision).
 SELECT x.user_id INTO actor FROM public.auth_sessions x WHERE x.id=p_session FOR SHARE;
 PERFORM 1 FROM public.organizations o WHERE o.id IN (p_org,p_live) ORDER BY o.id FOR SHARE;
 PERFORM 1 FROM public.platform_settings f WHERE f.key='owner_rules' FOR SHARE;
 PERFORM 1 FROM public.contacts c WHERE c.org_id=p_org AND c.user_id=actor AND c.is_owner ORDER BY c.id FOR UPDATE;
 PERFORM 1 FROM public.property_owners po JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
  WHERE po.org_id=p_org AND c.user_id=actor AND c.is_owner ORDER BY po.id FOR SHARE OF po;
 PERFORM 1 FROM public.properties pr WHERE pr.org_id=p_org AND pr.id IN (SELECT po.property_id FROM public.property_owners po
   JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE po.org_id=p_org AND c.user_id=actor AND c.is_owner)
  ORDER BY pr.id FOR SHARE;
 -- Full admission, after every wait.
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.auth_sessions x
   WHERE x.id=p_session AND x.user_id=actor AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='owner_rules'
  WHERE o.id=p_org AND o.feature_flags->'owner_rules'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) THEN
  RETURN jsonb_build_object('status','disabled');
 END IF;
 SELECT count(DISTINCT c.id),min(c.id::text)::uuid INTO owners,owner_id FROM public.contacts c
 WHERE c.org_id=p_org AND c.user_id=actor AND c.is_owner AND c.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM public.property_owners po
   JOIN public.properties pr ON pr.org_id=po.org_id AND pr.id=po.property_id
   JOIN public.organizations o ON o.id=po.org_id
   WHERE po.org_id=c.org_id AND po.owner_contact_id=c.id AND pr.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date));
 IF owners<>1 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 -- Reserved request ids replay their stored result; another actor, owner or payload is a conflict.
 SELECT * INTO prior FROM app.b091_owner_rule_commands c WHERE c.org_id=p_org AND c.request_id=p_request;
 IF FOUND THEN
  IF prior.actor_id IS DISTINCT FROM actor OR prior.owner_contact_id IS DISTINCT FROM owner_id
    OR prior.requested_rule IS DISTINCT FROM p_rule OR prior.expected_revision IS DISTINCT FROM p_expected_revision THEN
   RETURN jsonb_build_object('status','conflict');
  END IF;
  RETURN prior.result || jsonb_build_object('replayed',true);
 END IF;
 SELECT coalesce(max(r.revision),0) revision,
  coalesce((SELECT r2.renewal_rule FROM app.b091_owner_rule_revisions r2
    WHERE r2.org_id=p_org AND r2.owner_contact_id=owner_id ORDER BY r2.revision DESC LIMIT 1),'delegate_notify') rule
 INTO cur FROM app.b091_owner_rule_revisions r WHERE r.org_id=p_org AND r.owner_contact_id=owner_id;
 IF p_rule IS NULL OR p_rule NOT IN ('delegate_notify','delegate_unless_lower','ask_every_time')
   OR p_expected_revision IS NULL OR p_expected_revision<0 THEN
  outcome:='invalid'; result:=jsonb_build_object('status','invalid');
 ELSIF p_expected_revision<>cur.revision THEN
  outcome:='stale'; result:=jsonb_build_object('status','stale','rule',cur.rule,'revision',cur.revision);
 ELSIF p_rule=cur.rule THEN
  outcome:='unchanged'; result:=jsonb_build_object('status','unchanged','rule',cur.rule,'revision',cur.revision);
 ELSE
  new_rev:=cur.revision+1;
  INSERT INTO app.b091_owner_rule_revisions(org_id,owner_contact_id,revision,renewal_rule,previous_rule,request_id,created_by)
  VALUES (p_org,owner_id,new_rev,p_rule,cur.rule,p_request,actor) RETURNING id INTO rev_id;
  INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,old_row,new_row,changed_cols,reason,request_id,occurred_at)
  VALUES (p_org,actor,'owner','b091_owner_rule_revisions',rev_id::text,'insert','owner_rule_changed',
   jsonb_build_object('owner_contact_id',owner_id,'renewal_rule',cur.rule,'revision',cur.revision),
   jsonb_build_object('owner_contact_id',owner_id,'renewal_rule',p_rule,'revision',new_rev),ARRAY['renewal_rule'],
   'owner_rule_changed',p_request::text,clock_timestamp());
  outcome:='saved'; result:=jsonb_build_object('status','saved','rule',p_rule,'revision',new_rev);
 END IF;
 INSERT INTO app.b091_owner_rule_commands(org_id,request_id,actor_id,owner_contact_id,requested_rule,expected_revision,outcome,result)
 VALUES (p_org,p_request,actor,owner_id,p_rule,p_expected_revision,outcome,result);
 RETURN result || jsonb_build_object('replayed',false);
END $$;
REVOKE ALL ON FUNCTION app.b091_owner_rule_set(uuid,uuid,text,uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b091_owner_rule_set(uuid,uuid,text,uuid,uuid,text,integer) TO service_role;

-- The owner's own rule (OWN-34-AC3): the current rule (default delegate_notify) and its revision. NULL when OFF.
CREATE FUNCTION app.b091_owner_rule_view(p_org uuid,p_live uuid,p_env text,p_session uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; owner_id uuid; owners integer; result jsonb;
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
 IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='owner_rules'
  WHERE o.id=p_org AND o.feature_flags->'owner_rules'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) THEN
  RETURN NULL;
 END IF;
 SELECT count(DISTINCT c.id),min(c.id::text)::uuid INTO owners,owner_id FROM public.contacts c
 WHERE c.org_id=p_org AND c.user_id=actor AND c.is_owner AND c.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM public.property_owners po
   JOIN public.properties pr ON pr.org_id=po.org_id AND pr.id=po.property_id
   JOIN public.organizations o ON o.id=po.org_id
   WHERE po.org_id=c.org_id AND po.owner_contact_id=c.id AND pr.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date));
 IF owners<>1 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('rule',coalesce(r.renewal_rule,'delegate_notify'),'revision',coalesce(r.revision,0),
   'changedAt',r.created_at)
 INTO result
 FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT x.renewal_rule,x.revision,x.created_at FROM app.b091_owner_rule_revisions x
   WHERE x.org_id=p_org AND x.owner_contact_id=owner_id ORDER BY x.revision DESC LIMIT 1) r ON true;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b091_owner_rule_view(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b091_owner_rule_view(uuid,uuid,text,uuid) TO service_role;

-- OWN-34-AC4 staff side: an owner's current rule (when p_owner_contact is given) and the change log, newest first,
-- keyset paged by seq. The 今天 / bell notice 「{屋主}改了授權規則」 reads these entries (rendering is B-094/B-070).
-- Admin, manager and accountant (the roles that see owners). NULL when OFF. Another company's or a non-owner
-- contact is 42501.
CREATE FUNCTION app.b091_staff_rule_changes(p_org uuid,p_live uuid,p_env text,p_session uuid,p_owner_contact uuid,
 p_after bigint DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; result jsonb; page_limit integer:=greatest(1,least(50,coalesce(p_limit,20)));
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
 WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active' FOR SHARE;
 IF member_role IS NULL OR member_role NOT IN ('admin','manager','accountant') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='owner_rules'
  WHERE o.id=p_org AND o.feature_flags->'owner_rules'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) THEN
  RETURN NULL;
 END IF;
 IF p_after IS NOT NULL AND p_after<1 THEN RAISE EXCEPTION 'Invalid owner rule cursor' USING ERRCODE='22023'; END IF;
 IF p_owner_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.contacts c
   WHERE c.org_id=p_org AND c.id=p_owner_contact AND c.is_owner) THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 WITH page AS MATERIALIZED (
  SELECT r.seq,r.owner_contact_id,c.display_name,r.renewal_rule,r.previous_rule,r.revision,r.created_at,
   row_number() OVER (ORDER BY r.seq DESC) rn
  FROM app.b091_owner_rule_revisions r JOIN public.contacts c ON c.org_id=r.org_id AND c.id=r.owner_contact_id
  WHERE r.org_id=p_org AND (p_owner_contact IS NULL OR r.owner_contact_id=p_owner_contact)
   AND (p_after IS NULL OR r.seq<p_after)
  ORDER BY r.seq DESC LIMIT page_limit+1
 )
 SELECT jsonb_build_object(
  'owner',CASE WHEN p_owner_contact IS NULL THEN NULL ELSE (SELECT jsonb_build_object('ownerContactId',c.id,'name',c.display_name,
     'rule',coalesce(r.renewal_rule,'delegate_notify'),'revision',coalesce(r.revision,0),'changedAt',r.created_at)
    FROM public.contacts c LEFT JOIN LATERAL (SELECT x.renewal_rule,x.revision,x.created_at FROM app.b091_owner_rule_revisions x
      WHERE x.org_id=p_org AND x.owner_contact_id=c.id ORDER BY x.revision DESC LIMIT 1) r ON true
    WHERE c.org_id=p_org AND c.id=p_owner_contact) END,
  'changes',coalesce((SELECT jsonb_agg(jsonb_build_object('seq',p.seq::text,'ownerContactId',p.owner_contact_id,'ownerName',p.display_name,
     'rule',p.renewal_rule,'previousRule',p.previous_rule,'revision',p.revision,'changedAt',p.created_at) ORDER BY p.rn)
    FROM page p WHERE p.rn<=page_limit),'[]'::jsonb),
  'next',(SELECT p.seq::text FROM page p WHERE p.rn=page_limit AND EXISTS (SELECT 1 FROM page q WHERE q.rn>page_limit)))
 INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b091_staff_rule_changes(uuid,uuid,text,uuid,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b091_staff_rule_changes(uuid,uuid,text,uuid,uuid,bigint,integer) TO service_role;
COMMIT;
