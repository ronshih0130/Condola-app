-- B-033 slice 2. Additive deployment; controlled configuration and local auth only.
BEGIN;
SET LOCAL lock_timeout='3s';
INSERT INTO public.platform_settings(key,value) VALUES
 ('line_tenant_portal','{"enabled":false,"allowed_org_ids":[]}'),
 ('line_vendor_portal','{"enabled":false,"allowed_org_ids":[]}'),
 ('line_owner_portal','{"enabled":false,"allowed_org_ids":[]}') ON CONFLICT(key) DO NOTHING;
ALTER TABLE app.b033_line_flows
 ADD COLUMN org_id uuid REFERENCES public.organizations(id),
 ADD COLUMN contact_id uuid,
 ADD COLUMN invitation_id uuid REFERENCES public.invitations(id),
 ADD COLUMN invitation_hash text,
 ADD COLUMN user_id uuid REFERENCES auth.users(id),
 ADD COLUMN browser_hash text,
 ADD COLUMN csrf_hash text,
 ADD COLUMN pkce_hash text,
 ADD COLUMN oauth_started_at timestamptz,
 ADD COLUMN verified_hash text,
 ADD COLUMN verified_at timestamptz,
 ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 ADD COLUMN return_path text,
 ADD CONSTRAINT b033_flow_contact FOREIGN KEY(org_id,contact_id) REFERENCES public.contacts(org_id,id);
ALTER TABLE public.line_account_links ADD COLUMN persona text CHECK(persona IN ('tenant','vendor','owner'));
-- Trusted links do not store raw provider identifiers. Legacy links retain their original constraint.
ALTER TABLE public.line_account_links DROP CONSTRAINT line_account_links_check;
ALTER TABLE public.line_account_links ADD CONSTRAINT line_account_links_check
 CHECK(status<>'linked' OR (linked_at IS NOT NULL AND (line_user_id IS NOT NULL OR login_identity_id IS NOT NULL)));
CREATE TABLE app.b033_line_sessions (
 session_id uuid PRIMARY KEY REFERENCES public.auth_sessions(id) ON DELETE CASCADE,
 identity_id uuid NOT NULL REFERENCES app.b033_line_identities(id),
 flow_id uuid NOT NULL UNIQUE REFERENCES app.b033_line_flows(id)
);
-- Private, session-bound proof of an explicit password (+ required MFA) step-up.
CREATE TABLE app.b033_line_stepups (
 session_id uuid PRIMARY KEY REFERENCES public.auth_sessions(id) ON DELETE CASCADE,
 authenticated_at timestamptz NOT NULL,
 mfa_verified boolean NOT NULL,
 credential_hash text NOT NULL CHECK(credential_hash ~ '^[0-9a-f]{64}$')
);
ALTER TABLE app.b033_line_stepups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b033_line_stepups FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON app.b033_line_stepups TO service_role;
CREATE TABLE app.b033_line_limits (
 key_hash text PRIMARY KEY CHECK(key_hash ~ '^[0-9a-f]{64}$'),
 attempts integer NOT NULL, reset_at timestamptz NOT NULL
);
ALTER TABLE app.b033_line_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b033_line_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b033_line_sessions,app.b033_line_limits FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON app.b033_line_sessions TO service_role;
GRANT SELECT,INSERT,UPDATE ON app.b033_line_limits TO service_role;

