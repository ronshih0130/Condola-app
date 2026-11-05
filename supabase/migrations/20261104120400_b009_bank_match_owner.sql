-- Version 20261104120400.
-- Trust only the bank_transactions table-owner login without a role switch.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION app.b009_direct_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_login text := session_user::text;
  v_active text := coalesce(nullif(current_setting('role', true), 'none'), v_login);
  v_owner text := pg_get_userbyid((
    SELECT c.relowner FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'bank_transactions'
  ));
  v_old_org uuid;
  v_new_org uuid;
  v_enabled boolean;
BEGIN
  -- Trust only a login that is the table owner and has not switched role.
  -- The definer identity is not the invoker, so it is not consulted here.
  IF v_login = v_owner AND v_active = v_owner THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE;
  IF TG_OP <> 'INSERT' THEN v_old_org := OLD.org_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_org := NEW.org_id; END IF;
  PERFORM 1 FROM public.organizations WHERE id IN (v_old_org, v_new_org) ORDER BY id FOR SHARE;
  SELECT EXISTS (
    SELECT 1 FROM public.organizations o
    JOIN public.platform_settings p ON p.key = 'bank_matching'
    WHERE o.id IN (v_old_org, v_new_org)
      AND o.feature_flags -> 'bank_matching' = 'true'::jsonb
      AND p.value -> 'enabled' = 'true'::jsonb
      AND jsonb_typeof(p.value -> 'allowed_org_ids') = 'array'
      AND p.value -> 'allowed_org_ids' @> jsonb_build_array(o.id::text)
  ) INTO v_enabled;
  IF v_enabled THEN
    RAISE EXCEPTION 'Bank matching requires audited server path' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

ALTER FUNCTION app.b009_direct_write_guard() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app.b009_direct_write_guard() FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
