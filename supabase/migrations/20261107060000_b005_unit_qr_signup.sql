-- B-005 / CAP-M-34: pending applications only. Never an access entitlement.
BEGIN;
INSERT INTO public.platform_settings(key,value)
VALUES ('unit_qr_signup','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT DO NOTHING;

CREATE TABLE app.b005_unit_qr_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  handle_hash text UNIQUE CHECK (handle_hash ~ '^[0-9a-f]{64}$'),
  scan_ip_hash text CHECK (scan_ip_hash ~ '^[0-9a-f]{64}$'),
  scanned_at timestamptz,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  revoked_at timestamptz,
  completed_at timestamptz,
  FOREIGN KEY (org_id,unit_id) REFERENCES public.units(org_id,id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX b005_unit_qr_actor ON app.b005_unit_qr_contexts(org_id,actor_id,created_at);
CREATE INDEX b005_unit_qr_user ON app.b005_unit_qr_contexts(user_id,created_at);
CREATE INDEX b005_unit_qr_ip ON app.b005_unit_qr_contexts(scan_ip_hash,scanned_at);
CREATE TABLE app.b005_unit_qr_applicants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  submitted_name text NOT NULL CHECK (length(btrim(submitted_name)) BETWEEN 1 AND 120),
  submitted_phone text NOT NULL CHECK (submitted_phone ~ '^\+[1-9][0-9]{6,14}$'),
  submitted_email text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status='pending'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,unit_id,user_id),
  FOREIGN KEY (org_id,unit_id) REFERENCES public.units(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY (org_id,contact_id) REFERENCES public.contacts(org_id,id) ON DELETE CASCADE
);
ALTER TABLE app.b005_unit_qr_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b005_unit_qr_applicants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b005_unit_qr_contexts, app.b005_unit_qr_applicants FROM PUBLIC,anon,authenticated,service_role;

-- Each rendered form has its own non-bearer id tied to an exact scanned context.
CREATE TABLE app.b005_unit_qr_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id uuid NOT NULL REFERENCES app.b005_unit_qr_contexts(id) ON DELETE CASCADE
);
-- Persist intent at successful binding, including cross-device confirmation.
CREATE TABLE app.b005_unit_qr_selections (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  context_id uuid NOT NULL REFERENCES app.b005_unit_qr_contexts(id) ON DELETE CASCADE
);
-- Privacy tombstones deliberately survive contact deletion so DELETE audit is
-- also masked. Only the completion gateway can mark a generated contact id.
CREATE TABLE app.b005_unit_qr_contacts (contact_id uuid PRIMARY KEY);
ALTER TABLE app.b005_unit_qr_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b005_unit_qr_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b005_unit_qr_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b005_unit_qr_forms,app.b005_unit_qr_selections,app.b005_unit_qr_contacts
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b005_unit_qr_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings s ON s.key='unit_qr_signup'
 WHERE o.id=p_org AND o.feature_flags->'unit_qr_signup'='true'::jsonb
 AND s.value->'enabled'='true'::jsonb AND jsonb_typeof(s.value->'allowed_org_ids')='array'
 AND s.value->'allowed_org_ids' @> jsonb_build_array(o.id::text));
