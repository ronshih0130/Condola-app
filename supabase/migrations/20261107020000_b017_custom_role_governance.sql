BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Private durable authority. No API role has table privileges, including BYPASSRLS.
CREATE TABLE app.b017_roles (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  current_revision integer NOT NULL CHECK (current_revision > 0),
  retired boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, id)
);
CREATE TABLE app.b017_role_revisions (
  org_id uuid NOT NULL,
  role_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  grants text[] NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, role_id, revision),
  FOREIGN KEY (org_id, role_id) REFERENCES app.b017_roles(org_id, id)
);
ALTER TABLE app.b017_roles ADD CONSTRAINT b017_current_revision_fk
  FOREIGN KEY (org_id, id, current_revision) REFERENCES app.b017_role_revisions(org_id, role_id, revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE app.b017_assignments (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_id uuid,
  revision integer,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES public.org_members(org_id, user_id),
  FOREIGN KEY (org_id, role_id, revision) REFERENCES app.b017_role_revisions(org_id, role_id, revision),
  CHECK ((role_id IS NULL) = (revision IS NULL))
);
COMMENT ON TABLE app.b017_assignments IS 'NULL role is an explicit unassignment tombstone. Status changes and reinvites never delete or reset authority.';
CREATE TABLE app.b017_governance_receipts (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, request_id)
);
ALTER TABLE app.b017_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b017_role_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b017_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b017_governance_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b017_roles, app.b017_role_revisions, app.b017_assignments, app.b017_governance_receipts FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b017_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT coalesce((SELECT o.feature_flags->'custom_roles' = 'true'::jsonb
   AND f.value->'enabled' = 'true'::jsonb
   AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.value->'allowed_org_ids')='array' THEN f.value->'allowed_org_ids' ELSE '[]'::jsonb END) x
                   WHERE jsonb_typeof(x) <> 'string' OR x = '""'::jsonb)
   AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
 FROM public.organizations o JOIN public.platform_settings f ON f.key='custom_roles' WHERE o.id=p_org), false)
$$;

