-- B-013 shared approval state. Intent outbox only; no delivery or payment.
-- CONTRACT.md overrides the older design's table count and proposed signatures.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE app.b013_estimate_heads (
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 ticket_id uuid NOT NULL,
 current_version_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id, ticket_id),
 FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id) ON DELETE RESTRICT
);
CREATE TABLE app.b013_estimate_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 property_id uuid NOT NULL,
 version_no bigint NOT NULL CHECK (version_no > 0),
 currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 minor_unit smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4),
 amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
 work_scope text NOT NULL CHECK (length(btrim(work_scope)) BETWEEN 1 AND 8000),
 evidence_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(evidence_snapshot) = 'array' AND jsonb_array_length(evidence_snapshot) <= 8),
 designated_ownership_id uuid NOT NULL,
 designated_contact_id uuid NOT NULL,
 designated_principal_id uuid NOT NULL,
 captured_threshold_minor bigint NOT NULL CHECK (captured_threshold_minor >= 0),
 threshold_source text NOT NULL CHECK (threshold_source IN ('property_override', 'owner_default', 'regional_default')),
 threshold_revision_id uuid,
 threshold_provenance_sha256 bytea NOT NULL CHECK (octet_length(threshold_provenance_sha256) = 32),
 payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
 requires_owner_decision boolean GENERATED ALWAYS AS (amount_minor > captured_threshold_minor) STORED,
 submitted_by uuid NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (org_id, ticket_id, id),
 UNIQUE (org_id, ticket_id, version_no),
 UNIQUE (org_id, ticket_id, id, designated_principal_id),
 FOREIGN KEY (org_id, ticket_id) REFERENCES app.b013_estimate_heads(org_id, ticket_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id, property_id) REFERENCES public.properties(org_id, id) ON DELETE RESTRICT,
 CHECK ((threshold_source = 'regional_default' AND threshold_revision_id IS NULL)
  OR (threshold_source <> 'regional_default' AND threshold_revision_id IS NOT NULL))
);
ALTER TABLE app.b013_estimate_heads ADD CONSTRAINT b013_head_current_version_fk
 FOREIGN KEY (org_id, ticket_id, current_version_id)
 REFERENCES app.b013_estimate_versions(org_id, ticket_id, id)
 DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.b013_estimate_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 version_id uuid NOT NULL,
 decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'more_information')),
 decided_by uuid NOT NULL,
 reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 4000),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (decision = 'approved' OR reason IS NOT NULL),
 UNIQUE (org_id, version_id),
 UNIQUE (org_id, ticket_id, version_id, id),
 FOREIGN KEY (org_id, ticket_id, version_id)
  REFERENCES app.b013_estimate_versions(org_id, ticket_id, id) ON DELETE RESTRICT,
 FOREIGN KEY (org_id, ticket_id, version_id, decided_by)
  REFERENCES app.b013_estimate_versions(org_id, ticket_id, id, designated_principal_id) ON DELETE RESTRICT
);
CREATE TABLE app.b013_repair_emergencies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 version_id uuid NOT NULL,
 category text NOT NULL CHECK (category IN ('water', 'electricity', 'safety')),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
 authorized_photo_snapshot jsonb NOT NULL
  CHECK (jsonb_typeof(authorized_photo_snapshot) = 'array'
   AND jsonb_array_length(authorized_photo_snapshot) BETWEEN 1 AND 8),
 authorized_by uuid NOT NULL,
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (org_id, version_id),
 UNIQUE (org_id, ticket_id, version_id, id),
 FOREIGN KEY (org_id, ticket_id, version_id)
  REFERENCES app.b013_estimate_versions(org_id, ticket_id, id) ON DELETE RESTRICT
);
CREATE TABLE app.b013_repair_appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 version_id uuid NOT NULL,
 repair_vendor_job_id uuid NOT NULL,
 event_kind text NOT NULL CHECK (event_kind IN
  ('vendor_proposed', 'company_confirmed', 'vendor_rejected', 'vendor_completion_submitted')),
 proposed_start timestamptz,
 proposed_end timestamptz,
 confirmed_start timestamptz,
 confirmed_end timestamptz,
 actor_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (proposed_end IS NULL OR proposed_start IS NULL OR proposed_end >= proposed_start),
 CHECK (confirmed_end IS NULL OR confirmed_start IS NULL OR confirmed_end >= confirmed_start),
 CHECK (event_kind <> 'company_confirmed' OR (confirmed_start IS NOT NULL AND confirmed_end IS NOT NULL)),
 UNIQUE (org_id, ticket_id, version_id, id),
 FOREIGN KEY (org_id, ticket_id, version_id)
  REFERENCES app.b013_estimate_versions(org_id, ticket_id, id) ON DELETE RESTRICT,
 FOREIGN KEY (repair_vendor_job_id) REFERENCES public.repair_vendor_jobs(id) ON DELETE RESTRICT
);
CREATE TABLE app.b013_repair_event_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 version_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('approval_reminder_24h', 'emergency_owner_notice')),
 emergency_id uuid,
 designated_principal_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (org_id, version_id, kind),
 UNIQUE (org_id, ticket_id, version_id, id),
 CHECK ((kind = 'emergency_owner_notice') = (emergency_id IS NOT NULL)),
 FOREIGN KEY (org_id, ticket_id, version_id)
  REFERENCES app.b013_estimate_versions(org_id, ticket_id, id) ON DELETE RESTRICT,
 FOREIGN KEY (org_id, ticket_id, version_id, designated_principal_id)
  REFERENCES app.b013_estimate_versions(org_id, ticket_id, id, designated_principal_id) ON DELETE RESTRICT,
 FOREIGN KEY (org_id, ticket_id, version_id, emergency_id)
  REFERENCES app.b013_repair_emergencies(org_id, ticket_id, version_id, id)
  DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE app.b013_repair_commands (
 actor_id uuid NOT NULL,
 request_id uuid NOT NULL,
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 ticket_id uuid NOT NULL,
 operation_kind text NOT NULL CHECK (operation_kind IN ('submit', 'decision', 'emergency', 'appointment', 'reminder', 'close')),
 outcome text NOT NULL CHECK (outcome IN
  ('recorded', 'cancelled', 'rejected_conflict', 'rejected_disabled', 'rejected_invalid', 'rejected_unavailable')),
 expected_head_id uuid,
 requested_version_id uuid,
 payload_sha256 bytea CHECK (payload_sha256 IS NULL OR octet_length(payload_sha256) = 32),
 -- Independently bind the actual arguments; a reused caller hash is not proof.
 input_sha256 bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
 result_version_id uuid,
 result_decision_id uuid,
 result_emergency_id uuid,
 result_appointment_id uuid,
 result_event_id uuid,
 -- Persist the exact response, including its original derived state.
 result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'
  AND result_json ? 'status' AND result_json->>'status' = outcome),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (actor_id, request_id),
 FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id) ON DELETE RESTRICT,
 FOREIGN KEY (org_id, ticket_id, result_version_id)
  REFERENCES app.b013_estimate_versions(org_id, ticket_id, id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id, ticket_id, result_version_id, result_decision_id)
  REFERENCES app.b013_estimate_decisions(org_id, ticket_id, version_id, id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id, ticket_id, result_version_id, result_emergency_id)
  REFERENCES app.b013_repair_emergencies(org_id, ticket_id, version_id, id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id, ticket_id, result_version_id, result_appointment_id)
  REFERENCES app.b013_repair_appointments(org_id, ticket_id, version_id, id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id, ticket_id, result_version_id, result_event_id)
  REFERENCES app.b013_repair_event_outbox(org_id, ticket_id, version_id, id) DEFERRABLE INITIALLY DEFERRED,
 CHECK (outcome = 'recorded' OR (result_version_id IS NULL AND result_decision_id IS NULL
  AND result_emergency_id IS NULL AND result_appointment_id IS NULL AND result_event_id IS NULL)),
 CHECK ((result_decision_id IS NULL AND result_emergency_id IS NULL
  AND result_appointment_id IS NULL AND result_event_id IS NULL) OR result_version_id IS NOT NULL)
);

