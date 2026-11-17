-- B-109b (PR-036 = a, Ron 2026-11-16 「Agree on rec」; GS-53 = A; MGT-90-AC4…AC6): apply the B-109 shared-meter split
-- to utility runs for ONE by-room unit. Fix-forward, additive: no table, grant, policy or data change.
--  * app.b109_split_shares: the ONE split rule (exact div(), remainder to the first, all-zero weights split evenly),
--    pure (no table access), shared by the preview and posting.
--  * app.b109_shared_meter_split is replaced in place (same signature, ACL kept): its shares come from
--    app.b109_split_shares, and 依分表度數 prefers the typed reading of a utility run of the space's unit in that
--    period (what posting uses); without a run it keeps the meter_readings rule.
--  * app.b109b_run_config: for a utility run (unit + period), the revision in effect at the period start and whether
--    it applies (only live rooms of this one by-room unit), names an archived or missing room, spans units, or names
--    a whole unit; whether this is the revision's first period for the unit (no live run of any other period on or
--    after its effective date); and the unit main meter's in-period reading.
--    Lock order (B-091 r2 pattern): every row the decision reads is locked first, as id-ordered locked sets; the
--    full admission runs last, on the locked rows only, and requires each locked set to equal the current one.
-- Posting (utility-posting.ts) splits the unit's shared kWh (total minus room meters) among the selected rooms
-- instead of PUBLIC_POWER_RULE when shared_meter is ON, in every mode through app.b109b_run_config and its blocks;
-- OFF is unchanged. Issued bills never change.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- p_weights: [{id, weight}] in display order (weight >= 0). Returns [{id, weight, milli, amount}] in the same order:
-- each share floored with div(), the remainder to the first; all weights zero split evenly. NULL p_amount: no amount.
CREATE FUNCTION app.b109_split_shares(p_weights jsonb,p_total bigint,p_amount bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n integer; total_weight numeric; result jsonb;
BEGIN
 IF p_weights IS NULL OR jsonb_typeof(p_weights)<>'array' OR jsonb_array_length(p_weights)=0
   OR p_total IS NULL OR p_total<0 OR (p_amount IS NOT NULL AND p_amount<0)
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_weights) e
     WHERE jsonb_typeof(e)<>'object' OR NOT (e ? 'id') OR jsonb_typeof(e->'weight') IS DISTINCT FROM 'number' OR (e->>'weight')::numeric<0) THEN
  RAISE EXCEPTION 'Invalid split weights' USING ERRCODE='22023';
 END IF;
 n:=jsonb_array_length(p_weights);
 SELECT sum((e->>'weight')::numeric) INTO total_weight FROM jsonb_array_elements(p_weights) e;
 WITH base AS (
  SELECT o.k ord,o.e,
   CASE WHEN total_weight=0 THEN 1::numeric ELSE (o.e->>'weight')::numeric END w,
   CASE WHEN total_weight=0 THEN n::numeric ELSE total_weight END tw
  FROM jsonb_array_elements(p_weights) WITH ORDINALITY AS o(e,k)
 ), shares AS (
  SELECT b.*,div(p_total*b.w,b.tw)::bigint milli,
   CASE WHEN p_amount IS NULL THEN NULL ELSE div(p_amount*b.w,b.tw)::bigint END amount
  FROM base b
 )
 SELECT jsonb_agg(jsonb_build_object('id',s.e->'id','weight',s.w::text,
   'milli',(s.milli + CASE WHEN s.ord=1 THEN p_total-(SELECT sum(x.milli) FROM shares x) ELSE 0 END)::text,
   'amount',CASE WHEN p_amount IS NULL THEN NULL
     ELSE (s.amount + CASE WHEN s.ord=1 THEN p_amount-(SELECT sum(x.amount) FROM shares x) ELSE 0 END)::text END) ORDER BY s.ord)
 INTO result FROM shares s;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b109_split_shares(jsonb,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b109_split_shares(jsonb,bigint,bigint) TO service_role;

CREATE OR REPLACE FUNCTION app.b109_shared_meter_split(p_org uuid,p_live uuid,p_env text,p_session uuid,p_property uuid,
 p_period date,p_kwh numeric,p_amount_minor bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; cfg record; period_end date; month_end date; total_milli bigint;
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
 month_end:=period_end;
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
    -- B-109b: a utility run of the space's unit in this period wins: its typed reading is what posting uses.
    WHEN t.run_id IS NOT NULL THEN CASE WHEN t.kwh>=0 THEN t.kwh END
    WHEN v.meters=1 AND e.value IS NOT NULL AND s.value IS NOT NULL AND NOT e.is_estimate AND NOT s.is_estimate
     AND e.value>=s.value THEN e.value-s.value END AS weight,
   CASE WHEN cfg.split_method<>'sub_meter' THEN NULL
    WHEN t.run_id IS NOT NULL THEN CASE WHEN t.kwh IS NULL OR t.kwh<0 THEN 'missing_reading' END
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
    ORDER BY mr.read_on DESC,mr.created_at DESC,mr.id DESC LIMIT 1) s ON true
  LEFT JOIN LATERAL (SELECT r.id run_id,
     (SELECT (x->>'kwh')::numeric FROM jsonb_array_elements(coalesce(r.inputs->'readings','[]'::jsonb)) x
       WHERE x->>'spaceId'=v.id::text AND x->>'method' IN ('submeter','by_reading') LIMIT 1) kwh
    FROM public.utility_allocation_runs r
    -- month_end, not period_end: utility_allocation_runs has its own period_end column.
    WHERE r.org_id=p_org AND r.status::text<>'void' AND r.period_start BETWEEN p_period AND month_end
     AND r.unit_id=(CASE WHEN v.kind='room' THEN (SELECT rm.unit_id FROM public.rooms rm WHERE rm.org_id=p_org AND rm.id=v.id) ELSE v.id END)
    ORDER BY r.computed_at DESC,r.id DESC LIMIT 1) t ON cfg.split_method='sub_meter') w;
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
 -- The one split rule (shared with B-109b posting): app.b109_split_shares, exact div(), remainder to the first.
 SELECT jsonb_agg(jsonb_build_object('id',sp->'id','kind',sp->'kind','unitLabel',sp->'unitLabel','label',sp->'label',
   'weight',sh->>'weight','kwh',((sh->>'milli')::numeric/1000)::numeric(14,3)::text,'amountMinor',sh->>'amount') ORDER BY o.n)
 INTO rows
 FROM jsonb_array_elements(app.b109_split_shares(
   (SELECT jsonb_agg(jsonb_build_object('id',e->'id','weight',(e->>'weight')::numeric) ORDER BY (e->>'ord')::integer) FROM jsonb_array_elements(spaces) e),
   total_milli,p_amount_minor)) WITH ORDINALITY AS o(sh,n)
 JOIN LATERAL (SELECT e AS sp FROM jsonb_array_elements(spaces) e WHERE e->'id'=o.sh->'id') q ON true;
 RETURN jsonb_build_object('status','ready','period',p_period::text,'revision',cfg.revision,'method',cfg.split_method,
  'effectiveFrom',cfg.effective_from::text,'startReading',cfg.start_reading::text,
  'kwh',(total_milli::numeric/1000)::numeric(14,3)::text,'amountMinor',p_amount_minor::text,'rows',rows);
