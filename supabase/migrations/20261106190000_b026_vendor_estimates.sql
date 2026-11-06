-- B-026 slice 2. Local vendor estimates reuse immutable B-013 approval state.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
INSERT INTO public.platform_settings(key,value)
 VALUES('vendor_estimates','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
 ON CONFLICT DO NOTHING;

CREATE TABLE app.b026_vendor_estimates (
 org_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 version_id uuid PRIMARY KEY,
 vendor_job_id uuid NOT NULL REFERENCES public.repair_vendor_jobs(id),
 FOREIGN KEY(org_id,ticket_id,version_id)
  REFERENCES app.b013_estimate_versions(org_id,ticket_id,id)
);
ALTER TABLE app.b026_vendor_estimates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b026_vendor_estimates FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b026_estimates_immutable BEFORE UPDATE OR DELETE ON app.b026_vendor_estimates
 FOR EACH ROW EXECUTE FUNCTION app.b013_approval_immutable_row();
CREATE TRIGGER b026_estimates_no_truncate BEFORE TRUNCATE ON app.b026_vendor_estimates
 FOR EACH STATEMENT EXECUTE FUNCTION app.b013_approval_immutable_row();

CREATE FUNCTION app.b026_estimates_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT coalesce((SELECT o.feature_flags->'vendor_estimates'='true'::jsonb
 AND f.value->'enabled'='true'::jsonb
 AND jsonb_typeof(f.value->'allowed_org_ids')='array'
 AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
 FROM public.organizations o CROSS JOIN public.platform_settings f
 WHERE o.id=p_org AND f.key='vendor_estimates'),false)
 AND app.b013_approvals_enabled(p_org) AND coalesce(app.vendor_dispatch_enabled(p_org),false)
$$;
REVOKE ALL ON FUNCTION app.b026_estimates_enabled(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_estimates_enabled(uuid) TO service_role;

-- Same lifecycle/assignment/sharing/terminal boundary as slice 4; no secret cleanup writes.
-- Revalidate after the full admission lock set and immediately before returning.
CREATE FUNCTION app.b026_estimate_job(p_hash text) RETURNS public.repair_vendor_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j public.repair_vendor_jobs;
BEGIN
 SELECT v.* INTO j FROM public.repair_vendor_jobs v
 JOIN public.maintenance_tickets t ON t.org_id=v.org_id AND t.id=v.ticket_id
 WHERE v.token_hash=p_hash AND v.active AND v.revoked_at IS NULL
 AND v.expires_at>clock_timestamp() AND v.scope='case_collaboration'
 AND v.sharing_approved_at IS NOT NULL AND v.vendor_contact_id=t.assigned_vendor_contact_id
 AND t.status::text NOT IN ('closed','cancelled');
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 RETURN j;
END $$;
REVOKE ALL ON FUNCTION app.b026_estimate_job(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b026_submit_vendor_estimate(p_token_hash text,p_request uuid,
 p_expected_head uuid,p_amount_minor bigint,p_currency text,p_minor_unit smallint,
 p_work_scope text,p_evidence jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE j public.repair_vendor_jobs; t record; pr record; own record; region record; rev record;
 p_org uuid; p_ticket uuid; p_payload_sha256 bytea;
 head uuid; n bigint; version_id uuid := gen_random_uuid();
 lock_deadline timestamptz;
 threshold bigint; source text; revision_id uuid; scale smallint; input jsonb; result jsonb;
BEGIN
 -- OFF admission precedes replay and every domain/ledger write.
 SELECT * INTO j FROM public.repair_vendor_jobs WHERE token_hash=p_token_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 p_org:=j.org_id; p_ticket:=j.ticket_id;
 IF NOT app.b026_estimates_enabled(p_org) THEN RETURN '{"status":"rejected_disabled"}'; END IF;
 j:=app.b026_estimate_job(p_token_hash);
 input:=jsonb_build_array('b026_vendor_estimate',j.id,p_expected_head,p_amount_minor::text,
  p_currency,p_minor_unit,p_work_scope,p_evidence);
 p_payload_sha256:=pg_catalog.sha256(convert_to(input::text,'UTF8'));
 -- The job UUID is the token principal, never the dispatching staff identity.
 -- b013_replay takes the advisory request lock before any row locks.
 result:=app.b013_replay(p_org,j.id,p_request,'submit',p_payload_sha256,input);
 -- All row locks are acquired in one exception subtransaction. A busy legacy
 -- appointment may own job -> ticket; never wait while holding the inverse.
 -- Retrying releases EVERY row lock (including flags), allowing flag-OFF to win.
 lock_deadline:=clock_timestamp()+interval '6 seconds';
 LOOP
  BEGIN
   PERFORM 1 FROM public.platform_settings
    WHERE key IN ('repair_approvals','vendor_estimates') ORDER BY key FOR SHARE NOWAIT;
   PERFORM 1 FROM public.organizations WHERE id=p_org ORDER BY id FOR SHARE NOWAIT;
   IF NOT app.b026_estimates_enabled(p_org) THEN RETURN '{"status":"rejected_disabled"}'; END IF;
   SELECT * INTO t FROM public.maintenance_tickets WHERE org_id=p_org AND id=p_ticket FOR UPDATE NOWAIT;
   PERFORM 1 FROM public.repair_vendor_jobs WHERE org_id=p_org AND ticket_id=p_ticket ORDER BY id FOR UPDATE NOWAIT;
   SELECT * INTO pr FROM public.properties WHERE org_id = p_org AND id = t.property_id AND archived_at IS NULL FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
   SELECT po.*, c.user_id AS principal_id INTO own
   FROM public.property_owners po
   JOIN public.contacts c ON c.org_id = po.org_id AND c.id = po.owner_contact_id
   JOIN public.organizations o ON o.id = po.org_id
   WHERE po.org_id = p_org AND po.property_id = pr.id AND c.is_owner
    AND c.user_id IS NOT NULL AND c.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
   ORDER BY po.id LIMIT 1 FOR SHARE OF po, c NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
   SELECT current_version_id INTO head FROM app.b013_estimate_heads WHERE org_id = p_org AND ticket_id = p_ticket FOR UPDATE NOWAIT;
   SELECT r.* INTO region FROM app.b013_regional_defaults r
   JOIN public.organizations o ON o.country_code::text = r.country_code
   WHERE o.id = p_org AND r.currency = pr.currency FOR SHARE OF r NOWAIT;
   SELECT r.* INTO rev FROM app.b013_default_roots root
   JOIN app.b013_default_revisions r ON r.org_id = root.org_id AND r.root_id = root.id
    AND r.id = root.current_revision AND r.revision_no = root.version
   WHERE root.org_id = p_org AND root.principal_id = own.principal_id AND root.currency = pr.currency
   FOR SHARE OF root NOWAIT;
   -- All flag/domain locks are now held through commit. Revalidate admission
   -- after waits, before replay, rejected-command persistence or domain writes.
   IF NOT app.b026_estimates_enabled(p_org) THEN RETURN '{"status":"rejected_disabled"}'; END IF;
   j:=app.b026_estimate_job(p_token_hash);
   EXIT;
  EXCEPTION WHEN lock_not_available THEN
   IF clock_timestamp()>=lock_deadline THEN
    RAISE EXCEPTION 'Estimate submission busy' USING ERRCODE='55P03';
   END IF;
   PERFORM pg_sleep(0.05);
  END;
 END LOOP;
 IF result IS NOT NULL THEN RETURN result; END IF;
 -- Optional evidence is an allowlist of existing uploads for this exact assignment.
 IF NOT app.b013_photo_refs(p_evidence,0) THEN RETURN '{"status":"rejected_invalid"}'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence) e WHERE
  e - 'id' <> '{}'::jsonb OR NOT EXISTS(SELECT 1 FROM public.ticket_attachments a
   WHERE a.id::text=e->>'id' AND a.org_id=p_org AND a.ticket_id=p_ticket
    AND a.vendor_job_id=j.id AND NOT a.is_internal)) THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501';
 END IF;
 IF head IS DISTINCT FROM p_expected_head THEN
  RETURN app.b013_store_result(p_org, j.id, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_conflict"}');
 END IF;
 scale := coalesce(region.minor_unit, rev.minor_unit);
 IF own.repair_approval_threshold_minor IS NOT NULL THEN
  threshold := own.repair_approval_threshold_minor; source := 'property_override'; revision_id := own.id;
 ELSIF rev.mode = 'set' THEN
  threshold := rev.threshold_minor; source := 'owner_default'; revision_id := rev.id;
  scale := rev.minor_unit;
 ELSE
  threshold := region.threshold_minor; source := 'regional_default'; revision_id := NULL;
 END IF;
 IF threshold IS NULL OR scale IS NULL THEN
  RETURN app.b013_store_result(p_org, j.id, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_unavailable"}');
 END IF;
 IF p_amount_minor IS NULL OR p_amount_minor < 0 OR p_currency IS NULL
  OR p_currency !~ '^[A-Z]{3}$' OR p_currency IS DISTINCT FROM btrim(pr.currency::text)
  OR p_minor_unit IS NULL OR p_minor_unit NOT BETWEEN 0 AND 4 OR p_minor_unit <> scale
  OR (region.minor_unit IS NOT NULL AND p_minor_unit <> region.minor_unit)
  OR p_work_scope IS NULL OR length(btrim(p_work_scope)) NOT BETWEEN 1 AND 8000
  OR NOT app.b013_photo_refs(p_evidence, 0) THEN
  RETURN app.b013_store_result(p_org, j.id, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_invalid"}');
 END IF;
 SELECT coalesce(max(version_no), 0) + 1 INTO n FROM app.b013_estimate_versions
 WHERE org_id = p_org AND ticket_id = p_ticket;
 INSERT INTO app.b013_estimate_heads(org_id, ticket_id, current_version_id)
 VALUES (p_org, p_ticket, version_id)
 ON CONFLICT (org_id, ticket_id) DO UPDATE
 SET current_version_id = EXCLUDED.current_version_id, updated_at = clock_timestamp();
 INSERT INTO app.b013_estimate_versions(
  id, org_id, ticket_id, property_id, version_no, currency, minor_unit, amount_minor,
  work_scope, evidence_snapshot, designated_ownership_id, designated_contact_id, designated_principal_id,
  captured_threshold_minor, threshold_source, threshold_revision_id, threshold_provenance_sha256, payload_sha256, submitted_by)
 VALUES (version_id, p_org, p_ticket, pr.id, n, p_currency, p_minor_unit, p_amount_minor,
  p_work_scope, p_evidence, own.id, own.owner_contact_id, own.principal_id,
  threshold, source, revision_id,
  pg_catalog.sha256(convert_to(jsonb_build_array(p_org, pr.id, own.id, own.owner_contact_id,
   own.principal_id, p_currency, scale, threshold::text, source, revision_id, region.revision)::text, 'UTF8')),
  p_payload_sha256, j.id);
 result := jsonb_build_object('status', 'recorded', 'version_id', version_id,
  'requires_owner_decision', p_amount_minor > threshold,
  'state', CASE WHEN p_amount_minor > threshold THEN 'pending_approval' ELSE 'policy_qualified' END);
 INSERT INTO app.b026_vendor_estimates(org_id,ticket_id,version_id,vendor_job_id)
 VALUES(p_org,p_ticket,version_id,j.id);
 PERFORM app.b026_estimate_job(p_token_hash);
 RETURN app.b013_store_result(p_org, j.id, p_request, p_ticket, 'submit', p_expected_head,
  NULL, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b026_submit_vendor_estimate(text,uuid,uuid,bigint,text,smallint,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_submit_vendor_estimate(text,uuid,uuid,bigint,text,smallint,text,jsonb) TO service_role;

CREATE FUNCTION app.b026_vendor_estimate_context(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j public.repair_vendor_jobs; result jsonb;
BEGIN
 SELECT * INTO j FROM public.repair_vendor_jobs WHERE token_hash=p_hash;
 IF NOT FOUND OR NOT app.b026_estimates_enabled(j.org_id) THEN RETURN NULL; END IF;
 j:=app.b026_estimate_job(p_hash);
 SELECT jsonb_build_object('headId',h.current_version_id,'currency',btrim(p.currency::text),
 'minorUnit',r.minor_unit,'photos',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id))
 FROM public.ticket_attachments a WHERE a.org_id=j.org_id AND a.ticket_id=j.ticket_id
 AND a.vendor_job_id=j.id AND NOT a.is_internal),'[]'::jsonb)) INTO result
 FROM public.maintenance_tickets t JOIN public.properties p ON p.id=t.property_id AND p.org_id=t.org_id
 JOIN public.organizations o ON o.id=t.org_id
 JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
 LEFT JOIN app.b013_estimate_heads h ON h.org_id=t.org_id AND h.ticket_id=t.id
 WHERE t.org_id=j.org_id AND t.id=j.ticket_id AND p.archived_at IS NULL;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b026_vendor_estimate_context(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_vendor_estimate_context(text) TO service_role;

CREATE FUNCTION app.b026_manager_estimates(p_org uuid,p_live uuid,p_env text,p_session uuid,p_ticket uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE result jsonb; actor_scope record;
BEGIN
 -- Preserve the B-013 scope/session/member contract without executing its
 -- complete estimate-history reader, including for direct OFF-path calls.
 IF NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor_scope FROM app.b013_actor(p_org,p_session);
 IF actor_scope.member_role IS NULL OR actor_scope.member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.maintenance_tickets WHERE id=p_ticket AND org_id=p_org) THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT app.b026_estimates_enabled(p_org) THEN RETURN '[]'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('versionId',v.id,'versionNo',v.version_no::text,
 'amountMinor',v.amount_minor::text,'currency',btrim(v.currency::text),'minorUnit',v.minor_unit,
 'workScope',v.work_scope,'isCurrent',h.current_version_id=v.id,
 'state',CASE WHEN h.current_version_id<>v.id THEN 'superseded' WHEN d.decision IS NOT NULL THEN d.decision
 WHEN v.requires_owner_decision THEN 'pending_approval' ELSE 'policy_qualified' END,
 'photos',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id))
 FROM jsonb_array_elements(v.evidence_snapshot) e JOIN public.ticket_attachments a ON a.id::text=e->>'id'
 WHERE a.org_id=v.org_id AND a.ticket_id=v.ticket_id AND a.vendor_job_id=b.vendor_job_id
 AND NOT a.is_internal),'[]'::jsonb)) ORDER BY v.version_no DESC),'[]'::jsonb) INTO result
 FROM app.b026_vendor_estimates b JOIN app.b013_estimate_versions v ON v.id=b.version_id
 JOIN app.b013_estimate_heads h ON h.org_id=v.org_id AND h.ticket_id=v.ticket_id
 LEFT JOIN app.b013_estimate_decisions d ON d.org_id=v.org_id AND d.version_id=v.id
 WHERE v.org_id=p_org AND v.ticket_id=p_ticket;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b026_manager_estimates(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_manager_estimates(uuid,uuid,text,uuid,uuid) TO service_role;

-- Persisted estimate admission cannot be bypassed by turning rendering flags OFF.
-- No effect for tickets without a B-026 estimate; legacy data/paths stay unchanged.
CREATE FUNCTION app.b026_work_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE ticket uuid; org uuid; head uuid; must_check boolean;
BEGIN
 IF TG_TABLE_NAME='b013_repair_appointments' THEN
  ticket:=NEW.ticket_id; org:=NEW.org_id;
  must_check:=NEW.event_kind IN ('vendor_proposed','company_confirmed','vendor_completion_submitted');
 ELSIF TG_TABLE_NAME='repair_vendor_jobs' THEN
  ticket:=NEW.ticket_id; org:=NEW.org_id;
  must_check:=NEW.reported_at IS DISTINCT FROM OLD.reported_at OR NEW.reported_cost_minor IS DISTINCT FROM OLD.reported_cost_minor;
 ELSE
  ticket:=NEW.id; org:=NEW.org_id;
  must_check:=NEW.scheduled_on IS DISTINCT FROM OLD.scheduled_on OR NEW.completed_on IS DISTINCT FROM OLD.completed_on
   OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status::text IN ('in_progress','resolved','closed'));
 END IF;
 IF must_check AND EXISTS(SELECT 1 FROM app.b026_vendor_estimates WHERE org_id=org AND ticket_id=ticket) THEN
  SELECT current_version_id INTO head FROM app.b013_estimate_heads WHERE org_id=org AND ticket_id=ticket;
  IF NOT coalesce(app.b013_dispatch_allowed(org,head),false) THEN
   RAISE EXCEPTION 'Estimate approval required' USING ERRCODE='40001';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b026_work_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b026_appointment_work_guard BEFORE INSERT ON app.b013_repair_appointments
 FOR EACH ROW EXECUTE FUNCTION app.b026_work_guard();
CREATE TRIGGER b026_report_work_guard BEFORE UPDATE ON public.repair_vendor_jobs
 FOR EACH ROW EXECUTE FUNCTION app.b026_work_guard();
CREATE TRIGGER b026_ticket_work_guard BEFORE UPDATE ON public.maintenance_tickets
 FOR EACH ROW EXECUTE FUNCTION app.b026_work_guard();
COMMIT;