CREATE FUNCTION app.b033_portal_enabled(p_org uuid,p_persona text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF p_persona NOT IN ('tenant','owner','vendor') OR app.b033_line_enabled(p_org) IS NOT TRUE THEN RETURN false; END IF;
 RETURN coalesce((SELECT o.feature_flags->('line_'||p_persona||'_portal')='true'::jsonb
  AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
  AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
  FROM public.organizations o JOIN public.platform_settings f ON f.key='line_'||p_persona||'_portal'
  WHERE o.id=p_org),false);
END $$;
-- Vendor mappings remain job-scoped in B-026. No job assignment or contact ownership is created here.
CREATE FUNCTION app.b033_contact_user(p_org uuid,p_contact uuid,p_persona text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT CASE WHEN p_persona='vendor' THEN
   (SELECT a.user_id FROM app.b026_vendor_accounts a WHERE a.org_id=c.org_id AND a.contact_id=c.id
     AND app.b026_accounts_enabled(c.org_id)) ELSE c.user_id END
 FROM public.contacts c WHERE c.org_id=p_org AND c.id=p_contact AND c.archived_at IS NULL
 AND CASE p_persona WHEN 'tenant' THEN c.is_tenant WHEN 'owner' THEN c.is_owner WHEN 'vendor' THEN c.is_vendor ELSE false END
$$;
CREATE FUNCTION app.b033_liff_config_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF current_user IN ('anon','authenticated','service_role') AND
  ((TG_OP='INSERT' AND (NEW.liff_id_tenant IS NOT NULL OR NEW.liff_id_vendor IS NOT NULL OR NEW.liff_id_owner IS NOT NULL))
   OR (TG_OP='UPDATE' AND ROW(NEW.liff_id_tenant,NEW.liff_id_vendor,NEW.liff_id_owner)
     IS DISTINCT FROM ROW(OLD.liff_id_tenant,OLD.liff_id_vendor,OLD.liff_id_owner))) THEN
  RAISE EXCEPTION 'LIFF configuration requires gateway' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b033_liff_config_guard BEFORE INSERT OR UPDATE ON public.line_channels
 FOR EACH ROW EXECUTE FUNCTION app.b033_liff_config_guard();
CREATE FUNCTION app.b033_liff_configure(p_channel uuid,p_tenant text,p_vendor text,p_owner text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 UPDATE public.line_channels SET liff_id_tenant=p_tenant,liff_id_vendor=p_vendor,liff_id_owner=p_owner
 WHERE id=p_channel AND (nullif(current_setting('app.active_org_id',true),'') IS NULL
  OR org_id::text=current_setting('app.active_org_id',true));
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
END $$;
-- Common link gateway: callers verify LINE and credentials inside their enclosing transaction.
-- The gateway independently rechecks scope and never turns a legacy line_user_id into authority.
CREATE FUNCTION app.b033_link(p_flow uuid,p_hash text,p_user uuid,p_consent text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE f app.b033_line_flows%ROWTYPE; ident app.b033_line_identities%ROWTYPE; link public.line_account_links%ROWTYPE; lid uuid;
BEGIN
 SELECT * INTO f FROM app.b033_line_flows WHERE id=p_flow FOR UPDATE;
 IF NOT FOUND OR f.kind NOT IN ('bind','invite') OR f.verified_hash IS DISTINCT FROM p_hash
  OR f.expires_at<=clock_timestamp() OR f.consumed_at IS NOT NULL OR f.attempts>5 THEN
  RAISE EXCEPTION 'already_consumed' USING ERRCODE='P0033'; END IF;
 PERFORM 1 FROM public.contacts WHERE org_id=f.org_id AND id=f.contact_id FOR UPDATE;
 IF app.b033_portal_enabled(f.org_id,f.persona) IS NOT TRUE
  OR app.b033_selected_channel(f.org_id) IS DISTINCT FROM f.line_channel_id
  OR app.b033_contact_user(f.org_id,f.contact_id,f.persona) IS DISTINCT FROM p_user THEN
  RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 IF p_consent IS NULL OR p_consent<>'line.binding.v1' THEN RAISE EXCEPTION 'consent_required' USING ERRCODE='P0033'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(f.line_channel_id::text||p_hash,33));
 SELECT * INTO ident FROM app.b033_line_identities WHERE line_channel_id=f.line_channel_id AND provider_user_hash=p_hash FOR UPDATE;
 IF FOUND AND (ident.user_id<>p_user OR ident.status<>'linked') THEN
  RAISE EXCEPTION 'identity_conflict' USING ERRCODE='P0033'; END IF;
 IF ident.id IS NULL THEN
  INSERT INTO app.b033_line_identities(line_channel_id,provider_user_hash,user_id,persona)
   VALUES(f.line_channel_id,p_hash,p_user,f.persona) RETURNING * INTO ident;
 END IF;
 SELECT * INTO link FROM public.line_account_links WHERE contact_id=f.contact_id AND line_channel_id=f.line_channel_id
  AND status IN ('pending','linked') FOR UPDATE;
 IF FOUND AND (link.login_identity_id IS DISTINCT FROM ident.id OR link.persona IS DISTINCT FROM f.persona) THEN
  RAISE EXCEPTION 'identity_conflict' USING ERRCODE='P0033'; END IF;
 IF link.id IS NULL THEN
  INSERT INTO public.line_account_links(org_id,contact_id,line_channel_id,status,invitation_id,login_identity_id,
   persona,identity_verified_at,linked_at,consented_at,consent_text_key,notification_opt_in,is_friend)
  VALUES(f.org_id,f.contact_id,f.line_channel_id,'linked',f.invitation_id,ident.id,f.persona,now(),now(),now(),p_consent,true,ident.friend_state)
  RETURNING id INTO lid;
 ELSE lid:=link.id;
 END IF;
 RETURN lid;
END $$;
-- Slice 1's guard is extended only for already-established B-026 vendor mappings.
CREATE OR REPLACE FUNCTION app.b033_link_verified_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF current_setting('role',true) IN ('anon','authenticated') AND
  (NEW.login_identity_id IS NOT NULL OR NEW.identity_verified_at IS NOT NULL OR NEW.notification_opt_in
   OR NEW.friend_event_at IS NOT NULL OR NEW.friend_event_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Verified link requires service' USING ERRCODE='42501'; END IF;
 -- Deactivation retains historical identity/scope; it must not require today's contact mapping.
 -- Do not allow this exception to insert, retarget, or reactivate a link.
 IF TG_OP='UPDATE' AND NEW.status='unlinked' AND NEW.unlinked_at IS NOT NULL
  AND NOT NEW.notification_opt_in AND OLD.login_identity_id IS NOT NULL
  AND ROW(NEW.id,NEW.org_id,NEW.contact_id,NEW.line_channel_id,NEW.login_identity_id,NEW.persona)
   IS NOT DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.contact_id,OLD.line_channel_id,OLD.login_identity_id,OLD.persona) THEN
  RETURN NEW;
 END IF;
 IF NEW.login_identity_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM app.b033_line_identities i JOIN public.contacts c ON c.id=NEW.contact_id AND c.org_id=NEW.org_id
  WHERE i.id=NEW.login_identity_id AND i.line_channel_id=NEW.line_channel_id
   AND i.user_id=CASE WHEN NEW.persona='vendor' THEN app.b033_contact_user(c.org_id,c.id,'vendor') ELSE c.user_id END
   AND (i.status='linked' OR NEW.status='unlinked') AND (i.unlinked_at IS NULL OR NEW.status='unlinked')) THEN
  RAISE EXCEPTION 'Identity mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='app' AND p.proname IN ('b033_portal_enabled','b033_contact_user','b033_liff_config_guard','b033_liff_configure','b033_link') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF f::text NOT LIKE '%b033_liff_config_guard%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END IF;
 END LOOP;
END $$;
COMMIT;