$$;
-- All writers admit settings before organization/parents, fencing flag changes.
CREATE FUNCTION app.b005_unit_qr_admit(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 LOCK TABLE public.platform_settings IN SHARE MODE;
 PERFORM 1 FROM public.organizations WHERE id=p_org FOR UPDATE;
 RETURN app.b005_unit_qr_enabled(p_org);
END $$;
CREATE FUNCTION app.b005_unit_qr_staff(p_org uuid,p_user uuid,p_session uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.b005_unit_qr_enabled(p_org) AND EXISTS (
 SELECT 1 FROM public.org_members m JOIN public.auth_sessions s ON s.user_id=m.user_id
 WHERE m.org_id=p_org AND m.user_id=p_user AND m.status='active' AND m.role IN ('admin','manager')
 AND s.id=p_session AND s.revoked_at IS NULL AND s.expires_at>now());
$$;
CREATE FUNCTION app.b005_unit_qr_issue(p_org uuid,p_unit uuid,p_user uuid,p_session uuid,p_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_id uuid;
BEGIN
 IF NOT app.b005_unit_qr_admit(p_org) OR NOT app.b005_unit_qr_staff(p_org,p_user,p_session) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user FOR SHARE;
 PERFORM 1 FROM public.auth_sessions WHERE id=p_session FOR SHARE;
 IF NOT app.b005_unit_qr_staff(p_org,p_user,p_session) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.units u JOIN public.properties p ON p.id=u.property_id AND p.org_id=u.org_id
 WHERE u.org_id=p_org AND u.id=p_unit AND u.archived_at IS NULL AND p.archived_at IS NULL FOR SHARE OF u,p;
 IF NOT FOUND OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM app.b005_unit_qr_contexts WHERE org_id=p_org AND actor_id=p_user AND created_at>now()-interval '30 minutes')>=10 THEN RETURN NULL; END IF;
 INSERT INTO app.b005_unit_qr_contexts(org_id,unit_id,actor_id,token_hash) VALUES(p_org,p_unit,p_user,p_hash) RETURNING id INTO v_id;
 RETURN v_id;
END $$;
CREATE FUNCTION app.b005_unit_qr_revoke(p_org uuid,p_id uuid,p_user uuid,p_session uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.b005_unit_qr_admit(p_org) OR NOT app.b005_unit_qr_staff(p_org,p_user,p_session) THEN RETURN false; END IF;
 PERFORM 1 FROM public.org_members WHERE org_id=p_org AND user_id=p_user FOR SHARE;
 PERFORM 1 FROM public.auth_sessions WHERE id=p_session FOR SHARE;
 IF NOT app.b005_unit_qr_staff(p_org,p_user,p_session) THEN RETURN false; END IF;
 UPDATE app.b005_unit_qr_contexts SET revoked_at=now() WHERE id=p_id AND org_id=p_org AND revoked_at IS NULL;
 RETURN FOUND;
END $$;
CREATE FUNCTION app.b005_unit_qr_scan(p_hash text,p_handle text,p_ip text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_org uuid; v_id uuid;
BEGIN
 SELECT org_id,id INTO v_org,v_id FROM app.b005_unit_qr_contexts WHERE token_hash=p_hash;
 IF v_org IS NULL OR NOT app.b005_unit_qr_admit(v_org) THEN RETURN false; END IF;
 IF p_handle IS NULL OR p_handle !~ '^[0-9a-f]{64}$' OR p_ip IS NULL OR p_ip !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 -- A single scan exchanges the QR for a browser handle; rate limit spans organizations.
 PERFORM pg_advisory_xact_lock(hashtextextended('b005-qr-ip:'||p_ip,0));
 IF (SELECT count(*) FROM app.b005_unit_qr_contexts WHERE scan_ip_hash=p_ip AND scanned_at>now()-interval '30 minutes')>=20 THEN RETURN false; END IF;
 PERFORM 1 FROM app.b005_unit_qr_contexts c JOIN public.units u ON u.id=c.unit_id AND u.org_id=c.org_id
 JOIN public.properties p ON p.id=u.property_id AND p.org_id=u.org_id
 WHERE c.id=v_id AND c.expires_at>now() AND c.revoked_at IS NULL AND c.handle_hash IS NULL
 AND u.archived_at IS NULL AND p.archived_at IS NULL FOR SHARE OF u,p;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE app.b005_unit_qr_contexts SET handle_hash=p_handle,scan_ip_hash=p_ip,scanned_at=now()
 WHERE id=v_id AND handle_hash IS NULL AND revoked_at IS NULL AND expires_at>now();
 RETURN FOUND;
END $$;
CREATE FUNCTION app.b005_unit_qr_context(p_handle text,p_user uuid DEFAULT NULL)
RETURNS TABLE(id uuid,done boolean,active boolean,enabled boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT c.id,c.completed_at IS NOT NULL,
 c.expires_at>now() AND c.revoked_at IS NULL AND u.archived_at IS NULL AND p.archived_at IS NULL,
 app.b005_unit_qr_enabled(c.org_id)
 FROM app.b005_unit_qr_contexts c
 JOIN public.units u ON u.id=c.unit_id AND u.org_id=c.org_id
 JOIN public.properties p ON p.id=u.property_id AND p.org_id=u.org_id
 WHERE ((p_handle IS NOT NULL AND c.handle_hash=p_handle)
 OR (p_handle IS NULL AND p_user IS NOT NULL AND c.user_id=p_user
   AND c.id=(SELECT s.context_id FROM app.b005_unit_qr_selections s WHERE s.user_id=p_user)));
$$;
CREATE FUNCTION app.b005_unit_qr_form(p_handle text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_org uuid; v_id uuid; v_form uuid;
BEGIN
 SELECT org_id,id INTO v_org,v_id FROM app.b005_unit_qr_contexts WHERE handle_hash=p_handle;
 IF v_org IS NULL OR NOT app.b005_unit_qr_admit(v_org) THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM app.b005_unit_qr_context(p_handle,NULL) WHERE active AND NOT done) THEN RETURN NULL; END IF;
 INSERT INTO app.b005_unit_qr_forms(context_id) VALUES(v_id) RETURNING id INTO v_form;
 RETURN v_form;
END $$;
CREATE FUNCTION app.b005_unit_qr_form_matches(p_form uuid,p_handle text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS (SELECT 1 FROM app.b005_unit_qr_forms f
 JOIN app.b005_unit_qr_context(p_handle,NULL) c ON c.id=f.context_id
 WHERE f.id=p_form AND c.active AND c.enabled AND NOT c.done);
$$;
CREATE FUNCTION app.b005_unit_qr_bind(p_handle text,p_user uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_org uuid;
BEGIN
 SELECT org_id INTO v_org FROM app.b005_unit_qr_contexts WHERE handle_hash=p_handle;
 IF v_org IS NULL OR p_user IS NULL OR NOT app.b005_unit_qr_admit(v_org) THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM app.b005_unit_qr_context(p_handle,p_user) WHERE active) THEN RETURN false; END IF;
 UPDATE app.b005_unit_qr_contexts SET user_id=p_user WHERE handle_hash=p_handle AND (user_id IS NULL OR user_id=p_user);
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO app.b005_unit_qr_selections(user_id,context_id)
 SELECT p_user,id FROM app.b005_unit_qr_contexts WHERE handle_hash=p_handle
 ON CONFLICT(user_id) DO UPDATE SET context_id=excluded.context_id;
 RETURN true;
END $$;
CREATE FUNCTION app.b005_unit_qr_complete(p_id uuid,p_user uuid,p_name text,p_phone text)
RETURNS TABLE(id uuid,org_id uuid,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_org uuid; v_ctx app.b005_unit_qr_contexts; v_contact uuid; v_id uuid; v_email text;
BEGIN
 SELECT c.org_id INTO v_org FROM app.b005_unit_qr_contexts c WHERE c.id=p_id AND c.user_id=p_user;
 IF v_org IS NULL OR NOT app.b005_unit_qr_admit(v_org) THEN RETURN; END IF;
 SELECT * INTO v_ctx FROM app.b005_unit_qr_contexts c WHERE c.id=p_id AND c.user_id=p_user FOR UPDATE;
 IF v_ctx.revoked_at IS NOT NULL OR v_ctx.expires_at<=now() THEN RETURN; END IF;
 PERFORM 1 FROM public.units u JOIN public.properties p ON p.id=u.property_id AND p.org_id=u.org_id
 WHERE u.id=v_ctx.unit_id AND u.org_id=v_org AND u.archived_at IS NULL AND p.archived_at IS NULL FOR SHARE OF u,p;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id=p_user AND u.email_confirmed_at IS NOT NULL FOR SHARE;
 IF v_email IS NULL OR nullif(btrim(p_name),'') IS NULL OR length(p_name)>120 OR p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{6,14}$' THEN RETURN; END IF;
 SELECT a.id INTO v_id FROM app.b005_unit_qr_applicants a WHERE a.org_id=v_org AND a.unit_id=v_ctx.unit_id AND a.user_id=p_user;
 IF v_id IS NOT NULL THEN
   UPDATE app.b005_unit_qr_contexts SET completed_at=coalesce(completed_at,now()) WHERE b005_unit_qr_contexts.id=p_id;
   RETURN QUERY SELECT v_id,v_org,false; RETURN;
 END IF;
 -- Organization admission serializes all QR contacts, including different units.
 -- First reuse this identity's private mapping; email is never an identity proof.
 SELECT c.id INTO v_contact FROM app.b005_unit_qr_applicants a
 JOIN public.contacts c ON c.id=a.contact_id AND c.org_id=a.org_id
 WHERE a.org_id=v_org AND a.user_id=p_user AND c.archived_at IS NULL AND c.is_tenant
 AND (c.user_id IS NULL OR c.user_id=p_user)
 AND NOT EXISTS (SELECT 1 FROM app.b005_unit_qr_applicants other
   WHERE other.org_id=v_org AND other.contact_id=c.id AND other.user_id<>p_user)
 ORDER BY a.created_at,a.id LIMIT 1 FOR UPDATE OF c;
 IF v_contact IS NULL THEN
   SELECT c.id INTO v_contact FROM public.contacts c
   WHERE c.org_id=v_org AND c.is_tenant AND c.archived_at IS NULL AND c.user_id=p_user
   AND NOT EXISTS (SELECT 1 FROM app.b005_unit_qr_applicants other
     WHERE other.org_id=v_org AND other.contact_id=c.id AND other.user_id<>p_user)
   ORDER BY c.id LIMIT 1 FOR UPDATE;
 END IF;
 IF v_contact IS NULL THEN
   -- Email-only matches require explicit staff reconciliation, never auto-merge.
   -- Keep verified email privately; the tenant directory has a unique email index.
   v_contact := gen_random_uuid();
   INSERT INTO app.b005_unit_qr_contacts(contact_id) VALUES(v_contact);
   INSERT INTO public.contacts(id,org_id,display_name,phone_e164,is_tenant)
   VALUES(v_contact,v_org,btrim(p_name),p_phone,true);
 END IF;
 -- Pending applications cannot unlock existing leases or overwrite directory data.
 INSERT INTO app.b005_unit_qr_applicants(org_id,unit_id,user_id,contact_id,submitted_name,submitted_phone,submitted_email)
 VALUES(v_org,v_ctx.unit_id,p_user,v_contact,btrim(p_name),p_phone,v_email) RETURNING b005_unit_qr_applicants.id INTO v_id;
 UPDATE public.profiles SET display_name=btrim(p_name) WHERE profiles.id=p_user;
 UPDATE app.b005_unit_qr_contexts SET completed_at=now() WHERE b005_unit_qr_contexts.id=p_id;
 RETURN QUERY SELECT v_id,v_org,true;
END $$;

-- Preserve generic contact auditing byte-for-byte for ordinary contacts; QR
-- contacts use a masked helper for INSERT/UPDATE/DELETE, before audit persistence.
CREATE FUNCTION app.b005_unit_qr_contact_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE
 o jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
 n jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
 cols text[];
BEGIN
 IF TG_OP='UPDATE' THEN
   SELECT array_agg(k) INTO cols FROM jsonb_each(n) e(k,v) WHERE o->k IS DISTINCT FROM v AND k<>'updated_at';
   IF cols IS NULL THEN RETURN NEW; END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM app.b005_unit_qr_contacts WHERE contact_id=coalesce(NEW.id,OLD.id)) THEN
   IF o IS NOT NULL THEN o := o || jsonb_build_object('display_name','[redacted]','phone_e164','[redacted]','email','[redacted]'); END IF;
   IF n IS NOT NULL THEN n := n || jsonb_build_object('display_name','[redacted]','phone_e164','[redacted]','email','[redacted]'); END IF;
 END IF;
 INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,old_row,new_row,changed_cols,reason,request_id)
 VALUES(coalesce((n->>'org_id')::uuid,(o->>'org_id')::uuid),auth.uid(),current_user,TG_TABLE_NAME,
   coalesce(n->>'id',o->>'id'),lower(TG_OP)::public.audit_action,o,n,cols,
   nullif(current_setting('app.change_reason',true),''),nullif(current_setting('app.request_id',true),''));
 RETURN coalesce(NEW,OLD);
END $$;
DROP TRIGGER trg_contacts_audit ON public.contacts;
CREATE TRIGGER trg_contacts_audit AFTER INSERT OR UPDATE OR DELETE ON public.contacts
 FOR EACH ROW EXECUTE FUNCTION app.b005_unit_qr_contact_audit();
REVOKE ALL ON FUNCTION app.b005_unit_qr_contact_audit() FROM PUBLIC,anon,authenticated,service_role;

-- Guard both sides of identity ownership. Contact row locks serialize inserts
-- across units and directory/user binding changes, even outside the QR gateway.
CREATE FUNCTION app.b005_unit_qr_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_user uuid;
BEGIN
 IF TG_TABLE_SCHEMA='app' THEN
   SELECT c.user_id INTO v_user FROM public.contacts c WHERE c.org_id=NEW.org_id AND c.id=NEW.contact_id FOR UPDATE;
   IF (v_user IS NOT NULL AND v_user<>NEW.user_id) OR EXISTS (
     SELECT 1 FROM app.b005_unit_qr_applicants a WHERE a.org_id=NEW.org_id AND a.contact_id=NEW.contact_id AND a.user_id<>NEW.user_id
   ) THEN RAISE EXCEPTION 'applicant_identity_conflict' USING ERRCODE='23514'; END IF;
 ELSE
   IF NEW.user_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM app.b005_unit_qr_applicants a WHERE a.org_id=NEW.org_id AND a.contact_id=NEW.id AND a.user_id<>NEW.user_id
   ) THEN RAISE EXCEPTION 'applicant_identity_conflict' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b005_applicant_identity BEFORE INSERT OR UPDATE ON app.b005_unit_qr_applicants
 FOR EACH ROW EXECUTE FUNCTION app.b005_unit_qr_identity_guard();
CREATE TRIGGER b005_contact_identity BEFORE UPDATE OF user_id ON public.contacts
 FOR EACH ROW WHEN (NEW.user_id IS DISTINCT FROM OLD.user_id) EXECUTE FUNCTION app.b005_unit_qr_identity_guard();
REVOKE ALL ON FUNCTION app.b005_unit_qr_identity_guard() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION app.b005_unit_qr_enabled(uuid),app.b005_unit_qr_admit(uuid),
 app.b005_unit_qr_staff(uuid,uuid,uuid),app.b005_unit_qr_issue(uuid,uuid,uuid,uuid,text),
 app.b005_unit_qr_revoke(uuid,uuid,uuid,uuid),app.b005_unit_qr_scan(text,text,text),
 app.b005_unit_qr_form(text),app.b005_unit_qr_form_matches(uuid,text),
 app.b005_unit_qr_context(text,uuid),app.b005_unit_qr_bind(text,uuid),app.b005_unit_qr_complete(uuid,uuid,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b005_unit_qr_enabled(uuid),app.b005_unit_qr_staff(uuid,uuid,uuid),
 app.b005_unit_qr_issue(uuid,uuid,uuid,uuid,text),app.b005_unit_qr_revoke(uuid,uuid,uuid,uuid),
 app.b005_unit_qr_scan(text,text,text),app.b005_unit_qr_form(text),app.b005_unit_qr_form_matches(uuid,text),
 app.b005_unit_qr_context(text,uuid),app.b005_unit_qr_bind(text,uuid),
 app.b005_unit_qr_complete(uuid,uuid,text,text) TO service_role;
COMMIT;
