-- Transaction ownership (including migration history) belongs to the runner.
-- No file-level transaction control or session settings.

-- B-015: additive owner metadata and default-OFF API-role invariants.
-- Lock order: property -> unit -> room -> contact, UUID order within each level.
-- Archive callers retain the existing advisory-before-row protocol. Raw writers
-- take NO advisory locks: both paths serialize on the same parent tuple locks
-- (FOR NO KEY UPDATE, retained until transaction end). A row UPDATE already owns
-- its child tuple before a BEFORE trigger runs; its parent locks use NOWAIT to
-- fail/retry rather than invert this order and deadlock. INSERT/gateway wait in
-- canonical order for each row, then re-read. Opposite-order multi-row INSERT
-- or UPSERT batches can still deadlock (40P01); abort the whole transaction
-- and return the same bounded busy outcome as 55P03, never retry a row alone. No broad table-grant or existing-definer changes.
-- The seal/admission boundary is actual current_user authenticated/anon. Trusted
-- service_role and existing definers keep their existing authority. The archive
-- gateway is service-only, matching the existing server connection trust model;
-- caller-set GUCs alone never authorize calling that gateway.
-- Gateway requires READ COMMITTED so dependency reads after tuple-lock waits
-- see newly committed child rows; old snapshots cannot miss those phantoms.
-- OFF: no row backfill, setting insert, audit receipt, or business mutation.

-- Namespace access is needed by invoker guards under anon; it grants no table
-- access or gateway execution. All new function ACLs are explicit below.
GRANT USAGE ON SCHEMA app TO anon;

ALTER TABLE public.contacts
 ADD COLUMN owner_archived_at timestamptz,
 ADD COLUMN owner_archived_by uuid,
 ADD COLUMN owner_archive_reason text;