END $$;

-- For one utility run (a unit and its period): NULL when shared_meter is OFF. Otherwise, from the revision in effect
-- at the PERIOD START (a period starting before its effective date is not governed by it, even if it ends after):
--  {status:none}               no revision in effect, or it names nothing of this unit;
--  {status:unavailable_rooms}  it names a room of this unit that is archived, or an id that no longer exists;
--  {status:multi_unit}         it also names spaces of another unit;
--  {status:whole_unit}         it names this unit as a whole unit (or this unit is not rented by room);
--  {status:applies, revision, method, effectiveFrom, spaceIds (EVERY selected room of this unit, display order),
--   startReading, firstPeriod, mainReading}.
-- Posting blocks on unavailable_rooms, multi_unit and whole_unit (never a silent PUBLIC_POWER_RULE fallback).
-- firstPeriod: no live (non-void) run of this unit for any OTHER period starting on or after the revision's
-- effective date, earlier or later; only then may the starting reading seed the total. mainReading: the unit main
-- meter's latest in-period reading (any period), or null. Staff admin/manager only (as posting).
CREATE FUNCTION app.b109b_run_config(p_org uuid,p_live uuid,p_env text,p_session uuid,p_unit uuid,
 p_period_start date,p_period_end date)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target uuid; actor uuid; member_role text; locked_role text; u record; cfg record; inside uuid[]; outside integer;
 missing integer; archived integer; whole boolean; first_period boolean; main jsonb; locked_orgs integer; locked_flag integer;
 locked_props integer; locked_cfgs uuid[]; locked_rooms uuid[]; locked_meters uuid[]; named uuid[]; locked_named_rooms uuid[];
 locked_named_units uuid[]; locked_runs uuid[];
