-- B-109 ADV-METER (GS-53 = A; MGT-90-AC4…AC6), 物件 › 進階設定 › 公用電表: the per-property shared (common-area)
-- electricity meter config, and a read-only split preview for a period. Additive, forward-only.
-- One NEW table (RLS on, no application grants), three NEW migration-owned VOLATILE service-only SECURITY DEFINER
-- gateways (search_path=pg_catalog,pg_temp; EXECUTE to service_role only) and the NEW flag shared_meter, seeded
-- OFF without overwriting. No existing object, grant, policy or data changes.
-- Admission (all gateways): the selected env/live tuple, a live auth session, an active native admin or manager
-- of this org, the shared_meter org + platform flag, and a non-archived property of this org.
-- Config is versioned: each save is a new revision effective from the first day of the next month (property-local),
-- so issued bills and the current period never change. The per-kWh price is NOT stored here (it stays in the
-- money-flow 電費規則 with its Taipower cap, MGT-90-AC5); the split preview takes kWh and an optional amount.
-- Rounding: shares are floored and the remainder goes to the first selected space in display order.
-- Applying the split to issued bills (B-008 / utility posting) is NOT part of this migration.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE app.b109_shared_meter_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  property_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  -- Rooms of by-room units and whole units of the property, validated by the save gateway.
  space_ids uuid[] NOT NULL CHECK (cardinality(space_ids) BETWEEN 1 AND 500),
  split_method text NOT NULL CHECK (split_method IN ('even','days_occupied','sub_meter')),
  start_reading numeric(14,3) NOT NULL CHECK (start_reading >= 0),
  effective_from date NOT NULL CHECK (extract(day FROM effective_from) = 1),
  request_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, property_id, revision),
  UNIQUE (org_id, request_id),
  FOREIGN KEY (org_id, property_id) REFERENCES public.properties (org_id, id)
);
CREATE INDEX b109_shared_meter_configs_effective_idx
  ON app.b109_shared_meter_configs (org_id, property_id, effective_from DESC, revision DESC);
