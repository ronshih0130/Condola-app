-- B-028 package 2: durable notification events produced inside existing business
-- transactions. Additive only; rollout defaults OFF. No transport and no change to
-- any existing table, function, grant or producer. Renewal is deferred (no durable
-- renewal operation exists on this branch).
INSERT INTO public.platform_settings(key,value)
VALUES ('notification_events_v2','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- One row per committed versioned source occurrence. source_* names the versioned
-- aggregate (invitation, reminder source event, payment, handover record, owner
-- statement, repair ticket); source_row_id is the exact row the operation committed.
CREATE TABLE app.b028_notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  family text NOT NULL CHECK (family IN ('invite','bill','payment','handover','report','repair')),
  kind text NOT NULL CHECK (kind IN ('invite_issued','rent_due','rent_overdue','rent_manual',
    'payment_confirmed','payment_rejected','payment_reversed','handover_published','report_version_recorded',
    'repair_approval_requested','repair_emergency_notice','repair_decision_recorded')),
  source_table text NOT NULL CHECK (source_table IN ('invitations','b010_source_events','payments',
    'handover_records','owner_statements','maintenance_tickets')),
  source_id uuid NOT NULL,
  source_version text NOT NULL CHECK (char_length(source_version) BETWEEN 1 AND 128),
  offset_key text NOT NULL CHECK (char_length(offset_key) BETWEEN 1 AND 64),
  source_row_table text NOT NULL CHECK (source_row_table IN ('invitations','b010_source_events','payments',
    'handover_versions','b014_statement_versions','b013_estimate_versions','b013_repair_event_outbox','b013_estimate_decisions')),
  source_row_id uuid NOT NULL,
  template_version smallint NOT NULL DEFAULT 1 CHECK (template_version = 1),
  vars jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(vars) = 'object'),
  occurred_at timestamptz NOT NULL,
  -- Producer transaction start (now()): never later than the snapshot that read the
  -- delivery control. The claim-time stale sweep compares against this, so a REPEATABLE
  -- READ producer whose snapshot predates an OFF cannot dispatch after a later re-ON.
  admitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,source_table,source_id,source_version,offset_key)
);
-- Intended recipients resolved inside the producing transaction, persona-scoped and
-- bound to the event organization by composite foreign keys.
CREATE TABLE app.b028_notification_event_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  event_id uuid NOT NULL,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  source_version text NOT NULL,
  offset_key text NOT NULL,
  persona text NOT NULL CHECK (persona IN ('staff','tenant','owner')),
  recipient_key text NOT NULL CHECK (recipient_key ~ '^(staff|tenant|owner):[0-9a-f-]{36}$'),
  principal_user_id uuid REFERENCES auth.users(id),
  contact_id uuid,
  member_id uuid,
  -- Bill recipients point at the reminder's existing Email claim, which keeps sole
  -- ownership of that Email; no package-1 attempt is ever created for them.
  claim_id uuid,
  locale text NOT NULL CHECK (locale IN ('zh-TW','en')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id,recipient_key),
  UNIQUE (org_id,source_table,source_id,source_version,recipient_key,offset_key),
  FOREIGN KEY (org_id,event_id) REFERENCES app.b028_notification_events(org_id,id),
  FOREIGN KEY (org_id,contact_id) REFERENCES public.contacts(org_id,id),
  FOREIGN KEY (org_id,member_id) REFERENCES public.org_members(org_id,id),
  FOREIGN KEY (org_id,claim_id) REFERENCES app.b028_recipient_claims(org_id,id),
  UNIQUE (org_id,claim_id),
  CHECK ((source_table = 'b010_source_events') = (claim_id IS NOT NULL)),
  CHECK ((persona = 'staff') = (member_id IS NOT NULL AND contact_id IS NULL AND principal_user_id IS NOT NULL)),
  CHECK ((persona <> 'staff') = (contact_id IS NOT NULL AND member_id IS NULL)),
  CHECK (recipient_key = persona || ':' || coalesce(member_id,contact_id)::text)
);
ALTER TABLE app.b028_notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b028_notification_event_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b028_notification_events,app.b028_notification_event_recipients FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b028_notification_events_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Immutable notification event' USING ERRCODE='42501'; END $$;
CREATE TRIGGER b028_notification_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app.b028_notification_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.b028_notification_events_immutable();
CREATE TRIGGER b028_notification_recipients_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app.b028_notification_event_recipients
  FOR EACH STATEMENT EXECUTE FUNCTION app.b028_notification_events_immutable();
