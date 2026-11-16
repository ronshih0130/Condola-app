-- VEN-31: verified LINE + a valid assigned job token authorizes FIRST binding.
-- A forwarded valid link can bind the first identity. This is the approved factor;
-- no contact data matching, outbound message, notification opt-in or flag mutation.
BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE app.b035_vendor_flows ADD COLUMN b101_contact_id uuid REFERENCES public.contacts(id);
CREATE FUNCTION app.b101_token_contact_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.b101_contact_id IS DISTINCT FROM OLD.b101_contact_id
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM app.b033_line_flows WHERE id=NEW.flow_id AND return_path='/v/link')
 AND (NEW.b101_contact_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.repair_vendor_jobs
  WHERE id=NEW.job_id AND vendor_contact_id=NEW.b101_contact_id))
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b101_token_contact_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b101_token_contact_guard BEFORE INSERT OR UPDATE ON app.b035_vendor_flows
 FOR EACH ROW EXECUTE FUNCTION app.b101_token_contact_guard();
ALTER TABLE app.b026_vendor_accounts ALTER COLUMN invite_id DROP NOT NULL;
ALTER TABLE app.b026_vendor_accounts ADD COLUMN line_identity_id uuid REFERENCES app.b033_line_identities(id);
ALTER TABLE app.b026_vendor_accounts ADD CONSTRAINT b101_account_provenance
 CHECK (invite_id IS NOT NULL OR line_identity_id IS NOT NULL);
ALTER TABLE app.b026_vendor_link_events DROP CONSTRAINT b026_vendor_link_events_reason_check;
ALTER TABLE app.b026_vendor_link_events ADD CONSTRAINT b026_vendor_link_events_reason_check
 CHECK(reason IN ('invited_claim','login_open_job','staff_correct','staff_unlink','staff_rebind','line_first_binding','vendor_not_mine','line_confirmed'));