CREATE FUNCTION app.b015_archive_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT (SELECT o.feature_flags->'record_archive'='true'::jsonb
  AND f.value->'enabled'='true'::jsonb
  AND CASE WHEN jsonb_typeof(f.value->'allowed_org_ids')='array' THEN
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') item(value)
      WHERE jsonb_typeof(item.value)<>'string' OR (item.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    ELSE false END
  AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
 FROM public.organizations o JOIN public.platform_settings f ON f.key='record_archive' WHERE o.id=p_org) IS TRUE
$$;
REVOKE ALL ON FUNCTION app.b015_archive_enabled(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_archive_enabled(uuid) TO anon,authenticated,service_role;

-- Invoker: row visibility remains governed by existing RLS. Missing/hidden or
-- cross-org ancestry fails positively; an absent row is never permission.
CREATE FUNCTION app.b015_archive_lock_path(p_org uuid,p_property uuid,p_unit uuid,p_room uuid,p_contact uuid,p_active boolean,p_nowait boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.properties; u public.units; r public.rooms; c public.contacts;
BEGIN
 IF p_property IS NOT NULL THEN
  IF p_nowait THEN SELECT * INTO p FROM public.properties WHERE org_id=p_org AND id=p_property FOR NO KEY UPDATE NOWAIT;
  ELSE SELECT * INTO p FROM public.properties WHERE org_id=p_org AND id=p_property FOR NO KEY UPDATE; END IF;
  IF p.id IS NULL OR (p_active AND p.archived_at IS NOT NULL) THEN RAISE EXCEPTION 'Archive parent unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 IF p_unit IS NOT NULL THEN
  IF p_nowait THEN SELECT * INTO u FROM public.units WHERE org_id=p_org AND id=p_unit FOR NO KEY UPDATE NOWAIT;
  ELSE SELECT * INTO u FROM public.units WHERE org_id=p_org AND id=p_unit FOR NO KEY UPDATE; END IF;
  IF u.id IS NULL OR u.property_id IS DISTINCT FROM p_property OR (p_active AND u.archived_at IS NOT NULL) THEN RAISE EXCEPTION 'Archive parent unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 IF p_room IS NOT NULL THEN
  IF p_nowait THEN SELECT * INTO r FROM public.rooms WHERE org_id=p_org AND id=p_room FOR NO KEY UPDATE NOWAIT;
  ELSE SELECT * INTO r FROM public.rooms WHERE org_id=p_org AND id=p_room FOR NO KEY UPDATE; END IF;
  IF r.id IS NULL OR r.unit_id IS DISTINCT FROM p_unit OR (p_active AND (r.archived_at IS NOT NULL OR u.rental_mode<>'by_room')) THEN RAISE EXCEPTION 'Archive parent unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 IF p_contact IS NOT NULL THEN
  IF p_nowait THEN SELECT * INTO c FROM public.contacts WHERE org_id=p_org AND id=p_contact FOR NO KEY UPDATE NOWAIT;
  ELSE SELECT * INTO c FROM public.contacts WHERE org_id=p_org AND id=p_contact FOR NO KEY UPDATE; END IF;
  IF c.id IS NULL OR NOT c.is_owner OR (p_active AND (c.owner_archived_at IS NOT NULL OR c.archived_at IS NOT NULL)) THEN RAISE EXCEPTION 'Archive owner unavailable' USING ERRCODE='23514'; END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.b015_archive_lock_path(uuid,uuid,uuid,uuid,uuid,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_archive_lock_path(uuid,uuid,uuid,uuid,uuid,boolean,boolean) TO anon,authenticated,service_role;

-- Ticket writers include maintenance staff and tenants who can read ancestry
-- but cannot UPDATE it. This lock-only definer grants no business mutation or
-- new table policy: ticket INSERT/UPDATE still undergoes its existing RLS.
CREATE FUNCTION app.b015_archive_lock_ticket(p_org uuid,p_property uuid,p_unit uuid,p_room uuid,p_lease uuid,p_nowait boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF app.b015_archive_enabled(p_org) IS NOT TRUE THEN RETURN; END IF;
 IF NOT (app.has_role(p_org,ARRAY['admin','manager','maintenance']::public.org_role[]) OR
   EXISTS(SELECT 1 FROM public.leases l WHERE l.org_id=p_org AND l.id=p_lease
    AND l.property_id=p_property AND l.unit_id IS NOT DISTINCT FROM p_unit AND l.target_room_id IS NOT DISTINCT FROM p_room
    AND app.is_lease_tenant(l.id)))
 THEN RAISE EXCEPTION 'Archive ticket authority unavailable' USING ERRCODE='42501'; END IF;
 PERFORM app.b015_archive_lock_path(p_org,p_property,p_unit,p_room,NULL,true,p_nowait);
 -- Recheck membership/lease association after any tuple-lock wait.
 IF NOT (app.has_role(p_org,ARRAY['admin','manager','maintenance']::public.org_role[]) OR
   EXISTS(SELECT 1 FROM public.leases l WHERE l.org_id=p_org AND l.id=p_lease
    AND l.property_id=p_property AND l.unit_id IS NOT DISTINCT FROM p_unit AND l.target_room_id IS NOT DISTINCT FROM p_room
    AND app.is_lease_tenant(l.id)))
 THEN RAISE EXCEPTION 'Archive ticket authority unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b015_archive_lock_ticket(uuid,uuid,uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_archive_lock_ticket(uuid,uuid,uuid,uuid,uuid,boolean) TO anon,authenticated,service_role;

CREATE FUNCTION app.b015_archive_marker_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE changed boolean;
BEGIN
 IF current_user NOT IN ('authenticated','anon') THEN RETURN NEW; END IF;
 IF app.b015_archive_enabled(NEW.org_id) IS NOT TRUE AND
    (TG_OP='INSERT' OR app.b015_archive_enabled(OLD.org_id) IS NOT TRUE) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='contacts' THEN
  IF TG_OP='INSERT' THEN changed:=NEW.owner_archived_at IS NOT NULL OR NEW.owner_archived_by IS NOT NULL OR NEW.owner_archive_reason IS NOT NULL;
  ELSE changed:=ROW(NEW.owner_archived_at,NEW.owner_archived_by,NEW.owner_archive_reason) IS DISTINCT FROM ROW(OLD.owner_archived_at,OLD.owner_archived_by,OLD.owner_archive_reason); END IF;
 ELSE
  IF TG_OP='INSERT' THEN changed:=NEW.archived_at IS NOT NULL;
  ELSE changed:=NEW.archived_at IS DISTINCT FROM OLD.archived_at; END IF;
 END IF;
 IF changed THEN RAISE EXCEPTION 'Use the archive gateway' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b015_archive_marker_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b015_archive_marker BEFORE INSERT OR UPDATE ON public.properties FOR EACH ROW EXECUTE FUNCTION app.b015_archive_marker_guard();
CREATE TRIGGER b015_archive_marker BEFORE INSERT OR UPDATE ON public.units FOR EACH ROW EXECUTE FUNCTION app.b015_archive_marker_guard();
CREATE TRIGGER b015_archive_marker BEFORE INSERT OR UPDATE ON public.rooms FOR EACH ROW EXECUTE FUNCTION app.b015_archive_marker_guard();
CREATE TRIGGER b015_archive_marker BEFORE INSERT OR UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION app.b015_archive_marker_guard();

CREATE FUNCTION app.b015_archive_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v_property uuid; v_unit uuid; v_room uuid; v_contact uuid; v_mode text; v_parent uuid; v_source_property uuid; v_destination_property uuid; v_locked_unit public.units;
BEGIN
 IF current_user NOT IN ('authenticated','anon') THEN RETURN NEW; END IF;
 IF app.b015_archive_enabled(NEW.org_id) IS NOT TRUE AND
    (TG_OP='INSERT' OR app.b015_archive_enabled(OLD.org_id) IS NOT TRUE) THEN RETURN NEW; END IF;
 -- Only failures inside the positively enabled admission block carry the tag.
 BEGIN
 IF TG_OP='UPDATE' AND NEW.org_id IS DISTINCT FROM OLD.org_id THEN RAISE EXCEPTION 'Archive scope changed' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='units' THEN
  IF TG_OP='UPDATE' AND ROW(NEW.property_id,NEW.rental_mode) IS NOT DISTINCT FROM ROW(OLD.property_id,OLD.rental_mode) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.property_id IS DISTINCT FROM OLD.property_id THEN
   -- The UPDATE owns the unit tuple already. Never wait for either parent.
   -- Reject even historical dependencies: their stored property must not drift.
   FOR v_parent IN SELECT id FROM public.properties WHERE org_id=NEW.org_id AND id IN (OLD.property_id,NEW.property_id) ORDER BY id LOOP
    PERFORM app.b015_archive_lock_path(NEW.org_id,v_parent,NULL,NULL,NULL,true,true);
   END LOOP;
   IF OLD.archived_at IS NOT NULL OR
      EXISTS(SELECT 1 FROM public.rooms WHERE org_id=NEW.org_id AND unit_id=OLD.id) OR
      EXISTS(SELECT 1 FROM public.leases WHERE org_id=NEW.org_id AND unit_id=OLD.id) OR
      EXISTS(SELECT 1 FROM public.maintenance_tickets WHERE org_id=NEW.org_id AND unit_id=OLD.id) OR
      EXISTS(SELECT 1 FROM public.meters WHERE org_id=NEW.org_id AND unit_id=OLD.id) OR
      EXISTS(SELECT 1 FROM public.expenses WHERE org_id=NEW.org_id AND unit_id=OLD.id) OR
      EXISTS(SELECT 1 FROM public.listing_terms WHERE org_id=NEW.org_id AND unit_id=OLD.id) OR
      EXISTS(SELECT 1 FROM public.utility_allocation_runs WHERE org_id=NEW.org_id AND unit_id=OLD.id)
   THEN RAISE EXCEPTION 'Restore or resolve unit dependencies before moving' USING ERRCODE='23514'; END IF;
  END IF;
  v_property:=NEW.property_id;
 ELSIF TG_TABLE_NAME='rooms' THEN
  IF TG_OP='UPDATE' AND NEW.unit_id IS NOT DISTINCT FROM OLD.unit_id THEN RETURN NEW; END IF;
  v_unit:=NEW.unit_id;
  SELECT property_id INTO v_property FROM public.units WHERE org_id=NEW.org_id AND id=v_unit;
  IF v_property IS NULL THEN RAISE EXCEPTION 'Archive parent unavailable' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   -- The UPDATE already owns the room tuple. Lock ALL properties before ALL
   -- units, in UUID order with NOWAIT, then validate the discovered paths.
   v_destination_property:=v_property;
   SELECT property_id INTO v_source_property FROM public.units WHERE org_id=NEW.org_id AND id=OLD.unit_id;
   IF v_source_property IS NULL OR OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Restore room ancestry before moving' USING ERRCODE='23514';
   END IF;
   FOR v_parent IN SELECT DISTINCT id FROM unnest(ARRAY[v_source_property,v_destination_property]) AS parents(id) ORDER BY id LOOP
    PERFORM app.b015_archive_lock_path(NEW.org_id,v_parent,NULL,NULL,NULL,true,true);
   END LOOP;
   FOR v_parent IN SELECT DISTINCT id FROM unnest(ARRAY[OLD.unit_id,NEW.unit_id]) AS units(id) ORDER BY id LOOP
    SELECT * INTO v_locked_unit FROM public.units WHERE org_id=NEW.org_id AND id=v_parent FOR NO KEY UPDATE NOWAIT;
    IF v_locked_unit.id IS NULL OR v_locked_unit.archived_at IS NOT NULL OR
       v_locked_unit.property_id IS DISTINCT FROM (CASE WHEN v_parent=OLD.unit_id THEN v_source_property ELSE v_destination_property END)
    THEN RAISE EXCEPTION 'Restore room ancestry before moving' USING ERRCODE='23514'; END IF;
   END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME='leases' THEN
  IF NEW.status NOT IN ('active','pending_signature') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.status,NEW.property_id,NEW.unit_id,NEW.target_unit_id,NEW.target_room_id) IS NOT DISTINCT FROM ROW(OLD.status,OLD.property_id,OLD.unit_id,OLD.target_unit_id,OLD.target_room_id) THEN RETURN NEW; END IF;
  v_property:=NEW.property_id; v_unit:=NEW.unit_id; v_room:=NEW.target_room_id;
  IF NEW.target_unit_id IS NOT NULL AND NEW.target_unit_id IS DISTINCT FROM v_unit THEN RAISE EXCEPTION 'Archive target mismatch' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='maintenance_tickets' THEN
  IF NEW.status NOT IN ('open','triaged','assigned','in_progress','on_hold') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.status,NEW.property_id,NEW.unit_id,NEW.room_id) IS NOT DISTINCT FROM ROW(OLD.status,OLD.property_id,OLD.unit_id,OLD.room_id) THEN RETURN NEW; END IF;
  v_property:=NEW.property_id; v_unit:=NEW.unit_id; v_room:=NEW.room_id;
  -- A room with omitted unit is legal in the legacy schema; resolve it here
  -- so the nullable composite FK cannot bypass unit/room admission.
  IF v_room IS NOT NULL AND v_unit IS NULL THEN
   SELECT unit_id INTO v_unit FROM public.rooms WHERE org_id=NEW.org_id AND id=v_room;
   IF v_unit IS NULL THEN RAISE EXCEPTION 'Archive parent unavailable' USING ERRCODE='23514'; END IF;
   NEW.unit_id:=v_unit;
  END IF;
 ELSIF TG_TABLE_NAME='property_owners' THEN
  IF TG_OP='UPDATE' AND ROW(NEW.property_id,NEW.owner_contact_id,NEW.effective_from,NEW.effective_to) IS NOT DISTINCT FROM ROW(OLD.property_id,OLD.owner_contact_id,OLD.effective_from,OLD.effective_to) THEN RETURN NEW; END IF;
  -- Ending an existing assignment is history maintenance, never new work.
  IF TG_OP='UPDATE' AND ROW(NEW.property_id,NEW.owner_contact_id,NEW.effective_from) IS NOT DISTINCT FROM ROW(OLD.property_id,OLD.owner_contact_id,OLD.effective_from) AND NEW.effective_to < current_date THEN RETURN NEW; END IF;
  v_property:=NEW.property_id; v_contact:=NEW.owner_contact_id;
 END IF;
 IF TG_TABLE_NAME='maintenance_tickets' THEN
  PERFORM app.b015_archive_lock_ticket(NEW.org_id,v_property,v_unit,v_room,NEW.lease_id,TG_OP='UPDATE');
 ELSE
  PERFORM app.b015_archive_lock_path(NEW.org_id,v_property,v_unit,v_room,v_contact,true,TG_OP='UPDATE');
 END IF;
 IF TG_TABLE_NAME='leases' THEN
  -- The earlier target normalizer reads before our tuple-lock wait. Re-read
  -- both target modes under the retained unit lock, after any waiter commits.
  SELECT rental_mode::text INTO v_mode FROM public.units WHERE org_id=NEW.org_id AND id=v_unit;
  IF (NEW.target_unit_id IS NOT NULL AND v_mode IS DISTINCT FROM 'whole_unit') OR
     (NEW.target_room_id IS NOT NULL AND v_mode IS DISTINCT FROM 'by_room')
  THEN RAISE EXCEPTION 'Archive target mode changed' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
 EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
  -- Preserve SQLSTATE for raw API clients and identify enabled archive work
  -- to the app without another flag query after the failed transaction.
  RAISE EXCEPTION USING ERRCODE=SQLSTATE, MESSAGE='Archive write contention', DETAIL='b015_archive_enabled_contention';
 END;
END $$;
REVOKE ALL ON FUNCTION app.b015_archive_admission() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b015_archive_admission BEFORE INSERT OR UPDATE ON public.units FOR EACH ROW EXECUTE FUNCTION app.b015_archive_admission();
CREATE TRIGGER b015_archive_admission BEFORE INSERT OR UPDATE ON public.rooms FOR EACH ROW EXECUTE FUNCTION app.b015_archive_admission();
-- Run after trg_lease_target_guard resolves omitted property/unit ancestry.
CREATE TRIGGER z_b015_archive_admission BEFORE INSERT OR UPDATE ON public.leases FOR EACH ROW EXECUTE FUNCTION app.b015_archive_admission();
CREATE TRIGGER b015_archive_admission BEFORE INSERT OR UPDATE ON public.property_owners FOR EACH ROW EXECUTE FUNCTION app.b015_archive_admission();

CREATE TRIGGER b015_archive_admission BEFORE INSERT OR UPDATE ON public.maintenance_tickets FOR EACH ROW EXECUTE FUNCTION app.b015_archive_admission();

CREATE FUNCTION app.b015_archive_has_work(p_org uuid,p_kind text,p_property uuid,p_unit uuid,p_room uuid,p_contact uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF p_kind='owner' THEN
  RETURN EXISTS(SELECT 1 FROM public.property_owners po JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id
   WHERE po.org_id=p_org AND po.owner_contact_id=p_contact AND (po.effective_to IS NULL OR po.effective_to>=current_date) AND p.archived_at IS NULL);
 END IF;
 RETURN (
  EXISTS(SELECT 1 FROM public.leases l WHERE l.org_id=p_org AND l.property_id=p_property AND (p_kind::text='property' OR (p_kind='unit' AND l.unit_id=p_unit::uuid) OR (p_kind='room' AND (l.target_room_id=p_room::uuid OR l.target_unit_id=p_unit::uuid))) AND l.status IN ('active','pending_signature')) OR
  EXISTS(SELECT 1 FROM public.leases l JOIN public.esign_cases ec ON ec.org_id=l.org_id AND ec.lease_id=l.id JOIN public.esign_versions ev ON ev.case_id=ec.id WHERE l.org_id=p_org AND l.property_id=p_property AND (p_kind::text='property' OR (p_kind='unit' AND l.unit_id=p_unit::uuid) OR (p_kind='room' AND (l.target_room_id=p_room::uuid OR l.target_unit_id=p_unit::uuid))) AND ev.status IN ('sent','partially_signed')) OR
  EXISTS(SELECT 1 FROM public.maintenance_tickets t WHERE t.org_id=p_org AND t.property_id=p_property AND (p_kind::text='property' OR (p_kind='unit' AND t.unit_id=p_unit::uuid) OR (p_kind='room' AND t.room_id=p_room::uuid)) AND t.status IN ('open','triaged','assigned','in_progress','on_hold')) OR
  EXISTS(SELECT 1 FROM public.maintenance_tickets t JOIN public.repair_vendor_jobs j ON j.org_id=t.org_id AND j.ticket_id=t.id WHERE t.org_id=p_org AND t.property_id=p_property AND (p_kind::text='property' OR (p_kind='unit' AND t.unit_id=p_unit::uuid) OR (p_kind='room' AND t.room_id=p_room::uuid)) AND j.active AND j.reported_at IS NULL AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) OR
  EXISTS(SELECT 1 FROM public.utility_allocation_runs ur JOIN public.units u ON u.org_id=ur.org_id AND u.id=ur.unit_id JOIN public.meters m ON m.org_id=ur.org_id AND m.id=ur.meter_id WHERE ur.org_id=p_org AND (
   (p_kind::text='property' AND (u.property_id=p_property OR m.property_id=p_property OR EXISTS (SELECT 1 FROM public.utility_allocation_lines al LEFT JOIN public.leases l ON l.org_id=al.org_id AND l.id=al.lease_id LEFT JOIN public.rooms ar ON ar.org_id=al.org_id AND ar.id=al.room_id LEFT JOIN public.units au ON au.org_id=ar.org_id AND au.id=ar.unit_id WHERE al.org_id=ur.org_id AND al.run_id=ur.id AND (l.property_id=p_property OR au.property_id=p_property)))) OR
   (p_kind='unit' AND (ur.unit_id=p_unit::uuid OR m.unit_id=p_unit::uuid OR EXISTS (SELECT 1 FROM public.utility_allocation_lines al LEFT JOIN public.leases l ON l.org_id=al.org_id AND l.id=al.lease_id LEFT JOIN public.rooms ar ON ar.org_id=al.org_id AND ar.id=al.room_id WHERE al.org_id=ur.org_id AND al.run_id=ur.id AND (l.unit_id=p_unit::uuid OR ar.unit_id=p_unit::uuid)))) OR
   (p_kind='room' AND (m.room_id=p_room::uuid OR EXISTS (SELECT 1 FROM public.utility_allocation_lines al LEFT JOIN public.leases l ON l.org_id=al.org_id AND l.id=al.lease_id WHERE al.org_id=ur.org_id AND al.run_id=ur.id AND (al.room_id=p_room::uuid OR l.target_room_id=p_room::uuid OR l.target_unit_id=p_unit::uuid))))) AND ur.status IN ('draft','approved'))
 );
END $$;
REVOKE ALL ON FUNCTION app.b015_archive_has_work(uuid,text,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b015_archive_context(p_org uuid,p_live uuid,p_env text,p_session uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  JOIN public.org_members m ON m.org_id=live.id AND m.user_id=auth.uid() AND m.status='active' AND m.role IN ('admin','manager')
  JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=m.user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  WHERE o.id=p_org AND o.environment::text=p_env AND ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (p_env='sandbox' AND o.live_org_id=p_live)))
 THEN RAISE EXCEPTION 'Archive authority unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b015_archive_context(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b015_archive_record(p_org uuid,p_live uuid,p_env text,p_session uuid,p_kind text,p_id uuid,p_archived boolean,p_xmin text,p_reason text,p_request uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE v_property uuid; v_unit uuid; v_room uuid; v_contact uuid; v_table text; v_column text; v_xmin text; v_archived timestamptz; v_mode text;
BEGIN
 PERFORM app.b015_archive_context(p_org,p_live,p_env,p_session);
 IF app.b015_archive_enabled(p_org) IS NOT TRUE THEN RETURN 'disabled'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Archive requires read committed' USING ERRCODE='25001'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('property','unit','room','owner') OR p_id IS NULL OR p_archived IS NULL OR p_request IS NULL OR p_xmin IS NULL OR p_reason IS NULL OR length(p_reason)>500 OR p_reason !~ '[^[:space:]]' THEN RAISE EXCEPTION 'Invalid archive command' USING ERRCODE='22023'; END IF;
 IF p_kind='property' THEN v_property:=p_id; v_table:='properties';
 ELSIF p_kind='unit' THEN
  v_unit:=p_id; v_table:='units'; SELECT property_id INTO v_property FROM public.units WHERE org_id=p_org AND id=p_id;
  IF v_property IS NULL THEN RAISE EXCEPTION 'Archive unavailable' USING ERRCODE='42501'; END IF;
 ELSIF p_kind='room' THEN
  v_room:=p_id; v_table:='rooms'; SELECT u.property_id,r.unit_id INTO v_property,v_unit FROM public.rooms r JOIN public.units u ON u.org_id=r.org_id AND u.id=r.unit_id WHERE r.org_id=p_org AND r.id=p_id;
  IF v_property IS NULL THEN RAISE EXCEPTION 'Archive unavailable' USING ERRCODE='42501'; END IF;
 ELSE v_contact:=p_id; v_table:='contacts'; END IF;
 PERFORM app.b015_archive_lock_path(p_org,v_property,v_unit,v_room,v_contact,false);
 PERFORM app.b015_archive_context(p_org,p_live,p_env,p_session);
 IF app.b015_archive_enabled(p_org) IS NOT TRUE THEN RETURN 'disabled'; END IF;
 v_column:=CASE WHEN p_kind='owner' THEN 'owner_archived_at' ELSE 'archived_at' END;
 EXECUTE format('SELECT xmin::text,%I FROM public.%I WHERE org_id=$1 AND id=$2',v_column,v_table) INTO v_xmin,v_archived USING p_org,p_id;
 IF v_xmin IS DISTINCT FROM p_xmin THEN RETURN 'stale'; END IF;
 IF (v_archived IS NOT NULL)=p_archived THEN RETURN 'already_in_desired_state'; END IF;
 IF p_archived THEN
  IF app.b015_archive_has_work(p_org,p_kind,v_property,v_unit,v_room,v_contact) THEN RETURN 'blocked'; END IF;
 ELSE
  IF p_kind='property' THEN
   -- Assignment admission also takes the property before contact locks. Keep
   -- every current owner locked through restore, including retained links.
   FOR v_contact IN SELECT DISTINCT po.owner_contact_id FROM public.property_owners po
    WHERE po.org_id=p_org AND po.property_id=p_id AND (po.effective_to IS NULL OR po.effective_to>=current_date)
    ORDER BY po.owner_contact_id LOOP
    PERFORM 1 FROM public.contacts WHERE org_id=p_org AND id=v_contact FOR NO KEY UPDATE;
    IF EXISTS(SELECT 1 FROM public.contacts WHERE org_id=p_org AND id=v_contact AND (owner_archived_at IS NOT NULL OR archived_at IS NOT NULL)) THEN RETURN 'blocked'; END IF;
   END LOOP;
  END IF;
  IF p_kind IN ('unit','room') AND EXISTS(SELECT 1 FROM public.properties WHERE id=v_property AND archived_at IS NOT NULL) THEN RETURN 'blocked'; END IF;
  IF p_kind='room' THEN
   SELECT rental_mode::text INTO v_mode FROM public.units WHERE org_id=p_org AND id=v_unit AND archived_at IS NULL;
   IF v_mode IS DISTINCT FROM 'by_room' THEN RETURN 'blocked'; END IF;
  END IF;
 END IF;
 PERFORM set_config('app.change_reason',p_reason,true),set_config('app.request_id',p_request::text,true);
 IF p_kind='owner' THEN
  UPDATE public.contacts SET owner_archived_at=CASE WHEN p_archived THEN clock_timestamp() END,
   owner_archived_by=CASE WHEN p_archived THEN auth.uid() END,owner_archive_reason=CASE WHEN p_archived THEN p_reason END WHERE org_id=p_org AND id=p_id;
 ELSE
  EXECUTE format('UPDATE public.%I SET archived_at=CASE WHEN $3 THEN clock_timestamp() END WHERE org_id=$1 AND id=$2',v_table) USING p_org,p_id,p_archived;
 END IF;
 PERFORM app.b015_archive_context(p_org,p_live,p_env,p_session);
 IF app.b015_archive_enabled(p_org) IS NOT TRUE THEN RAISE EXCEPTION 'Archive control changed' USING ERRCODE='42501'; END IF;
 RETURN 'changed';
END $$;
REVOKE ALL ON FUNCTION app.b015_archive_record(uuid,uuid,text,uuid,text,uuid,boolean,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b015_archive_record(uuid,uuid,text,uuid,text,uuid,boolean,text,text,uuid) TO service_role;