REVOKE ALL ON FUNCTION app.b028_notification_events_immutable() FROM PUBLIC,anon,authenticated,service_role;

-- Strict control: global enabled === true, allowlist array containing the org, and
-- organizations.feature_flags.<key> === true. Missing/malformed is OFF. This is a plain
-- snapshot read with no table or row lock: it runs at the end of existing business
-- transactions, which must never fail (55P03) because a settings write or an org
-- FOR UPDATE is in progress elsewhere. A concurrent flag flip takes effect for
-- transactions whose statement snapshot follows it.
CREATE FUNCTION app.b028_events_flag(p_org uuid,p_key text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
  IF p_org IS NULL OR p_key NOT IN ('notification_events_v2','notification_delivery_v2') THEN RETURN false; END IF;
  -- A pinned organization context can never produce for another organization.
  IF nullif(current_setting('app.active_org_id',true),'') IS NOT NULL
     AND current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text THEN
    RETURN false;
  END IF;
  RETURN (EXISTS (SELECT 1 FROM public.organizations o
    JOIN public.platform_settings f ON f.key=p_key
    WHERE o.id=p_org AND (o.feature_flags->p_key='true'::jsonb) IS TRUE
      AND (f.value->'enabled'='true'::jsonb) IS TRUE
      AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
      AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE)) IS TRUE;
END $$;
REVOKE ALL ON FUNCTION app.b028_events_flag(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b028_event_locale(p_locale text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_locale='en' THEN 'en' ELSE 'zh-TW' END
$$;
REVOKE ALL ON FUNCTION app.b028_event_locale(text) FROM PUBLIC,anon,authenticated,service_role;

-- Package-1 attempt row write, factored so b028_delivery_enqueue and the producer share
-- one implementation. Internal: no grant to any role.
CREATE FUNCTION app.b028_attempt_insert(p_org uuid,p_source_kind text,p_source_id uuid,p_recipient_key text,p_channel text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO app.b028_delivery_attempts(org_id,source_kind,source_id,recipient_key,channel)
    VALUES(p_org,p_source_kind,p_source_id,p_recipient_key,p_channel)
    ON CONFLICT (org_id,source_kind,source_id,recipient_key,channel) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT a.id INTO v_id FROM app.b028_delivery_attempts a WHERE a.org_id=p_org
      AND a.source_kind=p_source_kind AND a.source_id=p_source_id AND a.recipient_key=p_recipient_key AND a.channel=p_channel;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b028_attempt_insert(uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Package 1 gateway: body identical to 20261106235000 except the row write call.
CREATE OR REPLACE FUNCTION app.b028_delivery_enqueue(p_org uuid,p_source_kind text,p_source_id uuid,p_recipient_key text,p_channel text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE v_id uuid;
BEGIN
  IF app.b028_delivery_enabled(p_org) IS NOT TRUE THEN
    RAISE EXCEPTION 'Delivery unavailable' USING ERRCODE='42501';
  END IF;
  v_id := app.b028_attempt_insert(p_org,p_source_kind,p_source_id,p_recipient_key,p_channel);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b028_delivery_enqueue(uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_delivery_enqueue(uuid,text,uuid,text,text) TO service_role;

-- OFF->ON transitions of the effective notification_delivery_v2 control, per org. Written
-- only when an org's effective state turns ON (never while the control stays OFF).
CREATE TABLE app.b028_delivery_on_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  became_on_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX b028_delivery_on_transitions_org ON app.b028_delivery_on_transitions(org_id,became_on_at DESC);
ALTER TABLE app.b028_delivery_on_transitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b028_delivery_on_transitions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b028_attempt_flag_effective(p_value jsonb,p_org uuid,p_flags jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (p_value->'enabled'='true'::jsonb) IS TRUE AND (jsonb_typeof(p_value->'allowed_org_ids')='array') IS TRUE
    AND (p_value->'allowed_org_ids' @> jsonb_build_array(p_org::text)) IS TRUE
    AND (p_flags->'notification_delivery_v2'='true'::jsonb) IS TRUE
$$;
REVOKE ALL ON FUNCTION app.b028_attempt_flag_effective(jsonb,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b028_attempt_setting_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
  INSERT INTO app.b028_delivery_on_transitions(org_id)
    SELECT o.id FROM public.organizations o
    WHERE app.b028_attempt_flag_effective(NEW.value,o.id,o.feature_flags)
      AND NOT (TG_OP='UPDATE' AND app.b028_attempt_flag_effective(OLD.value,o.id,o.feature_flags));
  RETURN NULL;
END $$;
CREATE FUNCTION app.b028_attempt_org_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v_value jsonb;
BEGIN
  -- FOR SHARE serializes against a concurrent global/allowlist change (whose own trigger
  -- then re-reads organizations after this commits), so neither side can miss the
  -- transition. Fires only when the org's notification_delivery_v2 key changes.
  SELECT f.value INTO v_value FROM public.platform_settings f WHERE f.key='notification_delivery_v2' FOR SHARE;
  IF app.b028_attempt_flag_effective(v_value,NEW.id,NEW.feature_flags) AND NOT app.b028_attempt_flag_effective(v_value,OLD.id,OLD.feature_flags) THEN
    INSERT INTO app.b028_delivery_on_transitions(org_id) VALUES(NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b028_attempt_setting_transition(),app.b028_attempt_org_transition() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b028_attempt_setting_transition AFTER INSERT OR UPDATE ON public.platform_settings
  FOR EACH ROW WHEN (NEW.key='notification_delivery_v2') EXECUTE FUNCTION app.b028_attempt_setting_transition();
CREATE TRIGGER b028_attempt_org_transition AFTER UPDATE OF feature_flags ON public.organizations
  FOR EACH ROW WHEN (OLD.feature_flags->'notification_delivery_v2' IS DISTINCT FROM NEW.feature_flags->'notification_delivery_v2')
  EXECUTE FUNCTION app.b028_attempt_org_transition();

-- Package 1 claim: body identical to 20261106235000 plus one sweep. Producer attempts
-- (source_kind 'b028_event', admitted without locks) whose producer transaction started before the org's latest
-- OFF->ON transition are retired as terminal failed/'stale_admission' and never
-- dispatched. Attempts of every other source kind are untouched.
CREATE OR REPLACE FUNCTION app.b028_delivery_claim(p_org uuid,p_channel text,p_limit integer,p_ttl_seconds integer)
RETURNS TABLE(attempt_id uuid,token text,source_kind text,source_id uuid,recipient_key text,attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE v_row app.b028_delivery_attempts%ROWTYPE; v_token text; v_on timestamptz;
BEGIN
  IF app.b028_delivery_enabled(p_org) IS NOT TRUE THEN RETURN; END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('email','line') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'Invalid delivery claim' USING ERRCODE='22023';
  END IF;
  SELECT max(t.became_on_at) INTO v_on FROM app.b028_delivery_on_transitions t WHERE t.org_id=p_org;
  IF v_on IS NOT NULL THEN
    UPDATE app.b028_delivery_attempts SET status='failed',claim_token_hash=NULL,claim_expires_at=NULL,
      failure_code='stale_admission',updated_at=clock_timestamp()
      WHERE id IN (SELECT a.id FROM app.b028_delivery_attempts a
        LEFT JOIN app.b028_notification_events e ON e.org_id=a.org_id AND e.id=a.source_id
        WHERE a.org_id=p_org AND a.channel=p_channel AND a.source_kind='b028_event'
          AND coalesce(e.admitted_at,a.created_at)<v_on
          AND (a.status='queued' OR (a.status='claimed' AND a.claim_expires_at<=clock_timestamp()))
        FOR UPDATE OF a SKIP LOCKED);
  END IF;
  FOR v_row IN SELECT a.* FROM app.b028_delivery_attempts a
    WHERE a.org_id=p_org AND a.channel=p_channel
      AND (a.status='queued' OR (a.status='claimed' AND a.claim_expires_at<=clock_timestamp()))
    ORDER BY a.created_at,a.id LIMIT p_limit FOR UPDATE OF a SKIP LOCKED
  LOOP
    IF v_row.attempt>=5 THEN
      UPDATE app.b028_delivery_attempts SET status='failed',claim_token_hash=NULL,claim_expires_at=NULL,
        failure_code='claim_expired',updated_at=clock_timestamp() WHERE id=v_row.id;
      CONTINUE;
    END IF;
    v_token:=encode(public.gen_random_bytes(32),'hex');
    UPDATE app.b028_delivery_attempts SET status='claimed',attempt=v_row.attempt+1,
      claim_token_hash=encode(public.digest(v_token,'sha256'),'hex'),
      claim_expires_at=clock_timestamp()+make_interval(secs=>p_ttl_seconds),
      provider_ref=NULL,failure_code=NULL,updated_at=clock_timestamp() WHERE id=v_row.id;
    RETURN QUERY SELECT v_row.id,v_token,v_row.source_kind,v_row.source_id,v_row.recipient_key,v_row.attempt+1;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.b028_delivery_claim(uuid,text,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_delivery_claim(uuid,text,integer,integer) TO service_role;

-- Service-only producer. Callers pass only the committed source row; family, kind,
-- version, offset and recipients are derived here from rows of the same organization.
-- Returns NULL (no effect) when OFF or when the source is not an eligible row of p_org.
-- A replay of the same (source, version, offset) returns the existing event and adds
-- no recipient or delivery attempt. No explicit lock is taken and no lock_timeout is set:
-- foreign-key key-share waits follow the calling business transaction's own lock policy.
CREATE FUNCTION app.b028_produce_event(p_org uuid,p_source_kind text,p_source uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE
  v_family text; v_kind text; v_table text; v_id uuid; v_version text; v_offset text;
  v_row_table text; v_vars jsonb := '{}'::jsonb; v_at timestamptz; v_event uuid; v_lease uuid;
  v_contact uuid; v_principal uuid; v_member uuid; r record;
BEGIN
  IF p_source IS NULL OR p_source_kind IS NULL OR app.b028_events_flag(p_org,'notification_events_v2') IS NOT TRUE THEN RETURN NULL; END IF;
  IF p_source_kind='invitation' THEN
    SELECT i.id,i.kind::text AS kind,i.contact_id,i.created_at,
      ((i.expires_at AT TIME ZONE o.timezone)::date)::text AS expires_on INTO r
      FROM public.invitations i JOIN public.organizations o ON o.id=i.org_id
      WHERE i.id=p_source AND i.org_id=p_org AND i.status='pending' AND i.kind::text IN ('owner','tenant');
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_family:='invite'; v_kind:='invite_issued'; v_table:='invitations'; v_id:=r.id; v_version:='issued';
    v_offset:=r.kind; v_row_table:='invitations'; v_at:=r.created_at; v_contact:=r.contact_id;
    v_vars:=jsonb_build_object('invite_kind',r.kind,'expires_on',r.expires_on);
  ELSIF p_source_kind='b010_source_event' THEN
    SELECT e.id,e.kind,e.occurrence_key,e.local_date,e.created_at,i.due_date,i.balance_minor,i.currency INTO r
      FROM app.b010_source_events e JOIN public.invoices i ON i.org_id=e.org_id AND i.id=e.invoice_id
      WHERE e.id=p_source AND e.org_id=p_org AND e.kind IN ('rent_due','rent_overdue','rent_manual');
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_family:='bill'; v_kind:=r.kind; v_table:='b010_source_events'; v_id:=r.id; v_version:=r.occurrence_key;
    v_offset:=CASE WHEN r.kind='rent_manual' THEN 'manual' ELSE 'day:' || (r.local_date-r.due_date)::text END;
    v_row_table:='b010_source_events'; v_at:=r.created_at;
    v_vars:=jsonb_build_object('due_date',r.due_date::text,'balance_minor',r.balance_minor::text,'currency',r.currency::text);
  ELSIF p_source_kind='payment' THEN
    SELECT p.id,p.status::text AS status,p.lease_id,p.payer_contact_id,p.amount_minor,p.currency,p.paid_on,p.updated_at INTO r
      FROM public.payments p WHERE p.id=p_source AND p.org_id=p_org AND p.status::text IN ('confirmed','rejected','reversed');
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_family:='payment'; v_kind:='payment_' || r.status; v_table:='payments'; v_id:=r.id; v_version:=r.status;
    v_offset:='result'; v_row_table:='payments'; v_at:=clock_timestamp(); v_lease:=r.lease_id; v_contact:=r.payer_contact_id;
    v_vars:=jsonb_build_object('amount_minor',r.amount_minor::text,'currency',r.currency::text,'paid_on',r.paid_on::text);
  ELSIF p_source_kind='handover_version' THEN
    SELECT v.id,v.record_id,v.revision,v.lease_id,v.created_at,h.phase INTO r
      FROM app.handover_versions v JOIN app.handover_records h ON h.id=v.record_id AND h.org_id=v.org_id AND h.lease_id=v.lease_id
      WHERE v.id=p_source AND v.org_id=p_org;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_family:='handover'; v_kind:='handover_published'; v_table:='handover_records'; v_id:=r.record_id;
    v_version:=r.revision::text; v_offset:=r.phase; v_row_table:='handover_versions'; v_at:=r.created_at; v_lease:=r.lease_id;
    v_vars:=jsonb_build_object('phase',r.phase,'revision',r.revision);
  ELSIF p_source_kind='statement_version' THEN
    SELECT v.id,v.statement_id,v.version_no,v.created_at,s.owner_contact_id,s.period_start,s.period_end INTO r
      FROM app.b014_statement_versions v JOIN public.owner_statements s ON s.org_id=v.org_id AND s.id=v.statement_id
      WHERE v.id=p_source AND v.org_id=p_org AND s.status::text='issued';
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_family:='report'; v_kind:='report_version_recorded'; v_table:='owner_statements'; v_id:=r.statement_id;
    v_version:=r.version_no::text; v_offset:='version'; v_row_table:='b014_statement_versions'; v_at:=r.created_at;
    v_contact:=r.owner_contact_id;
    v_vars:=jsonb_build_object('version_no',r.version_no,'period_start',r.period_start::text,'period_end',r.period_end::text);
  ELSIF p_source_kind='repair_estimate_version' THEN
    SELECT v.id,v.ticket_id,v.version_no,v.amount_minor,v.currency,v.submitted_at,v.designated_contact_id,v.designated_principal_id INTO r
      FROM app.b013_estimate_versions v WHERE v.id=p_source AND v.org_id=p_org AND v.requires_owner_decision;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_family:='repair'; v_kind:='repair_approval_requested'; v_table:='maintenance_tickets'; v_id:=r.ticket_id;
    v_version:='estimate:' || r.version_no::text; v_offset:='approval'; v_row_table:='b013_estimate_versions'; v_at:=r.submitted_at;
    v_contact:=r.designated_contact_id; v_principal:=r.designated_principal_id;
    v_vars:=jsonb_build_object('version_no',r.version_no,'amount_minor',r.amount_minor::text,'currency',r.currency::text);
  ELSIF p_source_kind='repair_outbox' THEN
    SELECT x.id,x.ticket_id,x.kind,x.occurred_at,v.version_no,v.designated_contact_id,x.designated_principal_id,e.category INTO r
      FROM app.b013_repair_event_outbox x
      JOIN app.b013_estimate_versions v ON v.org_id=x.org_id AND v.ticket_id=x.ticket_id AND v.id=x.version_id
      LEFT JOIN app.b013_repair_emergencies e ON e.org_id=x.org_id AND e.ticket_id=x.ticket_id AND e.id=x.emergency_id
      WHERE x.id=p_source AND x.org_id=p_org AND x.kind='emergency_owner_notice';
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_family:='repair'; v_kind:='repair_emergency_notice'; v_table:='maintenance_tickets'; v_id:=r.ticket_id;
    v_version:='emergency:' || r.version_no::text; v_offset:=r.kind; v_row_table:='b013_repair_event_outbox'; v_at:=r.occurred_at;
    v_contact:=r.designated_contact_id; v_principal:=r.designated_principal_id;
    v_vars:=jsonb_build_object('version_no',r.version_no,'category',r.category);
  ELSIF p_source_kind='repair_decision' THEN
    SELECT d.id,d.ticket_id,d.decision,d.decided_at,v.version_no,v.submitted_by INTO r
      FROM app.b013_estimate_decisions d
      JOIN app.b013_estimate_versions v ON v.org_id=d.org_id AND v.ticket_id=d.ticket_id AND v.id=d.version_id
      WHERE d.id=p_source AND d.org_id=p_org;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_family:='repair'; v_kind:='repair_decision_recorded'; v_table:='maintenance_tickets'; v_id:=r.ticket_id;
    v_version:='decision:' || r.version_no::text; v_offset:=r.decision; v_row_table:='b013_estimate_decisions'; v_at:=r.decided_at;
    v_principal:=r.submitted_by;
    v_vars:=jsonb_build_object('version_no',r.version_no,'decision',r.decision);
  ELSE
    RETURN NULL;
  END IF;

  INSERT INTO app.b028_notification_events(org_id,family,kind,source_table,source_id,source_version,offset_key,
      source_row_table,source_row_id,vars,occurred_at)
    VALUES(p_org,v_family,v_kind,v_table,v_id,v_version,v_offset,v_row_table,p_source,v_vars,v_at)
    ON CONFLICT (org_id,source_table,source_id,source_version,offset_key) DO NOTHING RETURNING id INTO v_event;
  IF v_event IS NULL THEN
    -- Replay of the same committed source/version: no new recipients or attempts.
    SELECT e.id INTO v_event FROM app.b028_notification_events e WHERE e.org_id=p_org AND e.source_table=v_table
      AND e.source_id=v_id AND e.source_version=v_version AND e.offset_key=v_offset;
    RETURN v_event;
  END IF;

  IF v_family='invite' THEN
    INSERT INTO app.b028_notification_event_recipients(org_id,event_id,source_table,source_id,source_version,offset_key,
        persona,recipient_key,principal_user_id,contact_id,locale)
      SELECT p_org,v_event,v_table,v_id,v_version,v_offset,v_offset,v_offset || ':' || c.id::text,c.user_id,c.id,app.b028_event_locale(c.locale)
      FROM public.contacts c WHERE c.org_id=p_org AND c.id=v_contact AND c.archived_at IS NULL
        AND ((v_offset='owner' AND c.is_owner) OR (v_offset='tenant' AND c.is_tenant));
  ELSIF v_family='bill' THEN
    -- Existing reminder recipient resolution (app.b028_recipient_claims) is reused verbatim.
    INSERT INTO app.b028_notification_event_recipients(org_id,event_id,source_table,source_id,source_version,offset_key,
        persona,recipient_key,principal_user_id,contact_id,member_id,claim_id,locale)
      SELECT p_org,v_event,v_table,v_id,v_version,v_offset,
        CASE WHEN rc.member_id IS NULL THEN 'tenant' ELSE 'staff' END,
        CASE WHEN rc.member_id IS NULL THEN 'tenant:' || rc.contact_id::text ELSE 'staff:' || rc.member_id::text END,
        rc.principal_user_id,CASE WHEN rc.member_id IS NULL THEN rc.contact_id END,rc.member_id,rc.id,
        app.b028_event_locale(coalesce(ct.locale,pr.locale))
      FROM app.b028_recipient_claims rc
      LEFT JOIN public.contacts ct ON ct.org_id=rc.org_id AND ct.id=rc.contact_id
      LEFT JOIN public.org_members m ON m.org_id=rc.org_id AND m.id=rc.member_id
      LEFT JOIN public.profiles pr ON pr.id=m.user_id
      WHERE rc.org_id=p_org AND rc.event_id=v_id AND rc.channel='email'
        AND (rc.contact_id IS NOT NULL OR (m.id IS NOT NULL AND m.user_id=rc.principal_user_id))
      ON CONFLICT DO NOTHING;
  ELSIF v_family IN ('payment','handover') THEN
    -- Payment: the payer only (as the payment center does). Handover: current lease tenants.
    INSERT INTO app.b028_notification_event_recipients(org_id,event_id,source_table,source_id,source_version,offset_key,
        persona,recipient_key,principal_user_id,contact_id,locale)
      SELECT DISTINCT ON (c.id) p_org,v_event,v_table,v_id,v_version,v_offset,'tenant','tenant:' || c.id::text,c.user_id,c.id,app.b028_event_locale(c.locale)
      FROM public.lease_parties lp JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
      WHERE lp.org_id=p_org AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant')
        AND c.is_tenant AND c.archived_at IS NULL AND (v_family='handover' OR c.id=v_contact)
      ORDER BY c.id;
  ELSIF v_family='report' OR v_kind IN ('repair_approval_requested','repair_emergency_notice') THEN
    INSERT INTO app.b028_notification_event_recipients(org_id,event_id,source_table,source_id,source_version,offset_key,
        persona,recipient_key,principal_user_id,contact_id,locale)
      SELECT p_org,v_event,v_table,v_id,v_version,v_offset,'owner','owner:' || c.id::text,c.user_id,c.id,app.b028_event_locale(c.locale)
      FROM public.contacts c WHERE c.org_id=p_org AND c.id=v_contact AND c.is_owner AND c.archived_at IS NULL
        AND (v_principal IS NULL OR c.user_id=v_principal);
  ELSIF v_kind='repair_decision_recorded' THEN
    -- No helper resolves another user's role (app.has_role reads auth.uid()). The role
    -- set mirrors app.b013_submit_estimate's submitter check: the submitter, while still
    -- an active admin/manager of this org.
    INSERT INTO app.b028_notification_event_recipients(org_id,event_id,source_table,source_id,source_version,offset_key,
        persona,recipient_key,principal_user_id,member_id,locale)
      SELECT p_org,v_event,v_table,v_id,v_version,v_offset,'staff','staff:' || m.id::text,m.user_id,m.id,app.b028_event_locale(pr.locale)
      FROM public.org_members m LEFT JOIN public.profiles pr ON pr.id=m.user_id
      WHERE m.org_id=p_org AND m.user_id=v_principal AND m.status::text='active' AND m.role::text IN ('admin','manager');
  END IF;

  -- Package-1 durable attempts, only when notification_delivery_v2 is also ON, and never
  -- for bills: their existing Email claims (b028_claim_scheduled/b028_claim_manual) keep
  -- sole ownership, so one reminder recipient is one Email across both paths. The row is
  -- written by the same app.b028_attempt_insert that b028_delivery_enqueue uses. Admission
  -- here is a plain read (no NOWAIT locks inside business transactions); the fence moves
  -- to claim time: an attempt committed after OFF stays inert while OFF (claim/status
  -- admission), and after a later OFF->ON transition b028_delivery_claim retires it.
  IF v_family <> 'bill' AND app.b028_events_flag(p_org,'notification_delivery_v2') IS TRUE THEN
    FOR r IN SELECT x.recipient_key FROM app.b028_notification_event_recipients x
      WHERE x.org_id=p_org AND x.event_id=v_event ORDER BY x.recipient_key LOOP
      PERFORM app.b028_attempt_insert(p_org,'b028_event',v_event,r.recipient_key,'email');
    END LOOP;
  END IF;
  RETURN v_event;
END $$;
REVOKE ALL ON FUNCTION app.b028_produce_event(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_produce_event(uuid,text,uuid) TO service_role;

-- Service-only template inputs for one event recipient. OFF returns no row.
CREATE FUNCTION app.b028_event_message(p_org uuid,p_event uuid,p_recipient_key text)
RETURNS TABLE(kind text,vars jsonb,locale text,persona text,recipient_name text,firm_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
  IF app.b028_events_flag(p_org,'notification_events_v2') IS NOT TRUE THEN RETURN; END IF;
  RETURN QUERY SELECT e.kind,e.vars,x.locale,x.persona,
      coalesce(nullif(btrim(c.display_name),''),nullif(btrim(pr.display_name),''),''),o.name::text
    FROM app.b028_notification_events e
    JOIN app.b028_notification_event_recipients x ON x.org_id=e.org_id AND x.event_id=e.id
    JOIN public.organizations o ON o.id=e.org_id
    LEFT JOIN public.contacts c ON c.org_id=x.org_id AND c.id=x.contact_id
    LEFT JOIN public.org_members m ON m.org_id=x.org_id AND m.id=x.member_id
    LEFT JOIN public.profiles pr ON pr.id=m.user_id
    WHERE e.org_id=p_org AND e.id=p_event AND x.recipient_key=p_recipient_key;
END $$;
REVOKE ALL ON FUNCTION app.b028_event_message(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_event_message(uuid,uuid,text) TO service_role;
