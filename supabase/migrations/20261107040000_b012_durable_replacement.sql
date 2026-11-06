BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key,value) VALUES
  ('lease_renewal','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT(key) DO NOTHING;

-- A completed submission links an unsigned pending_signature successor. It is
-- not an agreement/signature, does not activate a lease, and carries no money.
CREATE TABLE app.b012_replacements (
  org_id uuid NOT NULL,
  predecessor_id uuid NOT NULL,
  replacement_id uuid NOT NULL,
  request_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,predecessor_id),
  UNIQUE(org_id,replacement_id),
  UNIQUE(org_id,request_id),
  CHECK(predecessor_id<>replacement_id),
  FOREIGN KEY(org_id,predecessor_id) REFERENCES public.leases(org_id,id),
  FOREIGN KEY(org_id,replacement_id) REFERENCES public.leases(org_id,id)
);
CREATE TABLE app.b012_notice_versions (
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  record_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  kind text NOT NULL CHECK(kind IN ('renewal_intent','non_renewal_notice','early_termination_notice')),
  party text NOT NULL CHECK(party IN ('tenant','owner','management')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  source text NOT NULL CHECK(source IN ('self_report','document','staff_record')),
  occurred_on date,
  effective_on date,
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,record_id,version),
  FOREIGN KEY(org_id,lease_id) REFERENCES public.leases(org_id,id)
);
CREATE INDEX b012_notices_lease ON app.b012_notice_versions(org_id,lease_id,record_id,version);
CREATE TABLE app.b012_response_versions (
  org_id uuid NOT NULL,
  record_id uuid NOT NULL,
  notice_version integer NOT NULL,
  party text NOT NULL CHECK(party IN ('tenant','owner','management')),
  version integer NOT NULL CHECK(version>0),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  response text NOT NULL CHECK(response IN ('agree','disagree','undecided')),
  body text NOT NULL CHECK(length(body)<=2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,record_id,party,version),
  FOREIGN KEY(org_id,record_id,notice_version) REFERENCES app.b012_notice_versions(org_id,record_id,version)
);
ALTER TABLE app.b012_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b012_notice_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b012_response_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b012_replacements,app.b012_notice_versions,app.b012_response_versions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b012_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  RAISE EXCEPTION 'B012 history is immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION app.b012_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b012_replacements_immutable BEFORE UPDATE OR DELETE ON app.b012_replacements
FOR EACH ROW EXECUTE FUNCTION app.b012_immutable();
CREATE TRIGGER b012_replacements_no_truncate BEFORE TRUNCATE ON app.b012_replacements
FOR EACH STATEMENT EXECUTE FUNCTION app.b012_immutable();
CREATE TRIGGER b012_notices_immutable BEFORE UPDATE OR DELETE ON app.b012_notice_versions
FOR EACH ROW EXECUTE FUNCTION app.b012_immutable();
CREATE TRIGGER b012_notices_no_truncate BEFORE TRUNCATE ON app.b012_notice_versions
FOR EACH STATEMENT EXECUTE FUNCTION app.b012_immutable();
CREATE TRIGGER b012_responses_immutable BEFORE UPDATE OR DELETE ON app.b012_response_versions
FOR EACH ROW EXECUTE FUNCTION app.b012_immutable();
CREATE TRIGGER b012_responses_no_truncate BEFORE TRUNCATE ON app.b012_response_versions
FOR EACH STATEMENT EXECUTE FUNCTION app.b012_immutable();