BEGIN
 IF p_unit IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<p_period_start THEN
  RAISE EXCEPTION 'Invalid shared meter run' USING ERRCODE='22023'; END IF;
 -- Row locks, every wait here (B-091 r2 / B-065 pattern): the session, the actor's membership, both orgs, the flag
 -- row, the unit and its property, then the locked SETS the decision reads, each aggregated in id order: the
 -- property's revisions, the unit's rooms, every room and unit any of those revisions names, the unit's main meters
 -- and the unit's live runs. Nothing below waits.
 SELECT x.user_id INTO target FROM public.auth_sessions x WHERE x.id=p_session FOR SHARE;
 SELECT m.role::text INTO locked_role FROM public.org_members m
  WHERE m.org_id=p_org AND m.user_id=target AND m.status::text='active' FOR SHARE;
 SELECT count(*) INTO locked_orgs FROM (SELECT 1 FROM public.organizations o WHERE o.id IN (p_org,p_live) ORDER BY o.id FOR SHARE) z;
 SELECT count(*) INTO locked_flag FROM (SELECT 1 FROM public.platform_settings f WHERE f.key='shared_meter' FOR SHARE) z;
 SELECT un.id,un.property_id,un.rental_mode::text mode INTO u FROM public.units un WHERE un.org_id=p_org AND un.id=p_unit FOR SHARE;
 SELECT count(*) INTO locked_props FROM (SELECT 1 FROM public.properties pr WHERE pr.org_id=p_org AND pr.id=u.property_id FOR SHARE) z;
 SELECT coalesce(array_agg(z.id ORDER BY z.id),'{}') INTO locked_cfgs FROM (SELECT c.id FROM app.b109_shared_meter_configs c
  WHERE c.org_id=p_org AND c.property_id=u.property_id ORDER BY c.id FOR SHARE) z;
 SELECT coalesce(array_agg(z.id ORDER BY z.id),'{}') INTO locked_rooms FROM (SELECT r.id FROM public.rooms r
  WHERE r.org_id=p_org AND r.unit_id=p_unit ORDER BY r.id FOR SHARE) z;
 SELECT coalesce(array_agg(DISTINCT s ORDER BY s),'{}') INTO named FROM app.b109_shared_meter_configs c, unnest(c.space_ids) s
  WHERE c.org_id=p_org AND c.id=ANY(locked_cfgs);
 SELECT coalesce(array_agg(z.id ORDER BY z.id),'{}') INTO locked_named_rooms FROM (SELECT r.id FROM public.rooms r
  WHERE r.org_id=p_org AND r.id=ANY(named) ORDER BY r.id FOR SHARE) z;
 SELECT coalesce(array_agg(z.id ORDER BY z.id),'{}') INTO locked_named_units FROM (SELECT un.id FROM public.units un
  WHERE un.org_id=p_org AND un.id=ANY(named) ORDER BY un.id FOR SHARE) z;
 SELECT coalesce(array_agg(z.id ORDER BY z.id),'{}') INTO locked_meters FROM (SELECT mt.id FROM public.meters mt
  WHERE mt.org_id=p_org AND mt.unit_id=p_unit AND mt.room_id IS NULL AND mt.utility::text='electricity' AND mt.archived_at IS NULL
  ORDER BY mt.id FOR SHARE) z;
 SELECT coalesce(array_agg(z.id ORDER BY z.id),'{}') INTO locked_runs FROM (SELECT r.id FROM public.utility_allocation_runs r
  WHERE r.org_id=p_org AND r.unit_id=p_unit AND r.status::text<>'void' ORDER BY r.id FOR SHARE) z;
 -- Full admission, after every wait, on the locked rows only.
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
 WHERE x.id=p_session AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp();
 IF actor IS NULL OR actor IS DISTINCT FROM target OR locked_orgs<1 OR locked_flag<>1 THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active';
 IF member_role IS NULL OR member_role IS DISTINCT FROM locked_role OR member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF u.id IS NULL OR locked_props<>1 OR NOT EXISTS (SELECT 1 FROM public.units un
   WHERE un.org_id=p_org AND un.id=p_unit AND un.property_id=u.property_id AND un.rental_mode::text=u.mode) THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='shared_meter'
  WHERE o.id=p_org AND o.feature_flags->'shared_meter'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) THEN
  RETURN NULL;
 END IF;
 -- The locked sets must still be exactly what the same predicates select now: a revision saved, a room added or
 -- moved, a main meter swapped or a run created/voided while this run waited refuses it (retry), never a decision on
 -- rows it did not lock.
 IF (SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') FROM app.b109_shared_meter_configs c
     WHERE c.org_id=p_org AND c.property_id=u.property_id) IS DISTINCT FROM locked_cfgs
   OR (SELECT coalesce(array_agg(r.id ORDER BY r.id),'{}') FROM public.rooms r
     WHERE r.org_id=p_org AND r.unit_id=p_unit) IS DISTINCT FROM locked_rooms
   OR (SELECT coalesce(array_agg(r.id ORDER BY r.id),'{}') FROM public.rooms r
     WHERE r.org_id=p_org AND r.id=ANY(named)) IS DISTINCT FROM locked_named_rooms
   OR (SELECT coalesce(array_agg(un.id ORDER BY un.id),'{}') FROM public.units un
     WHERE un.org_id=p_org AND un.id=ANY(named)) IS DISTINCT FROM locked_named_units
   OR (SELECT coalesce(array_agg(mt.id ORDER BY mt.id),'{}') FROM public.meters mt
     WHERE mt.org_id=p_org AND mt.unit_id=p_unit AND mt.room_id IS NULL AND mt.utility::text='electricity' AND mt.archived_at IS NULL)
     IS DISTINCT FROM locked_meters
   OR (SELECT coalesce(array_agg(r.id ORDER BY r.id),'{}') FROM public.utility_allocation_runs r
     WHERE r.org_id=p_org AND r.unit_id=p_unit AND r.status::text<>'void') IS DISTINCT FROM locked_runs THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 -- The revision in effect at the period start (locked rows only).
 SELECT * INTO cfg FROM app.b109_shared_meter_configs c
 WHERE c.org_id=p_org AND c.id=ANY(locked_cfgs) AND c.effective_from<=p_period_start
 ORDER BY c.effective_from DESC,c.revision DESC LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','none'); END IF;
 -- Every selected room of this unit (archived ones included), in display order; archived ones; ids that no longer
 -- exist; spaces of another unit (rooms elsewhere, or other whole units); this unit named as a whole.
 SELECT array_agg(r.id ORDER BY r.label,r.id),count(*) FILTER (WHERE r.archived_at IS NOT NULL) INTO inside,archived
  FROM public.rooms r WHERE r.org_id=p_org AND r.id=ANY(locked_rooms) AND r.id=ANY(cfg.space_ids);
 SELECT count(*) INTO missing FROM unnest(cfg.space_ids) s
  WHERE NOT (s=ANY(locked_named_rooms)) AND NOT (s=ANY(locked_named_units));
 SELECT count(*) INTO outside FROM unnest(cfg.space_ids) s
  WHERE s<>p_unit AND NOT (s=ANY(locked_rooms)) AND (s=ANY(locked_named_rooms) OR s=ANY(locked_named_units));
 whole:=p_unit = ANY(cfg.space_ids);
 IF inside IS NULL AND NOT whole AND missing=0 THEN RETURN jsonb_build_object('status','none','revision',cfg.revision); END IF;
 IF missing>0 THEN RETURN jsonb_build_object('status','unavailable_rooms','revision',cfg.revision); END IF;
 IF outside>0 THEN RETURN jsonb_build_object('status','multi_unit','revision',cfg.revision); END IF;
 IF whole OR u.mode<>'by_room' THEN RETURN jsonb_build_object('status','whole_unit','revision',cfg.revision); END IF;
 IF archived>0 THEN RETURN jsonb_build_object('status','unavailable_rooms','revision',cfg.revision); END IF;
 -- The first period of this revision for this unit: no live run of the unit for any other period starting on or
 -- after its effective date (a backfill before a later run is not the first period: that run used the baseline).
 first_period:=NOT EXISTS (SELECT 1 FROM public.utility_allocation_runs r
  WHERE r.org_id=p_org AND r.id=ANY(locked_runs) AND r.period_start>=cfg.effective_from
   AND NOT (r.period_start=p_period_start AND r.period_end=p_period_end));
 SELECT jsonb_build_object('value',mr.value::text,'estimated',mr.is_estimate,'readOn',mr.read_on::text) INTO main
 FROM public.meter_readings mr
 WHERE mr.org_id=p_org AND mr.meter_id=ANY(locked_meters) AND cardinality(locked_meters)=1
  AND mr.read_on BETWEEN p_period_start AND p_period_end
  AND NOT EXISTS (SELECT 1 FROM public.meter_readings sup WHERE sup.org_id=mr.org_id AND sup.supersedes_id=mr.id)
 ORDER BY mr.read_on DESC,mr.created_at DESC,mr.id DESC LIMIT 1;
 RETURN jsonb_build_object('status','applies','revision',cfg.revision,'method',cfg.split_method,
  'effectiveFrom',cfg.effective_from::text,'spaceIds',to_jsonb(inside),'startReading',cfg.start_reading::text,
  'firstPeriod',first_period,'mainReading',main);
END $$;
REVOKE ALL ON FUNCTION app.b109b_run_config(uuid,uuid,text,uuid,uuid,date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b109b_run_config(uuid,uuid,text,uuid,uuid,date,date) TO service_role;
COMMIT;
