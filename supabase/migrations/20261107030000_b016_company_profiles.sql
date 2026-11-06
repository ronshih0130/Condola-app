BEGIN;
SET LOCAL lock_timeout = '5s';

-- No backfill, provider installation or flag activation. The only regional
-- definition approved in B-016 is the firm's self-reported TW text profile.
DO $$ BEGIN
  IF current_user IN ('anon','authenticated','service_role') OR
    (SELECT proowner FROM pg_proc WHERE oid='app.payee_gateway(uuid,uuid,uuid,text,uuid,text,uuid,jsonb)'::regprocedure)
      IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'unexpected migration owner';
  END IF;
END $$;

CREATE FUNCTION app.b016_valid_company_data(d jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(d)='object'
   AND d ?& ARRAY['legal_name','tax_id','address']
   AND d-ARRAY['legal_name','tax_id','address']='{}'::jsonb
   AND jsonb_typeof(d->'legal_name')='string' AND length(d->>'legal_name') BETWEEN 1 AND 200
   AND jsonb_typeof(d->'tax_id')='string' AND length(d->>'tax_id')<=100
   AND jsonb_typeof(d->'address')='object'
   AND (d->'address') ?& ARRAY['city','district','street']
   AND (d->'address')-ARRAY['city','district','street']='{}'::jsonb
   AND jsonb_typeof(d->'address'->'city')='string' AND length(d->'address'->>'city')<=100
   AND jsonb_typeof(d->'address'->'district')='string' AND length(d->'address'->>'district')<=100
   AND jsonb_typeof(d->'address'->'street')='string' AND length(d->'address'->>'street')<=300
   AND ((d->'address'->>'city'='' AND d->'address'->>'district'='') OR d->'address'->>'street'<>'')
   AND NOT EXISTS (SELECT 1 FROM jsonb_each_text((d-'address') || (d->'address')) x
     WHERE x.value<>btrim(x.value) OR x.value ~ U&'[\0001-\001F\007F-\009F]'),false)
$$;