ALTER TABLE app.b109_shared_meter_configs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b109_shared_meter_configs FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.platform_settings (key, value)
VALUES ('shared_meter', '{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- MGT-90-AC4/AC6 writer. Statuses: saved | disabled | invalid | conflict. Denials raise 42501.
CREATE FUNCTION app.b109_shared_meter_save(p_org uuid,p_live uuid,p_env text,p_session uuid,p_request uuid,
 p_property uuid,p_spaces uuid[],p_method text,p_start_reading numeric)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; prior record; spaces uuid[]; effective date; next_revision integer; config_id uuid;
BEGIN
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT x.user_id INTO actor FROM public.auth_sessions x
 WHERE x.id=p_session AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='shared_meter'
  WHERE o.id=p_org AND o.feature_flags->'shared_meter'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) THEN
  RETURN jsonb_build_object('status','disabled');
 END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active' FOR SHARE;
 IF member_role IS NULL OR member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.properties p WHERE p.org_id=p_org AND p.id=p_property AND p.archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_request IS NULL THEN RETURN jsonb_build_object('status','invalid'); END IF;
 -- Idempotency first (one key per org), before any check on mutable data: renaming or archiving a space
 -- later never turns an identical retry into a conflict or an invalid. The space ids compare as a set.
 PERFORM pg_advisory_xact_lock(hashtextextended('b109/shared-meter/request/'||p_org::text||'/'||p_request::text,0));
 SELECT * INTO prior FROM app.b109_shared_meter_configs c WHERE c.org_id=p_org AND c.request_id=p_request;
 IF FOUND THEN
  IF prior.property_id IS DISTINCT FROM p_property OR prior.created_by IS DISTINCT FROM actor
    OR prior.split_method IS DISTINCT FROM p_method OR prior.start_reading IS DISTINCT FROM p_start_reading
    OR p_spaces IS NULL OR cardinality(p_spaces)<>cardinality(prior.space_ids)
    OR (SELECT array_agg(x ORDER BY x) FROM unnest(prior.space_ids) x)
       IS DISTINCT FROM (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_spaces) x) THEN
   RETURN jsonb_build_object('status','conflict');
  END IF;
  RETURN jsonb_build_object('status','saved','configId',prior.id,'revision',prior.revision,
   'effectiveFrom',prior.effective_from::text,'spaceCount',cardinality(prior.space_ids),'method',prior.split_method,'replayed',true);
 END IF;
 -- The property's current spaces in display order: rooms of by-room units, and whole units.
 SELECT array_agg(x.id ORDER BY x.unit_label,x.room_label NULLS FIRST,x.id) INTO spaces
 FROM (SELECT r.id,u.label unit_label,r.label room_label FROM public.rooms r
        JOIN public.units u ON u.org_id=r.org_id AND u.id=r.unit_id
       WHERE u.org_id=p_org AND u.property_id=p_property AND u.rental_mode::text='by_room'
        AND u.archived_at IS NULL AND r.archived_at IS NULL
       UNION ALL
       SELECT u.id,u.label,NULL FROM public.units u
       WHERE u.org_id=p_org AND u.property_id=p_property AND u.rental_mode::text='whole_unit' AND u.archived_at IS NULL) x
 WHERE x.id = ANY(coalesce(p_spaces,'{}'::uuid[]));
 IF p_spaces IS NULL OR cardinality(p_spaces)=0 OR cardinality(p_spaces)>500
   OR (SELECT count(DISTINCT s) FROM unnest(p_spaces) s)<>cardinality(p_spaces)
   OR coalesce(cardinality(spaces),0)<>cardinality(p_spaces)
   OR p_method IS NULL OR p_method NOT IN ('even','days_occupied','sub_meter')
   OR p_start_reading IS NULL OR p_start_reading<0 OR p_start_reading>=100000000000 OR scale(p_start_reading)>3 THEN
  RETURN jsonb_build_object('status','invalid');
 END IF;
 -- MGT-90-AC4: from the next period (the first day of next month on the property's own calendar, as bills
 -- are dated per property, PLT-54); issued bills never change.
 SELECT (date_trunc('month',(clock_timestamp() AT TIME ZONE p.timezone)) + interval '1 month')::date INTO effective
 FROM public.properties p WHERE p.org_id=p_org AND p.id=p_property;
 SELECT coalesce(max(c.revision),0)+1 INTO next_revision FROM app.b109_shared_meter_configs c
 WHERE c.org_id=p_org AND c.property_id=p_property;
 INSERT INTO app.b109_shared_meter_configs(org_id,property_id,revision,space_ids,split_method,start_reading,
  effective_from,request_id,created_by)
 VALUES (p_org,p_property,next_revision,spaces,p_method,p_start_reading,effective,p_request,actor)
 RETURNING id INTO config_id;
 INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,new_row,reason,request_id,occurred_at)
 VALUES (p_org,actor,member_role,'b109_shared_meter_configs',config_id::text,'insert',
  jsonb_build_object('property_id',p_property,'revision',next_revision,'space_ids',to_jsonb(spaces),
   'split_method',p_method,'start_reading',p_start_reading::text,'effective_from',effective::text),
  'shared_meter_saved',p_request::text,clock_timestamp());
 RETURN jsonb_build_object('status','saved','configId',config_id,'revision',next_revision,
  'effectiveFrom',effective::text,'spaceCount',cardinality(spaces),'method',p_method,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION app.b109_shared_meter_save(uuid,uuid,text,uuid,uuid,uuid,uuid[],text,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b109_shared_meter_save(uuid,uuid,text,uuid,uuid,uuid,uuid[],text,numeric) TO service_role;

-- The page reader: the property's spaces, the latest saved revision (for the form) and the next effective month.
-- NULL when the flag is off.
CREATE FUNCTION app.b109_shared_meter_view(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; property_name text; next_from date; result jsonb;
BEGIN
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT x.user_id INTO actor FROM public.auth_sessions x
 WHERE x.id=p_session AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='shared_meter'
  WHERE o.id=p_org AND o.feature_flags->'shared_meter'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) THEN
  RETURN NULL;
 END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active' FOR SHARE;
 IF member_role IS NULL OR member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT p.name INTO property_name FROM public.properties p WHERE p.org_id=p_org AND p.id=p_property AND p.archived_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT (date_trunc('month',(clock_timestamp() AT TIME ZONE p.timezone)) + interval '1 month')::date INTO next_from
 FROM public.properties p WHERE p.org_id=p_org AND p.id=p_property;
 SELECT jsonb_build_object('property',property_name,'nextEffectiveFrom',next_from::text,
  'spaces',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'unitLabel',x.unit_label,'label',x.room_label)
     ORDER BY x.unit_label,x.room_label NULLS FIRST,x.id)
   FROM (SELECT r.id,'room' kind,u.label unit_label,r.label room_label FROM public.rooms r
          JOIN public.units u ON u.org_id=r.org_id AND u.id=r.unit_id
         WHERE u.org_id=p_org AND u.property_id=p_property AND u.rental_mode::text='by_room'
          AND u.archived_at IS NULL AND r.archived_at IS NULL
         UNION ALL
         SELECT u.id,'whole_unit',u.label,NULL FROM public.units u
         WHERE u.org_id=p_org AND u.property_id=p_property AND u.rental_mode::text='whole_unit' AND u.archived_at IS NULL) x),'[]'::jsonb),
  'config',(SELECT jsonb_build_object('revision',c.revision,'spaceIds',to_jsonb(c.space_ids),'method',c.split_method,
     'startReading',c.start_reading::text,'effectiveFrom',c.effective_from::text)
   FROM app.b109_shared_meter_configs c WHERE c.org_id=p_org AND c.property_id=p_property
   ORDER BY c.revision DESC LIMIT 1))
 INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b109_shared_meter_view(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b109_shared_meter_view(uuid,uuid,text,uuid,uuid) TO service_role;

-- Read-only split preview for one monthly period (p_period = its first day): the revision in effect for that
-- period (latest revision with effective_from <= p_period), the selected spaces still present, their weights
-- (even: 1; days_occupied: inclusive lease days in the period; sub_meter: the space's own electricity meter
-- usage in the period = its latest reading inside the period minus its latest reading before it) and the shares of p_kwh (to 0.001 kWh) and of p_amount_minor (optional, minor units).
-- All weights zero splits evenly. Remainders go to the first space.
-- Status: ready | none | ambiguous_meters | missing_readings | estimated_readings.
CREATE FUNCTION app.b109_shared_meter_split(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,
 p_period date,p_kwh numeric,p_amount_minor bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; cfg record; period_end date; total_milli bigint; total_weight numeric;
 rows jsonb; spaces jsonb; problem text;
BEGIN
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT x.user_id INTO actor FROM public.auth_sessions x
 WHERE x.id=p_session AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='shared_meter'
  WHERE o.id=p_org AND o.feature_flags->'shared_meter'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) THEN
  RETURN NULL;
 END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active' FOR SHARE;
 IF member_role IS NULL OR member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.properties p WHERE p.org_id=p_org AND p.id=p_property AND p.archived_at IS NULL) THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_period IS NULL OR extract(day FROM p_period)<>1 OR p_kwh IS NULL OR p_kwh<0 OR p_kwh>=100000000000
   OR (p_amount_minor IS NOT NULL AND (p_amount_minor<0 OR p_amount_minor>1000000000000000)) THEN
  RAISE EXCEPTION 'Invalid shared meter split' USING ERRCODE='22023'; END IF;
 SELECT * INTO cfg FROM app.b109_shared_meter_configs c
 WHERE c.org_id=p_org AND c.property_id=p_property AND c.effective_from<=p_period
 ORDER BY c.effective_from DESC,c.revision DESC LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','none','period',p_period::text); END IF;
 period_end:=(p_period + interval '1 month' - interval '1 day')::date;
 total_milli:=round(p_kwh*1000)::bigint;
 -- Per selected space still present, in display order (ord 1 = the first space): its weight, or why it has none.
 -- 依分表度數 resolves exactly ONE property-scoped active electricity meter per space (a room's own meter, or a
 -- whole unit's main meter) and reads both endpoints from that meter only: its latest reading inside the
 -- period and its latest reading before it. No meter, two or more meters, a missing endpoint, an estimated
 -- endpoint or a negative difference makes the split not ready (never guessed).
 SELECT coalesce(jsonb_agg(jsonb_build_object('ord',w.ord,'id',w.id,'kind',w.kind,'unitLabel',w.unit_label,
   'label',w.room_label,'weight',w.weight,'problem',w.problem) ORDER BY w.ord),'[]'::jsonb) INTO spaces
 FROM (SELECT v.ord,v.id,v.kind,v.unit_label,v.room_label,
   CASE WHEN cfg.split_method='even' THEN 1::numeric
    WHEN cfg.split_method='days_occupied' THEN v.days
    WHEN v.meters=1 AND e.value IS NOT NULL AND s.value IS NOT NULL AND NOT e.is_estimate AND NOT s.is_estimate
     AND e.value>=s.value THEN e.value-s.value END AS weight,
   CASE WHEN cfg.split_method<>'sub_meter' THEN NULL
    WHEN v.meters>1 THEN 'ambiguous_meter'
    WHEN v.meters=0 OR e.value IS NULL OR s.value IS NULL OR e.value<s.value THEN 'missing_reading'
    WHEN e.is_estimate OR s.is_estimate THEN 'estimated_reading' END AS problem
  FROM (SELECT row_number() OVER (ORDER BY x.unit_label,x.room_label NULLS FIRST,x.id) ord,x.id,x.kind,x.unit_label,x.room_label,
    coalesce((SELECT sum(greatest(0,
       least(coalesce(l.end_date,period_end),period_end) - greatest(l.start_date,p_period) + 1))
      FROM public.leases l
      WHERE l.org_id=p_org AND l.property_id=p_property AND l.status::text IN ('active','ended','terminated')
       AND ((x.kind='room' AND l.target_room_id=x.id) OR (x.kind='whole_unit' AND l.target_unit_id=x.id))
       AND l.start_date<=period_end AND coalesce(l.end_date,period_end)>=p_period),0)::numeric AS days,
    (SELECT count(*) FROM public.meters mt
      WHERE mt.org_id=p_org AND mt.property_id=p_property AND mt.utility::text='electricity' AND mt.archived_at IS NULL
       AND ((x.kind='room' AND mt.room_id=x.id) OR (x.kind='whole_unit' AND mt.unit_id=x.id AND mt.room_id IS NULL))) AS meters,
    (SELECT mt.id FROM public.meters mt
      WHERE mt.org_id=p_org AND mt.property_id=p_property AND mt.utility::text='electricity' AND mt.archived_at IS NULL
       AND ((x.kind='room' AND mt.room_id=x.id) OR (x.kind='whole_unit' AND mt.unit_id=x.id AND mt.room_id IS NULL))
      ORDER BY mt.id LIMIT 1) AS meter_id
   FROM (SELECT r.id,'room' kind,u.label unit_label,r.label room_label FROM public.rooms r
          JOIN public.units u ON u.org_id=r.org_id AND u.id=r.unit_id
         WHERE u.org_id=p_org AND u.property_id=p_property AND u.rental_mode::text='by_room'
          AND u.archived_at IS NULL AND r.archived_at IS NULL
         UNION ALL
         SELECT u.id,'whole_unit',u.label,NULL FROM public.units u
         WHERE u.org_id=p_org AND u.property_id=p_property AND u.rental_mode::text='whole_unit' AND u.archived_at IS NULL) x
   WHERE x.id = ANY(cfg.space_ids)) v
  LEFT JOIN LATERAL (SELECT mr.value,mr.is_estimate FROM public.meter_readings mr
    WHERE mr.org_id=p_org AND mr.meter_id=v.meter_id AND v.meters=1 AND mr.read_on BETWEEN p_period AND period_end
     AND NOT EXISTS (SELECT 1 FROM public.meter_readings sup WHERE sup.org_id=mr.org_id AND sup.supersedes_id=mr.id)
    ORDER BY mr.read_on DESC,mr.created_at DESC,mr.id DESC LIMIT 1) e ON true
  LEFT JOIN LATERAL (SELECT mr.value,mr.is_estimate FROM public.meter_readings mr
    WHERE mr.org_id=p_org AND mr.meter_id=v.meter_id AND v.meters=1 AND mr.read_on<p_period
     AND NOT EXISTS (SELECT 1 FROM public.meter_readings sup WHERE sup.org_id=mr.org_id AND sup.supersedes_id=mr.id)
    ORDER BY mr.read_on DESC,mr.created_at DESC,mr.id DESC LIMIT 1) s ON true) w;
 IF jsonb_array_length(spaces)=0 THEN RETURN jsonb_build_object('status','none','period',p_period::text); END IF;
 -- Not ready: one status by precedence (ambiguous > missing > estimated), and EVERY space with any problem,
 -- each with its own kind, in display order.
 FOR problem IN SELECT unnest(ARRAY['ambiguous_meter','missing_reading','estimated_reading']) LOOP
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(spaces) e WHERE e->>'problem'=problem) THEN
   RETURN jsonb_build_object('status',CASE problem WHEN 'ambiguous_meter' THEN 'ambiguous_meters'
     WHEN 'missing_reading' THEN 'missing_readings' ELSE 'estimated_readings' END,
    'period',p_period::text,'revision',cfg.revision,
    'spaces',(SELECT jsonb_agg(jsonb_build_object('id',e->'id','problem',e->'problem') ORDER BY (e->>'ord')::integer)
      FROM jsonb_array_elements(spaces) e WHERE e->>'problem' IS NOT NULL));
  END IF;
 END LOOP;
 SELECT sum((e->>'weight')::numeric) INTO total_weight FROM jsonb_array_elements(spaces) e;
 WITH base AS (
  SELECT (e->>'ord')::integer ord,e,
   CASE WHEN total_weight=0 THEN 1::numeric ELSE (e->>'weight')::numeric END w,
   CASE WHEN total_weight=0 THEN jsonb_array_length(spaces)::numeric ELSE total_weight END tw
  FROM jsonb_array_elements(spaces) e
 ), shares AS (
  -- div() is exact integer division (all values are non-negative): numeric "/" rounds to a finite scale first and
  -- can round a share up, moving a unit of the remainder away from the first space.
  SELECT b.*,div(total_milli*b.w,b.tw)::bigint milli,
   CASE WHEN p_amount_minor IS NULL THEN NULL ELSE div(p_amount_minor*b.w,b.tw)::bigint END amount
  FROM base b
 ), fixed AS (
  SELECT s.ord,s.e,s.w,
   s.milli + CASE WHEN s.ord=1 THEN total_milli-(SELECT sum(x.milli) FROM shares x) ELSE 0 END milli,
   CASE WHEN p_amount_minor IS NULL THEN NULL
    ELSE s.amount + CASE WHEN s.ord=1 THEN p_amount_minor-(SELECT sum(x.amount) FROM shares x) ELSE 0 END END amount
  FROM shares s
 )
 SELECT jsonb_agg(jsonb_build_object('id',f.e->'id','kind',f.e->'kind','unitLabel',f.e->'unitLabel','label',f.e->'label',
   'weight',f.w::text,'kwh',(f.milli::numeric/1000)::numeric(14,3)::text,'amountMinor',f.amount::text) ORDER BY f.ord)
 INTO rows FROM fixed f;
 RETURN jsonb_build_object('status','ready','period',p_period::text,'revision',cfg.revision,'method',cfg.split_method,
  'effectiveFrom',cfg.effective_from::text,'startReading',cfg.start_reading::text,
  'kwh',(total_milli::numeric/1000)::numeric(14,3)::text,'amountMinor',p_amount_minor::text,'rows',rows);
END $$;
REVOKE ALL ON FUNCTION app.b109_shared_meter_split(uuid,uuid,text,uuid,uuid,date,numeric,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b109_shared_meter_split(uuid,uuid,text,uuid,uuid,date,numeric,bigint) TO service_role;
COMMIT;
