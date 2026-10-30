BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- No backfill: a null basis always retains the historical invoice behavior.
ALTER TABLE public.leases ADD COLUMN first_period_basis jsonb;

-- The only adoption/recapture entry point derives every source and provenance
-- field from the locked lease and authenticated actor. The basis is not an
-- approval record or a statement about the signed PDF.
CREATE FUNCTION app.b008_capture_first_period(p_lease uuid, p_prorate boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_env text;
  v_global jsonb;
  v_flags jsonb;
  v_lease public.leases;
  v_enabled boolean;
  v_basis jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Retry transaction' USING ERRCODE='40001'; END IF;
  IF v_user IS NULL OR p_prorate IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
  BEGIN
    v_org := nullif(current_setting('app.active_org_id',true),'')::uuid;
    v_env := nullif(current_setting('app.env',true),'');
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END;
  IF v_org IS NULL OR v_env NOT IN ('live','sandbox') THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;

  SELECT value INTO v_global FROM public.platform_settings WHERE key='billing_previews' FOR SHARE;
  SELECT o.feature_flags INTO v_flags
    FROM public.organizations o
    JOIN public.organizations live ON live.id=coalesce(o.live_org_id,o.id) AND live.environment='live'
    JOIN public.org_members m ON m.org_id=live.id AND m.user_id=v_user AND m.status='active' AND m.role IN ('admin','manager')
   WHERE o.id=v_org AND o.environment::text=v_env
     AND ((o.environment='live' AND o.id=live.id) OR (o.environment='sandbox' AND o.live_org_id=live.id))
   FOR SHARE OF o,live,m;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
  v_enabled := coalesce(v_global->'enabled'='true'::jsonb,false)
    AND jsonb_typeof(v_global->'allowed_org_ids')='array'
    AND (v_global->'allowed_org_ids') @> jsonb_build_array(v_org::text)
    AND coalesce(v_flags->'billing_previews'='true'::jsonb,false);
  v_enabled := coalesce(v_enabled,false);

  SELECT * INTO v_lease FROM public.leases WHERE id=p_lease AND org_id=v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='42501'; END IF;
  IF NOT v_enabled AND (v_lease.first_period_basis IS NULL OR (v_lease.first_period_basis->'prorateFirstPeriod') IS DISTINCT FROM to_jsonb(p_prorate)) THEN
    RAISE EXCEPTION 'Feature unavailable' USING ERRCODE='42501';
  END IF;
  IF v_lease.rent_frequency::text <> 'monthly' OR v_lease.currency NOT IN ('TWD','USD') THEN
    RAISE EXCEPTION 'Unsupported billing source' USING ERRCODE='23514';
  END IF;
  -- B001 case writers already lock the case, and case creation locks this lease.
  PERFORM 1 FROM public.esign_cases c WHERE c.org_id=v_org AND c.lease_id=p_lease ORDER BY c.id FOR UPDATE;
  -- Existing legacy signature rows can also be updated directly by staff.
  -- New rows' foreign key checks are fenced by the lease lock above.
  PERFORM 1 FROM public.lease_signatures s WHERE s.org_id=v_org AND s.lease_id=p_lease ORDER BY s.id FOR UPDATE;
  IF v_lease.status NOT IN ('draft','pending_signature') OR v_lease.esign_status NOT IN ('not_sent','sent') OR v_lease.signed_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.lease_signatures s WHERE s.lease_id=p_lease AND s.status='signed')
    OR EXISTS (SELECT 1 FROM public.esign_cases c JOIN public.esign_versions v ON v.case_id=c.id JOIN public.esign_signers s ON s.version_id=v.id WHERE c.org_id=v_org AND c.lease_id=p_lease AND s.signed_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.esign_cases c JOIN public.esign_versions v ON v.case_id=c.id JOIN public.esign_signature_images i ON i.version_id=v.id WHERE c.org_id=v_org AND c.lease_id=p_lease)
    -- A disposal tombstone does not prove that no partial signature existed.
    OR EXISTS (SELECT 1 FROM public.esign_disposals d WHERE d.org_id=v_org AND d.lease_id=p_lease)
    OR EXISTS (SELECT 1 FROM public.invoices i WHERE i.org_id=v_org AND i.lease_id=p_lease AND i.source='move_in') THEN
    RAISE EXCEPTION 'Billing source is locked' USING ERRCODE='23514';
  END IF;
  v_basis := jsonb_build_object('version','monthly-30-v1','startDate',v_lease.start_date::text,
    'endDate',v_lease.end_date::text,'monthlyRentMinor',v_lease.rent_amount_minor,
    'currency',btrim(v_lease.currency),'rentFrequency',v_lease.rent_frequency::text,
    'prorateFirstPeriod',p_prorate,'actor',v_user::text,'capturedAt',clock_timestamp());
  UPDATE public.leases SET first_period_basis=v_basis,prorate_first_period=p_prorate WHERE id=p_lease AND org_id=v_org;
  RETURN v_basis;
END $$;
-- This is a private server gateway: an ordinary database role cannot bypass
-- the app's current table-consent and partner-consent checks by calling it.
-- The server's trusted login must own or have an explicit reviewed grant.
REVOKE ALL ON FUNCTION app.b008_capture_first_period(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- SECURITY INVOKER is essential: a SECURITY DEFINER guard would make every
-- caller appear to be its owner. The migration/function owner is trusted.
CREATE FUNCTION app.b008_guard_first_period_basis() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_capture_owner name;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO v_capture_owner FROM pg_proc p WHERE p.oid='app.b008_capture_first_period(uuid,boolean)'::regprocedure;
  IF TG_OP='INSERT' THEN
    IF NEW.first_period_basis IS NOT NULL AND current_user <> v_capture_owner THEN RAISE EXCEPTION 'Billing source is protected' USING ERRCODE='42501'; END IF;
  ELSIF NEW.first_period_basis IS DISTINCT FROM OLD.first_period_basis AND current_user <> v_capture_owner THEN
    RAISE EXCEPTION 'Billing source is protected' USING ERRCODE='42501';
  ELSIF OLD.first_period_basis IS NOT NULL AND current_user <> v_capture_owner AND
    (NEW.prorate_first_period IS DISTINCT FROM OLD.prorate_first_period OR
     NEW.rent_amount_minor IS DISTINCT FROM OLD.rent_amount_minor OR
     NEW.currency IS DISTINCT FROM OLD.currency OR NEW.start_date IS DISTINCT FROM OLD.start_date OR
     NEW.rent_frequency IS DISTINCT FROM OLD.rent_frequency OR
     (OLD.status IN ('draft','pending_signature') AND NEW.end_date IS DISTINCT FROM OLD.end_date)) THEN
    RAISE EXCEPTION 'Billing source is protected' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b008_guard_first_period_basis() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b008_guard_first_period_basis BEFORE INSERT OR UPDATE ON public.leases FOR EACH ROW EXECUTE FUNCTION app.b008_guard_first_period_basis();
COMMIT;