ALTER TABLE app.b013_estimate_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b013_estimate_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b013_estimate_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b013_repair_emergencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b013_repair_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b013_repair_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b013_repair_event_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
 app.b013_estimate_heads, app.b013_estimate_versions, app.b013_estimate_decisions,
 app.b013_repair_emergencies, app.b013_repair_appointments,
 app.b013_repair_commands, app.b013_repair_event_outbox
 FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b013_approval_immutable_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Immutable repair approval history' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION app.b013_approval_immutable_row() FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY[
  'b013_estimate_versions', 'b013_estimate_decisions', 'b013_repair_emergencies',
  'b013_repair_appointments', 'b013_repair_commands', 'b013_repair_event_outbox'
 ] LOOP
  EXECUTE format('CREATE TRIGGER b013_immutable_row BEFORE UPDATE OR DELETE ON app.%I
   FOR EACH ROW EXECUTE FUNCTION app.b013_approval_immutable_row()', relation_name);
  EXECUTE format('CREATE TRIGGER b013_immutable_truncate BEFORE TRUNCATE ON app.%I
   FOR EACH STATEMENT EXECUTE FUNCTION app.b013_approval_immutable_row()', relation_name);
 END LOOP;
END $$;

CREATE FUNCTION app.b013_approvals_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT coalesce((
  SELECT o.feature_flags->'repair_approvals' = 'true'::jsonb
   AND f.value->'enabled' = 'true'::jsonb
   AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
  FROM public.organizations o CROSS JOIN public.platform_settings f
  WHERE o.id = p_org AND f.key = 'repair_approvals'
 ), false)
$$;
REVOKE ALL ON FUNCTION app.b013_approvals_enabled(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b013_actor(p_org uuid, p_session uuid)
RETURNS TABLE(actor uuid, member_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 SELECT s.user_id INTO actor FROM public.auth_sessions s
 WHERE s.id = p_session AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id = p_org AND m.user_id = actor AND m.status::text = 'active' FOR SHARE;
 IF NOT FOUND AND NOT EXISTS (
  SELECT 1 FROM public.property_owners po
  JOIN public.contacts c ON c.org_id = po.org_id AND c.id = po.owner_contact_id
  JOIN public.properties pr ON pr.org_id = po.org_id AND pr.id = po.property_id
  JOIN public.organizations o ON o.id = po.org_id
  WHERE po.org_id = p_org AND c.user_id = actor AND c.is_owner AND c.archived_at IS NULL
   AND pr.archived_at IS NULL
   AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
   AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app.b013_actor(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The request lock also serializes first-use requests before a ledger row exists.
CREATE FUNCTION app.b013_replay(p_org uuid, p_actor uuid, p_request uuid,
 p_operation text, p_hash bytea, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE cmd app.b013_repair_commands;
BEGIN
 IF p_request IS NULL OR p_hash IS NULL OR octet_length(p_hash) <> 32 THEN
  RAISE EXCEPTION 'Invalid repair command' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b013/approval/request/' || p_actor::text || '/' || p_request::text, 0));
 SELECT * INTO cmd FROM app.b013_repair_commands
 WHERE actor_id = p_actor AND request_id = p_request;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF cmd.org_id IS DISTINCT FROM p_org OR cmd.operation_kind IS DISTINCT FROM p_operation
  OR cmd.payload_sha256 IS DISTINCT FROM p_hash
  OR cmd.input_sha256 IS DISTINCT FROM pg_catalog.sha256(convert_to(p_input::text, 'UTF8')) THEN
  RETURN '{"status":"rejected_conflict"}'::jsonb;
 END IF;
 RETURN cmd.result_json;
END $$;
REVOKE ALL ON FUNCTION app.b013_replay(uuid, uuid, uuid, text, bytea, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b013_store_result(p_org uuid, p_actor uuid, p_request uuid,
 p_ticket uuid, p_operation text, p_expected uuid, p_version uuid,
 p_hash bytea, p_input jsonb, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 INSERT INTO app.b013_repair_commands(
  actor_id, request_id, org_id, ticket_id, operation_kind, outcome,
  expected_head_id, requested_version_id, payload_sha256, input_sha256,
  result_version_id, result_decision_id, result_emergency_id, result_appointment_id, result_event_id, result_json)
 VALUES (p_actor, p_request, p_org, p_ticket, p_operation, p_result->>'status',
  p_expected, p_version, p_hash, pg_catalog.sha256(convert_to(p_input::text, 'UTF8')),
  (p_result->>'version_id')::uuid, (p_result->>'decision_id')::uuid,
  (p_result->>'emergency_id')::uuid, (p_result->>'appointment_id')::uuid,
  (p_result->>'event_id')::uuid, p_result);
 RETURN p_result;
END $$;
REVOKE ALL ON FUNCTION app.b013_store_result(uuid, uuid, uuid, uuid, text, uuid, uuid, bytea, jsonb, jsonb)
 FROM PUBLIC, anon, authenticated, service_role;

-- All state transitions use the same ticket lock, including first submission.
CREATE FUNCTION app.b013_lock_version(p_org uuid, p_version uuid)
RETURNS app.b013_estimate_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v app.b013_estimate_versions;
BEGIN
 SELECT * INTO v FROM app.b013_estimate_versions WHERE org_id = p_org AND id = p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 PERFORM 1 FROM public.maintenance_tickets WHERE org_id = p_org AND id = v.ticket_id FOR UPDATE;
 IF NOT EXISTS (SELECT 1 FROM app.b013_estimate_heads
  WHERE org_id = p_org AND ticket_id = v.ticket_id AND current_version_id = p_version) THEN
  RAISE EXCEPTION 'Estimate is not current' USING ERRCODE = '40001';
 END IF;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION app.b013_lock_version(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b013_photo_refs(p_refs jsonb, p_min integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF p_refs IS NULL OR jsonb_typeof(p_refs) <> 'array' THEN RETURN false; END IF;
 RETURN jsonb_array_length(p_refs) BETWEEN p_min AND 8 AND NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(p_refs) x
  WHERE jsonb_typeof(x) <> 'object' OR jsonb_typeof(x->'id') IS DISTINCT FROM 'string'
   OR length(btrim(x->>'id')) = 0
 );
END $$;
REVOKE ALL ON FUNCTION app.b013_photo_refs(jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b013_submit_estimate(p_org uuid, p_session uuid, p_request uuid,
 p_ticket uuid, p_expected_head uuid, p_amount_minor bigint, p_currency text,
 p_minor_unit smallint, p_work_scope text, p_evidence jsonb, p_payload_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record; t record; pr record; own record; region record; rev record;
 head uuid; n bigint; version_id uuid := gen_random_uuid();
 threshold bigint; source text; revision_id uuid; scale smallint;
 input jsonb; result jsonb;
BEGIN
 SELECT * INTO a FROM app.b013_actor(p_org, p_session);
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
  OR NOT app.b013_photo_refs(p_evidence, 0) THEN
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
 PERFORM app.b013_actor(p_org, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, p_ticket, 'submit', p_expected_head,
  NULL, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_submit_estimate(uuid, uuid, uuid, uuid, uuid, bigint, text, smallint, text, jsonb, bytea)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_submit_estimate(uuid, uuid, uuid, uuid, uuid, bigint, text, smallint, text, jsonb, bytea)
 TO service_role;

CREATE FUNCTION app.b013_decide_estimate(p_org uuid, p_session uuid, p_request uuid,
 p_version uuid, p_decision text, p_reason text, p_payload_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record; v app.b013_estimate_versions; input jsonb; result jsonb; decision_id uuid;
BEGIN
 SELECT * INTO a FROM app.b013_actor(p_org, p_session);
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
 PERFORM app.b013_actor(p_org, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'decision', NULL,
  p_version, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_decide_estimate(uuid, uuid, uuid, uuid, text, text, bytea)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_decide_estimate(uuid, uuid, uuid, uuid, text, text, bytea) TO service_role;

CREATE FUNCTION app.b013_authorize_emergency(p_org uuid, p_session uuid, p_request uuid,
 p_version uuid, p_category text, p_reason text, p_photos jsonb, p_payload_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record; v app.b013_estimate_versions; input jsonb; result jsonb; emergency_id uuid; event_id uuid;
BEGIN
 SELECT * INTO a FROM app.b013_actor(p_org, p_session);
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
  OR NOT app.b013_photo_refs(p_photos, 1) THEN
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
 PERFORM app.b013_actor(p_org, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'emergency', NULL,
  p_version, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_authorize_emergency(uuid, uuid, uuid, uuid, text, text, jsonb, bytea)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_authorize_emergency(uuid, uuid, uuid, uuid, text, text, jsonb, bytea) TO service_role;

CREATE FUNCTION app.b013_record_appointment(p_org uuid, p_session uuid, p_request uuid,
 p_version uuid, p_vendor_job uuid, p_event_kind text,
 p_proposed_start timestamptz, p_proposed_end timestamptz,
 p_confirmed_start timestamptz, p_confirmed_end timestamptz, p_payload_sha256 bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record; v app.b013_estimate_versions; input jsonb; result jsonb; appointment_id uuid;
BEGIN
 SELECT * INTO a FROM app.b013_actor(p_org, p_session);
 -- Epoch values keep replay identity independent of the caller's TimeZone.
 input := jsonb_build_array(p_version, p_vendor_job, p_event_kind,
  extract(epoch FROM p_proposed_start), extract(epoch FROM p_proposed_end),
  extract(epoch FROM p_confirmed_start), extract(epoch FROM p_confirmed_end));
 result := app.b013_replay(p_org, a.actor, p_request, 'appointment', p_payload_sha256, input);
 IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO v FROM app.b013_estimate_versions WHERE org_id = p_org AND id = p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 IF NOT app.b013_approvals_enabled(p_org) OR NOT coalesce(app.vendor_dispatch_enabled(p_org), false) THEN
  RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'appointment', NULL,
   p_version, p_payload_sha256, input, '{"status":"rejected_disabled"}');
 END IF;
 IF a.member_role IS NULL OR a.member_role NOT IN ('admin', 'manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501';
 END IF;
 v := app.b013_lock_version(p_org, p_version);
 PERFORM 1 FROM public.repair_vendor_jobs
 WHERE id = p_vendor_job AND org_id = p_org AND ticket_id = v.ticket_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
 IF p_event_kind IS NULL OR p_event_kind NOT IN
  ('vendor_proposed', 'company_confirmed', 'vendor_rejected', 'vendor_completion_submitted')
  OR (p_proposed_end IS NOT NULL AND p_proposed_start IS NOT NULL AND p_proposed_end < p_proposed_start)
  OR (p_confirmed_end IS NOT NULL AND p_confirmed_start IS NOT NULL AND p_confirmed_end < p_confirmed_start)
  OR (p_event_kind = 'company_confirmed' AND (p_confirmed_start IS NULL OR p_confirmed_end IS NULL)) THEN
  result := '{"status":"rejected_invalid"}';
 ELSE
  INSERT INTO app.b013_repair_appointments(org_id, ticket_id, version_id, repair_vendor_job_id,
   event_kind, proposed_start, proposed_end, confirmed_start, confirmed_end, actor_id)
  VALUES (p_org, v.ticket_id, p_version, p_vendor_job, p_event_kind,
   p_proposed_start, p_proposed_end, p_confirmed_start, p_confirmed_end, a.actor) RETURNING id INTO appointment_id;
  result := jsonb_build_object('status', 'recorded', 'version_id', p_version, 'appointment_id', appointment_id);
 END IF;
 -- Appointment events never write maintenance_tickets.status.
 PERFORM app.b013_actor(p_org, p_session);
 RETURN app.b013_store_result(p_org, a.actor, p_request, v.ticket_id, 'appointment', NULL,
  p_version, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b013_record_appointment(uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, bytea)
 FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_record_appointment(uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, bytea)
 TO service_role;

CREATE FUNCTION app.b013_emit_reminder(p_org uuid, p_version uuid, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v app.b013_estimate_versions; event_id uuid;
BEGIN
 IF NOT app.b013_approvals_enabled(p_org) THEN RETURN '{"status":"rejected_disabled"}'; END IF;
 SELECT * INTO v FROM app.b013_estimate_versions WHERE org_id = p_org AND id = p_version;
 IF NOT FOUND THEN RETURN '{"status":"not_due"}'; END IF;
 PERFORM 1 FROM public.maintenance_tickets WHERE org_id = p_org AND id = v.ticket_id FOR UPDATE;
 IF p_now IS NULL OR NOT v.requires_owner_decision OR v.submitted_at > p_now - interval '24 hours'
  OR NOT EXISTS (SELECT 1 FROM app.b013_estimate_heads
   WHERE org_id = p_org AND ticket_id = v.ticket_id AND current_version_id = p_version)
  OR EXISTS (SELECT 1 FROM app.b013_estimate_decisions WHERE org_id = p_org AND version_id = p_version)
  OR EXISTS (SELECT 1 FROM app.b013_repair_emergencies WHERE org_id = p_org AND version_id = p_version) THEN
  RETURN '{"status":"not_due"}';
 END IF;
 INSERT INTO app.b013_repair_event_outbox(org_id, ticket_id, version_id, kind, designated_principal_id, occurred_at)
 VALUES (p_org, v.ticket_id, p_version, 'approval_reminder_24h', v.designated_principal_id, p_now)
 ON CONFLICT (org_id, version_id, kind) DO NOTHING RETURNING id INTO event_id;
 IF event_id IS NULL THEN RETURN '{"status":"duplicate"}'; END IF;
 RETURN '{"status":"recorded"}';
END $$;
REVOKE ALL ON FUNCTION app.b013_emit_reminder(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_emit_reminder(uuid, uuid, timestamptz) TO service_role;

CREATE FUNCTION app.b013_dispatch_allowed(p_org uuid, p_version uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT app.b013_approvals_enabled(p_org) AND coalesce(app.vendor_dispatch_enabled(p_org), false)
 AND EXISTS (
  SELECT 1 FROM app.b013_estimate_versions v
  JOIN app.b013_estimate_heads h ON h.org_id = v.org_id AND h.ticket_id = v.ticket_id AND h.current_version_id = v.id
  WHERE v.org_id = p_org AND v.id = p_version AND (
   NOT v.requires_owner_decision
   OR EXISTS (SELECT 1 FROM app.b013_estimate_decisions d
    WHERE d.org_id = v.org_id AND d.ticket_id = v.ticket_id AND d.version_id = v.id AND d.decision = 'approved')
   OR EXISTS (SELECT 1 FROM app.b013_repair_emergencies e
    WHERE e.org_id = v.org_id AND e.ticket_id = v.ticket_id AND e.version_id = v.id)
  )
 )
$$;
REVOKE ALL ON FUNCTION app.b013_dispatch_allowed(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b013_dispatch_allowed(uuid, uuid) TO service_role;
COMMIT;
