-- B-030: local mock lifecycle only, no commercial defaults or operation restrictions.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
INSERT INTO public.platform_settings(key,value)
VALUES ('usage_subscriptions','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b030_plan_versions (
  plan_key text NOT NULL CHECK (plan_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  version integer NOT NULL CHECK (version > 0),
  price_amount_minor bigint, price_currency text,
  grace_seconds bigint CHECK (grace_seconds BETWEEN 0 AND 31536000),
  units_limit bigint CHECK (units_limit >= 0),
  signatures_limit bigint CHECK (signatures_limit >= 0),
  stored_bytes_limit bigint CHECK (stored_bytes_limit >= 0),
  notifications_limit bigint CHECK (notifications_limit >= 0),
  vendor_jobs_limit bigint CHECK (vendor_jobs_limit >= 0),
  restriction_rules jsonb,
  PRIMARY KEY (plan_key,version),
  CHECK (price_amount_minor IS NULL AND price_currency IS NULL),
  CHECK (restriction_rules IS NULL)
);
INSERT INTO app.b030_plan_versions(plan_key,version) VALUES ('unconfigured',1);
CREATE TABLE app.b030_subscriptions (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id),
  state text NOT NULL CHECK (state IN ('trialing','active','grace','restricted','canceled')),
  plan_key text NOT NULL, plan_version integer NOT NULL,
  provider_sequence bigint NOT NULL CHECK (provider_sequence > 0),
  provider_occurred_at timestamptz NOT NULL,
  grace_ends_at timestamptz,
  FOREIGN KEY (plan_key,plan_version) REFERENCES app.b030_plan_versions(plan_key,version)
);
CREATE TABLE app.b030_provider_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  previous_state text,
  next_state text NOT NULL CHECK (next_state IN ('trialing','active','grace','restricted','canceled')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,sequence)
);
CREATE TABLE app.b030_vendor_assignments (
  ticket_id uuid PRIMARY KEY REFERENCES public.maintenance_tickets(id),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  generation bigint NOT NULL CHECK (generation > 0),
  vendor_contact_id uuid,
  first_job_id uuid REFERENCES public.repair_vendor_jobs(id),
  first_dispatched_at timestamptz,
  CHECK ((first_job_id IS NULL) = (first_dispatched_at IS NULL))
);
ALTER TABLE app.b030_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b030_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b030_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b030_vendor_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b030_plan_versions,app.b030_subscriptions,app.b030_provider_events,app.b030_vendor_assignments FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b030_plans_immutable BEFORE UPDATE OR DELETE ON app.b030_plan_versions
FOR EACH ROW EXECUTE FUNCTION app.usage_events_immutable();
CREATE TRIGGER b030_plans_no_truncate BEFORE TRUNCATE ON app.b030_plan_versions
FOR EACH STATEMENT EXECUTE FUNCTION app.usage_events_immutable();
CREATE TRIGGER b030_events_immutable BEFORE UPDATE OR DELETE ON app.b030_provider_events
FOR EACH ROW EXECUTE FUNCTION app.usage_events_immutable();
CREATE TRIGGER b030_events_no_truncate BEFORE TRUNCATE ON app.b030_provider_events
FOR EACH STATEMENT EXECUTE FUNCTION app.usage_events_immutable();

CREATE FUNCTION app.b030_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,app AS $$
  SELECT coalesce((SELECT CASE WHEN jsonb_typeof(p.value->'allowed_org_ids')='array'
    THEN p.value->'enabled'='true'::jsonb AND p.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
      AND o.feature_flags->'usage_subscriptions'='true'::jsonb ELSE false END
    FROM public.organizations o CROSS JOIN public.platform_settings p WHERE o.id=p_org AND p.key='usage_subscriptions'),false)
