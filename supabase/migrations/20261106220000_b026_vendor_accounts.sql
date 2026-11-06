-- B-026 slice 3: account authority is independent of single-job capabilities.
BEGIN;
INSERT INTO public.platform_settings(key,value) VALUES
 ('vendor_account','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT DO NOTHING;
CREATE TABLE app.b026_vendor_account_invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
 contact_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES auth.users(id),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL, expires_at timestamptz NOT NULL,
 claimed_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(org_id,contact_id) REFERENCES public.contacts(org_id,id)
);
CREATE TABLE app.b026_vendor_accounts (
 org_id uuid NOT NULL, contact_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES auth.users(id),
 invite_id uuid NOT NULL REFERENCES app.b026_vendor_account_invites(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,contact_id), UNIQUE(org_id,contact_id,user_id),
 FOREIGN KEY(org_id,contact_id) REFERENCES public.contacts(org_id,id)
);
CREATE TABLE app.b026_vendor_job_accounts (
 job_id uuid PRIMARY KEY REFERENCES public.repair_vendor_jobs(id), org_id uuid NOT NULL,
 contact_id uuid NOT NULL, user_id uuid, manual boolean NOT NULL DEFAULT false,
 FOREIGN KEY(org_id,contact_id,user_id) REFERENCES app.b026_vendor_accounts(org_id,contact_id,user_id)
);
CREATE TABLE app.b026_vendor_link_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
 job_id uuid REFERENCES public.repair_vendor_jobs(id), contact_id uuid NOT NULL,
 previous_user_id uuid, user_id uuid, actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('invited_claim','login_open_job','staff_correct','staff_unlink','staff_rebind')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app.b026_vendor_account_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b026_vendor_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b026_vendor_job_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b026_vendor_link_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b026_vendor_account_invites,app.b026_vendor_accounts,
 app.b026_vendor_job_accounts,app.b026_vendor_link_events FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b026_links_immutable BEFORE UPDATE OR DELETE ON app.b026_vendor_link_events
 FOR EACH ROW EXECUTE FUNCTION app.b013_approval_immutable_row();
CREATE TRIGGER b026_links_no_truncate BEFORE TRUNCATE ON app.b026_vendor_link_events
 FOR EACH STATEMENT EXECUTE FUNCTION app.b013_approval_immutable_row();

CREATE FUNCTION app.b026_accounts_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT coalesce((SELECT o.feature_flags->'vendor_account'='true'::jsonb
 AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
 AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
 FROM public.organizations o CROSS JOIN public.platform_settings f
 WHERE o.id=p_org AND f.key='vendor_account'),false)
 AND coalesce(app.vendor_dispatch_enabled(p_org),false)
