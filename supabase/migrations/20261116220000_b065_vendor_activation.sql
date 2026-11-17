-- B-065 VF-1 phase A (VEN-17-AC1, AC5…AC7; GS-31): a signed-in vendor self-declares their issuer type from 我的帳號
-- 開立類型. Three types (issuer-types.md): individual (個人（非營業人）師傅), exempt_business (免用統一發票之營業人),
-- invoice_business (使用統一發票之營業人). The declaration is append-only per (org, vendor contact); the latest row is
-- current, and changing it affects only later documents (old PDFs never change). Only the vendor declares it: there is
-- no staff writer (the company must not tick the type), and a staff member of the org is refused even when they also
-- hold a vendor account there. Admission is the B-026 account session and the caller's own vendor account in that
-- org, never a job or document token. Gate: B-065's own vendor_activation flag (seeded OFF),
-- vendor_workbench, the B-026 account gate and effective brand_v3. Audited; every request id (recorded or unchanged)
-- is reserved in a private ledger with its caller, payload and first answer. 0 outbound.
-- Not here (phase B, needs a rendering plan): the direction-1 stamp generator and its consent record (VEN-18-AC2,
-- AC9, AC10); tax-id just-in-time capture and per-type document rules (B-067).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

INSERT INTO public.platform_settings(key,value) VALUES
 ('vendor_activation','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT DO NOTHING;

CREATE TABLE app.b065_issuer_types (
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 issuer_type text NOT NULL CHECK (issuer_type IN ('individual','exempt_business','invoice_business')),
 declared_by uuid NOT NULL,
 declared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id, request_id),
 FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id) ON DELETE CASCADE
);
CREATE INDEX b065_issuer_types_current ON app.b065_issuer_types(org_id, contact_id, declared_at DESC);
ALTER TABLE app.b065_issuer_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b065_issuer_types FROM PUBLIC,anon,authenticated,service_role;