CREATE TABLE app.b101_vendor_confirmations (
 flow_id uuid PRIMARY KEY REFERENCES app.b033_line_flows(id),
 org_id uuid NOT NULL, contact_id uuid NOT NULL, user_id uuid NOT NULL,
 identity_id uuid NOT NULL REFERENCES app.b033_line_identities(id),
 link_id uuid NOT NULL REFERENCES public.line_account_links(id),
 candidate_ids uuid[], confirmed_at timestamptz,
 FOREIGN KEY(org_id,contact_id,user_id) REFERENCES app.b026_vendor_accounts(org_id,contact_id,user_id) ON DELETE CASCADE
);
ALTER TABLE app.b101_vendor_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b101_vendor_confirmations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b101_enabled(p_org uuid,p_env_v2 boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.b026_accounts_enabled(p_org) AND app.b033_portal_enabled(p_org,'vendor') AND
 coalesce((SELECT feature_flags->'brand_v3'='true'::jsonb AND
 (p_env_v2 OR feature_flags->'brand_v2'='true'::jsonb) FROM public.organizations WHERE id=p_org),false)
$$;
CREATE FUNCTION app.b101_lock(p_org uuid,p_env_v2 boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.b026_account_lock(p_org) OR app.b101_enabled(p_org,p_env_v2) IS NOT TRUE
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 PERFORM 1 FROM public.platform_settings WHERE key IN ('line_platform','line_vendor_portal','vendor_dispatch','vendor_link') FOR SHARE NOWAIT;
 IF app.b101_enabled(p_org,p_env_v2) IS NOT TRUE THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
END $$;
-- Deny every other persona, contact or org, even inactive/historical authority.
CREATE FUNCTION app.b101_vendor_only(p_user uuid,p_org uuid,p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.org_members WHERE user_id=p_user)
 AND NOT EXISTS(SELECT 1 FROM public.contacts WHERE user_id=p_user AND
  (is_tenant OR is_owner OR org_id<>p_org OR id<>p_contact))
 AND NOT EXISTS(SELECT 1 FROM app.b026_vendor_accounts WHERE user_id=p_user AND (org_id<>p_org OR contact_id<>p_contact))
 AND NOT EXISTS(SELECT 1 FROM public.line_account_links l JOIN app.b033_line_identities i ON i.id=l.login_identity_id
  WHERE i.user_id=p_user AND (l.org_id<>p_org OR l.contact_id<>p_contact OR l.persona IS DISTINCT FROM 'vendor'))
 AND NOT EXISTS(SELECT 1 FROM app.b033_line_identities WHERE user_id=p_user AND persona<>'vendor')
$$;
CREATE FUNCTION app.b101_match(p_flow uuid,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE f app.b033_line_flows; v app.b035_vendor_flows; j public.repair_vendor_jobs;
 c public.contacts; i app.b033_line_identities; a app.b026_vendor_accounts;
 actor uuid; lid uuid; first_binding boolean:=false;
BEGIN
 SELECT * INTO f FROM app.b033_line_flows WHERE id=p_flow FOR UPDATE;
 IF NOT FOUND OR f.return_path<>'/v/link' OR f.kind<>'login' OR f.persona<>'vendor'
 OR f.verified_hash IS NULL OR f.oauth_started_at IS NULL OR f.pkce_hash IS NULL
 OR f.expires_at<=clock_timestamp() OR f.consumed_at IS NOT NULL OR f.attempts>5
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 PERFORM app.b101_lock(f.org_id,p_env_v2);
 IF app.b033_selected_channel(f.org_id) IS DISTINCT FROM f.line_channel_id
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 -- Serialize B101 across channels as well as the B033 identity lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(f.verified_hash,101));
 PERFORM pg_advisory_xact_lock(hashtextextended(f.line_channel_id::text||f.verified_hash,33));
 SELECT * INTO i FROM app.b033_line_identities WHERE line_channel_id=f.line_channel_id AND provider_user_hash=f.verified_hash FOR UPDATE;
 IF EXISTS(SELECT 1 FROM app.b033_line_identities WHERE provider_user_hash=f.verified_hash AND line_channel_id<>f.line_channel_id)
 OR (i.id IS NOT NULL AND (i.status<>'linked' OR i.unlinked_at IS NOT NULL OR i.persona<>'vendor'))
 THEN RAISE EXCEPTION 'identity_conflict' USING ERRCODE='P0033'; END IF;
 SELECT * INTO v FROM app.b035_vendor_flows WHERE flow_id=f.id;
 IF FOUND THEN
  SELECT * INTO j FROM public.repair_vendor_jobs WHERE id=v.job_id AND org_id=f.org_id;
  PERFORM 1 FROM public.maintenance_tickets WHERE id=j.ticket_id AND org_id=f.org_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.repair_vendor_jobs WHERE ticket_id=j.ticket_id AND org_id=f.org_id ORDER BY id FOR UPDATE NOWAIT;
  SELECT x.* INTO j FROM public.repair_vendor_jobs x JOIN public.maintenance_tickets t ON t.id=x.ticket_id AND t.org_id=x.org_id
   WHERE x.id=v.job_id AND x.org_id=f.org_id AND x.token_hash=v.token_hash
   AND x.vendor_contact_id=v.b101_contact_id AND x.vendor_contact_id=t.assigned_vendor_contact_id AND x.active AND x.revoked_at IS NULL
   AND x.expires_at>clock_timestamp() AND x.scope='case_collaboration' AND x.sharing_approved_at IS NOT NULL
   AND t.status::text NOT IN ('closed','cancelled');
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
  SELECT * INTO c FROM public.contacts WHERE id=j.vendor_contact_id AND org_id=f.org_id FOR UPDATE NOWAIT;
 ELSE
  -- Subsequent sign-in needs the exact established binding, never another token.
  SELECT x.* INTO c FROM public.contacts x JOIN public.line_account_links l ON l.contact_id=x.id AND l.org_id=x.org_id
   WHERE l.login_identity_id=i.id AND l.org_id=f.org_id AND l.persona='vendor' AND l.status='linked' AND l.unlinked_at IS NULL;
  IF c.id IS NOT NULL THEN SELECT * INTO c FROM public.contacts WHERE id=c.id AND org_id=c.org_id FOR UPDATE NOWAIT; END IF;
 END IF;
 IF c.id IS NULL OR NOT c.is_vendor OR c.is_owner OR c.is_tenant OR c.archived_at IS NOT NULL
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 SELECT * INTO a FROM app.b026_vendor_accounts WHERE org_id=c.org_id AND contact_id=c.id FOR UPDATE;
 actor:=coalesce(i.user_id,a.user_id,c.user_id);
 -- User FK writers (staff/contact membership) cannot race this authority check.
 IF actor IS NOT NULL THEN PERFORM 1 FROM auth.users WHERE id=actor FOR UPDATE NOWAIT; END IF;
 IF (a.user_id IS NOT NULL AND a.user_id IS DISTINCT FROM actor)
 OR (c.user_id IS NOT NULL AND c.user_id IS DISTINCT FROM actor)
 OR (actor IS NOT NULL AND NOT app.b101_vendor_only(actor,c.org_id,c.id))
 OR EXISTS(SELECT 1 FROM public.line_account_links WHERE org_id=c.org_id AND contact_id=c.id
   AND (login_identity_id IS DISTINCT FROM i.id OR persona IS DISTINCT FROM 'vendor' OR status<>'linked' OR unlinked_at IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public.line_account_links WHERE login_identity_id=i.id AND (org_id<>c.org_id OR contact_id<>c.id))
 OR EXISTS(SELECT 1 FROM app.b033_line_identities WHERE user_id=actor AND id IS DISTINCT FROM i.id)
 THEN RAISE EXCEPTION 'identity_conflict' USING ERRCODE='P0033'; END IF;
 IF i.id IS NULL THEN
  IF v.flow_id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
  IF actor IS NULL THEN
   -- Unreachable mailbox; LINE is the credential. No password and no email sent.
   actor:=app.provision_portal_user('line-vendor-'||gen_random_uuid()::text||'@line.invalid',c.display_name,NULL);
  END IF;
  INSERT INTO app.b033_line_identities(line_channel_id,provider_user_hash,user_id,persona)
   VALUES(f.line_channel_id,f.verified_hash,actor,'vendor') RETURNING * INTO i;
  first_binding:=true;
 END IF;
 IF a.user_id IS NULL THEN
  IF v.flow_id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
  INSERT INTO app.b026_vendor_accounts(org_id,contact_id,user_id,line_identity_id) VALUES(c.org_id,c.id,actor,i.id);
 ELSE
  -- Existing invite provenance is retained; LINE accounts use explicit confirmation thereafter.
  UPDATE app.b026_vendor_accounts SET line_identity_id=i.id WHERE org_id=c.org_id AND contact_id=c.id;
 END IF;
 SELECT id INTO lid FROM public.line_account_links WHERE login_identity_id=i.id AND org_id=c.org_id AND contact_id=c.id
  AND persona='vendor' AND status='linked' AND unlinked_at IS NULL;
 IF lid IS NULL THEN
  IF v.flow_id IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
  INSERT INTO public.line_account_links(org_id,contact_id,line_channel_id,status,login_identity_id,persona,identity_verified_at,linked_at,notification_opt_in,is_friend)
   VALUES(c.org_id,c.id,f.line_channel_id,'linked',i.id,'vendor',clock_timestamp(),clock_timestamp(),false,false) RETURNING id INTO lid;
  first_binding:=true;
 END IF;
 IF first_binding THEN
  INSERT INTO app.b026_vendor_link_events(org_id,job_id,contact_id,user_id,actor_id,reason)
   VALUES(c.org_id,j.id,c.id,actor,actor,'line_first_binding');
  INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row)
   VALUES(c.org_id,actor,'app','contacts',c.id,'update','vendor_line_first_binding',jsonb_build_object('identityId',i.id,'jobId',j.id));
 END IF;
 INSERT INTO app.b101_vendor_confirmations(flow_id,org_id,contact_id,user_id,identity_id,link_id)
  VALUES(f.id,c.org_id,c.id,actor,i.id,lid);
 UPDATE app.b033_line_flows SET consumed_at=clock_timestamp() WHERE id=f.id;
 RETURN jsonb_build_object('userId',actor,'identityId',i.id);
END $$;

-- Every list/removal/confirmation rechecks live authority, exact scope and gates.
CREATE FUNCTION app.b101_review(p_flow uuid,p_env_v2 boolean,p_action text,p_job uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE f app.b033_line_flows; r app.b101_vendor_confirmations; i app.b033_line_identities;
 j public.repair_vendor_jobs; candidate uuid; visible uuid[]; jobs jsonb;
BEGIN
 SELECT * INTO f FROM app.b033_line_flows WHERE id=p_flow FOR UPDATE;
 IF NOT FOUND OR f.return_path<>'/v/link' OR f.expires_at<=clock_timestamp() OR f.verified_hash IS NULL
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 PERFORM app.b101_lock(f.org_id,p_env_v2);
 SELECT * INTO r FROM app.b101_vendor_confirmations WHERE flow_id=f.id FOR UPDATE;
 IF NOT FOUND OR r.confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'already_consumed' USING ERRCODE='P0033'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(f.line_channel_id::text||f.verified_hash,33));
 SELECT * INTO i FROM app.b033_line_identities WHERE id=r.identity_id FOR SHARE;
 PERFORM 1 FROM auth.users WHERE id=r.user_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.contacts c JOIN app.b026_vendor_accounts a ON a.org_id=c.org_id AND a.contact_id=c.id
  JOIN public.line_account_links l ON l.id=r.link_id
  WHERE c.org_id=r.org_id AND c.id=r.contact_id AND c.is_vendor AND NOT c.is_tenant AND NOT c.is_owner AND c.archived_at IS NULL
  AND (c.user_id IS NULL OR c.user_id=r.user_id) AND a.user_id=r.user_id AND a.line_identity_id=i.id
  AND l.login_identity_id=i.id AND l.org_id=c.org_id AND l.contact_id=c.id AND l.persona='vendor' AND l.status='linked' AND l.unlinked_at IS NULL
  FOR SHARE OF c,a,l NOWAIT;
 IF NOT FOUND OR i.status<>'linked' OR i.unlinked_at IS NOT NULL OR i.user_id IS DISTINCT FROM r.user_id
 OR i.provider_user_hash IS DISTINCT FROM f.verified_hash OR i.line_channel_id IS DISTINCT FROM f.line_channel_id
 OR app.b033_selected_channel(r.org_id) IS DISTINCT FROM f.line_channel_id
 OR NOT app.b101_vendor_only(r.user_id,r.org_id,r.contact_id)
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 IF p_action NOT IN ('list','remove','confirm') THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 -- Freeze only the IDs actually displayed; new arrivals wait for a new sign-in.
 IF p_action='list' AND r.candidate_ids IS NULL THEN
  SELECT coalesce(array_agg(x.id ORDER BY x.id),'{}') INTO r.candidate_ids
  FROM public.repair_vendor_jobs x JOIN public.maintenance_tickets t ON t.org_id=x.org_id AND t.id=x.ticket_id
  WHERE x.org_id=r.org_id AND x.vendor_contact_id=r.contact_id AND t.assigned_vendor_contact_id=r.contact_id
   AND x.active AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp() AND x.sharing_approved_at IS NOT NULL
   AND x.scope='case_collaboration' AND t.status::text NOT IN ('closed','cancelled')
   AND NOT EXISTS(SELECT 1 FROM app.b026_vendor_job_accounts a WHERE a.job_id=x.id);
  UPDATE app.b101_vendor_confirmations SET candidate_ids=r.candidate_ids WHERE flow_id=f.id;
 END IF;
 IF r.candidate_ids IS NULL OR (p_action='remove' AND (p_job IS NULL OR NOT p_job=ANY(r.candidate_ids)))
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 visible:='{}'; jobs:='[]';
 FOR candidate IN SELECT unnest(r.candidate_ids) ORDER BY 1 LOOP
  SELECT * INTO j FROM public.repair_vendor_jobs WHERE id=candidate AND org_id=r.org_id;
  PERFORM 1 FROM public.maintenance_tickets WHERE id=j.ticket_id AND org_id=r.org_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.repair_vendor_jobs WHERE ticket_id=j.ticket_id AND org_id=r.org_id ORDER BY id FOR UPDATE NOWAIT;
  SELECT x.* INTO j FROM public.repair_vendor_jobs x JOIN public.maintenance_tickets t ON t.id=x.ticket_id AND t.org_id=x.org_id
   WHERE x.id=candidate AND x.org_id=r.org_id AND x.vendor_contact_id=r.contact_id AND t.assigned_vendor_contact_id=r.contact_id
   AND x.active AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp() AND x.sharing_approved_at IS NOT NULL
   AND x.scope='case_collaboration' AND t.status::text NOT IN ('closed','cancelled')
   AND NOT EXISTS(SELECT 1 FROM app.b026_vendor_job_accounts a WHERE a.job_id=x.id);
  IF NOT FOUND THEN
   IF p_action='remove' AND candidate=p_job THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
   CONTINUE;
  END IF;
  IF p_action='remove' AND candidate=p_job THEN
   INSERT INTO app.b026_vendor_job_accounts(job_id,org_id,contact_id,user_id,manual) VALUES(j.id,r.org_id,r.contact_id,NULL,true);
   INSERT INTO app.b026_vendor_link_events(org_id,job_id,contact_id,user_id,actor_id,reason) VALUES(r.org_id,j.id,r.contact_id,NULL,r.user_id,'vendor_not_mine');
  ELSIF p_action='confirm' THEN
   INSERT INTO app.b026_vendor_job_accounts(job_id,org_id,contact_id,user_id) VALUES(j.id,r.org_id,r.contact_id,r.user_id);
   INSERT INTO app.b026_vendor_link_events(org_id,job_id,contact_id,user_id,actor_id,reason) VALUES(r.org_id,j.id,r.contact_id,r.user_id,r.user_id,'line_confirmed');
  ELSE
   visible:=array_append(visible,j.id);
   jobs:=jobs||jsonb_build_array(jsonb_build_object('id',j.id,'description',j.shared_description));
  END IF;
 END LOOP;
 UPDATE app.b101_vendor_confirmations SET candidate_ids=visible,
  confirmed_at=CASE WHEN p_action='confirm' THEN clock_timestamp() ELSE NULL END WHERE flow_id=f.id;
 RETURN jsonb_build_object('jobs',jobs,'userId',r.user_id,'identityId',r.identity_id,'orgId',r.org_id);
END $$;
-- Ordinary B033 login must not bypass B101 confirmation, persona guards or its gates.
CREATE FUNCTION app.b101_identity_managed(p_identity uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.b026_vendor_accounts WHERE line_identity_id=p_identity)
$$;
REVOKE ALL ON FUNCTION app.b101_identity_managed(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b101_identity_managed(uuid) TO service_role;
REVOKE ALL ON FUNCTION app.b101_enabled(uuid,boolean),app.b101_lock(uuid,boolean),app.b101_vendor_only(uuid,uuid,uuid),
 app.b101_match(uuid,boolean),app.b101_review(uuid,boolean,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b101_enabled(uuid,boolean),app.b101_match(uuid,boolean),app.b101_review(uuid,boolean,text,uuid) TO service_role;

-- Preserve invite-account behavior; LINE matching requires a displayed V-LINK snapshot.
CREATE OR REPLACE FUNCTION app.b026_account_candidates(p_session_hash text) RETURNS TABLE(token text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid;
BEGIN
 actor:=app.b026_account_actor(p_session_hash);
 RETURN QUERY SELECT s.token FROM app.b026_vendor_accounts a
 JOIN public.contacts c ON c.org_id=a.org_id AND c.id=a.contact_id AND c.is_vendor AND c.archived_at IS NULL
 JOIN public.repair_vendor_jobs j ON j.org_id=a.org_id AND j.vendor_contact_id=a.contact_id
 JOIN public.maintenance_tickets t ON t.org_id=j.org_id AND t.id=j.ticket_id AND t.assigned_vendor_contact_id=a.contact_id
 JOIN public.repair_vendor_secrets s ON s.job_id=j.id
 WHERE a.line_identity_id IS NULL AND a.user_id=actor AND (c.user_id IS NULL OR c.user_id=actor) AND app.b026_accounts_enabled(a.org_id)
 AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()
 AND j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL
 AND t.status::text NOT IN ('closed','cancelled')
 AND NOT EXISTS(SELECT 1 FROM app.b026_vendor_job_accounts l WHERE l.job_id=j.id)
 ORDER BY a.org_id,t.id,j.id;
END $$;

-- Preserve invite-account behavior; LINE matching requires a displayed V-LINK snapshot.
CREATE OR REPLACE FUNCTION app.b026_link_vendor_job(p_session_hash text,p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid; j public.repair_vendor_jobs;
BEGIN
 actor:=app.b026_account_actor(p_session_hash);
 SELECT * INTO j FROM public.repair_vendor_jobs WHERE token_hash=p_hash;
 IF NOT FOUND OR NOT app.b026_account_lock(j.org_id) THEN RETURN false; END IF;
 PERFORM 1 FROM public.maintenance_tickets WHERE org_id=j.org_id AND id=j.ticket_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.repair_vendor_jobs WHERE org_id=j.org_id AND ticket_id=j.ticket_id ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.contacts WHERE org_id=j.org_id AND id=j.vendor_contact_id FOR SHARE NOWAIT;
 -- Post-state capability, current assignment, contact and account authorization at write time.
 SELECT v.* INTO j FROM public.repair_vendor_jobs v
 JOIN public.maintenance_tickets t ON t.org_id=v.org_id AND t.id=v.ticket_id AND t.assigned_vendor_contact_id=v.vendor_contact_id
 JOIN public.contacts c ON c.org_id=v.org_id AND c.id=v.vendor_contact_id AND c.is_vendor AND c.archived_at IS NULL
 JOIN app.b026_vendor_accounts a ON a.org_id=v.org_id AND a.contact_id=v.vendor_contact_id AND a.user_id=actor AND a.line_identity_id IS NULL
 JOIN public.repair_vendor_secrets s ON s.job_id=v.id
 WHERE v.token_hash=p_hash AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(trim(both from s.token),'UTF8')),'hex')=p_hash
 AND v.active AND v.revoked_at IS NULL AND v.expires_at>clock_timestamp()
 AND v.scope='case_collaboration' AND v.sharing_approved_at IS NOT NULL
 AND t.status::text NOT IN ('closed','cancelled') AND (c.user_id IS NULL OR c.user_id=actor);
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM app.b026_account_actor(p_session_hash);
 INSERT INTO app.b026_vendor_job_accounts(job_id,org_id,contact_id,user_id) VALUES(j.id,j.org_id,j.vendor_contact_id,actor)
 ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO app.b026_vendor_link_events(org_id,job_id,contact_id,user_id,actor_id,reason)
 VALUES(j.org_id,j.id,j.vendor_contact_id,actor,actor,'login_open_job');
 RETURN true;
END $$;
COMMIT;
