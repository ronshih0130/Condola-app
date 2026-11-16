-- B-105 (R9-VEN) Round 7 batch 3 vendor case: RV-JOB-ACCEPT, RV-DECLINE, RV-JOB-WAIT, RV-PHOTOS(-CLOSED).
-- GS-25 (接單 is the first stage), GS-26 (owner wait: no vendor primary), GS-27 (after photos), GS-49 (decline
-- with an optional reason), GS-51 (photos read-only after close), MGT-104-AC2/AC4 (agreed completion date).
-- Adds B-105's own default-OFF gate (platform_settings.vendor_job_v3, seeded OFF with ON CONFLICT DO NOTHING),
-- one private table (RLS on, no application grants) and three service-only SECURITY DEFINER gateways.
-- Admission is the token bearer only (app.open_vendor_job) plus the enhanced case-collaboration link rules;
-- no existing object, table grant, policy or data changes. 0 outbound: nothing here sends or queues a message.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

INSERT INTO public.platform_settings(key,value) VALUES
 ('vendor_job_v3','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT DO NOTHING;

-- One accept/decline per vendor job. The first decision wins; a replay returns it.
CREATE TABLE app.b105_vendor_job_decisions (
 vendor_job_id uuid PRIMARY KEY REFERENCES public.repair_vendor_jobs(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 ticket_id uuid NOT NULL,
 decision text NOT NULL CHECK (decision IN ('accepted','declined')),
 agreed_completion_on date,
 decline_reason text CHECK (decline_reason IS NULL OR length(btrim(decline_reason)) BETWEEN 1 AND 500),
 request_id uuid NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (decision='declined' OR decline_reason IS NULL),
 CHECK (decision='accepted' OR agreed_completion_on IS NULL)
);
ALTER TABLE app.b105_vendor_job_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b105_vendor_job_decisions FROM PUBLIC,anon,authenticated,service_role;

-- Gate: own flag (platform allowlist + org flag), effective brand_v3, vendor_dispatch and enhanced vendor_link.
CREATE FUNCTION app.b105_enabled(p_org uuid,p_env_v2 boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce((SELECT o.feature_flags->'vendor_job_v3'='true'::jsonb
  AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
  AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
  AND o.feature_flags->'brand_v3'='true'::jsonb
  AND (coalesce(p_env_v2,false) OR o.feature_flags->'brand_v2'='true'::jsonb)
  AND o.feature_flags->>'vendor_link'='true'
  AND coalesce((SELECT l.value->'enabled'='true'::jsonb AND jsonb_typeof(l.value->'allowed_org_ids')='array'
   AND l.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
   FROM public.platform_settings l WHERE l.key='vendor_link'),false)
  AND coalesce(app.vendor_dispatch_enabled(o.id),false)
  FROM public.organizations o JOIN public.platform_settings f ON f.key='vendor_job_v3'
  WHERE o.id=p_org),false)
$$;
REVOKE ALL ON FUNCTION app.b105_enabled(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Read: this one job's case facts. NULL when OFF or the bearer is not admitted (same as an unknown token).
CREATE FUNCTION app.b105_vendor_case(p_token_hash text,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE opened record; j public.repair_vendor_jobs; t public.maintenance_tickets;
 d app.b105_vendor_job_decisions; head uuid; v app.b013_estimate_versions;
 closed boolean; wait_version bigint; photos jsonb; company text;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO opened FROM app.open_vendor_job(p_token_hash);
 IF NOT FOUND OR NOT app.b105_enabled(opened.org_id,p_env_v2) THEN RETURN NULL; END IF;
 SELECT * INTO t FROM public.maintenance_tickets WHERE org_id=opened.org_id AND id=opened.ticket_id;
 SELECT * INTO j FROM public.repair_vendor_jobs
  WHERE id=opened.job_id AND org_id=opened.org_id AND ticket_id=opened.ticket_id AND token_hash=p_token_hash;
 IF t.id IS NULL OR j.id IS NULL OR NOT j.active OR j.revoked_at IS NOT NULL OR j.expires_at<=clock_timestamp()
  OR j.scope<>'case_collaboration' OR j.sharing_approved_at IS NULL OR j.vendor_contact_id IS NULL
  OR j.vendor_contact_id IS DISTINCT FROM t.assigned_vendor_contact_id THEN RETURN NULL; END IF;
 closed:=t.status::text NOT IN ('open','triaged','assigned','in_progress','on_hold','resolved');
 SELECT * INTO d FROM app.b105_vendor_job_decisions WHERE vendor_job_id=j.id AND org_id=j.org_id;
 SELECT o.name INTO company FROM public.organizations o WHERE o.id=j.org_id;
 -- GS-26: the current estimate needs the owner and is undecided (R3: not under an emergency authorisation).
 IF NOT closed AND d.decision='accepted' AND app.b013_approvals_enabled(j.org_id) THEN
  SELECT h.current_version_id INTO head FROM app.b013_estimate_heads h WHERE h.org_id=t.org_id AND h.ticket_id=t.id;
  SELECT * INTO v FROM app.b013_estimate_versions x WHERE x.org_id=t.org_id AND x.ticket_id=t.id AND x.id=head;
  IF v.id IS NOT NULL AND v.requires_owner_decision
   AND NOT EXISTS(SELECT 1 FROM app.b013_estimate_decisions x WHERE x.org_id=v.org_id AND x.ticket_id=v.ticket_id AND x.version_id=v.id)
   AND NOT EXISTS(SELECT 1 FROM app.b013_repair_emergencies x WHERE x.org_id=v.org_id AND x.ticket_id=v.ticket_id AND x.version_id=v.id)
  THEN wait_version:=v.version_no; END IF;
 END IF;
 -- This vendor job's own uploads only. A NULL phase is the 處理後 set (GS-27: earlier uploads count).
 -- viewable mirrors the existing byte route: own uploads while open, otherwise only staff-shared photos.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',f.file_name,
   'phase',CASE WHEN a.phase='before' THEN 'before' ELSE 'after' END,
   'viewable',NOT closed OR EXISTS(SELECT 1 FROM public.repair_vendor_job_shared_photos s
     WHERE s.org_id=a.org_id AND s.job_id=j.id AND s.attachment_id=a.id))
   ORDER BY a.created_at,a.id),'[]'::jsonb) INTO photos
 FROM public.ticket_attachments a JOIN public.files f ON f.id=a.file_id AND f.org_id=a.org_id
 WHERE a.org_id=t.org_id AND a.ticket_id=t.id AND a.vendor_job_id=j.id AND NOT a.is_internal;
 RETURN jsonb_build_object('company',coalesce(company,''),'closed',closed,
  'decision',d.decision,'agreedCompletionOn',d.agreed_completion_on,'scheduledOn',t.scheduled_on,
  'ownerWaitVersion',wait_version,'estimates',coalesce(app.b026_estimates_enabled(j.org_id),false),'photos',photos);
END $$;
REVOKE ALL ON FUNCTION app.b105_vendor_case(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b105_vendor_case(text,boolean) TO service_role;

-- Write admission shared by the two writers: locks the ticket, then its jobs by id (lockTicketThenJobs order),
-- and re-admits after the locks. Raises 42501 for anything not admitted; nothing is written before it returns.
CREATE FUNCTION app.b105_vendor_write_job(p_token_hash text,p_env_v2 boolean) RETURNS public.repair_vendor_jobs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE opened record; j public.repair_vendor_jobs; t public.maintenance_tickets;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO opened FROM app.open_vendor_job(p_token_hash);
 IF NOT FOUND OR NOT app.b105_enabled(opened.org_id,p_env_v2) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM public.maintenance_tickets WHERE org_id=opened.org_id AND id=opened.ticket_id FOR UPDATE;
 PERFORM 1 FROM public.repair_vendor_jobs x WHERE x.org_id=opened.org_id AND x.ticket_id=opened.ticket_id ORDER BY x.id FOR UPDATE;
 SELECT * INTO j FROM public.repair_vendor_jobs
  WHERE id=opened.job_id AND org_id=opened.org_id AND ticket_id=opened.ticket_id AND token_hash=p_token_hash;
 IF t.id IS NULL OR j.id IS NULL OR NOT j.active OR j.revoked_at IS NOT NULL OR j.expires_at<=clock_timestamp()
  OR j.scope<>'case_collaboration' OR j.sharing_approved_at IS NULL OR j.vendor_contact_id IS NULL
  OR j.vendor_contact_id IS DISTINCT FROM t.assigned_vendor_contact_id
  OR t.status::text NOT IN ('open','triaged','assigned','in_progress','on_hold','resolved')
  OR NOT app.b105_enabled(j.org_id,p_env_v2)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 RETURN j;
END $$;
REVOKE ALL ON FUNCTION app.b105_vendor_write_job(text,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Write: 接受工單 (with an optional 約定完工日) or 確定不接 (with an optional reason). Idempotent per job.
CREATE FUNCTION app.b105_vendor_decide(p_token_hash text,p_env_v2 boolean,p_request uuid,
 p_decision text,p_agreed_on date,p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.repair_vendor_jobs; d app.b105_vendor_job_decisions; scheduled date;
BEGIN
 j:=app.b105_vendor_write_job(p_token_hash,p_env_v2);
 SELECT * INTO d FROM app.b105_vendor_job_decisions WHERE vendor_job_id=j.id FOR UPDATE;
 IF FOUND THEN
  -- A replay (same request) or a repeat of the same decision returns the first result unchanged.
  IF d.request_id=p_request OR d.decision=p_decision THEN
   RETURN jsonb_build_object('status','recorded','decision',d.decision,'replayed',true); END IF;
  RETURN '{"status":"rejected_conflict"}'::jsonb;
 END IF;
 SELECT t.scheduled_on INTO scheduled FROM public.maintenance_tickets t WHERE t.org_id=j.org_id AND t.id=j.ticket_id;
 IF p_request IS NULL OR p_decision IS NULL OR p_decision NOT IN ('accepted','declined')
  OR (p_decision='accepted' AND p_reason IS NOT NULL)
  OR (p_decision='declined' AND p_agreed_on IS NOT NULL)
  OR (p_reason IS NOT NULL AND length(btrim(p_reason)) NOT BETWEEN 1 AND 500)
  OR (p_agreed_on IS NOT NULL AND scheduled IS NOT NULL AND p_agreed_on<scheduled)
 THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 INSERT INTO app.b105_vendor_job_decisions(vendor_job_id,org_id,ticket_id,decision,agreed_completion_on,decline_reason,request_id)
 VALUES (j.id,j.org_id,j.ticket_id,p_decision,p_agreed_on,btrim(p_reason),p_request);
 RETURN jsonb_build_object('status','recorded','decision',p_decision,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION app.b105_vendor_decide(text,boolean,uuid,text,date,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b105_vendor_decide(text,boolean,uuid,text,date,text) TO service_role;

-- Write: tag one of this job's own uploads as 處理前 or 處理後. Only after 接單, only while the case is open.
CREATE FUNCTION app.b105_vendor_photo_phase(p_token_hash text,p_env_v2 boolean,p_attachment uuid,p_phase text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.repair_vendor_jobs;
BEGIN
 j:=app.b105_vendor_write_job(p_token_hash,p_env_v2);
 IF NOT EXISTS(SELECT 1 FROM app.b105_vendor_job_decisions d WHERE d.vendor_job_id=j.id AND d.decision='accepted')
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_attachment IS NULL OR p_phase IS NULL OR p_phase NOT IN ('before','after')
 THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 UPDATE public.ticket_attachments a SET phase=p_phase
  WHERE a.id=p_attachment AND a.org_id=j.org_id AND a.ticket_id=j.ticket_id AND a.vendor_job_id=j.id
   AND NOT a.is_internal AND (a.phase IS NULL OR a.phase=p_phase);
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 RETURN '{"status":"recorded"}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION app.b105_vendor_photo_phase(text,boolean,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b105_vendor_photo_phase(text,boolean,uuid,text) TO service_role;
COMMIT;