CREATE TABLE app.b016_company_profiles (
 org_id uuid PRIMARY KEY REFERENCES public.organizations(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(), current_version uuid,
 UNIQUE(org_id,id)
);
CREATE TABLE app.b016_company_profile_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, profile_id uuid NOT NULL,
 version_no bigint NOT NULL CHECK(version_no>0), request_id uuid NOT NULL,
 expected_version uuid, actor_user_id uuid NOT NULL REFERENCES auth.users(id),
 country_code text NOT NULL CHECK(country_code='TW'),
 address_schema text NOT NULL CHECK(address_schema='company-tw-text-v1'),
 data jsonb NOT NULL CHECK(app.b016_valid_company_data(data)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(org_id,profile_id) REFERENCES app.b016_company_profiles(org_id,id),
 UNIQUE(org_id,id), UNIQUE(org_id,profile_id,id), UNIQUE(org_id,version_no), UNIQUE(org_id,request_id)
);
ALTER TABLE app.b016_company_profiles ADD FOREIGN KEY(org_id,id,current_version)
 REFERENCES app.b016_company_profile_versions(org_id,profile_id,id);

CREATE TABLE app.b016_pending_email_changes (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.organizations(id),
 user_id uuid NOT NULL REFERENCES auth.users(id), session_id uuid NOT NULL REFERENCES public.auth_sessions(id),
 request_id uuid NOT NULL, version uuid NOT NULL DEFAULT gen_random_uuid(),
 current_email text NOT NULL, target_email text NOT NULL,
 current_hash text NOT NULL CHECK(current_hash ~ '^[a-f0-9]{64}$'),
 target_hash text NOT NULL CHECK(target_hash ~ '^[a-f0-9]{64}$'),
 current_verified boolean NOT NULL DEFAULT false, target_verified boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','pending','unknown','verifying','uncertain','consumed')),
 attempt_id uuid, attempt_mailbox text CHECK(attempt_mailbox IN ('current','target')),
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
 CHECK(current_email<>target_email AND current_email=lower(current_email) AND target_email=lower(target_email)),
 CHECK(current_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   AND target_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 CHECK((state='consumed')=(consumed_at IS NOT NULL)),
 CHECK(state<>'consumed' OR (current_verified AND target_verified)),
 CHECK((attempt_id IS NULL)=(attempt_mailbox IS NULL)),
 CHECK(state NOT IN ('verifying','uncertain') OR attempt_id IS NOT NULL),
 UNIQUE(org_id,user_id,request_id)
);
ALTER TABLE app.b016_company_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b016_company_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b016_pending_email_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b016_company_profiles,app.b016_company_profile_versions,app.b016_pending_email_changes
 FROM PUBLIC,anon,authenticated,service_role;

-- Serialize flag changes (including absent rows) before parent locks, as in the
-- existing feature gateways. Live session and membership are read from storage.
CREATE FUNCTION app.b016_admit(p_session uuid,p_org uuid,p_admin boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $$
DECLARE f jsonb; o public.organizations%ROWTYPE; s public.auth_sessions%ROWTYPE; r text;
BEGIN
 IF p_session IS NULL OR p_org IS NULL OR
   current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text OR
   current_setting('app.env',true) IS DISTINCT FROM 'live' THEN RETURN false; END IF;
 LOCK TABLE public.platform_settings IN SHARE MODE;
 SELECT value INTO f FROM public.platform_settings WHERE key='company_profile_edit';
 IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f->'enabled' IS DISTINCT FROM 'true'::jsonb
   OR jsonb_typeof(f->'allowed_org_ids') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(f->'allowed_org_ids') e(value)
   WHERE jsonb_typeof(value)<>'string' OR value #>> '{}' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
   OR NOT(f->'allowed_org_ids' @> jsonb_build_array(p_org::text)) THEN RETURN false; END IF;
 SELECT * INTO o FROM public.organizations WHERE id=p_org FOR SHARE;
 IF NOT FOUND OR o.environment::text<>'live' OR o.live_org_id IS NOT NULL
   OR o.feature_flags->'company_profile_edit' IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
 SELECT * INTO s FROM public.auth_sessions WHERE id=p_session FOR SHARE;
 IF NOT FOUND OR s.user_id::text IS DISTINCT FROM current_setting('request.jwt.claim.sub',true)
   OR s.revoked_at IS NOT NULL OR s.expires_at<=clock_timestamp() THEN RETURN false; END IF;
 SELECT role::text INTO r FROM public.org_members WHERE org_id=p_org AND user_id=s.user_id AND status='active' FOR SHARE;
 RETURN coalesce(r=ANY(CASE WHEN p_admin THEN ARRAY['admin'] ELSE ARRAY['admin','manager','accountant','maintenance'] END),false)
   AND s.expires_at>clock_timestamp();
END $$;

CREATE FUNCTION app.b016_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'immutable company profile version'; END $$;
CREATE TRIGGER b016_version_immutable BEFORE UPDATE OR DELETE ON app.b016_company_profile_versions
 FOR EACH ROW EXECUTE FUNCTION app.b016_immutable();

CREATE FUNCTION app.b016_company_profile_gateway(p_session uuid,p_org uuid,p_op text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $$
DECLARE root app.b016_company_profiles%ROWTYPE; v app.b016_company_profile_versions%ROWTYPE;
 o public.organizations%ROWTYPE; expected uuid; req uuid; data jsonb; actor uuid;
BEGIN
 IF NOT app.b016_admit(p_session,p_org,true) THEN RETURN '{"state":"denied"}'; END IF;
 actor:=current_setting('request.jwt.claim.sub')::uuid;
 SELECT * INTO o FROM public.organizations WHERE id=p_org;
 IF o.country_code::text<>'TW' OR NOT EXISTS(SELECT 1 FROM public.jurisdictions WHERE id=o.jurisdiction_id AND code='TW' AND country_code='TW')
   THEN RETURN '{"state":"unavailable"}'; END IF;
 -- Advisory serialization also covers the first save, without inserting on denied/stale requests.
 PERFORM pg_advisory_xact_lock(hashtextextended('b016-company:'||p_org::text,0));
 IF NOT app.b016_admit(p_session,p_org,true) THEN RETURN '{"state":"denied"}'; END IF;
 SELECT * INTO root FROM app.b016_company_profiles WHERE org_id=p_org;
 IF p_op='read' AND p_payload='{}'::jsonb THEN
   SELECT * INTO v FROM app.b016_company_profile_versions WHERE id=root.current_version;
   RETURN jsonb_build_object('state','ready','version',root.current_version,'country','TW',
     'data',coalesce(v.data,jsonb_build_object('legal_name',coalesce(o.legal_name,o.name),'tax_id',coalesce(o.tax_id,''),
       'address',jsonb_build_object('city','','district','','street',''))));
 END IF;
 IF p_op IS DISTINCT FROM 'save' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
   OR NOT(p_payload ?& ARRAY['request_id','expected_version','data'])
   OR p_payload-ARRAY['request_id','expected_version','data']<>'{}'::jsonb
   OR NOT app.b016_valid_company_data(p_payload->'data') THEN RETURN '{"state":"invalid"}'; END IF;
 req:=(p_payload->>'request_id')::uuid; expected:=(p_payload->>'expected_version')::uuid; data:=p_payload->'data';
 IF req IS NULL THEN RETURN '{"state":"invalid"}'; END IF;
 SELECT * INTO v FROM app.b016_company_profile_versions WHERE org_id=p_org AND request_id=req;
 IF FOUND THEN
   IF v.actor_user_id=actor AND v.data=data AND v.expected_version IS NOT DISTINCT FROM expected THEN
     RETURN jsonb_build_object('state','replayed','version',v.id);
   END IF;
   RETURN '{"state":"invalid"}';
 END IF;
 IF root.current_version IS DISTINCT FROM expected THEN RETURN '{"state":"stale"}'; END IF;
 IF root.id IS NULL THEN
   INSERT INTO app.b016_company_profiles(org_id) VALUES(p_org) RETURNING * INTO root;
 END IF;
 INSERT INTO app.b016_company_profile_versions(org_id,profile_id,version_no,request_id,expected_version,actor_user_id,country_code,address_schema,data)
 VALUES(p_org,root.id,coalesce((SELECT version_no FROM app.b016_company_profile_versions WHERE id=root.current_version),0)+1,
   req,expected,actor,'TW','company-tw-text-v1',data) RETURNING * INTO v;
 UPDATE app.b016_company_profiles SET current_version=v.id WHERE org_id=p_org;
 INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row,request_id)
 VALUES(p_org,actor,'admin','b016_company_profile_versions',v.id::text,'insert','company_profile_saved',
   jsonb_build_object('version',v.id,'fields',jsonb_build_array('legal_name','tax_id','address'),'values','[masked]'),req::text);
 RETURN jsonb_build_object('state','updated','version',v.id);
END $$;

-- The durable store never updates auth.users. Only the injected mock provider
-- may simulate canonical confirmation. The final CAS checks its exact snapshot.
CREATE FUNCTION app.b016_email_gateway(p_session uuid,p_org uuid,p_op text,p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='2s' AS $$
DECLARE actor uuid; pending app.b016_pending_email_changes%ROWTYPE; canonical record;
 mirror text; req uuid; proof_hash text; mailbox text; all_verified boolean; v_now timestamptz;
BEGIN
 IF NOT app.b016_admit(p_session,p_org,false) THEN RETURN '{"state":"denied"}'; END IF;
 actor:=current_setting('request.jwt.claim.sub')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('b016-email:'||actor::text,0));
 IF NOT app.b016_admit(p_session,p_org,false) THEN RETURN '{"state":"denied"}'; END IF;
 SELECT email::text,email_confirmed_at,xmin::text AS version INTO canonical FROM auth.users WHERE id=actor FOR UPDATE;
 SELECT email::text INTO mirror FROM public.profiles WHERE id=actor FOR UPDATE;
 IF canonical.email IS NULL OR canonical.email_confirmed_at IS NULL OR mirror IS NULL THEN RETURN '{"state":"unavailable"}'; END IF;
 IF p_op IS NULL OR p_op NOT IN ('identity','begin','started','load','reserve_verify','verify','uncertain')
   THEN RETURN '{"state":"invalid"}'; END IF;
 IF p_op='identity' THEN
   RETURN jsonb_build_object('state','ready','email',canonical.email,'confirmed',true,'version',canonical.version);
 END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN '{"state":"invalid"}'; END IF;
 IF p_op='begin' THEN
   req:=(p->>'request_id')::uuid;
   SELECT * INTO pending FROM app.b016_pending_email_changes WHERE org_id=p_org AND user_id=actor AND request_id=req;
   IF FOUND THEN
     IF pending.target_email=p->>'target' AND pending.session_id=p_session THEN
       RETURN jsonb_build_object('state','replayed','id',pending.id);
     END IF;
     RETURN '{"state":"invalid"}';
   END IF;
   IF req IS NULL OR lower(canonical.email) IS DISTINCT FROM p->>'current' OR lower(mirror) IS DISTINCT FROM p->>'current'
     OR EXISTS(SELECT 1 FROM app.b016_pending_email_changes WHERE user_id=actor AND state<>'consumed'
       AND (expires_at>clock_timestamp() OR state IN ('verifying','uncertain','unknown'))) -- unresolved provider outcome blocks new initiation even after expiry
     THEN RETURN '{"state":"stale"}'; END IF;
   v_now:=clock_timestamp();
   INSERT INTO app.b016_pending_email_changes(id,org_id,user_id,session_id,request_id,current_email,target_email,current_hash,target_hash,created_at,expires_at)
   VALUES((p->>'id')::uuid,p_org,actor,p_session,req,p->>'current',p->>'target',p->>'current_hash',p->>'target_hash',v_now,v_now+interval '30 minutes') RETURNING * INTO pending;
   RETURN jsonb_build_object('state','reserved','id',pending.id);
 END IF;
 SELECT * INTO pending FROM app.b016_pending_email_changes
 WHERE id=(p->>'id')::uuid AND org_id=p_org AND user_id=actor AND session_id=p_session FOR UPDATE;
 IF NOT FOUND THEN RETURN '{"state":"invalid"}'; END IF;
 IF pending.state='consumed' THEN RETURN '{"state":"rejected"}'; END IF;
 -- A reservation is durable across provider I/O. Neither mailbox can reserve
 -- another proof until this exact attempt completes. Crashed attempts never retry.
 IF pending.state='uncertain' THEN RETURN '{"state":"uncertain"}'; END IF;
 IF pending.state='verifying' THEN
   IF p_op NOT IN ('verify','uncertain') THEN RETURN '{"state":"verifying"}'; END IF;
   IF (p->>'attempt_id')::uuid IS DISTINCT FROM pending.attempt_id THEN RETURN '{"state":"stale"}'; END IF;
   IF p_op='uncertain' THEN
     UPDATE app.b016_pending_email_changes SET state='uncertain' WHERE id=pending.id;
     RETURN '{"state":"uncertain"}';
   END IF;
 END IF;
 IF pending.expires_at<=clock_timestamp() THEN RETURN '{"state":"expired"}'; END IF;
 IF p_op='started' AND pending.state='reserved' AND p->>'state' IN ('pending','unknown') THEN
   UPDATE app.b016_pending_email_changes SET state=p->>'state',version=gen_random_uuid() WHERE id=pending.id;
   RETURN jsonb_build_object('state',p->>'state','id',pending.id);
 END IF;
 IF pending.state NOT IN ('pending','verifying') THEN RETURN '{"state":"unknown"}'; END IF;
 IF p_op='load' THEN
   RETURN jsonb_build_object('state','ready','id',pending.id,'version',pending.version,
     'current',pending.current_email,'target',pending.target_email);
 END IF;
 IF p_op NOT IN ('reserve_verify','verify') THEN RETURN '{"state":"stale"}'; END IF;
 IF p_op='verify' AND (pending.state<>'verifying' OR (p->>'version')::uuid IS DISTINCT FROM pending.version
   OR p->>'mailbox' IS DISTINCT FROM pending.attempt_mailbox) THEN RETURN '{"state":"stale"}'; END IF;
 mailbox:=p->>'mailbox'; proof_hash:=p->>'hash';
 IF mailbox IS NULL OR mailbox NOT IN ('current','target') OR proof_hash IS NULL OR
   (mailbox='current' AND (pending.current_verified OR proof_hash<>pending.current_hash)) OR
   (mailbox='target' AND (pending.target_verified OR proof_hash<>pending.target_hash)) THEN RETURN '{"state":"rejected"}'; END IF;
 IF p_op='reserve_verify' THEN
   IF pending.state<>'pending' OR (p->>'attempt_id')::uuid IS NULL THEN RETURN '{"state":"invalid"}'; END IF;
   UPDATE app.b016_pending_email_changes SET state='verifying',attempt_id=(p->>'attempt_id')::uuid,
     attempt_mailbox=mailbox,version=gen_random_uuid() WHERE id=pending.id RETURNING * INTO pending;
   RETURN jsonb_build_object('state','ready','id',pending.id,'version',pending.version,
     'current',pending.current_email,'target',pending.target_email);
 END IF;
 all_verified:=(pending.current_verified OR mailbox='current') AND (pending.target_verified OR mailbox='target');
 IF NOT all_verified AND p->>'provider' IS DISTINCT FROM 'partial' THEN RETURN '{"state":"unknown"}'; END IF;
 IF all_verified AND (p->>'provider' IS DISTINCT FROM 'final_candidate' OR
   canonical.email IS DISTINCT FROM p->>'canonical_email' OR canonical.version IS DISTINCT FROM p->>'canonical_version'
   OR p->'canonical_confirmed' IS DISTINCT FROM 'true'::jsonb OR lower(canonical.email)<>pending.target_email
   OR lower(mirror)<>pending.current_email) THEN RETURN '{"state":"stale"}'; END IF;
 IF NOT app.b016_admit(p_session,p_org,false) THEN RETURN '{"state":"denied"}'; END IF;
 IF pending.expires_at<=clock_timestamp() THEN RETURN '{"state":"expired"}'; END IF;
 UPDATE app.b016_pending_email_changes SET current_verified=current_verified OR mailbox='current',
   target_verified=target_verified OR mailbox='target',version=gen_random_uuid(),
   state=CASE WHEN all_verified THEN 'consumed' ELSE 'pending' END,
   attempt_id=NULL,attempt_mailbox=NULL,
   consumed_at=CASE WHEN all_verified THEN clock_timestamp() END WHERE id=pending.id;
 IF all_verified THEN
   UPDATE public.profiles SET email=pending.target_email WHERE id=actor;
   INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row,request_id)
   VALUES(p_org,actor,'app','b016_pending_email_changes',pending.id::text,'update','staff_email_changed',
     '{"field":"email","value":"[masked]","adapter":"mock"}',pending.request_id::text);
   RETURN '{"state":"committed"}';
 END IF;
 RETURN '{"state":"partial"}';
END $$;

-- Statements retain issuer facts, separate from unresolved fee policy. Existing
-- statements remain NULL; editing the profile never rewrites an issued document.
ALTER TABLE public.owner_statements ADD COLUMN company_profile_version_id uuid,
 ADD COLUMN company_profile_snapshot jsonb,
 ADD FOREIGN KEY(org_id,company_profile_version_id) REFERENCES app.b016_company_profile_versions(org_id,id),
 ADD CHECK((company_profile_version_id IS NULL)=(company_profile_snapshot IS NULL));
CREATE FUNCTION app.b016_statement_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v app.b016_company_profile_versions%ROWTYPE; sid uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
   IF NEW.company_profile_version_id IS DISTINCT FROM OLD.company_profile_version_id OR
     NEW.company_profile_snapshot IS DISTINCT FROM OLD.company_profile_snapshot THEN
     RAISE EXCEPTION 'immutable statement company snapshot';
   END IF;
   RETURN NEW;
 END IF;
 -- Do not accept caller-injected issuer snapshots, even while OFF.
 NEW.company_profile_version_id:=NULL; NEW.company_profile_snapshot:=NULL;
 sid:=nullif(current_setting('app.b016_session_id',true),'')::uuid;
 -- Legacy OFF insert: no admission SQL, locks or profile reads.
 IF sid IS NULL THEN RETURN NEW; END IF;
 IF NOT app.b016_admit(sid,NEW.org_id,false) THEN RETURN NEW; END IF;
 SELECT v0.* INTO v FROM app.b016_company_profiles p JOIN app.b016_company_profile_versions v0 ON v0.id=p.current_version WHERE p.org_id=NEW.org_id FOR SHARE OF p;
 IF FOUND THEN NEW.company_profile_version_id:=v.id;
   NEW.company_profile_snapshot:=jsonb_build_object('country',v.country_code,'schema',v.address_schema,'data',v.data); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b016_statement_profile BEFORE INSERT OR UPDATE ON public.owner_statements
 FOR EACH ROW EXECUTE FUNCTION app.b016_statement_profile();

REVOKE ALL ON FUNCTION app.b016_valid_company_data(jsonb),app.b016_admit(uuid,uuid,boolean),app.b016_immutable(),
 app.b016_company_profile_gateway(uuid,uuid,text,jsonb),app.b016_email_gateway(uuid,uuid,text,jsonb),app.b016_statement_profile()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b016_company_profile_gateway(uuid,uuid,text,jsonb),app.b016_email_gateway(uuid,uuid,text,jsonb) TO service_role;
COMMIT;
