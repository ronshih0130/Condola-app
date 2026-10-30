BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The database flag is authoritative; an absent or malformed value fails closed.
INSERT INTO public.platform_settings(key, value, description)
VALUES ('payee_details', '{"enabled":false,"allowed_org_ids":[]}'::jsonb, 'Payee details rollout control')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.payee_access_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('settings','tenant','save','assign','ingress')),
  actor_id uuid,
  org_id uuid,
  environment text CHECK (environment IN ('live','sandbox')),
  actor_role text CHECK (actor_role IN ('admin','manager','accountant','maintenance','tenant','unknown')),
  target_id uuid,
  bank_account_id uuid,
  account_last5 text CHECK (account_last5 IS NULL OR account_last5 ~ '^[0-9]{5}$'),
  outcome text NOT NULL CHECK (outcome IN ('allowed','denied','missing')),
  reason text NOT NULL CHECK (reason IN ('ok','unauthenticated','no_context','invalid_context','forbidden','disabled','not_found','invalid_input')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE app.payee_access_log FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE app.payee_access_log_id_seq FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.payee_log_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'payee access log is append-only' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION app.payee_log_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER payee_log_no_change BEFORE UPDATE OR DELETE ON app.payee_access_log
  FOR EACH ROW EXECUTE FUNCTION app.payee_log_immutable();
CREATE TRIGGER payee_log_no_truncate BEFORE TRUNCATE ON app.payee_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.payee_log_immutable();

-- Historical objects stay in place for code/schema compatibility, but no
-- ordinary database role may bypass the audited gateway to read numbers.
REVOKE ALL ON TABLE public.payee_account_numbers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tenant_payee_account(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Direct legacy bank writes remain possible only for non-payee rows. Lock the
-- org before checking references so gateway writes and legacy writes cannot
-- silently race. A concurrent inverse lock order may abort one transaction.
CREATE FUNCTION app.payee_bank_is_protected(p_org uuid, p_account uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', true),'none'), session_user::text) <> 'service_role'
    AND NOT app.is_member(p_org) THEN
    RETURN true;
  END IF;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR UPDATE;
  IF NOT FOUND THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM public.payee_account_numbers WHERE org_id=p_org AND bank_account_id=p_account)
    OR EXISTS (SELECT 1 FROM public.leases WHERE org_id=p_org AND payee_bank_account_id=p_account);
END $$;
REVOKE ALL ON FUNCTION app.payee_bank_is_protected(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.payee_bank_is_protected(uuid,uuid) TO authenticated, service_role;

CREATE FUNCTION app.payee_bank_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user NOT IN ('anon','authenticated','service_role') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_default_payee OR NEW.holder_name IS NOT NULL OR NEW.country_code IS NOT NULL OR NEW.details <> '{}'::jsonb THEN
      RAISE EXCEPTION 'payee account requires gateway' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF app.payee_bank_is_protected(OLD.org_id,OLD.id) OR OLD.is_default_payee OR OLD.holder_name IS NOT NULL THEN
    RAISE EXCEPTION 'payee account requires gateway' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.is_default_payee OR NEW.holder_name IS NOT NULL OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.details IS DISTINCT FROM OLD.details THEN
    RAISE EXCEPTION 'payee account requires gateway' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.payee_bank_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER payee_bank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION app.payee_bank_guard();

-- Preserve ordinary lease updates while preventing assignment from bypassing
-- the gateway. The function owner and database administrators remain trusted.
CREATE FUNCTION app.payee_assignment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_user IN ('anon','authenticated','service_role') AND
    ((TG_OP = 'INSERT' AND NEW.payee_bank_account_id IS NOT NULL) OR
     (TG_OP = 'UPDATE' AND NEW.payee_bank_account_id IS DISTINCT FROM OLD.payee_bank_account_id)) THEN
    RAISE EXCEPTION 'payee assignment requires gateway' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.payee_assignment_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER payee_assignment_guard BEFORE INSERT OR UPDATE OF payee_bank_account_id ON public.leases
  FOR EACH ROW EXECUTE FUNCTION app.payee_assignment_guard();

CREATE FUNCTION app.payee_gateway(
  p_session uuid, p_actor uuid, p_org uuid, p_env text, p_attempt uuid,
  p_op text, p_target uuid, p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_actor uuid;
  v_org public.organizations%ROWTYPE;
  v_role text := 'unknown';
  v_flag jsonb;
  v_reason text := 'ok';
  v_outcome text := 'allowed';
  v_data jsonb;
  v_row record;
  v_lease record;
  v_account record;
  v_owner uuid;
  v_account_id uuid;
  v_number text;
  v_number_key text;
  v_holder text;
  v_bank text;
  v_bank_code text;
  v_branch text;
  v_details jsonb := '{}'::jsonb;
  v_default boolean;
  v_last5 text;
  v_accounts jsonb := '[]'::jsonb;
  v_logged boolean := false;
BEGIN
  -- Inputs here are supplied by the trusted server adapter, never the client.
  -- Invalid attempt/operation is programmer error and cannot produce a row.
  IF p_attempt IS NULL OR p_op NOT IN ('settings','tenant','save','assign','ingress') OR p_op IS NULL THEN
    RAISE EXCEPTION 'invalid payee gateway invocation' USING ERRCODE = '22023';
  END IF;

  SELECT s.user_id INTO v_actor FROM public.auth_sessions s
    WHERE s.id = p_session AND s.user_id = p_actor AND s.revoked_at IS NULL
      AND s.expires_at > now() FOR SHARE;
  IF v_actor IS NULL THEN
    v_reason := 'unauthenticated';
  ELSIF p_input->'invalid' = 'true'::jsonb OR (p_op IN ('tenant','assign') AND p_target IS NULL) THEN
    v_reason := 'invalid_input';
  ELSIF p_org IS NULL OR p_env IS NULL THEN
    v_reason := 'no_context';
  ELSIF p_env NOT IN ('live','sandbox') THEN
    v_reason := 'invalid_context';
  ELSE
    -- Lock rollout configuration before org/lease/account for consistent order.
    SELECT value INTO v_flag FROM public.platform_settings WHERE key = 'payee_details' FOR SHARE;
    SELECT * INTO v_org FROM public.organizations WHERE id = p_org FOR UPDATE;
    IF v_org.id IS NULL OR v_org.environment::text IS DISTINCT FROM p_env THEN
      v_reason := 'invalid_context';
    ELSE
      SELECT m.role::text INTO v_role FROM public.org_members m
        WHERE m.org_id = CASE WHEN v_org.environment::text = 'sandbox' THEN v_org.live_org_id ELSE p_org END
          AND m.user_id = v_actor AND m.status = 'active' FOR SHARE;
      v_role := coalesce(v_role, 'unknown');
      IF p_op = 'ingress' THEN
        v_reason := 'forbidden';
      ELSIF jsonb_typeof(v_flag) IS DISTINCT FROM 'object'
        OR v_flag->'enabled' IS DISTINCT FROM 'true'::jsonb
        OR jsonb_typeof(v_flag->'allowed_org_ids') IS DISTINCT FROM 'array'
        OR NOT (v_flag->'allowed_org_ids' ? p_org::text)
        OR v_org.feature_flags->'payee_details' IS DISTINCT FROM 'true'::jsonb THEN
        IF p_op = 'tenant' THEN
          SELECT l.property_id INTO v_lease FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id
            JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
            WHERE l.id=p_target AND l.org_id=p_org AND c.user_id=v_actor AND c.is_tenant AND c.archived_at IS NULL
            FOR SHARE OF l,lp,c;
          IF NOT FOUND THEN v_reason := 'forbidden';
          ELSE
            v_role := 'tenant';
            -- No protected-number lookup when the flag is off.
            SELECT account_last5::text INTO v_last5 FROM public.bank_accounts
              WHERE org_id = p_org AND archived_at IS NULL AND show_to_tenants
                AND (property_id IS NULL OR property_id = v_lease.property_id)
              ORDER BY created_at, id LIMIT 1;
            v_data := jsonb_build_object('enabled', false, 'last5', v_last5, 'account', NULL);
          END IF;
        ELSE
          v_reason := 'disabled';
        END IF;
      ELSIF p_op <> 'tenant' AND v_role <> 'admin' THEN
        v_reason := 'forbidden';
      END IF;
    END IF;
  END IF;

  IF v_reason = 'ok' AND v_data IS NULL AND p_op = 'tenant' THEN
    -- The caller must be a tenant on the exact lease in the verified org.
    SELECT l.id, l.property_id, l.status, l.start_date, l.end_date, l.payee_bank_account_id
      INTO v_lease FROM public.leases l
      WHERE l.id = p_target AND l.org_id = p_org FOR SHARE;
    PERFORM 1 FROM public.lease_parties lp JOIN public.contacts c ON c.id = lp.contact_id AND c.org_id = lp.org_id
        WHERE lp.org_id = p_org AND lp.lease_id = v_lease.id AND c.user_id = v_actor
          AND c.is_tenant AND c.archived_at IS NULL
        FOR SHARE OF lp,c;
    IF v_lease.id IS NULL OR v_lease.status <> 'active'
      OR v_lease.start_date > current_date OR (v_lease.end_date IS NOT NULL AND v_lease.end_date < current_date)
      OR NOT FOUND THEN
      v_reason := 'forbidden';
    ELSE
      v_role := 'tenant';
      SELECT b.id, b.holder_name, b.bank_name, b.bank_code, b.branch_code,
        n.account_number, b.account_last5::text AS account_last5, b.owner_contact_id, b.details
      INTO v_account FROM public.bank_accounts b
      LEFT JOIN public.payee_account_numbers n ON n.org_id = b.org_id AND n.bank_account_id = b.id
      WHERE b.org_id = p_org AND b.archived_at IS NULL AND b.show_to_tenants
        AND (b.property_id IS NULL OR b.property_id = v_lease.property_id)
        AND ((v_lease.payee_bank_account_id IS NOT NULL AND b.id = v_lease.payee_bank_account_id)
          OR (v_lease.payee_bank_account_id IS NULL AND b.is_default_payee AND b.owner_contact_id IS NULL))
      FOR SHARE OF b;
      IF v_account.id IS NULL OR v_account.account_number IS NULL THEN
        v_outcome := 'missing';
        v_data := jsonb_build_object('enabled', true, 'last5', NULL, 'account', NULL);
      ELSE
        v_data := jsonb_build_object('enabled', true, 'last5', NULL, 'account',
          jsonb_build_object('id',v_account.id,'holder_name',v_account.holder_name,'bank_name',v_account.bank_name,
            'bank_code',v_account.bank_code,'branch_code',v_account.branch_code,'account_number',v_account.account_number,
            'account_last5',v_account.account_last5,'owner_contact_id',CASE WHEN v_account.owner_contact_id IS NULL THEN NULL ELSE 'owner' END,
            'is_default_payee',false,'details',v_account.details));
        v_account_id := v_account.id;
        v_last5 := v_account.account_last5;
      END IF;
    END IF;
  ELSIF v_reason = 'ok' AND v_data IS NULL AND p_op = 'settings' THEN
    FOR v_row IN SELECT b.id, b.holder_name, b.bank_name, b.bank_code, b.branch_code,
        n.account_number, b.account_last5::text AS account_last5, b.owner_contact_id, b.is_default_payee, b.details
      FROM public.bank_accounts b LEFT JOIN public.payee_account_numbers n
        ON n.org_id = b.org_id AND n.bank_account_id = b.id
      WHERE b.org_id = p_org AND b.archived_at IS NULL ORDER BY b.created_at, b.id FOR SHARE OF b
    LOOP
      v_accounts := v_accounts || jsonb_build_array(to_jsonb(v_row));
      INSERT INTO app.payee_access_log(attempt_id,operation,actor_id,org_id,environment,actor_role,target_id,bank_account_id,account_last5,outcome,reason)
        VALUES(p_attempt,p_op,v_actor,p_org,p_env,v_role,p_target,v_row.id,v_row.account_last5,'allowed','ok');
      v_logged := true;
    END LOOP;
    SELECT jsonb_build_object('country',v_org.country_code,'accounts',v_accounts,
      'owners',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'display_name',c.display_name) ORDER BY c.display_name,c.id)
        FROM public.contacts c WHERE c.org_id=p_org AND c.is_owner AND c.archived_at IS NULL),'[]'::jsonb),
      'leases',coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'payee_bank_account_id',l.payee_bank_account_id) ORDER BY l.created_at,l.id)
        FROM public.leases l WHERE l.org_id=p_org),'[]'::jsonb)) INTO v_data;
  ELSIF v_reason = 'ok' AND v_data IS NULL AND p_op = 'assign' THEN
    IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR
      (p_input->'accountId' IS NOT NULL AND p_input->'accountId' <> 'null'::jsonb
        AND (jsonb_typeof(p_input->'accountId') <> 'string' OR (p_input->>'accountId') !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$')) THEN
      v_reason := 'invalid_input';
    ELSE
      v_account_id := nullif(p_input->>'accountId','')::uuid;
      SELECT property_id INTO v_lease FROM public.leases WHERE id=p_target AND org_id=p_org FOR UPDATE;
      IF NOT FOUND THEN v_reason := 'not_found';
      ELSIF v_account_id IS NOT NULL THEN
        PERFORM 1 FROM public.bank_accounts WHERE id=v_account_id AND org_id=p_org AND archived_at IS NULL AND show_to_tenants
          AND (property_id IS NULL OR property_id = v_lease.property_id) FOR SHARE;
        IF NOT FOUND THEN v_reason := 'invalid_input'; END IF;
      END IF;
      IF v_reason = 'ok' THEN
        UPDATE public.leases SET payee_bank_account_id=v_account_id,updated_at=now() WHERE id=p_target AND org_id=p_org;
        v_data := jsonb_build_object('leaseId',p_target,'accountId',v_account_id);
      END IF;
    END IF;
  ELSIF v_reason = 'ok' AND v_data IS NULL AND p_op = 'save' THEN
    IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR jsonb_typeof(p_input->'isDefault') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(p_input->'details') IS DISTINCT FROM 'object' THEN
      v_reason := 'invalid_input';
    ELSE
      v_holder := btrim(p_input->>'holderName'); v_bank := btrim(p_input->>'bankName');
      v_bank_code := btrim(p_input->>'bankCode'); v_branch := btrim(p_input->>'branchCode');
      v_number := btrim(p_input->>'accountNumber'); v_default := (p_input->>'isDefault')::boolean;
      v_number_key := lower(regexp_replace(coalesce(v_number,''),'[^A-Za-z0-9]','','g'));
      IF nullif(p_input->>'ownerContactId','') IS NOT NULL THEN
        IF (p_input->>'ownerContactId') !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' THEN v_reason := 'invalid_input';
        ELSE v_owner := (p_input->>'ownerContactId')::uuid; END IF;
      END IF;
      IF v_holder IS NULL OR length(v_holder) NOT BETWEEN 1 AND 200 OR v_number IS NULL
        OR v_number !~ '^[A-Za-z0-9 -]{1,34}$' OR v_number_key = '' OR (v_default AND v_owner IS NOT NULL)
        OR (v_org.country_code = 'TW' AND (coalesce(v_bank_code,'') !~ '^[0-9]{3}$' OR coalesce(v_branch,'') !~ '^[A-Za-z0-9 -]{1,40}$'))
        OR (v_org.country_code <> 'TW' AND (v_bank IS NULL OR length(v_bank) NOT BETWEEN 1 AND 200))
        OR coalesce(p_input->'details'->>'swift','') !~ '^[A-Za-z0-9 -]{0,100}$'
        OR coalesce(p_input->'details'->>'routing','') !~ '^[A-Za-z0-9 -]{0,100}$' THEN
        v_reason := 'invalid_input';
      END IF;
      IF v_owner IS NOT NULL THEN
        PERFORM 1 FROM public.contacts WHERE id=v_owner AND org_id=p_org AND is_owner AND archived_at IS NULL FOR SHARE;
        IF NOT FOUND THEN v_reason := 'invalid_input'; END IF;
      END IF;
      -- Existing bank_accounts audit records its regular metadata. Prevent a
      -- number from being smuggled into those freely entered metadata fields.
      IF v_number_key <> '' AND EXISTS (
        SELECT 1 FROM unnest(ARRAY[v_holder,v_bank,v_bank_code,v_branch,
          p_input->'details'->>'swift',p_input->'details'->>'routing']) AS field(value)
        WHERE strpos(lower(regexp_replace(coalesce(field.value,''),'[^A-Za-z0-9]','','g')),v_number_key) > 0
      ) THEN v_reason := 'invalid_input'; END IF;
      IF p_target IS NOT NULL THEN
        PERFORM 1 FROM public.bank_accounts WHERE id=p_target AND org_id=p_org AND archived_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN v_reason := 'not_found'; END IF;
      END IF;
      IF v_reason = 'ok' THEN
        PERFORM set_config('request.jwt.claim.sub',v_actor::text,true);
        IF v_org.country_code <> 'TW' THEN
          v_details := jsonb_strip_nulls(jsonb_build_object('swift',nullif(btrim(p_input->'details'->>'swift'),''),'routing',nullif(btrim(p_input->'details'->>'routing'),'')));
          v_bank_code := NULL; v_branch := NULL;
        END IF;
        IF v_default THEN UPDATE public.bank_accounts SET is_default_payee=false,updated_at=now() WHERE org_id=p_org AND is_default_payee AND archived_at IS NULL; END IF;
        v_account_id := coalesce(p_target,gen_random_uuid());
        IF p_target IS NULL THEN
          INSERT INTO public.bank_accounts(id,org_id,nickname,holder_name,bank_name,bank_code,branch_code,country_code,details,owner_contact_id,is_default_payee,currency,show_to_tenants,updated_at)
            VALUES(v_account_id,p_org,v_holder,v_holder,nullif(v_bank,''),v_bank_code,v_branch,v_org.country_code,v_details,v_owner,v_default,v_org.default_currency,true,now());
        ELSE
          UPDATE public.bank_accounts SET holder_name=v_holder,bank_name=nullif(v_bank,''),bank_code=v_bank_code,branch_code=v_branch,country_code=v_org.country_code,details=v_details,owner_contact_id=v_owner,is_default_payee=v_default,show_to_tenants=true,updated_at=now() WHERE id=v_account_id AND org_id=p_org;
        END IF;
        INSERT INTO public.payee_account_numbers(bank_account_id,org_id,account_number,updated_by)
          VALUES(v_account_id,p_org,v_number,v_actor) ON CONFLICT(bank_account_id) DO UPDATE SET account_number=excluded.account_number,updated_by=v_actor;
        v_number := regexp_replace(v_number,'[^0-9]','','g');
        v_last5 := CASE WHEN length(v_number)>=5 THEN right(v_number,5) ELSE NULL END;
        UPDATE public.bank_accounts SET account_last5=v_last5 WHERE id=v_account_id AND org_id=p_org;
        v_data := jsonb_build_object('accountId',v_account_id);
      END IF;
    END IF;
  END IF;

  IF v_reason <> 'ok' THEN v_outcome := 'denied'; v_data := NULL; END IF;
  IF NOT v_logged THEN
    INSERT INTO app.payee_access_log(attempt_id,operation,actor_id,org_id,environment,actor_role,target_id,bank_account_id,account_last5,outcome,reason)
      VALUES(p_attempt,p_op,v_actor,CASE WHEN v_org.id IS NOT NULL AND v_actor IS NOT NULL AND v_org.environment::text = p_env THEN p_org ELSE NULL END,
        CASE WHEN v_org.id IS NOT NULL AND v_actor IS NOT NULL AND v_org.environment::text = p_env THEN p_env ELSE NULL END,
        CASE WHEN v_actor IS NOT NULL THEN v_role ELSE NULL END,p_target,v_account_id,v_last5,v_outcome,v_reason);
  END IF;
  RETURN jsonb_build_object('ok',v_reason='ok','reason',v_reason,'data',v_data);
END $$;

REVOKE ALL ON FUNCTION app.payee_gateway(uuid,uuid,uuid,text,uuid,text,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.payee_gateway(uuid,uuid,uuid,text,uuid,text,uuid,jsonb) TO service_role;
COMMIT;