-- Idempotency ledger: one row per accepted request id (recorded or unchanged) with who asked, for which contact, what
-- they asked for and the first answer. A replay by the same caller with the same payload returns that answer.
CREATE TABLE app.b065_issuer_requests (
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 issuer_type text NOT NULL CHECK (issuer_type IN ('individual','exempt_business','invoice_business')),
 answer jsonb NOT NULL CHECK (answer->>'status' IN ('recorded','unchanged')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id, request_id),
 FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id) ON DELETE CASCADE
);
ALTER TABLE app.b065_issuer_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b065_issuer_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b065_enabled(p_org uuid,p_env_v2 boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce((SELECT o.feature_flags->'vendor_activation'='true'::jsonb
  AND coalesce((SELECT f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
    AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
    FROM public.platform_settings f WHERE f.key='vendor_activation'),false)
  AND o.feature_flags->'vendor_workbench'='true'::jsonb
  AND o.feature_flags->'brand_v3'='true'::jsonb
  AND (coalesce(p_env_v2,false) OR o.feature_flags->'brand_v2'='true'::jsonb)
  AND coalesce(app.b026_accounts_enabled(o.id),false)
  FROM public.organizations o WHERE o.id=p_org),false)
$$;
REVOKE ALL ON FUNCTION app.b065_enabled(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Admission: live account session -> its vendor account in this org -> that live vendor contact, and the caller is
-- not a staff member of the org. 42501 otherwise.
-- p_lock (writers): first take, in a fixed order, every row the admission reads or a later write's foreign keys need
-- (the two platform switches, the organization, the caller's vendor account, its contact and any membership row),
-- FOR SHARE, then decide admission with all of them held. The session row is share-locked NOWAIT by
-- b026_account_actor during the decision itself, and the admitted binding and contact must be ones locked here (a
-- binding or a switch row that appeared during a wait is refused, not admitted), so nothing can wait after the
-- decision. The lock target is found by a plain lookup that grants nothing.
CREATE FUNCTION app.b065_account_contact(p_session_hash text,p_org uuid,p_env_v2 boolean,p_lock boolean,
 OUT actor uuid,OUT contact uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target uuid; locked_switches int; locked_org int; locked_accounts uuid[]; locked_contacts uuid[];
BEGIN
 IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' OR p_org IS NULL
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_lock THEN
  SELECT s.user_id INTO target FROM public.auth_sessions s WHERE s.token_hash=p_session_hash;
  IF target IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO locked_switches FROM (SELECT 1 FROM public.platform_settings f
   WHERE f.key IN ('vendor_account','vendor_activation') ORDER BY f.key FOR SHARE) x;
  SELECT count(*) INTO locked_org FROM (SELECT 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE) x;
  SELECT coalesce(array_agg(x.contact_id),'{}') INTO locked_accounts FROM (SELECT va.contact_id FROM app.b026_vendor_accounts va
   WHERE va.org_id=p_org AND va.user_id=target ORDER BY va.contact_id FOR SHARE) x;
  -- Only the contacts of the bindings locked above (a binding inserted meanwhile is not a lock target).
  SELECT coalesce(array_agg(x.id),'{}') INTO locked_contacts FROM (SELECT c.id FROM public.contacts c
   WHERE c.org_id=p_org AND c.id=ANY(locked_accounts) ORDER BY c.id FOR SHARE) x;
  PERFORM 1 FROM public.org_members m WHERE m.org_id=p_org AND m.user_id=target ORDER BY m.id FOR SHARE;
  -- Every row the decision may admit on must be one of the rows locked above; otherwise refuse, never wait.
  IF locked_switches<>2 OR locked_org<>1 OR cardinality(locked_accounts)=0 OR cardinality(locked_contacts)=0
  THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 -- The decision: identical for readers and writers.
 actor:=app.b026_account_actor(p_session_hash);
 IF (p_lock AND actor IS DISTINCT FROM target) OR NOT app.b065_enabled(p_org,p_env_v2)
  OR EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text<>'removed')
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT va.contact_id INTO contact FROM app.b026_vendor_accounts va
  JOIN public.contacts c ON c.org_id=va.org_id AND c.id=va.contact_id AND c.is_vendor AND c.archived_at IS NULL
  WHERE va.org_id=p_org AND va.user_id=actor AND (NOT p_lock OR va.contact_id=ANY(locked_accounts)) ORDER BY va.contact_id LIMIT 1;
 IF contact IS NULL OR (p_lock AND NOT (contact=ANY(locked_accounts) AND contact=ANY(locked_contacts)))
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b065_account_contact(text,uuid,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Read: the caller's current declared type in this org (NULL issuerType when never declared).
CREATE FUNCTION app.b065_issuer_view(p_session_hash text,p_org uuid,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record; current_type text;
BEGIN
 SELECT * INTO a FROM app.b065_account_contact(p_session_hash,p_org,p_env_v2,false);
 SELECT t.issuer_type INTO current_type FROM app.b065_issuer_types t
  WHERE t.org_id=p_org AND t.contact_id=a.contact ORDER BY t.declared_at DESC, t.request_id DESC LIMIT 1;
 RETURN jsonb_build_object('issuerType',current_type);
END $$;
REVOKE ALL ON FUNCTION app.b065_issuer_view(text,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_issuer_view(text,uuid,boolean) TO service_role;

-- Write: declare the type. Lock order: the request key, then the org's declaration key, then (in b065_account_contact)
-- every row the admission or the foreign keys of the inserts below touch, then the admission decision; nothing waits
-- after it (the inserts' FK targets, organizations and contacts, are already share-locked; audit_log has no FKs).
-- Every accepted request id is reserved with its caller, contact, payload and first answer: a replay by the same caller
-- with the same payload returns that answer, anything else under that id is rejected_conflict. The same type again is
-- 'unchanged' (reserved, no declaration, no audit).
CREATE FUNCTION app.b065_save_issuer_type(p_session_hash text,p_org uuid,p_env_v2 boolean,p_request uuid,p_issuer_type text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record; prior app.b065_issuer_requests; current_type text; answer jsonb;
BEGIN
 IF p_request IS NOT NULL AND p_org IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('b065/issuer/'||p_org::text||'/'||p_request::text,0));
 END IF;
 -- Declarations in one org are serialized (rare, tiny writes) so "current" and the audit old value are well defined.
 IF p_org IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('b065/issuer-org/'||p_org::text,0));
 END IF;
 SELECT * INTO a FROM app.b065_account_contact(p_session_hash,p_org,p_env_v2,true);
 IF p_request IS NULL OR p_issuer_type IS NULL OR p_issuer_type NOT IN ('individual','exempt_business','invoice_business')
 THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 SELECT * INTO prior FROM app.b065_issuer_requests r WHERE r.org_id=p_org AND r.request_id=p_request;
 IF FOUND THEN
  IF prior.actor_id=a.actor AND prior.contact_id=a.contact AND prior.issuer_type=p_issuer_type THEN
   RETURN prior.answer||'{"replayed":true}'::jsonb; END IF;
  RETURN '{"status":"rejected_conflict"}'::jsonb;
 END IF;
 SELECT t.issuer_type INTO current_type FROM app.b065_issuer_types t
  WHERE t.org_id=p_org AND t.contact_id=a.contact ORDER BY t.declared_at DESC, t.request_id DESC LIMIT 1;
 IF current_type IS NOT DISTINCT FROM p_issuer_type THEN
  answer:=jsonb_build_object('status','unchanged','issuerType',p_issuer_type,'replayed',false);
 ELSE
  INSERT INTO app.b065_issuer_types(org_id,request_id,contact_id,issuer_type,declared_by)
  VALUES (p_org,p_request,a.contact,p_issuer_type,a.actor);
  INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,old_row,new_row,request_id)
  VALUES (p_org,a.actor,'vendor','contacts',a.contact::text,'update','vendor_issuer_type',
   jsonb_build_object('issuerType',current_type),jsonb_build_object('issuerType',p_issuer_type),p_request::text);
  answer:=jsonb_build_object('status','recorded','issuerType',p_issuer_type,'replayed',false);
 END IF;
 INSERT INTO app.b065_issuer_requests(org_id,request_id,actor_id,contact_id,issuer_type,answer)
 VALUES (p_org,p_request,a.actor,a.contact,p_issuer_type,answer);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION app.b065_save_issuer_type(text,uuid,boolean,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_save_issuer_type(text,uuid,boolean,uuid,text) TO service_role;
COMMIT;
