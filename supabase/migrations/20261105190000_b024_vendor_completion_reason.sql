BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.b013_repair_appointments
 ADD COLUMN response_reason text,
 ADD CONSTRAINT b024_response_reason_length CHECK
  (response_reason IS NULL OR length(btrim(response_reason)) BETWEEN 1 AND 4000),
 ADD CONSTRAINT b024_rejection_requires_reason CHECK
  (event_kind <> 'vendor_rejected' OR response_reason IS NOT NULL);

-- Replace the old signature with a trailing default so existing callers still
-- resolve unambiguously. No table privileges or rollout flags are changed.
DROP FUNCTION app.b013_record_appointment(uuid,uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,bytea);

CREATE FUNCTION app.b013_record_appointment(p_org uuid, p_session uuid, p_request uuid,
 p_version uuid, p_vendor_job uuid, p_event_kind text,
 p_proposed_start timestamptz, p_proposed_end timestamptz,
 p_confirmed_start timestamptz, p_confirmed_end timestamptz, p_payload_sha256 bytea,
 p_response_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE a record; v app.b013_estimate_versions; input jsonb; result jsonb; appointment_id uuid;
BEGIN
 SELECT * INTO a FROM app.b013_actor(p_org, p_session);
 IF a.member_role IS NULL OR a.member_role NOT IN ('admin', 'manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501';
 END IF;
 -- Epoch values keep replay identity independent of the caller's TimeZone.
 input := jsonb_build_array(p_version, p_vendor_job, p_event_kind,
  extract(epoch FROM p_proposed_start), extract(epoch FROM p_proposed_end),
  extract(epoch FROM p_confirmed_start), extract(epoch FROM p_confirmed_end));
 -- Preserve old replay identity when no reason was supplied.
 IF p_response_reason IS NOT NULL THEN input := input || jsonb_build_array(p_response_reason); END IF;
 result := app.b013_replay(p_org, a.actor, p_request, 'appointment', p_payload_sha256, input);
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO v FROM app.b013_estimate_versions WHERE org_id = p_org AND id = p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 IF NOT app.b013_approvals_enabled(p_org) OR NOT coalesce(app.vendor_dispatch_enabled(p_org), false) THEN
  RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'appointment', NULL,
   p_version, p_payload_sha256, input, '{"status":"rejected_disabled"}');
 END IF;
 v := app.b013_lock_version(p_org, p_version);
 PERFORM 1 FROM public.repair_vendor_jobs
 WHERE id = p_vendor_job AND org_id = p_org AND ticket_id = v.ticket_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 IF p_event_kind IS NULL OR p_event_kind NOT IN
  ('vendor_proposed', 'company_confirmed', 'vendor_rejected', 'vendor_completion_submitted')
  OR (p_response_reason IS NOT NULL AND length(btrim(p_response_reason)) NOT BETWEEN 1 AND 4000)
  OR (p_event_kind = 'vendor_rejected' AND p_response_reason IS NULL)
  OR (p_proposed_end IS NOT NULL AND p_proposed_start IS NOT NULL AND p_proposed_end < p_proposed_start)
  OR (p_confirmed_end IS NOT NULL AND p_confirmed_start IS NOT NULL AND p_confirmed_end < p_confirmed_start)
  OR (p_event_kind = 'company_confirmed' AND (p_confirmed_start IS NULL OR p_confirmed_end IS NULL)) THEN
  result := '{"status":"rejected_invalid"}';
 ELSE
  INSERT INTO app.b013_repair_appointments(org_id, ticket_id, version_id, repair_vendor_job_id,
   event_kind, proposed_start, proposed_end, confirmed_start, confirmed_end, actor_id, response_reason)
  VALUES (p_org, v.ticket_id, p_version, p_vendor_job, p_event_kind,
   p_proposed_start, p_proposed_end, p_confirmed_start, p_confirmed_end, a.actor, p_response_reason) RETURNING id INTO appointment_id;
  result := jsonb_build_object('status', 'recorded', 'version_id', p_version, 'appointment_id', appointment_id);
 END IF;
 -- Appointment events never write maintenance_tickets.status.
 PERFORM app.b013_actor(p_org, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'appointment', NULL,
  p_version, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_record_appointment(uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, bytea, text)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_record_appointment(uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, bytea, text)
 TO service_role;

CREATE FUNCTION app.b013_record_vendor_appointment(p_org uuid, p_job uuid, p_token_hash text,
 p_request uuid, p_version uuid, p_event_kind text,
 p_proposed_start timestamptz, p_proposed_end timestamptz,
 p_confirmed_start timestamptz, p_confirmed_end timestamptz,
 p_response_reason text, p_payload_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j public.repair_vendor_jobs; v app.b013_estimate_versions;
 actor uuid; input jsonb; result jsonb; appointment_id uuid;
BEGIN
 -- The capability pins org and ticket; no auth_session is available on /v/[token].
 SELECT * INTO j FROM public.repair_vendor_jobs
 WHERE id=p_job AND org_id=p_org AND token_hash=p_token_hash
  AND active AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO v FROM app.b013_estimate_versions WHERE org_id=p_org AND id=p_version;
 IF NOT FOUND OR v.ticket_id IS DISTINCT FROM j.ticket_id THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501';
 END IF;
 -- Attribute to the dispatching staff member. If absent, use the job UUID itself
 -- as a stable synthetic actor (ledger actor_id has no auth.users foreign key).
 actor := coalesce(j.created_by,j.id);
 -- Namespace vendor identity so a staff request cannot replay as a vendor request.
 -- Never persist the token or its hash in input/result JSON.
 input := jsonb_build_array('vendor',p_job,p_version,p_event_kind,
  extract(epoch FROM p_proposed_start),extract(epoch FROM p_proposed_end),
  extract(epoch FROM p_confirmed_start),extract(epoch FROM p_confirmed_end),p_response_reason);
 result := app.b013_replay(p_org,actor,p_request,'appointment',p_payload_sha256,input);
 IF result IS NOT NULL THEN RETURN result; END IF;
 IF NOT app.b013_approvals_enabled(p_org) OR NOT coalesce(app.vendor_dispatch_enabled(p_org),false) THEN
  RETURN app.b013_store_result(p_org,actor,p_request,v.ticket_id,'appointment',NULL,
   p_version,p_payload_sha256,input,'{"status":"rejected_disabled"}');
 END IF;
 v := app.b013_lock_version(p_org,p_version);
 IF p_event_kind IS NULL OR p_event_kind NOT IN
  ('vendor_proposed','vendor_rejected','vendor_completion_submitted')
  OR (p_response_reason IS NOT NULL AND length(btrim(p_response_reason)) NOT BETWEEN 1 AND 4000)
  OR (p_event_kind='vendor_rejected' AND p_response_reason IS NULL)
  OR (p_proposed_start IS NOT NULL AND p_proposed_end IS NOT NULL AND p_proposed_end<p_proposed_start)
  OR (p_confirmed_start IS NOT NULL AND p_confirmed_end IS NOT NULL AND p_confirmed_end<p_confirmed_start) THEN
  result := '{"status":"rejected_invalid"}';
 ELSIF p_event_kind='vendor_completion_submitted' AND NOT app.b013_dispatch_allowed(p_org,p_version) THEN
  result := '{"status":"rejected_conflict"}';
 ELSE
  INSERT INTO app.b013_repair_appointments(org_id,ticket_id,version_id,repair_vendor_job_id,
   event_kind,proposed_start,proposed_end,confirmed_start,confirmed_end,response_reason,actor_id)
  VALUES(p_org,v.ticket_id,p_version,p_job,p_event_kind,p_proposed_start,p_proposed_end,
   p_confirmed_start,p_confirmed_end,p_response_reason,actor) RETURNING id INTO appointment_id;
  result := jsonb_build_object('status','recorded','version_id',p_version,'appointment_id',appointment_id);
 END IF;
 -- Recheck expiry after waiting for the version lock. The SHARE lock prevents
 -- concurrent revocation/reassignment until this transaction ends.
 IF j.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501';
 END IF;
 -- Appointment events never write maintenance_tickets.status.
 RETURN app.b013_store_result(p_org,actor,p_request,v.ticket_id,'appointment',NULL,
  p_version,p_payload_sha256,input,result);
END $$;
REVOKE ALL ON FUNCTION app.b013_record_vendor_appointment(uuid,uuid,text,uuid,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,bytea)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_record_vendor_appointment(uuid,uuid,text,uuid,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,bytea)
 TO service_role;

COMMIT;
