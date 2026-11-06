-- B-028 package 4: close inherited B-013 repair authorization/integrity gaps.
-- (1) Staff/owner repair mutators bind the selected environment/live-org tuple and
--     the request principal, exactly as the B-021 readers bind the tuple.
-- (2) Estimate evidence and emergency photo refs must name real, owner-visible ticket
--     photos of the same org and ticket.
-- (3) Appointments keep their vendor job's org/ticket even if the parent job is updated.
-- No table, column, grant widening or rollout flag change. With repair_approvals OFF a
-- valid context still records the existing disabled-command result.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Internal: environment tuple (same predicate as b013_owner_pending/history/manager_view),
-- then the existing session/membership check, then the session must belong to the
-- request principal (svc() sets request.jwt.claim.sub to Session.userId).
CREATE FUNCTION app.b028_repair_actor(p_org uuid, p_live uuid, p_env text, p_session uuid)
RETURNS TABLE(actor uuid, member_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE r record;
BEGIN
 IF p_env IS NULL OR p_env NOT IN ('live','sandbox') OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM app.b013_actor(p_org,p_session);
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM r.actor THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501';
 END IF;
 actor := r.actor; member_role := r.member_role;
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app.b028_repair_actor(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Internal: shape (unchanged b013_photo_refs), then every ref id must be a ticket
-- attachment of this org and ticket, backed by a file of the same org in the private
-- ticket-photo bucket, and not internal (internal attachments are hidden from the
-- owner who reads these refs). Missing (deleted) ids fail. Rows are pinned FOR SHARE
-- until the command commits. Reject, never strip: callers return rejected_invalid.
CREATE FUNCTION app.b028_repair_photo_refs(p_org uuid, p_ticket uuid, p_refs jsonb, p_min integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE ids uuid[]; n integer;
BEGIN
 IF NOT app.b013_photo_refs(p_refs,p_min) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_refs) x
  WHERE x->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
  RETURN false;
 END IF;
 SELECT array_agg(DISTINCT (x->>'id')::uuid) INTO ids FROM jsonb_array_elements(p_refs) x;
 IF ids IS NULL THEN RETURN true; END IF;
 SELECT count(*) INTO n FROM (
  SELECT a.id FROM public.ticket_attachments a
  JOIN public.files f ON f.org_id=a.org_id AND f.id=a.file_id
  WHERE a.org_id=p_org AND a.ticket_id=p_ticket AND a.id=ANY(ids)
   AND NOT a.is_internal AND f.storage_bucket='ticket-photos-private'
  FOR SHARE OF a,f
 ) s;
 RETURN n=cardinality(ids);
END $$;
REVOKE ALL ON FUNCTION app.b028_repair_photo_refs(uuid,uuid,jsonb,integer) FROM PUBLIC,anon,authenticated,service_role;

-- The four session mutators gain (p_live, p_env) after p_org, matching the readers.
-- CREATE OR REPLACE cannot add parameters; dropping the old signatures leaves no
-- unbound path. Bodies are the current ones (b024 for record_appointment) apart from
-- the actor call and the photo check.
DROP FUNCTION app.b013_submit_estimate(uuid,uuid,uuid,uuid,uuid,bigint,text,smallint,text,jsonb,bytea);
DROP FUNCTION app.b013_decide_estimate(uuid,uuid,uuid,uuid,text,text,bytea);
DROP FUNCTION app.b013_authorize_emergency(uuid,uuid,uuid,uuid,text,text,jsonb,bytea);
DROP FUNCTION app.b013_record_appointment(uuid,uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,bytea,text);

CREATE FUNCTION app.b013_submit_estimate(p_org uuid, p_live uuid, p_env text, p_session uuid, p_request uuid,
 p_ticket uuid, p_expected_head uuid, p_amount_minor bigint, p_currency text,
 p_minor_unit smallint, p_work_scope text, p_evidence jsonb, p_payload_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record; t record; pr record; own record; region record; rev record;
 head uuid; n bigint; version_id uuid := gen_random_uuid();
 threshold bigint; source text; revision_id uuid; scale smallint;
 input jsonb; result jsonb;
BEGIN
 SELECT * INTO a FROM app.b028_repair_actor(p_org, p_live, p_env, p_session);
 -- W1/W7: the ticket must belong to the session-validated org before any ledger write.
 IF p_ticket IS NULL OR NOT EXISTS (SELECT 1 FROM public.maintenance_tickets WHERE org_id = p_org AND id = p_ticket) THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501';
 END IF;
 input := jsonb_build_array(p_ticket, p_expected_head, p_amount_minor::text, p_currency,
  p_minor_unit, p_work_scope, p_evidence);
 result := app.b013_replay(p_org, a.actor, p_request, 'submit', p_payload_sha256, input);
 IF result IS NOT NULL THEN RETURN result; END IF;
 IF NOT app.b013_approvals_enabled(p_org) THEN
  RETURN app.b013_store_result(p_org, a.actor, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_disabled"}');
 END IF;
 IF a.member_role IS NULL OR a.member_role NOT IN ('admin', 'manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501';
 END IF;
 SELECT * INTO t FROM public.maintenance_tickets WHERE org_id = p_org AND id = p_ticket FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 SELECT * INTO pr FROM public.properties WHERE org_id = p_org AND id = t.property_id AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 SELECT po.*, c.user_id AS principal_id INTO own
 FROM public.property_owners po
 JOIN public.contacts c ON c.org_id = po.org_id AND c.id = po.owner_contact_id
 JOIN public.organizations o ON o.id = po.org_id
 WHERE po.org_id = p_org AND po.property_id = pr.id AND c.is_owner
  AND c.user_id IS NOT NULL AND c.archived_at IS NULL
  AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
  AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
 ORDER BY po.id LIMIT 1 FOR SHARE OF po, c;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 SELECT current_version_id INTO head FROM app.b013_estimate_heads WHERE org_id = p_org AND ticket_id = p_ticket FOR UPDATE;
 IF head IS DISTINCT FROM p_expected_head THEN
  RETURN app.b013_store_result(p_org, a.actor, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_conflict"}');
 END IF;
 SELECT r.* INTO region FROM app.b013_regional_defaults r
 JOIN public.organizations o ON o.country_code::text = r.country_code
 WHERE o.id = p_org AND r.currency = pr.currency FOR SHARE OF r;
 SELECT r.* INTO rev FROM app.b013_default_roots root
 JOIN app.b013_default_revisions r ON r.org_id = root.org_id AND r.root_id = root.id
  AND r.id = root.current_revision AND r.revision_no = root.version
 WHERE root.org_id = p_org AND root.principal_id = own.principal_id AND root.currency = pr.currency
 FOR SHARE OF root;
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
  RETURN app.b013_store_result(p_org, a.actor, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_unavailable"}');
 END IF;
 IF p_amount_minor IS NULL OR p_amount_minor < 0 OR p_currency IS NULL
  OR p_currency !~ '^[A-Z]{3}$' OR p_currency IS DISTINCT FROM btrim(pr.currency::text)
  OR p_minor_unit IS NULL OR p_minor_unit NOT BETWEEN 0 AND 4 OR p_minor_unit <> scale
  OR (region.minor_unit IS NOT NULL AND p_minor_unit <> region.minor_unit)
  OR p_work_scope IS NULL OR length(btrim(p_work_scope)) NOT BETWEEN 1 AND 8000
  OR NOT app.b028_repair_photo_refs(p_org, p_ticket, p_evidence, 0) THEN
  RETURN app.b013_store_result(p_org, a.actor, p_request, p_ticket, 'submit', p_expected_head,
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
  p_payload_sha256, a.actor);
 result := jsonb_build_object('status', 'recorded', 'version_id', version_id,
  'requires_owner_decision', p_amount_minor > threshold,
  'state', CASE WHEN p_amount_minor > threshold THEN 'pending_approval' ELSE 'policy_qualified' END);
 PERFORM app.b028_repair_actor(p_org, p_live, p_env, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, p_ticket, 'submit', p_expected_head,
  NULL, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_submit_estimate(uuid, uuid, text, uuid, uuid, uuid, uuid, bigint, text, smallint, text, jsonb, bytea)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_submit_estimate(uuid, uuid, text, uuid, uuid, uuid, uuid, bigint, text, smallint, text, jsonb, bytea)
 TO service_role;

CREATE FUNCTION app.b013_decide_estimate(p_org uuid, p_live uuid, p_env text, p_session uuid, p_request uuid,
 p_version uuid, p_decision text, p_reason text, p_payload_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record; v app.b013_estimate_versions; input jsonb; result jsonb; decision_id uuid;
BEGIN
 SELECT * INTO a FROM app.b028_repair_actor(p_org, p_live, p_env, p_session);
 input := jsonb_build_array(p_version, p_decision, p_reason);
 result := app.b013_replay(p_org, a.actor, p_request, 'decision', p_payload_sha256, input);
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO v FROM app.b013_estimate_versions WHERE org_id = p_org AND id = p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 IF NOT app.b013_approvals_enabled(p_org) THEN
  RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'decision', NULL,
   p_version, p_payload_sha256, input, '{"status":"rejected_disabled"}');
 END IF;
 v := app.b013_lock_version(p_org, p_version);
 IF a.actor <> v.designated_principal_id THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501';
 END IF;
 PERFORM 1 FROM public.property_owners po
 JOIN public.contacts c ON c.org_id = po.org_id AND c.id = po.owner_contact_id
 JOIN public.properties pr ON pr.org_id = po.org_id AND pr.id = po.property_id
 JOIN public.organizations o ON o.id = po.org_id
 WHERE po.org_id = p_org AND po.id = v.designated_ownership_id AND po.property_id = v.property_id
  AND c.id = v.designated_contact_id AND c.user_id = a.actor AND c.is_owner AND c.archived_at IS NULL
  AND pr.archived_at IS NULL AND pr.currency = v.currency
  AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
  AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
 FOR SHARE OF po, c, pr;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 IF EXISTS (SELECT 1 FROM app.b013_regional_defaults r JOIN public.organizations o
  ON o.country_code::text = r.country_code WHERE o.id = p_org AND r.currency = v.currency
  AND r.minor_unit <> v.minor_unit) THEN
  RAISE EXCEPTION 'Repair currency changed' USING ERRCODE = '40001';
 END IF;
 IF NOT v.requires_owner_decision OR EXISTS (
  SELECT 1 FROM app.b013_estimate_decisions WHERE org_id = p_org AND version_id = p_version
 ) THEN
  result := '{"status":"rejected_conflict"}';
 ELSIF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected', 'more_information')
  OR (p_reason IS NOT NULL AND length(btrim(p_reason)) NOT BETWEEN 1 AND 4000)
  OR (p_decision <> 'approved' AND p_reason IS NULL) THEN
  result := '{"status":"rejected_invalid"}';
 ELSE
  INSERT INTO app.b013_estimate_decisions(org_id, ticket_id, version_id, decision, decided_by, reason)
  VALUES (p_org, v.ticket_id, p_version, p_decision, a.actor, p_reason) RETURNING id INTO decision_id;
  result := jsonb_build_object('status', 'recorded', 'version_id', p_version, 'decision_id', decision_id);
 END IF;
 PERFORM app.b028_repair_actor(p_org, p_live, p_env, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'decision', NULL,
  p_version, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_decide_estimate(uuid, uuid, text, uuid, uuid, uuid, text, text, bytea)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_decide_estimate(uuid, uuid, text, uuid, uuid, uuid, text, text, bytea) TO service_role;

CREATE FUNCTION app.b013_authorize_emergency(p_org uuid, p_live uuid, p_env text, p_session uuid, p_request uuid,
 p_version uuid, p_category text, p_reason text, p_photos jsonb, p_payload_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record; v app.b013_estimate_versions; input jsonb; result jsonb; emergency_id uuid; event_id uuid;
BEGIN
 SELECT * INTO a FROM app.b028_repair_actor(p_org, p_live, p_env, p_session);
 input := jsonb_build_array(p_version, p_category, p_reason, p_photos);
 result := app.b013_replay(p_org, a.actor, p_request, 'emergency', p_payload_sha256, input);
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO v FROM app.b013_estimate_versions WHERE org_id = p_org AND id = p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 IF NOT app.b013_approvals_enabled(p_org) THEN
  RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'emergency', NULL,
   p_version, p_payload_sha256, input, '{"status":"rejected_disabled"}');
 END IF;
 IF a.member_role IS DISTINCT FROM 'admin' THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501';
 END IF;
 v := app.b013_lock_version(p_org, p_version);
 IF NOT v.requires_owner_decision
  OR EXISTS (SELECT 1 FROM app.b013_estimate_decisions WHERE org_id = p_org AND version_id = p_version)
  OR EXISTS (SELECT 1 FROM app.b013_repair_emergencies WHERE org_id = p_org AND version_id = p_version) THEN
  result := '{"status":"rejected_conflict"}';
 ELSIF p_category IS NULL OR p_category NOT IN ('water', 'electricity', 'safety')
  OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4000
  OR NOT app.b028_repair_photo_refs(p_org, v.ticket_id, p_photos, 1) THEN
  result := '{"status":"rejected_invalid"}';
 ELSE
  INSERT INTO app.b013_repair_emergencies(org_id, ticket_id, version_id, category, reason, authorized_photo_snapshot, authorized_by)
  VALUES (p_org, v.ticket_id, p_version, p_category, p_reason, p_photos, a.actor) RETURNING id INTO emergency_id;
  INSERT INTO app.b013_repair_event_outbox(org_id, ticket_id, version_id, kind, emergency_id, designated_principal_id)
  VALUES (p_org, v.ticket_id, p_version, 'emergency_owner_notice', emergency_id, v.designated_principal_id)
  RETURNING id INTO event_id;
  INSERT INTO public.audit_log(org_id, actor_user_id, actor_role, table_name, row_id,
   action, new_row, reason, request_id, occurred_at)
  VALUES (p_org, a.actor, 'admin', 'b013_repair_emergencies', emergency_id::text, 'insert',
   jsonb_build_object('version_id', p_version, 'emergency_id', emergency_id, 'event_id', event_id, 'category', p_category),
   'repair_emergency_authorized', p_request::text, clock_timestamp());
  result := jsonb_build_object('status', 'recorded', 'version_id', p_version,
   'emergency_id', emergency_id, 'event_id', event_id);
 END IF;
 PERFORM app.b028_repair_actor(p_org, p_live, p_env, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'emergency', NULL,
  p_version, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_authorize_emergency(uuid, uuid, text, uuid, uuid, uuid, text, text, jsonb, bytea)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_authorize_emergency(uuid, uuid, text, uuid, uuid, uuid, text, text, jsonb, bytea) TO service_role;

CREATE FUNCTION app.b013_record_appointment(p_org uuid, p_live uuid, p_env text, p_session uuid, p_request uuid,
 p_version uuid, p_vendor_job uuid, p_event_kind text,
 p_proposed_start timestamptz, p_proposed_end timestamptz,
 p_confirmed_start timestamptz, p_confirmed_end timestamptz, p_payload_sha256 bytea,
 p_response_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE a record; v app.b013_estimate_versions; input jsonb; result jsonb; appointment_id uuid;
BEGIN
 SELECT * INTO a FROM app.b028_repair_actor(p_org, p_live, p_env, p_session);
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
 PERFORM app.b028_repair_actor(p_org, p_live, p_env, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'appointment', NULL,
  p_version, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_record_appointment(uuid, uuid, text, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, bytea, text)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_record_appointment(uuid, uuid, text, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, bytea, text)
 TO service_role;

-- (3) The B-021 insert guard does not cover a later parent-job UPDATE of org_id or
-- ticket_id. Reference the job by its existing (org_id, ticket_id, id) unique index
-- (b028_vendor_job_scope_unique) so such an update is rejected (NO ACTION, 23503).
-- NOT VALID + VALIDATE run in this migration's single transaction, so the SHARE ROW
-- EXCLUSIVE lock on both tables is held until COMMIT (no lock-time saving); the
-- insert guard already guarantees every existing row matches.
ALTER TABLE app.b013_repair_appointments
 ADD CONSTRAINT b028_appointment_job_scope_fkey
 FOREIGN KEY (org_id, ticket_id, repair_vendor_job_id)
 REFERENCES public.repair_vendor_jobs(org_id, ticket_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE app.b013_repair_appointments VALIDATE CONSTRAINT b028_appointment_job_scope_fkey;
COMMIT;