$$;
REVOKE ALL ON FUNCTION app.b030_enabled(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b030_admit_write(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,app AS $$
BEGIN
  IF NOT app.b030_enabled(p_org) THEN RETURN false; END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  RETURN app.b030_enabled(p_org);
END $$;
REVOKE ALL ON FUNCTION app.b030_admit_write(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b030_require_reader(p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,app AS $$
BEGIN
  IF nullif(current_setting('app.active_org_id',true),'') IS DISTINCT FROM p_org::text
    OR nullif(current_setting('app.env',true),'') IS DISTINCT FROM (SELECT environment::text FROM public.organizations WHERE id=p_org)
    OR NOT coalesce(app.has_role(p_org,'{admin,accountant}'),false) THEN
    RAISE EXCEPTION 'Subscription unavailable' USING ERRCODE='42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.b030_require_reader(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Read-time period aggregates: exact event provenance, no stale materialization or read writes.
CREATE FUNCTION app.b030_usage_summary(p_org uuid,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(dimension text,quantity text,events text,source_event_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,app AS $$
BEGIN
  PERFORM app.b030_require_reader(p_org);
  IF NOT app.b030_enabled(p_org) THEN RETURN; END IF;
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to THEN
    RAISE EXCEPTION 'Invalid usage period' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT u.dimension,sum(u.quantity)::text,count(*)::text,array_agg(u.id ORDER BY u.occurred_at,u.id)
    FROM app.usage_events u JOIN public.organizations o ON o.id=u.org_id
    WHERE u.org_id=p_org AND NOT u.sandbox AND o.environment::text='live'
      AND u.occurred_at>=p_from AND u.occurred_at<p_to GROUP BY u.dimension ORDER BY u.dimension;
END $$;
REVOKE ALL ON FUNCTION app.b030_usage_summary(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b030_usage_summary(uuid,timestamptz,timestamptz) TO authenticated;

CREATE FUNCTION app.b030_plan_presentation(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog,public,app AS $$
DECLARE s app.b030_subscriptions%ROWTYPE; p app.b030_plan_versions%ROWTYPE;
BEGIN
  PERFORM app.b030_require_reader(p_org);
  IF NOT app.b030_enabled(p_org) THEN RETURN jsonb_build_object('enabled',false); END IF;
  SELECT * INTO s FROM app.b030_subscriptions WHERE org_id=p_org;
  SELECT * INTO p FROM app.b030_plan_versions WHERE plan_key=coalesce(s.plan_key,'unconfigured') AND version=coalesce(s.plan_version,1);
  RETURN jsonb_build_object('enabled',true,'state',s.state,'planKey',p.plan_key,'planVersion',p.version,
    'pricing','not_configured','priceAmountMinor',NULL,'priceCurrency',NULL,
    'graceSeconds',p.grace_seconds::text,'graceEndsAt',s.grace_ends_at,
    'limits',jsonb_build_object('units',p.units_limit::text,'signatures',p.signatures_limit::text,
      'stored_bytes',p.stored_bytes_limit::text,'notifications',p.notifications_limit::text,'vendor_jobs',p.vendor_jobs_limit::text),
    'restrictionRules',NULL);
END $$;
REVOKE ALL ON FUNCTION app.b030_plan_presentation(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b030_plan_presentation(uuid) TO authenticated;

-- Trusted local server verifies HMAC/freshness before calling; no public RPC grant.
CREATE FUNCTION app.b030_apply_mock_event(p_org uuid,p_id text,p_sequence bigint,p_state text,p_at timestamptz,
  p_plan text,p_version integer,p_sha text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,app AS $$
DECLARE prior app.b030_provider_events%ROWTYPE; s app.b030_subscriptions%ROWTYPE; p app.b030_plan_versions%ROWTYPE; deadline timestamptz;
BEGIN
  IF NOT app.b030_admit_write(p_org) THEN RETURN 'off'; END IF;
  -- Global event identity first, then per-org sequence: deterministic lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended('b030-event:'||coalesce(p_id,''),0));
  PERFORM pg_advisory_xact_lock(hashtextextended('b030-org:'||p_org::text,0));
  SELECT * INTO prior FROM app.b030_provider_events WHERE event_id=p_id;
  IF FOUND THEN
    IF prior.org_id=p_org AND prior.body_sha256=p_sha AND prior.sequence=p_sequence AND prior.next_state=p_state AND prior.occurred_at=p_at THEN
      RETURN 'duplicate';
    END IF;
    RAISE EXCEPTION 'Mock event conflict' USING ERRCODE='23505';
  END IF;
  IF p_id IS NULL OR p_sequence IS NULL OR p_sequence<=0 OR p_state IS NULL OR p_at IS NULL OR NOT isfinite(p_at)
    OR p_state NOT IN ('trialing','active','grace','restricted','canceled') OR p_sha IS NULL THEN
    RAISE EXCEPTION 'Invalid mock event' USING ERRCODE='22023';
  END IF;
  SELECT * INTO p FROM app.b030_plan_versions WHERE plan_key=p_plan AND version=p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown plan version' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM app.b030_subscriptions WHERE org_id=p_org;
  IF s.org_id IS NOT NULL AND (p_sequence<=s.provider_sequence OR p_at<s.provider_occurred_at) THEN
    RAISE EXCEPTION 'Out of order mock event' USING ERRCODE='22023';
  END IF;
  IF NOT (CASE WHEN s.state IS NULL THEN p_state IN ('trialing','active')
    WHEN s.state='canceled' THEN false
    WHEN s.state=p_state THEN true
    WHEN s.state='trialing' THEN p_state IN ('active','grace','canceled')
    WHEN s.state='active' THEN p_state IN ('grace','canceled')
    WHEN s.state='grace' THEN p_state IN ('active','restricted','canceled')
    WHEN s.state='restricted' THEN p_state IN ('active','canceled') ELSE false END) THEN
    RAISE EXCEPTION 'Invalid mock transition' USING ERRCODE='22023';
  END IF;
  IF p_state='grace' THEN
    IF s.state='grace' THEN deadline:=s.grace_ends_at;
    ELSIF p.grace_seconds IS NOT NULL THEN deadline:=p_at + p.grace_seconds * interval '1 second'; END IF;
  END IF;
  INSERT INTO app.b030_provider_events(event_id,org_id,sequence,body_sha256,occurred_at,previous_state,next_state)
    VALUES(p_id,p_org,p_sequence,p_sha,p_at,s.state,p_state);
  INSERT INTO app.b030_subscriptions(org_id,state,plan_key,plan_version,provider_sequence,provider_occurred_at,grace_ends_at)
    VALUES(p_org,p_state,p_plan,p_version,p_sequence,p_at,deadline)
    ON CONFLICT(org_id) DO UPDATE SET state=excluded.state,plan_key=excluded.plan_key,plan_version=excluded.plan_version,
      provider_sequence=excluded.provider_sequence,provider_occurred_at=excluded.provider_occurred_at,grace_ends_at=excluded.grace_ends_at;
  RETURN 'applied';
END $$;
REVOKE ALL ON FUNCTION app.b030_apply_mock_event(uuid,text,bigint,text,timestamptz,text,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b030_apply_mock_event(uuid,text,bigint,text,timestamptz,text,integer,text) TO service_role;

-- Existing business audit rows are the durable recovery source. Telemetry failures
-- roll back only this function's subtransaction, never the business row or its audit.
CREATE FUNCTION app.b030_track_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,app AS $$
DECLARE prior_timeout text; assignment_generation bigint;
BEGIN
  IF TG_OP='UPDATE' AND NEW.assigned_vendor_contact_id IS NOT DISTINCT FROM OLD.assigned_vendor_contact_id THEN RETURN NEW; END IF;
  IF NOT app.b030_enabled(NEW.org_id) THEN RETURN NEW; END IF;
  prior_timeout := current_setting('lock_timeout');
  IF prior_timeout::interval = interval '0' OR prior_timeout::interval > interval '250 milliseconds' THEN
    PERFORM set_config('lock_timeout','250ms',true);
  END IF;
  IF app.b030_admit_write(NEW.org_id) THEN
    SELECT count(*) INTO assignment_generation FROM public.audit_log l
      WHERE l.org_id=NEW.org_id AND l.table_name='maintenance_tickets' AND l.row_id=NEW.id::text
        AND (l.action='insert' OR (l.action='update' AND l.old_row->'assigned_vendor_contact_id' IS DISTINCT FROM l.new_row->'assigned_vendor_contact_id'));
    INSERT INTO app.b030_vendor_assignments(ticket_id,org_id,generation,vendor_contact_id)
      VALUES(NEW.id,NEW.org_id,assignment_generation,NEW.assigned_vendor_contact_id)
      ON CONFLICT(ticket_id) DO UPDATE SET generation=excluded.generation,
        vendor_contact_id=excluded.vendor_contact_id,first_job_id=NULL,first_dispatched_at=NULL;
  END IF;
  PERFORM set_config('lock_timeout',prior_timeout,true);
  RETURN NEW;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  -- SQLSTATE only: never expose the failed SQL, row, identifiers or exception text.
  -- The next admitted dispatch compares the durable audit generation and repairs
  -- missed transitions (including A -> B -> A); no synthetic historical usage.
  RAISE WARNING 'b030_assignment_tracking_failed sqlstate=% recovery=next_dispatch', SQLSTATE;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b030_track_assignment() FROM PUBLIC,anon,authenticated,service_role;
-- AFTER the existing trg_maintenance_tickets_audit, including same-statement changes.
CREATE TRIGGER z_b030_assignment_generation AFTER INSERT OR UPDATE OF assigned_vendor_contact_id ON public.maintenance_tickets
FOR EACH ROW EXECUTE FUNCTION app.b030_track_assignment();

-- Telemetry must never stall dispatch: every lock wait inside (admission and the
-- assignment row) is capped; a timeout aborts only the caller's usage savepoint.
CREATE FUNCTION app.b030_vendor_dispatch_source(p_org uuid,p_job uuid)
RETURNS TABLE(state text,id text,ticket text,vendor text,at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,app SET lock_timeout = '250ms' AS $$
DECLARE j public.repair_vendor_jobs%ROWTYPE; a app.b030_vendor_assignments%ROWTYPE; first_job public.repair_vendor_jobs%ROWTYPE;
  source_seq bigint; saved_seq bigint; assignment_generation bigint;
BEGIN
  IF NOT app.b030_admit_write(p_org) THEN
    RETURN QUERY SELECT 'off'::text,NULL::text,NULL::text,NULL::text,NULL::text;
    RETURN;
  END IF;
  SELECT * INTO j FROM public.repair_vendor_jobs WHERE org_id=p_org AND repair_vendor_jobs.id=p_job;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM public.maintenance_tickets t WHERE t.org_id=p_org AND t.id=j.ticket_id
    AND t.assigned_vendor_contact_id=j.vendor_contact_id FOR UPDATE;
  IF NOT FOUND OR NOT j.active OR j.revoked_at IS NOT NULL THEN RETURN; END IF;
  SELECT * INTO a FROM app.b030_vendor_assignments WHERE ticket_id=j.ticket_id FOR UPDATE;
  SELECT count(*) INTO assignment_generation FROM public.audit_log l
    WHERE l.org_id=p_org AND l.table_name='maintenance_tickets' AND l.row_id=j.ticket_id::text
      AND (l.action='insert' OR (l.action='update' AND l.old_row->'assigned_vendor_contact_id' IS DISTINCT FROM l.new_row->'assigned_vendor_contact_id'));
  -- Reconcile dispatch history across OFF periods without recording any OFF assignments.
  -- A known ON generation with no dispatch pointer must still start at the current job.
  WITH history AS (
      SELECT v.*,row_number() OVER (ORDER BY v.active,coalesce(v.revoked_at,v.created_at),v.id) seq
      FROM public.repair_vendor_jobs v WHERE v.org_id=p_org AND v.ticket_id=j.ticket_id
    ), boundary AS (SELECT coalesce(max(seq),0) seq FROM history WHERE vendor_contact_id IS DISTINCT FROM j.vendor_contact_id)
    SELECT min(h.seq),(SELECT seq FROM history WHERE history.id=a.first_job_id) INTO source_seq,saved_seq
      FROM history h,boundary b WHERE h.seq>b.seq;
  SELECT h.* INTO first_job FROM public.repair_vendor_jobs h WHERE h.id=(
    SELECT v.id FROM public.repair_vendor_jobs v WHERE v.org_id=p_org AND v.ticket_id=j.ticket_id
    ORDER BY v.active,coalesce(v.revoked_at,v.created_at),v.id OFFSET (source_seq-1) LIMIT 1);
  IF a.ticket_id IS NOT NULL AND assignment_generation>a.generation
    AND (a.first_job_id IS NULL OR (a.vendor_contact_id IS NOT DISTINCT FROM j.vendor_contact_id AND source_seq<=saved_seq)) THEN
    -- Recover skipped tracking from the business audit, even if the vendor came
    -- back to A without dispatching B. Only the current dispatch is recorded.
    UPDATE app.b030_vendor_assignments SET generation=assignment_generation,vendor_contact_id=j.vendor_contact_id,
      first_job_id=NULL,first_dispatched_at=NULL WHERE ticket_id=j.ticket_id RETURNING * INTO a;
  END IF;
  IF a.ticket_id IS NULL OR a.vendor_contact_id IS DISTINCT FROM j.vendor_contact_id
    OR (a.first_job_id IS NOT NULL AND source_seq>saved_seq) THEN
    -- First admission or dispatches while OFF: reuse B-029's source, avoiding rollout double counts.
    INSERT INTO app.b030_vendor_assignments(ticket_id,org_id,generation,vendor_contact_id,first_job_id,first_dispatched_at)
      VALUES(j.ticket_id,p_org,assignment_generation,j.vendor_contact_id,first_job.id,first_job.created_at)
      ON CONFLICT(ticket_id) DO UPDATE SET generation=excluded.generation,
        vendor_contact_id=excluded.vendor_contact_id,first_job_id=excluded.first_job_id,first_dispatched_at=excluded.first_dispatched_at;
  ELSE
    UPDATE app.b030_vendor_assignments SET first_job_id=coalesce(first_job_id,j.id),first_dispatched_at=coalesce(first_dispatched_at,j.created_at)
      WHERE ticket_id=j.ticket_id AND first_job_id IS NULL;
  END IF;
  RETURN QUERY SELECT 'ready'::text,a1.first_job_id::text,a1.ticket_id::text,a1.vendor_contact_id::text,a1.first_dispatched_at::text
    FROM app.b030_vendor_assignments a1 WHERE a1.org_id=p_org AND a1.ticket_id=j.ticket_id AND a1.vendor_contact_id=j.vendor_contact_id;
END $$;
REVOKE ALL ON FUNCTION app.b030_vendor_dispatch_source(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b030_vendor_dispatch_source(uuid,uuid) TO service_role;
COMMIT;