CREATE FUNCTION app.b017_native(p_role text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
 SELECT CASE p_role
 WHEN 'admin' THEN ARRAY['dash.view','props.view','props.edit','leases.edit','tenants.contact','pay.record','pay.reverse','bank.reconcile','stmt.view','stmt.generate','exp.add','month.close','tickets.update','messages.send','reports.export','team.manage','settings.edit','data.export']
 WHEN 'manager' THEN ARRAY['dash.view','props.view','props.edit','leases.edit','tenants.contact','pay.record','stmt.view','exp.add','tickets.update','messages.send','reports.export']
 WHEN 'accountant' THEN ARRAY['dash.view','props.view','pay.record','pay.reverse','bank.reconcile','stmt.view','stmt.generate','exp.add','month.close','reports.export']
 WHEN 'maintenance' THEN ARRAY['tenants.contact','tickets.update'] ELSE ARRAY[]::text[] END
$$;

-- NULL means unavailable, never native fallback. Revisions invalidate assignments
-- deliberately: the Admin must explicitly reassign the current revision.
CREATE FUNCTION app.b017_effective(p_org uuid, p_user uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE m public.org_members; a app.b017_assignments; keys text[];
BEGIN
 SELECT * INTO m FROM public.org_members WHERE org_id=p_org AND user_id=p_user AND status='active';
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT app.b017_enabled(p_org) THEN RETURN app.b017_native(m.role::text); END IF;
 SELECT * INTO a FROM app.b017_assignments WHERE org_id=p_org AND user_id=p_user;
 IF NOT FOUND OR a.role_id IS NULL THEN RETURN app.b017_native(m.role::text); END IF;
 SELECT v.grants INTO keys FROM app.b017_roles r JOIN app.b017_role_revisions v
 ON (v.org_id,v.role_id,v.revision)=(r.org_id,r.id,r.current_revision)
 WHERE r.org_id=p_org AND r.id=a.role_id AND NOT r.retired AND r.current_revision=a.revision;
 RETURN CASE WHEN keys IS NULL THEN NULL ELSE ARRAY(SELECT k FROM unnest(keys) k WHERE k=ANY(app.b017_native(m.role::text))) END;
END $$;

CREATE FUNCTION app.b017_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'B017 immutable history' USING ERRCODE='42501'; END $$;
CREATE TRIGGER b017_revision_immutable BEFORE UPDATE OR DELETE ON app.b017_role_revisions
 FOR EACH ROW EXECUTE FUNCTION app.b017_immutable();
CREATE TRIGGER b017_receipt_immutable BEFORE UPDATE OR DELETE ON app.b017_governance_receipts
 FOR EACH ROW EXECUTE FUNCTION app.b017_immutable();

-- Admission: flag SHARE lock, organization, native Admin members (id order),
-- other members (id order), roles (id order), assignments (user_id order).
-- Taking every role/assignment in the org also covers indirect revise/retire effects.
CREATE FUNCTION app.b017_lock(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
 PERFORM 1 FROM public.platform_settings WHERE key='custom_roles' FOR SHARE;
 PERFORM 1 FROM public.organizations WHERE id=p_org FOR UPDATE;
 IF NOT app.b017_enabled(p_org) THEN RAISE EXCEPTION 'B017 disabled' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.org_members WHERE org_id=p_org ORDER BY (role='admin') DESC,id FOR UPDATE;
 PERFORM 1 FROM app.b017_roles WHERE org_id=p_org ORDER BY id FOR UPDATE;
 PERFORM 1 FROM app.b017_assignments WHERE org_id=p_org ORDER BY user_id FOR UPDATE;
END $$;

CREATE FUNCTION app.b017_session(p_org uuid,p_user uuid,p_session uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT EXISTS (SELECT 1 FROM public.auth_sessions s JOIN public.org_members m ON m.user_id=s.user_id
 WHERE s.id=p_session AND s.user_id=p_user AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND m.org_id=p_org AND m.status='active')
$$;

CREATE FUNCTION app.b017_preserve_admin(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id=p_org AND m.role='admin' AND m.status='active'
   AND app.b017_effective(p_org,m.user_id) @> ARRAY['team.manage','settings.edit'])
 THEN RAISE EXCEPTION 'B017 last usable native Admin' USING ERRCODE='42501'; END IF;
 IF EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id=p_org AND m.is_billing_owner
   AND (m.role<>'admin' OR m.status<>'active' OR NOT coalesce(app.b017_effective(p_org,m.user_id) @> ARRAY['team.manage','settings.edit'],false)))
 THEN RAISE EXCEPTION 'B017 billing owner protection' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION public.b017_resolve(p_org uuid,p_user uuid,p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE keys text[]; native text;
BEGIN
 IF NOT app.b017_enabled(p_org) THEN
   SELECT m.role::text INTO native FROM public.organizations o JOIN public.org_members m
    ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    JOIN public.auth_sessions a ON a.id=p_session AND a.user_id=m.user_id
    WHERE o.id=p_org AND m.user_id=p_user AND m.status='active'
      AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp();
   RETURN jsonb_build_object('enabled',false,'nativeRole',native,'keys',app.b017_native(native));
 END IF;
 IF NOT app.b017_session(p_org,p_user,p_session) THEN RETURN jsonb_build_object('enabled',true,'keys',NULL); END IF;
 SELECT role::text INTO native FROM public.org_members WHERE org_id=p_org AND user_id=p_user AND status='active';
 keys:=app.b017_effective(p_org,p_user);
 RETURN jsonb_build_object('enabled',true,'keys',keys,'nativeRole',native,
   'assigned',EXISTS(SELECT 1 FROM app.b017_assignments WHERE org_id=p_org AND user_id=p_user AND role_id IS NOT NULL),
   'photos',native<>'accountant' AND coalesce('tickets.update'=ANY(keys),false),
   'audit',native='admin' AND keys IS NOT NULL);
END $$;

-- Called only inside an existing server transaction, after business-row waits.
-- NOWAIT fences reverse lock order; failures roll back the whole operation.
-- Lock the session as well: logout/revocation cannot race the final write.
CREATE FUNCTION public.b017_authorize(p_org uuid,p_user uuid,p_session uuid,p_key text,p_photos boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE keys text[]; native text;
BEGIN
 -- A queued custom actor must not carry an added grant across durable disable.
 -- Ordinary deployment-OFF callers never invoke this gateway.
 IF NOT app.b017_enabled(p_org) THEN
   SELECT m.role::text INTO native FROM public.organizations o JOIN public.org_members m
    ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    JOIN public.auth_sessions a ON a.id=p_session AND a.user_id=m.user_id
    WHERE o.id=p_org AND m.user_id=p_user AND m.status='active'
      AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp();
   IF native IS NULL
     OR NOT coalesce(p_key=ANY(app.b017_native(native)),false)
     OR (p_photos AND native='accountant')
   THEN RAISE EXCEPTION 'B017 native authority denied' USING ERRCODE='42501'; END IF;
   RETURN;
 END IF;
 PERFORM 1 FROM public.platform_settings WHERE key='custom_roles' FOR SHARE NOWAIT;
 PERFORM 1 FROM public.organizations WHERE id=p_org FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.org_members WHERE org_id=p_org ORDER BY (role='admin') DESC,id FOR UPDATE NOWAIT;
 PERFORM 1 FROM app.b017_roles WHERE org_id=p_org ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM app.b017_assignments WHERE org_id=p_org ORDER BY user_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.auth_sessions WHERE id=p_session AND user_id=p_user FOR SHARE;
 IF NOT app.b017_enabled(p_org) THEN RAISE EXCEPTION 'B017 admission changed' USING ERRCODE='42501'; END IF;
 IF NOT app.b017_session(p_org,p_user,p_session) THEN RAISE EXCEPTION 'B017 session' USING ERRCODE='42501'; END IF;
 keys:=app.b017_effective(p_org,p_user);
 SELECT role::text INTO native FROM public.org_members WHERE org_id=p_org AND user_id=p_user;
 IF p_key IS NULL AND keys IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.b017_assignments WHERE org_id=p_org AND user_id=p_user AND role_id IS NOT NULL) THEN RETURN; END IF;
 IF NOT coalesce(p_key=ANY(keys),false) OR (p_photos AND native='accountant')
 THEN RAISE EXCEPTION 'B017 current authority denied' USING ERRCODE='42501'; END IF;
END $$;

-- Fixed five operation wrappers below share one private implementation so replay,
-- grant ceilings and the resulting-state safety check cannot diverge.
CREATE FUNCTION app.b017_govern(p_org uuid,p_user uuid,p_session uuid,p_request uuid,p_op text,
 p_role uuid,p_member uuid,p_grants text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE ceiling text[]; desired text[]; actor_role text; target_user uuid; version integer;
 receipt app.b017_governance_receipts; hash text; result jsonb;
BEGIN
 PERFORM app.b017_lock(p_org);
 IF p_request IS NULL OR NOT app.b017_session(p_org,p_user,p_session) THEN RAISE EXCEPTION 'B017 session' USING ERRCODE='42501'; END IF;
 SELECT role::text INTO actor_role FROM public.org_members WHERE org_id=p_org AND user_id=p_user;
 ceiling:=app.b017_effective(p_org,p_user);
 IF actor_role<>'admin' OR NOT coalesce('team.manage'=ANY(ceiling),false) THEN RAISE EXCEPTION 'B017 governance denied' USING ERRCODE='42501'; END IF;
 hash:=encode(public.digest(jsonb_build_array(p_user,p_op,p_role,p_member,p_grants)::text,'sha256'),'hex');
 SELECT * INTO receipt FROM app.b017_governance_receipts WHERE org_id=p_org AND request_id=p_request;
 IF FOUND THEN
   IF receipt.actor_id<>p_user OR receipt.digest<>hash THEN RAISE EXCEPTION 'B017 conflicting replay' USING ERRCODE='22023'; END IF;
   RETURN receipt.result;
 END IF;
 IF p_op IN ('create','revise') THEN
   desired:=p_grants;
   IF desired IS NULL OR array_position(desired,NULL) IS NOT NULL
     OR cardinality(desired)<>(SELECT count(DISTINCT x) FROM unnest(desired) x)
     OR NOT desired <@ array_remove(app.b017_native('admin'),'data.export')
     OR NOT desired <@ ceiling THEN RAISE EXCEPTION 'B017 grant ceiling' USING ERRCODE='42501'; END IF;
 END IF;
 IF p_op='create' THEN
   p_role:=gen_random_uuid(); version:=1;
   INSERT INTO app.b017_roles(org_id,id,current_revision) VALUES(p_org,p_role,version);
   INSERT INTO app.b017_role_revisions(org_id,role_id,revision,grants,created_by) VALUES(p_org,p_role,version,desired,p_user);
 ELSE
   IF p_op<>'unassign' THEN
     SELECT current_revision INTO version FROM app.b017_roles WHERE org_id=p_org AND id=p_role AND NOT retired;
     IF NOT FOUND THEN RAISE EXCEPTION 'B017 role unavailable' USING ERRCODE='42501'; END IF;
   END IF;
   IF p_op='revise' THEN
     version:=version+1;
     INSERT INTO app.b017_role_revisions(org_id,role_id,revision,grants,created_by) VALUES(p_org,p_role,version,desired,p_user);
     UPDATE app.b017_roles SET current_revision=version WHERE org_id=p_org AND id=p_role;
   ELSIF p_op='retire' THEN
     UPDATE app.b017_roles SET retired=true WHERE org_id=p_org AND id=p_role;
   ELSIF p_op IN ('assign','unassign') THEN
     SELECT user_id INTO target_user FROM public.org_members WHERE org_id=p_org AND id=p_member;
     IF NOT FOUND THEN RAISE EXCEPTION 'B017 member unavailable' USING ERRCODE='42501'; END IF;
     IF p_op='assign' THEN
       SELECT grants INTO desired FROM app.b017_role_revisions WHERE org_id=p_org AND role_id=p_role AND revision=version;
     ELSE
       p_role:=NULL; version:=NULL;
       SELECT app.b017_native(role::text) INTO desired FROM public.org_members WHERE org_id=p_org AND id=p_member;
     END IF;
     IF NOT desired <@ ceiling THEN RAISE EXCEPTION 'B017 assignment ceiling' USING ERRCODE='42501'; END IF;
     IF NOT desired <@ (SELECT app.b017_native(role::text) FROM public.org_members WHERE org_id=p_org AND id=p_member)
     THEN RAISE EXCEPTION 'B017 cross-base grants deferred: grants must be a subset of the member native role' USING ERRCODE='42501'; END IF;
     INSERT INTO app.b017_assignments(org_id,user_id,role_id,revision) VALUES(p_org,target_user,p_role,version)
       ON CONFLICT(org_id,user_id) DO UPDATE SET role_id=excluded.role_id, revision=excluded.revision,updated_at=clock_timestamp();
   ELSE RAISE EXCEPTION 'B017 invalid operation' USING ERRCODE='22023'; END IF;
 END IF;
 -- Prevent both direct self-assignment and indirect revise/retire self-lockout.
 IF NOT coalesce(app.b017_effective(p_org,p_user) @> ARRAY['team.manage','settings.edit'],false)
 THEN RAISE EXCEPTION 'B017 self lockout' USING ERRCODE='42501'; END IF;
 PERFORM app.b017_preserve_admin(p_org);
 result:=jsonb_build_object('roleId',p_role,'revision',version,'operation',p_op);
 INSERT INTO app.b017_governance_receipts(org_id,request_id,actor_id,digest,result) VALUES(p_org,p_request,p_user,hash,result);
 RETURN result;
END $$;

CREATE FUNCTION public.b017_create_role(p_org uuid,p_user uuid,p_session uuid,p_request uuid,p_grants text[]) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT app.b017_govern(p_org,p_user,p_session,p_request,'create',NULL,NULL,p_grants) $$;
CREATE FUNCTION public.b017_revise_role(p_org uuid,p_user uuid,p_session uuid,p_request uuid,p_role uuid,p_grants text[]) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT app.b017_govern(p_org,p_user,p_session,p_request,'revise',p_role,NULL,p_grants) $$;
CREATE FUNCTION public.b017_retire_role(p_org uuid,p_user uuid,p_session uuid,p_request uuid,p_role uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT app.b017_govern(p_org,p_user,p_session,p_request,'retire',p_role,NULL,NULL) $$;
CREATE FUNCTION public.b017_assign_role(p_org uuid,p_user uuid,p_session uuid,p_request uuid,p_role uuid,p_member uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT app.b017_govern(p_org,p_user,p_session,p_request,'assign',p_role,p_member,NULL) $$;
CREATE FUNCTION public.b017_unassign_role(p_org uuid,p_user uuid,p_session uuid,p_request uuid,p_member uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT app.b017_govern(p_org,p_user,p_session,p_request,'unassign',NULL,p_member,NULL) $$;

-- Preview is advisory for the TS ceiling; the writer repeats it under locks.
CREATE FUNCTION public.b017_assignment_grants(p_org uuid,p_user uuid,p_session uuid,p_role uuid,p_member uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE result text[];
BEGIN
 IF NOT app.b017_enabled(p_org) OR NOT app.b017_session(p_org,p_user,p_session)
   OR NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user AND role='admin')
   OR NOT coalesce('team.manage'=ANY(app.b017_effective(p_org,p_user)),false)
 THEN RAISE EXCEPTION 'B017 governance denied' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND id=p_member)
 THEN RAISE EXCEPTION 'B017 member unavailable' USING ERRCODE='42501'; END IF;
 IF p_role IS NULL THEN
   SELECT app.b017_native(role::text) INTO result FROM public.org_members WHERE org_id=p_org AND id=p_member;
 ELSE
   SELECT v.grants INTO result FROM app.b017_roles r JOIN app.b017_role_revisions v
    ON (v.org_id,v.role_id,v.revision)=(r.org_id,r.id,r.current_revision)
    WHERE r.org_id=p_org AND r.id=p_role AND NOT r.retired;
 END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'B017 role unavailable' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;

-- ON native team actions share the same locks, live-session check and ceiling.
CREATE FUNCTION public.b017_change_member(p_org uuid,p_user uuid,p_session uuid,p_member uuid,p_role text,p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE target public.org_members; ceiling text[];
BEGIN
 PERFORM app.b017_lock(p_org);
 IF NOT app.b017_session(p_org,p_user,p_session) THEN RAISE EXCEPTION 'B017 session' USING ERRCODE='42501'; END IF;
 ceiling:=app.b017_effective(p_org,p_user);
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user AND role='admin')
   OR NOT coalesce('team.manage'=ANY(ceiling),false)
 THEN RAISE EXCEPTION 'B017 governance denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO target FROM public.org_members WHERE org_id=p_org AND id=p_member;
 IF NOT FOUND OR target.user_id=p_user THEN RAISE EXCEPTION 'B017 self or foreign member' USING ERRCODE='42501'; END IF;
 IF (p_role IS NULL) = (p_status IS NULL) OR (p_role IS NOT NULL AND p_role NOT IN ('admin','manager','accountant','maintenance'))
   OR (p_status IS NOT NULL AND p_status NOT IN ('active','suspended','removed'))
 THEN RAISE EXCEPTION 'B017 invalid member change' USING ERRCODE='22023'; END IF;
 IF p_role IS NOT NULL AND NOT app.b017_native(p_role) <@ ceiling
 THEN RAISE EXCEPTION 'B017 native grant ceiling' USING ERRCODE='42501'; END IF;
 IF p_status='active' AND NOT coalesce(app.b017_effective(p_org,target.user_id),app.b017_native(target.role::text)) <@ ceiling
 THEN RAISE EXCEPTION 'B017 reactivation ceiling' USING ERRCODE='42501'; END IF;
 PERFORM set_config('request.jwt.claim.sub',p_user::text,true);
 UPDATE public.org_members SET role=coalesce(p_role::public.org_role,role),status=coalesce(p_status::public.member_status,status)
 WHERE org_id=p_org AND id=p_member;
 IF p_status IN ('suspended','removed') THEN
   UPDATE public.auth_sessions SET revoked_at=clock_timestamp() WHERE user_id=target.user_id AND revoked_at IS NULL;
 END IF;
 PERFORM app.b017_preserve_admin(p_org);
END $$;

-- Legacy writers may already hold a member tuple before this row trigger.
-- Fence that inversion with NOWAIT instead of waiting on an organization held
-- by a gateway. Only the target org participates: OFF orgs never lock ON orgs.
-- Gateways themselves always use b017_lock's documented parent-first order.
CREATE FUNCTION app.b017_member_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE org uuid;
BEGIN
 org:=CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 IF app.b017_enabled(org) THEN
   PERFORM 1 FROM public.platform_settings WHERE key='custom_roles' FOR SHARE NOWAIT;
   PERFORM 1 FROM public.organizations WHERE id=org FOR UPDATE NOWAIT;
   PERFORM 1 FROM public.org_members WHERE org_id=org ORDER BY (role='admin') DESC,id FOR UPDATE NOWAIT;
   PERFORM 1 FROM app.b017_roles WHERE org_id=org ORDER BY id FOR UPDATE NOWAIT;
   PERFORM 1 FROM app.b017_assignments WHERE org_id=org ORDER BY user_id FOR UPDATE NOWAIT;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b017_member_admission BEFORE INSERT OR UPDATE OR DELETE ON public.org_members
 FOR EACH ROW EXECUTE FUNCTION app.b017_member_admission();

CREATE FUNCTION app.b017_member_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE org uuid; actor uuid:=auth.uid(); ceiling text[];
BEGIN
 org:=CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.user_id) IS DISTINCT FROM (OLD.org_id,OLD.user_id)
   AND (app.b017_enabled(OLD.org_id) OR app.b017_enabled(NEW.org_id))
 THEN RAISE EXCEPTION 'B017 immutable member scope' USING ERRCODE='42501'; END IF;
 IF NOT app.b017_enabled(org) THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' AND OLD.is_billing_owner AND
   (TG_OP='DELETE' OR NOT NEW.is_billing_owner OR NEW.status<>'active' OR NEW.role<>'admin')
 THEN RAISE EXCEPTION 'B017 billing owner protection' USING ERRCODE='42501'; END IF;
 IF actor IS NOT NULL THEN
   ceiling:=app.b017_effective(org,actor);
   IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=org AND user_id=actor AND role='admin' AND status='active')
     OR NOT coalesce('team.manage'=ANY(ceiling),false)
   THEN RAISE EXCEPTION 'B017 native governance denied' USING ERRCODE='42501'; END IF;
   IF TG_OP<>'DELETE' AND NOT coalesce(app.b017_effective(org,NEW.user_id) <@ ceiling, NEW.status<>'active')
   THEN RAISE EXCEPTION 'B017 native grant ceiling' USING ERRCODE='42501'; END IF;
 END IF;
 PERFORM app.b017_preserve_admin(org);
 RETURN NULL;
END $$;
CREATE TRIGGER b017_member_guard AFTER INSERT OR UPDATE OR DELETE ON public.org_members
 FOR EACH ROW EXECUTE FUNCTION app.b017_member_guard();

-- Invitation issuance and acceptance cannot restore grants the inviter has
-- since lost. The existing acceptance UPDATE keeps the assignment/tombstone.
CREATE FUNCTION app.b017_invite_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE ceiling text[];
BEGIN
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.invited_by) IS DISTINCT FROM (OLD.org_id,OLD.invited_by)
   AND (app.b017_enabled(OLD.org_id) OR app.b017_enabled(NEW.org_id))
 THEN RAISE EXCEPTION 'B017 immutable invitation scope' USING ERRCODE='42501'; END IF;
 IF NEW.kind<>'team_member' OR NEW.status NOT IN ('pending','accepted') OR NOT app.b017_enabled(NEW.org_id) THEN RETURN NEW; END IF;
 -- Existing invite writers may hold the org/invitation already. NOWAIT fences
 -- that inversion; a caller retries the complete operation, never a partial write.
 PERFORM 1 FROM public.platform_settings WHERE key='custom_roles' FOR SHARE NOWAIT;
 PERFORM 1 FROM public.organizations WHERE id=NEW.org_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.org_members WHERE org_id=NEW.org_id ORDER BY (role='admin') DESC,id FOR UPDATE NOWAIT;
 PERFORM 1 FROM app.b017_roles WHERE org_id=NEW.org_id ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM app.b017_assignments WHERE org_id=NEW.org_id ORDER BY user_id FOR UPDATE NOWAIT;
 IF auth.uid() IS NOT NULL AND
   (NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=NEW.org_id AND user_id=auth.uid() AND role='admin' AND status='active')
    OR NOT coalesce(app.b017_effective(NEW.org_id,auth.uid()) @> ARRAY['team.manage'],false)
    OR NOT coalesce(app.b017_native(NEW.role::text) <@ app.b017_effective(NEW.org_id,auth.uid()),false))
 THEN RAISE EXCEPTION 'B017 invitation actor ceiling' USING ERRCODE='42501'; END IF;
 ceiling:=app.b017_effective(NEW.org_id,NEW.invited_by);
 IF NOT EXISTS(SELECT 1 FROM public.org_members WHERE org_id=NEW.org_id AND user_id=NEW.invited_by AND role='admin' AND status='active')
  OR NOT coalesce('team.manage'=ANY(ceiling),false)
  OR NOT coalesce(app.b017_native(NEW.role::text) <@ ceiling,false)
 THEN RAISE EXCEPTION 'B017 invitation grant ceiling' USING ERRCODE='42501'; END IF;
 -- Acceptance runs after the member update, in the same transaction and locks.
 -- Check resulting authority, including any retained assignment, not just role.
 IF NEW.status='accepted' AND (NEW.accepted_by IS NULL OR
   NOT coalesce(app.b017_effective(NEW.org_id,NEW.accepted_by) <@ ceiling,false))
 THEN RAISE EXCEPTION 'B017 retained invitation grant ceiling' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b017_invite_guard BEFORE INSERT OR UPDATE ON public.invitations
 FOR EACH ROW EXECUTE FUNCTION app.b017_invite_guard();

-- Restrictive policy intersects existing RLS: genuine portal grants remain as
-- before. Native Accountant cannot use a ticket grant to inspect photo metadata.
CREATE FUNCTION app.b017_photo_allowed(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT NOT app.b017_enabled(p_org) OR NOT EXISTS
 (SELECT 1 FROM public.org_members m WHERE m.org_id=p_org AND m.user_id=auth.uid()) OR EXISTS
 (SELECT 1 FROM public.org_members m WHERE m.org_id=p_org AND m.user_id=auth.uid() AND m.status='active'
  AND m.role<>'accountant' AND 'tickets.update'=ANY(app.b017_effective(p_org,auth.uid())))
$$;
CREATE POLICY b017_ticket_photo_floor ON public.ticket_attachments AS RESTRICTIVE TO authenticated
 USING (app.b017_photo_allowed(org_id)) WITH CHECK (app.b017_photo_allowed(org_id));
CREATE FUNCTION app.b017_file_allowed(p_org uuid,p_file uuid,p_bucket text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT NOT app.b017_enabled(p_org) OR
  (p_bucket<>'ticket-photos-private' AND NOT EXISTS(SELECT 1 FROM public.ticket_attachments WHERE org_id=p_org AND file_id=p_file))
  OR app.b017_photo_allowed(p_org)
$$;
CREATE POLICY b017_file_photo_floor ON public.files AS RESTRICTIVE TO authenticated
 USING (app.b017_file_allowed(org_id,id,storage_bucket))
 WITH CHECK (app.b017_file_allowed(org_id,id,storage_bucket));
CREATE FUNCTION app.b017_audit_allowed(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
 SELECT NOT app.b017_enabled(p_org) OR EXISTS(SELECT 1 FROM public.org_members m
 WHERE m.org_id=p_org AND m.user_id=auth.uid() AND m.role='admin' AND m.status='active'
 AND app.b017_effective(p_org,m.user_id) IS NOT NULL)
$$;
CREATE POLICY b017_company_audit_floor ON public.audit_log AS RESTRICTIVE FOR SELECT TO authenticated
 USING (app.b017_audit_allowed(org_id));

-- db.ts svc()/svcOn() run as service_role. Browser/JWT authenticated users have
-- no EXECUTE on gateways or resolver and no access to the private authority.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('app','public') AND p.proname = ANY(ARRAY['b017_authorize','b017_enabled','b017_native','b017_effective','b017_immutable','b017_lock','b017_session','b017_preserve_admin','b017_resolve','b017_govern','b017_create_role','b017_revise_role','b017_retire_role','b017_assign_role','b017_unassign_role','b017_assignment_grants','b017_change_member','b017_member_admission','b017_member_guard','b017_invite_guard','b017_photo_allowed','b017_file_allowed','b017_audit_allowed'])
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.b017_authorize(uuid,uuid,uuid,text,boolean), public.b017_resolve(uuid,uuid,uuid),
 public.b017_create_role(uuid,uuid,uuid,uuid,text[]), public.b017_revise_role(uuid,uuid,uuid,uuid,uuid,text[]),
 public.b017_retire_role(uuid,uuid,uuid,uuid,uuid), public.b017_assign_role(uuid,uuid,uuid,uuid,uuid,uuid),
 public.b017_unassign_role(uuid,uuid,uuid,uuid,uuid), public.b017_assignment_grants(uuid,uuid,uuid,uuid,uuid),
 public.b017_change_member(uuid,uuid,uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION app.b017_photo_allowed(uuid),app.b017_file_allowed(uuid,uuid,text),app.b017_audit_allowed(uuid) TO authenticated;
COMMIT;