$$;
-- No authentication bookkeeping writes. A job token cannot be an account credential.
CREATE FUNCTION app.b026_account_actor(p_session_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid;
BEGIN
 SELECT s.user_id INTO actor FROM public.auth_sessions s JOIN auth.users u ON u.id=s.user_id
 WHERE s.token_hash=p_session_hash AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND u.email_confirmed_at IS NOT NULL FOR SHARE OF s NOWAIT;
 IF actor IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
-- Shared org request lock serializes claim/sync/correction before any row locks.
-- NOWAIT avoids inversion with legacy job-first gateways; caller retries whole tx.
CREATE FUNCTION app.b026_account_lock(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.b026_accounts_enabled(p_org) THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b026/accounts/'||p_org::text,0));
 PERFORM 1 FROM public.platform_settings WHERE key='vendor_account' FOR SHARE NOWAIT;
 PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE NOWAIT;
 RETURN app.b026_accounts_enabled(p_org);
END $$;
CREATE FUNCTION app.b026_account_staff(p_org uuid,p_live uuid,p_env text,p_session uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid;
BEGIN
 SELECT s.user_id INTO actor FROM public.auth_sessions s
 JOIN public.org_members m ON m.user_id=s.user_id AND m.org_id=p_org
 JOIN public.organizations o ON o.id=m.org_id
 JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
 WHERE s.id=p_session AND s.user_id=auth.uid() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND m.status::text='active' AND m.role::text IN ('admin','manager')
 AND o.environment::text=p_env AND ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
 OR (p_env='sandbox' AND o.live_org_id=p_live)) FOR SHARE OF s,m NOWAIT;
 IF actor IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION app.b026_invite_vendor_account(p_org uuid,p_live uuid,p_env text,p_session uuid,
 p_contact uuid,p_user uuid,p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid; result uuid;
BEGIN
 IF NOT app.b026_account_lock(p_org) THEN RETURN NULL; END IF;
 actor:=app.b026_account_staff(p_org,p_live,p_env,p_session);
 PERFORM 1 FROM public.contacts WHERE id=p_contact AND org_id=p_org AND is_vendor
 AND archived_at IS NULL AND (user_id IS NULL OR user_id=p_user) FOR SHARE NOWAIT;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user AND email_confirmed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 INSERT INTO app.b026_vendor_account_invites(org_id,contact_id,user_id,token_hash,created_by,expires_at)
 VALUES(p_org,p_contact,p_user,p_hash,actor,clock_timestamp()+interval '7 days') RETURNING id INTO result;
 RETURN result;
END $$;
-- Staff resets a mistaken contact binding; the replacement still accepts an
-- identity-bound invitation. Historical jobs remain tombstoned until corrected.
CREATE FUNCTION app.b026_rebind_vendor_account(p_org uuid,p_live uuid,p_env text,p_session uuid,
 p_contact uuid,p_user uuid,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid; prior uuid; c public.contacts; invitation uuid; event_id uuid;
BEGIN
 IF NOT app.b026_account_lock(p_org) THEN RETURN '{"status":"disabled"}'; END IF;
 actor:=app.b026_account_staff(p_org,p_live,p_env,p_session);
 SELECT * INTO c FROM public.contacts WHERE id=p_contact AND org_id=p_org FOR UPDATE NOWAIT;
 IF NOT FOUND OR NOT c.is_vendor OR c.archived_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user AND email_confirmed_at IS NOT NULL)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT user_id INTO prior FROM app.b026_vendor_accounts WHERE org_id=p_org AND contact_id=p_contact;
 IF prior IS NULL OR prior=p_user THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 -- Never repoint an owner/tenant identity as a side effect of vendor correction.
 IF c.user_id IS NOT NULL AND c.user_id<>p_user THEN
  IF c.user_id<>prior OR c.is_owner OR c.is_tenant
  THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
  UPDATE public.contacts SET user_id=p_user WHERE id=p_contact AND org_id=p_org;
 END IF;
 PERFORM 1 FROM app.b026_vendor_job_accounts WHERE org_id=p_org AND contact_id=p_contact ORDER BY job_id FOR UPDATE NOWAIT;
 INSERT INTO app.b026_vendor_link_events(org_id,job_id,contact_id,previous_user_id,user_id,actor_id,reason)
 SELECT org_id,job_id,contact_id,user_id,NULL,actor,'staff_unlink'
 FROM app.b026_vendor_job_accounts WHERE org_id=p_org AND contact_id=p_contact AND user_id IS NOT NULL;
 UPDATE app.b026_vendor_job_accounts SET user_id=NULL,manual=true WHERE org_id=p_org AND contact_id=p_contact;
 DELETE FROM app.b026_vendor_accounts WHERE org_id=p_org AND contact_id=p_contact;
 UPDATE app.b026_vendor_account_invites SET revoked_at=clock_timestamp()
 WHERE org_id=p_org AND contact_id=p_contact AND revoked_at IS NULL;
 invitation:=app.b026_invite_vendor_account(p_org,p_live,p_env,p_session,p_contact,p_user,p_hash);
 INSERT INTO app.b026_vendor_link_events(org_id,contact_id,previous_user_id,user_id,actor_id,reason)
 VALUES(p_org,p_contact,prior,p_user,actor,'staff_rebind') RETURNING id INTO event_id;
 RETURN jsonb_build_object('status','invited','invitationId',invitation,'eventId',event_id,'previousUserId',prior);
END $$;
REVOKE ALL ON FUNCTION app.b026_rebind_vendor_account(uuid,uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_rebind_vendor_account(uuid,uuid,text,uuid,uuid,uuid,text) TO service_role;
CREATE FUNCTION app.b026_claim_vendor_account(p_session_hash text,p_invite_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid; i app.b026_vendor_account_invites; existing uuid;
BEGIN
 actor:=app.b026_account_actor(p_session_hash);
 SELECT * INTO i FROM app.b026_vendor_account_invites WHERE token_hash=p_invite_hash AND user_id=actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT app.b026_account_lock(i.org_id) THEN RETURN '{"status":"disabled"}'; END IF;
 SELECT * INTO i FROM app.b026_vendor_account_invites WHERE id=i.id FOR UPDATE NOWAIT;
 IF i.revoked_at IS NOT NULL OR i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.contacts WHERE id=i.contact_id AND org_id=i.org_id AND is_vendor
 AND archived_at IS NULL AND (user_id IS NULL OR user_id=actor) FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT user_id INTO existing FROM app.b026_vendor_accounts WHERE org_id=i.org_id AND contact_id=i.contact_id;
 IF existing IS NOT NULL AND existing<>actor THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 PERFORM app.b026_account_actor(p_session_hash);
 IF existing IS NULL THEN
  INSERT INTO app.b026_vendor_accounts(org_id,contact_id,user_id,invite_id) VALUES(i.org_id,i.contact_id,actor,i.id);
  INSERT INTO app.b026_vendor_link_events(org_id,contact_id,user_id,actor_id,reason)
   VALUES(i.org_id,i.contact_id,actor,actor,'invited_claim');
 END IF;
 IF i.claimed_at IS NULL THEN UPDATE app.b026_vendor_account_invites SET claimed_at=clock_timestamp() WHERE id=i.id; END IF;
 RETURN jsonb_build_object('status','claimed','orgId',i.org_id);
END $$;
-- Internal candidate secrets never leave the server. Returning a candidate grants no link authority.
CREATE FUNCTION app.b026_account_candidates(p_session_hash text) RETURNS TABLE(token text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid;
BEGIN
 actor:=app.b026_account_actor(p_session_hash);
 RETURN QUERY SELECT s.token FROM app.b026_vendor_accounts a
 JOIN public.contacts c ON c.org_id=a.org_id AND c.id=a.contact_id AND c.is_vendor AND c.archived_at IS NULL
 JOIN public.repair_vendor_jobs j ON j.org_id=a.org_id AND j.vendor_contact_id=a.contact_id
 JOIN public.maintenance_tickets t ON t.org_id=j.org_id AND t.id=j.ticket_id AND t.assigned_vendor_contact_id=a.contact_id
 JOIN public.repair_vendor_secrets s ON s.job_id=j.id
 WHERE a.user_id=actor AND (c.user_id IS NULL OR c.user_id=actor) AND app.b026_accounts_enabled(a.org_id)
 AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()
 AND j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL
 AND t.status::text NOT IN ('closed','cancelled')
 AND NOT EXISTS(SELECT 1 FROM app.b026_vendor_job_accounts l WHERE l.job_id=j.id)
 ORDER BY a.org_id,t.id,j.id;
END $$;
CREATE FUNCTION app.b026_link_vendor_job(p_session_hash text,p_hash text) RETURNS boolean
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
 JOIN app.b026_vendor_accounts a ON a.org_id=v.org_id AND a.contact_id=v.vendor_contact_id AND a.user_id=actor
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
CREATE FUNCTION app.b026_vendor_account_history(p_session_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid; settings jsonb; jobs jsonb;
BEGIN
 actor:=app.b026_account_actor(p_session_hash);
 SELECT coalesce(jsonb_agg(jsonb_build_object('orgId',a.org_id,'contactId',a.contact_id,'name',c.display_name) ORDER BY a.org_id,a.contact_id),'[]') INTO settings
 FROM app.b026_vendor_accounts a JOIN public.contacts c ON c.org_id=a.org_id AND c.id=a.contact_id
 WHERE a.user_id=actor AND c.is_vendor AND c.archived_at IS NULL AND (c.user_id IS NULL OR c.user_id=actor)
 AND app.b026_accounts_enabled(a.org_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('jobId',j.id,'orgId',j.org_id,'ticketId',j.ticket_id,
 'status',t.status,'description',j.shared_description,'readOnly',t.status::text IN ('closed','cancelled')) ORDER BY j.created_at DESC,j.id),'[]') INTO jobs
 FROM app.b026_vendor_job_accounts l
 JOIN app.b026_vendor_accounts a ON a.org_id=l.org_id AND a.contact_id=l.contact_id AND a.user_id=l.user_id
 JOIN public.contacts c ON c.org_id=a.org_id AND c.id=a.contact_id
 JOIN public.repair_vendor_jobs j ON j.id=l.job_id AND j.org_id=l.org_id AND j.vendor_contact_id=l.contact_id
 JOIN public.maintenance_tickets t ON t.org_id=j.org_id AND t.id=j.ticket_id AND t.assigned_vendor_contact_id=l.contact_id
 WHERE l.user_id=actor AND c.is_vendor AND c.archived_at IS NULL AND (c.user_id IS NULL OR c.user_id=actor)
 AND app.b026_accounts_enabled(l.org_id) AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()
 AND j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL;
 RETURN jsonb_build_object('settings',settings,'jobs',jobs);
END $$;
CREATE FUNCTION app.b026_correct_vendor_job(p_org uuid,p_live uuid,p_env text,p_session uuid,
 p_job uuid,p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor uuid; j public.repair_vendor_jobs; prior app.b026_vendor_job_accounts; event_id uuid;
BEGIN
 IF NOT app.b026_account_lock(p_org) THEN RETURN '{"status":"disabled"}'; END IF;
 actor:=app.b026_account_staff(p_org,p_live,p_env,p_session);
 SELECT * INTO j FROM public.repair_vendor_jobs WHERE id=p_job AND org_id=p_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.maintenance_tickets WHERE id=j.ticket_id AND org_id=p_org FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.repair_vendor_jobs WHERE ticket_id=j.ticket_id AND org_id=p_org ORDER BY id FOR UPDATE NOWAIT;
 SELECT * INTO j FROM public.repair_vendor_jobs WHERE id=p_job AND org_id=p_org;
 PERFORM 1 FROM public.contacts WHERE id=j.vendor_contact_id AND org_id=p_org FOR SHARE NOWAIT;
 IF p_user IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.b026_vendor_accounts a
 JOIN public.contacts c ON c.id=a.contact_id AND c.org_id=a.org_id
 JOIN public.maintenance_tickets t ON t.id=j.ticket_id AND t.org_id=a.org_id AND t.assigned_vendor_contact_id=a.contact_id
 WHERE a.org_id=p_org AND a.contact_id=j.vendor_contact_id AND a.user_id=p_user
 AND c.is_vendor AND c.archived_at IS NULL AND (c.user_id IS NULL OR c.user_id=p_user))
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO prior FROM app.b026_vendor_job_accounts WHERE job_id=p_job;
 IF FOUND AND prior.user_id IS NOT DISTINCT FROM p_user AND prior.contact_id=j.vendor_contact_id AND prior.manual THEN
  RETURN '{"status":"unchanged"}';
 END IF;
 INSERT INTO app.b026_vendor_job_accounts(job_id,org_id,contact_id,user_id,manual)
 VALUES(j.id,p_org,j.vendor_contact_id,p_user,true) ON CONFLICT(job_id) DO UPDATE
 SET contact_id=EXCLUDED.contact_id,user_id=EXCLUDED.user_id,manual=true;
 INSERT INTO app.b026_vendor_link_events(org_id,job_id,contact_id,previous_user_id,user_id,actor_id,reason)
 VALUES(p_org,j.id,j.vendor_contact_id,prior.user_id,p_user,actor,CASE WHEN p_user IS NULL THEN 'staff_unlink' ELSE 'staff_correct' END)
 RETURNING id INTO event_id;
 RETURN jsonb_build_object('status','corrected','eventId',event_id);
END $$;
CREATE FUNCTION app.b026_vendor_link_events_for_staff(p_org uuid,p_live uuid,p_env text,p_session uuid,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE result jsonb;
BEGIN
 PERFORM app.b026_account_staff(p_org,p_live,p_env,p_session);
 IF NOT app.b026_accounts_enabled(p_org) THEN RETURN '[]'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.repair_vendor_jobs WHERE org_id=p_org AND id=p_job)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'actorId',actor_id,'reason',reason,
  'previousUserId',previous_user_id,'userId',user_id,'at',created_at) ORDER BY created_at,id),'[]') INTO result
 FROM app.b026_vendor_link_events WHERE org_id=p_org AND job_id=p_job;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b026_vendor_link_events_for_staff(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_vendor_link_events_for_staff(uuid,uuid,text,uuid,uuid) TO service_role;
CREATE FUNCTION app.b026_vendor_login_access(p_user uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.b026_vendor_account_invites i
 JOIN public.contacts c ON c.org_id=i.org_id AND c.id=i.contact_id
 WHERE i.user_id=p_user AND i.revoked_at IS NULL AND c.is_vendor AND c.archived_at IS NULL
 AND (c.user_id IS NULL OR c.user_id=p_user) AND app.b026_accounts_enabled(i.org_id)
 AND (i.expires_at>clock_timestamp() OR EXISTS(SELECT 1 FROM app.b026_vendor_accounts a
 WHERE a.org_id=i.org_id AND a.contact_id=i.contact_id AND a.user_id=p_user)))
$$;
REVOKE ALL ON FUNCTION app.b026_vendor_login_access(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_vendor_login_access(uuid) TO service_role;
REVOKE ALL ON FUNCTION app.b026_accounts_enabled(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_accounts_enabled(uuid) TO service_role;
REVOKE ALL ON FUNCTION app.b026_account_actor(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_account_actor(text) TO service_role;
REVOKE ALL ON FUNCTION app.b026_account_lock(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app.b026_account_staff(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app.b026_invite_vendor_account(uuid,uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_invite_vendor_account(uuid,uuid,text,uuid,uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION app.b026_claim_vendor_account(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_claim_vendor_account(text,text) TO service_role;
REVOKE ALL ON FUNCTION app.b026_account_candidates(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_account_candidates(text) TO service_role;
REVOKE ALL ON FUNCTION app.b026_link_vendor_job(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_link_vendor_job(text,text) TO service_role;
REVOKE ALL ON FUNCTION app.b026_vendor_account_history(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_vendor_account_history(text) TO service_role;
REVOKE ALL ON FUNCTION app.b026_correct_vendor_job(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_correct_vendor_job(uuid,uuid,text,uuid,uuid,uuid) TO service_role;
COMMIT;