-- This invariant survives flag rollback. No existing lease is frozen until a
-- replacement is recorded. Also protect the successor's durable backlink.
CREATE FUNCTION app.b012_freeze_lease() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM app.b012_replacements WHERE org_id=OLD.org_id AND predecessor_id=OLD.id) THEN
    RAISE EXCEPTION 'Replaced predecessor is immutable' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM app.b012_replacements WHERE org_id=OLD.org_id AND replacement_id=OLD.id)
    AND (TG_OP='DELETE' OR NEW.previous_lease_id IS DISTINCT FROM OLD.previous_lease_id
      OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION 'Replacement link is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b012_freeze_lease() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b012_freeze_lease BEFORE UPDATE OR DELETE ON public.leases
FOR EACH ROW EXECUTE FUNCTION app.b012_freeze_lease();

-- Reject party edits on a replaced predecessor (serialization: see submission locks).
CREATE FUNCTION app.b012_freeze_parties() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN SELECT DISTINCT id FROM unnest(ARRAY[
    CASE WHEN TG_OP<>'INSERT' THEN OLD.lease_id END,
    CASE WHEN TG_OP<>'DELETE' THEN NEW.lease_id END]) id WHERE id IS NOT NULL ORDER BY id LOOP
    -- No lock here: existing party writers keep their exact lock footprint (flag OFF
    -- byte-for-byte). Serialization with submission comes from the submission
    -- locking the predecessor lease and its party rows FOR UPDATE; new-party INSERTs
    -- wait on the lease through the FK key-share lock, then see the replacement.
    IF EXISTS(SELECT 1 FROM app.b012_replacements WHERE predecessor_id=v_id) THEN
      RAISE EXCEPTION 'Replaced predecessor parties are immutable' USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b012_freeze_parties() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b012_freeze_parties BEFORE INSERT OR UPDATE OR DELETE ON public.lease_parties
FOR EACH ROW EXECUTE FUNCTION app.b012_freeze_parties();

CREATE FUNCTION app.b012_flag_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS(SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id=p_org
    WHERE f.key='lease_renewal' AND f.value->'enabled'='true'::jsonb
    AND o.feature_flags->'lease_renewal'='true'::jsonb
    AND CASE WHEN jsonb_typeof(f.value->'allowed_org_ids')='array' THEN NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') a(value)
      WHERE jsonb_typeof(a.value)<>'string' OR (a.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') ELSE false END
    AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text));
$$;
REVOKE ALL ON FUNCTION app.b012_flag_on(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Call before any mutation; missing/malformed/OFF controls perform zero writes.
-- Lock order: global flag SHARE -> organization SHARE -> session SHARE -> live
-- membership SHARE -> archive ancestry advisory SHARE (property/unit/room) ->
-- predecessor UPDATE -> property SHARE -> unit UPDATE -> room UPDATE.
-- No competing lease is locked after the unit.
CREATE FUNCTION app.b012_lock_controls(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM 1 FROM public.platform_settings WHERE key='lease_renewal' FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  RETURN app.b012_flag_on(p_org);
END $$;
REVOKE ALL ON FUNCTION app.b012_lock_controls(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b012_party(p_org uuid,p_session uuid,p_kind text,p_lease uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_live uuid; v_property uuid; v_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT app.b012_flag_on(p_org) THEN RETURN NULL; END IF;
  SELECT coalesce(o.live_org_id,o.id) INTO v_live FROM public.organizations o
    WHERE o.id=p_org AND current_setting('app.active_org_id',true)=o.id::text
      AND current_setting('app.env',true)=o.environment::text;
  IF v_live IS NULL OR NOT EXISTS(SELECT 1 FROM public.auth_sessions
    WHERE id=p_session AND user_id=auth.uid() AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RETURN NULL; END IF;
  SELECT property_id, status::text INTO v_property, v_status FROM public.leases WHERE id=p_lease AND org_id=p_org;
  IF v_property IS NULL THEN RETURN NULL; END IF;
  -- Draft leases stay staff-only, matching the base portal policies (tenant_lease_read: status <> 'draft').
  IF p_kind IN ('tenant','owner') AND v_status='draft' THEN RETURN NULL; END IF;
  IF p_kind='staff' AND EXISTS(SELECT 1 FROM public.org_members
    WHERE org_id=v_live AND user_id=auth.uid() AND status='active' AND role IN ('admin','manager')) THEN RETURN 'management'; END IF;
  IF p_kind='tenant' AND EXISTS(SELECT 1 FROM public.lease_parties lp JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
    WHERE lp.org_id=p_org AND lp.lease_id=p_lease AND c.user_id=auth.uid() AND c.archived_at IS NULL
      AND lp.role IN ('primary','co_tenant','occupant')) THEN RETURN 'tenant'; END IF;
  IF p_kind='owner' AND EXISTS(SELECT 1 FROM public.property_owners po JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
    WHERE po.org_id=p_org AND po.property_id=v_property AND c.user_id=auth.uid() AND c.is_owner AND c.archived_at IS NULL
      AND po.effective_from<=current_date AND (po.effective_to IS NULL OR po.effective_to>current_date)) THEN RETURN 'owner'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b012_party(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b012_lock_actor(p_org uuid,p_session uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM 1 FROM public.auth_sessions WHERE id=p_session AND user_id=auth.uid() FOR SHARE;
  PERFORM 1 FROM public.org_members m JOIN public.organizations o ON o.id=p_org
    WHERE m.org_id=coalesce(o.live_org_id,o.id) AND m.user_id=auth.uid() FOR SHARE OF m;
END $$;
REVOKE ALL ON FUNCTION app.b012_lock_actor(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b012_submit_replacement(p_org uuid,p_session uuid,p_lease uuid,p_request uuid,p_terms jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_old public.leases; v_discovered public.leases; v_unit public.units; v_room public.rooms;
  v_saved app.b012_replacements; v_new uuid;
  v_digest text; v_start date; v_end date; v_rent bigint; v_deposit bigint; v_due smallint;
BEGIN
  IF NOT app.b012_lock_controls(p_org) THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  PERFORM app.b012_lock_actor(p_org,p_session);
  IF app.b012_party(p_org,p_session,'staff',p_lease) IS DISTINCT FROM 'management' THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  IF p_request IS NULL OR p_terms IS NULL OR jsonb_typeof(p_terms)<>'object'
    OR NOT p_terms ?& ARRAY['startDate','endDate','rentMinor','depositMinor','frequency','dueDay','currency']
    OR jsonb_typeof(p_terms->'startDate')<>'string' OR (p_terms->>'startDate') !~ '^\d{4}-\d{2}-\d{2}$'
    OR (p_terms->'endDate'<>'null'::jsonb AND (jsonb_typeof(p_terms->'endDate')<>'string' OR (p_terms->>'endDate') !~ '^\d{4}-\d{2}-\d{2}$'))
    OR jsonb_typeof(p_terms->'rentMinor')<>'string' OR (p_terms->>'rentMinor') !~ '^\d{1,19}$'
    OR jsonb_typeof(p_terms->'depositMinor')<>'string' OR (p_terms->>'depositMinor') !~ '^\d{1,19}$'
    OR coalesce(p_terms->>'frequency','') NOT IN ('monthly','quarterly','yearly')
    OR coalesce(p_terms->>'dueDay','') !~ '^([1-9]|[12][0-9]|3[01])$' THEN RETURN jsonb_build_object('state','invalid'); END IF;
  v_start:=(p_terms->>'startDate')::date; v_end:=(p_terms->>'endDate')::date;
  v_rent:=(p_terms->>'rentMinor')::bigint; v_deposit:=(p_terms->>'depositMinor')::bigint; v_due:=(p_terms->>'dueDay')::smallint;
  IF v_end<v_start THEN RETURN jsonb_build_object('state','invalid'); END IF;
  v_digest:=encode(sha256(convert_to(jsonb_build_object('lease',p_lease,'actor',auth.uid(),'terms',p_terms)::text,'UTF8')),'hex');
  SELECT * INTO v_discovered FROM public.leases WHERE org_id=p_org AND id=p_lease;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  -- Match record-archive-admission.ts exactly: shared ancestry keys, root first,
  -- before physical lease/target locks. Archive takes its target key exclusively.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('condola:record-archive:'||p_org::text||':property:'||v_discovered.property_id::text,0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('condola:record-archive:'||p_org::text||':unit:'||v_discovered.unit_id::text,0));
  IF v_discovered.target_room_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('condola:record-archive:'||p_org::text||':room:'||v_discovered.target_room_id::text,0));
  END IF;
  SELECT * INTO v_old FROM public.leases WHERE org_id=p_org AND id=p_lease FOR UPDATE;
  -- Lock the predecessor's party rows (after the lease, before unit/room) so no party
  -- edit can slip between copying them and installing the immutable link.
  PERFORM 1 FROM public.lease_parties WHERE org_id=p_org AND lease_id=p_lease ORDER BY id FOR UPDATE;
  IF NOT FOUND OR v_old.property_id IS DISTINCT FROM v_discovered.property_id
    OR v_old.unit_id IS DISTINCT FROM v_discovered.unit_id
    OR v_old.target_unit_id IS DISTINCT FROM v_discovered.target_unit_id
    OR v_old.target_room_id IS DISTINCT FROM v_discovered.target_room_id THEN
    RETURN jsonb_build_object('state','unavailable');
  END IF;
  -- Recheck after waiting; a retry must work even though its predecessor is frozen.
  IF app.b012_party(p_org,p_session,'staff',p_lease) IS DISTINCT FROM 'management' THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  SELECT * INTO v_saved FROM app.b012_replacements WHERE org_id=p_org AND request_id=p_request;
  IF FOUND THEN
    IF v_saved.payload_digest<>v_digest THEN RETURN jsonb_build_object('state','conflict'); END IF;
    RETURN jsonb_build_object('state','replayed','leaseId',v_saved.replacement_id);
  END IF;
  IF EXISTS(SELECT 1 FROM app.b012_replacements WHERE org_id=p_org AND predecessor_id=p_lease)
    OR EXISTS(SELECT 1 FROM public.leases WHERE org_id=p_org AND previous_lease_id=p_lease) THEN RETURN jsonb_build_object('state','conflict'); END IF;
  IF v_old.status NOT IN ('active','ended','terminated') OR v_old.end_date IS NULL
    OR v_start<=v_old.end_date OR p_terms->>'currency' IS DISTINCT FROM btrim(v_old.currency) THEN RETURN jsonb_build_object('state','invalid'); END IF;
  -- Replay above is historical. Fresh submissions must still have active,
  -- unchanged ancestry after all waits, including direct archive UPDATEs.
  PERFORM 1 FROM public.properties WHERE org_id=p_org AND id=v_old.property_id AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  SELECT * INTO v_unit FROM public.units WHERE org_id=p_org AND id=v_old.unit_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_unit.property_id IS DISTINCT FROM v_old.property_id THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  IF v_old.target_room_id IS NOT NULL THEN
    SELECT * INTO v_room FROM public.rooms WHERE org_id=p_org AND id=v_old.target_room_id AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_room.unit_id IS DISTINCT FROM v_old.unit_id THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  END IF;
  -- Authoritative, inclusive-date and unbounded-end recheck, under target locks.
  -- Do not trust the earlier advisory comparison or a caller-provided overlap bit.
  IF EXISTS(SELECT 1 FROM public.leases l WHERE l.org_id=p_org AND l.unit_id=v_old.unit_id
    AND l.status IN ('pending_signature','active') AND l.term && daterange(v_start,v_end,'[]')
    AND (l.target_unit_id IS NOT NULL OR v_old.target_unit_id IS NOT NULL OR l.target_room_id=v_old.target_room_id)) THEN
    RETURN jsonb_build_object('state','overlap');
  END IF;
  IF (v_old.target_room_id IS NOT NULL AND v_unit.rental_mode<>'by_room')
    OR (v_old.target_room_id IS NULL AND (v_unit.rental_mode<>'whole_unit' OR v_old.target_unit_id IS DISTINCT FROM v_unit.id)) THEN
    RETURN jsonb_build_object('state','unavailable');
  END IF;
  INSERT INTO public.leases(org_id,property_id,unit_id,target_unit_id,target_room_id,status,start_date,end_date,
    currency,rent_amount_minor,rent_frequency,due_day,deposit_amount_minor,previous_lease_id,created_by)
  VALUES(p_org,v_old.property_id,v_old.unit_id,v_old.target_unit_id,v_old.target_room_id,'pending_signature',v_start,v_end,
    v_old.currency,v_rent,(p_terms->>'frequency')::public.charge_frequency,v_due,v_deposit,p_lease,auth.uid()) RETURNING id INTO v_new;
  INSERT INTO public.lease_parties(org_id,lease_id,contact_id,role,rent_share_bp)
    SELECT org_id,v_new,contact_id,role,rent_share_bp FROM public.lease_parties WHERE org_id=p_org AND lease_id=p_lease;
  INSERT INTO app.b012_replacements(org_id,predecessor_id,replacement_id,request_id,payload_digest,actor_user_id)
    VALUES(p_org,p_lease,v_new,p_request,v_digest,auth.uid());
  RETURN jsonb_build_object('state','submitted','leaseId',v_new);
EXCEPTION
  WHEN exclusion_violation THEN RETURN jsonb_build_object('state','overlap');
  WHEN unique_violation THEN RETURN jsonb_build_object('state','conflict');
  WHEN invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range OR check_violation THEN RETURN jsonb_build_object('state','invalid');
END $$;
REVOKE ALL ON FUNCTION app.b012_submit_replacement(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b012_submit_replacement(uuid,uuid,uuid,uuid,jsonb) TO authenticated;

CREATE FUNCTION app.b012_record_notice(p_org uuid,p_session uuid,p_kind text,p_lease uuid,p_record uuid,p_expected integer,
  p_notice text,p_source text,p_occurred date,p_effective date,p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_party text; v_prior app.b012_notice_versions;
BEGIN
  IF NOT app.b012_lock_controls(p_org) THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  PERFORM app.b012_lock_actor(p_org,p_session);
  IF app.b012_party(p_org,p_session,p_kind,p_lease) IS NULL THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  PERFORM 1 FROM public.leases WHERE org_id=p_org AND id=p_lease FOR UPDATE;
  v_party:=app.b012_party(p_org,p_session,p_kind,p_lease);
  IF v_party IS NULL THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  IF p_record IS NULL OR p_expected IS NULL OR p_expected<0 OR p_notice IS NULL
    OR p_notice NOT IN ('renewal_intent','non_renewal_notice','early_termination_notice') OR p_source IS NULL
    OR p_source NOT IN ('self_report','document','staff_record') OR (p_source='staff_record' AND v_party<>'management')
    OR p_body IS NULL OR length(btrim(p_body)) NOT BETWEEN 1 AND 2000 THEN RETURN jsonb_build_object('state','invalid'); END IF;
  SELECT * INTO v_prior FROM app.b012_notice_versions WHERE org_id=p_org AND record_id=p_record ORDER BY version DESC LIMIT 1;
  IF FOUND THEN
    IF v_prior.lease_id<>p_lease OR v_prior.party<>v_party OR v_prior.actor_user_id<>auth.uid() THEN RETURN jsonb_build_object('state','unavailable'); END IF;
    IF v_prior.version<>p_expected THEN RETURN jsonb_build_object('state','stale'); END IF;
    IF v_prior.kind<>p_notice OR v_prior.source<>p_source THEN RETURN jsonb_build_object('state','invalid'); END IF;
  ELSIF p_expected<>0 THEN RETURN jsonb_build_object('state','stale'); END IF;
  INSERT INTO app.b012_notice_versions(org_id,lease_id,record_id,version,kind,party,actor_user_id,source,occurred_on,effective_on,body)
    VALUES(p_org,p_lease,p_record,p_expected+1,p_notice,v_party,auth.uid(),p_source,p_occurred,p_effective,p_body);
  RETURN jsonb_build_object('state','recorded','recordId',p_record,'version',p_expected+1);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('state','conflict');
END $$;
REVOKE ALL ON FUNCTION app.b012_record_notice(uuid,uuid,text,uuid,uuid,integer,text,text,date,date,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b012_record_notice(uuid,uuid,text,uuid,uuid,integer,text,text,date,date,text) TO authenticated;

CREATE FUNCTION app.b012_respond_notice(p_org uuid,p_session uuid,p_kind text,p_lease uuid,p_record uuid,p_notice_version integer,
  p_expected integer,p_response text,p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_party text; v_notice app.b012_notice_versions; v_prior app.b012_response_versions;
BEGIN
  IF NOT app.b012_lock_controls(p_org) THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  PERFORM app.b012_lock_actor(p_org,p_session);
  IF app.b012_party(p_org,p_session,p_kind,p_lease) IS NULL THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  PERFORM 1 FROM public.leases WHERE org_id=p_org AND id=p_lease FOR UPDATE;
  v_party:=app.b012_party(p_org,p_session,p_kind,p_lease);
  IF v_party IS NULL THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  SELECT * INTO v_notice FROM app.b012_notice_versions WHERE org_id=p_org AND lease_id=p_lease AND record_id=p_record ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  IF p_notice_version IS DISTINCT FROM v_notice.version THEN RETURN jsonb_build_object('state','stale'); END IF;
  IF p_expected IS NULL OR p_expected<0 OR p_response IS NULL OR p_response NOT IN ('agree','disagree','undecided')
    OR p_body IS NULL OR length(p_body)>2000 THEN RETURN jsonb_build_object('state','invalid'); END IF;
  SELECT * INTO v_prior FROM app.b012_response_versions WHERE org_id=p_org AND record_id=p_record AND party=v_party ORDER BY version DESC LIMIT 1;
  IF FOUND AND v_prior.actor_user_id<>auth.uid() THEN RETURN jsonb_build_object('state','unavailable'); END IF;
  IF coalesce(v_prior.version,0)<>p_expected THEN RETURN jsonb_build_object('state','stale'); END IF;
  INSERT INTO app.b012_response_versions(org_id,record_id,notice_version,party,version,actor_user_id,response,body)
    VALUES(p_org,p_record,p_notice_version,v_party,p_expected+1,auth.uid(),p_response,p_body);
  RETURN jsonb_build_object('state','recorded','recordId',p_record,'version',p_expected+1);
END $$;
REVOKE ALL ON FUNCTION app.b012_respond_notice(uuid,uuid,text,uuid,uuid,integer,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b012_respond_notice(uuid,uuid,text,uuid,uuid,integer,integer,text,text) TO authenticated;

-- Explicit projection: no contact details, documents, freeform lease notes or
-- neighboring tenant data. Re-authorize each linked lease independently.
CREATE FUNCTION app.b012_lifecycle_view(p_org uuid,p_session uuid,p_kind text,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_leases jsonb; v_notices jsonb; v_responses jsonb;
BEGIN
  IF app.b012_party(p_org,p_session,p_kind,p_lease) IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'startDate',l.start_date,'endDate',l.end_date,
    'rentMinor',l.rent_amount_minor::text,'depositMinor',l.deposit_amount_minor::text,'currency',btrim(l.currency),
    'frequency',l.rent_frequency,'dueDay',l.due_day,'status',l.status,
    'readOnly',EXISTS(SELECT 1 FROM app.b012_replacements r WHERE r.org_id=p_org AND r.predecessor_id=l.id),
    'previousLeaseId',CASE WHEN app.b012_party(p_org,p_session,p_kind,l.previous_lease_id) IS NOT NULL THEN l.previous_lease_id END)
    ORDER BY l.start_date,l.id),'[]'::jsonb) INTO v_leases
  FROM public.leases l WHERE l.org_id=p_org AND (l.id=p_lease OR EXISTS(
    SELECT 1 FROM app.b012_replacements r WHERE r.org_id=p_org AND
      ((r.predecessor_id=p_lease AND r.replacement_id=l.id) OR (r.replacement_id=p_lease AND r.predecessor_id=l.id))))
    AND app.b012_party(p_org,p_session,p_kind,l.id) IS NOT NULL;
  SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.record_id,n.version),'[]'::jsonb) INTO v_notices
    FROM app.b012_notice_versions n WHERE n.org_id=p_org AND n.lease_id=p_lease;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.record_id,r.party,r.version),'[]'::jsonb) INTO v_responses
    FROM app.b012_response_versions r WHERE r.org_id=p_org AND EXISTS(
      SELECT 1 FROM app.b012_notice_versions n WHERE n.org_id=p_org AND n.lease_id=p_lease AND n.record_id=r.record_id);
  RETURN jsonb_build_object('leases',v_leases,'notices',v_notices,'responses',v_responses);
END $$;
REVOKE ALL ON FUNCTION app.b012_lifecycle_view(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b012_lifecycle_view(uuid,uuid,text,uuid) TO authenticated;
COMMIT;
