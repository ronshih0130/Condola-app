-- FILE: supabase/migrations/20261112010000_b045_pricing_interim.sql
-- B-045 / PLT-30 / C2: interim pricing page, usage card, and apply queue.
-- Additive only. Flag seeded OFF. Applicant PII (company + phone) is locked down.
-- Does not touch upgrade_requests. No outbound (no NOTIFY, no mail hooks).

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- B-045: per-org admission flag. Default OFF. Effective only when enabled is
-- boolean true AND allowed_org_ids includes the org AND
-- organizations.feature_flags.pricing_interim is boolean true.
INSERT INTO public.platform_settings(key, value, description)
VALUES (
  'pricing_interim',
  '{"enabled":false,"allowed_org_ids":[]}'::jsonb,
  'B-045 interim pricing page, usage card, and apply queue. Default OFF. Effective only when enabled is boolean true AND allowed_org_ids includes the org AND organizations.feature_flags.pricing_interim is boolean true. First hosted ON = Ron''s 4 internal orgs after CEO GO. Logged-out /pricing and /apply need a separate public GO.'
)
ON CONFLICT (key) DO NOTHING;

-- B-045 / PLT-30 / C2: apply queue (Q-E). paid_received_on is the 入帳日 clock
-- for 「確認入帳後 1 個工作天內開通」, internal-admin only, never set automatically.
CREATE TABLE IF NOT EXISTS public.pricing_apply_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
  user_id              uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  company_name         text NOT NULL CHECK (length(btrim(company_name)) > 0),
  phone                text NOT NULL CHECK (length(btrim(phone)) > 0),
  units                integer NOT NULL CHECK (units >= 0),
  plan                 text NULL CHECK (plan IS NULL OR plan IN ('standard', 'pro', 'unsure')),
  note                 text NULL,
  status               text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'contacted', 'activated', 'closed')),
  paid_received_on     date NULL,          -- C2 入帳日, internal-admin only
  paid_received_set_at timestamptz NULL,
  paid_received_set_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Admin queue ordering.
CREATE INDEX IF NOT EXISTS pricing_apply_requests_created_at_desc_idx
  ON public.pricing_apply_requests (created_at DESC);

-- Lock down: applicant PII. Deny by default; only service_role touches rows.
ALTER TABLE public.pricing_apply_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_apply_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pricing_apply_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.pricing_apply_requests FROM anon;
REVOKE ALL ON TABLE public.pricing_apply_requests FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.pricing_apply_requests TO service_role;

-- B-045: public /apply submission. SECURITY DEFINER to bypass FORCE RLS (owner).
CREATE OR REPLACE FUNCTION app.submit_pricing_apply(
  p_org_id       uuid,
  p_user_id      uuid,
  p_company_name text,
  p_phone        text,
  p_units        integer,
  p_plan         text,
  p_note         text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_company text := btrim(p_company_name);
  v_phone   text := btrim(p_phone);
  v_plan    text := p_plan;
  v_id      uuid;
BEGIN
  IF length(v_company) = 0 THEN
    RAISE EXCEPTION 'pricing apply: empty company_name';
  END IF;
  IF length(v_phone) = 0 THEN
    RAISE EXCEPTION 'pricing apply: empty phone';
  END IF;
  IF p_units IS NULL OR p_units < 0 THEN
    RAISE EXCEPTION 'pricing apply: invalid units: %', p_units;
  END IF;
  IF v_plan = 'premium' THEN
    v_plan := 'pro';  -- accept legacy label
  END IF;
  IF v_plan IS NOT NULL AND v_plan NOT IN ('standard', 'pro', 'unsure') THEN
    RAISE EXCEPTION 'pricing apply: invalid plan: %', v_plan;
  END IF;

  INSERT INTO public.pricing_apply_requests (
    org_id, user_id, company_name, phone, units, plan, note,
    status, paid_received_on, paid_received_set_at, paid_received_set_by
  )
  VALUES (
    p_org_id, p_user_id, v_company, v_phone, p_units, v_plan, p_note,
    'submitted', NULL, NULL, NULL
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app.submit_pricing_apply(uuid, uuid, text, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.submit_pricing_apply(uuid, uuid, text, text, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION app.submit_pricing_apply(uuid, uuid, text, text, integer, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION app.submit_pricing_apply(uuid, uuid, text, text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION app.submit_pricing_apply(uuid, uuid, text, text, integer, text, text) TO CURRENT_USER;

-- PLT-30: admin queue read. Platform-admin authorization is enforced in the app.
CREATE OR REPLACE FUNCTION app.list_pricing_apply_requests()
RETURNS SETOF public.pricing_apply_requests
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM public.pricing_apply_requests ORDER BY created_at DESC;
$$;
REVOKE ALL ON FUNCTION app.list_pricing_apply_requests() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_pricing_apply_requests() FROM anon;
REVOKE ALL ON FUNCTION app.list_pricing_apply_requests() FROM authenticated;
GRANT EXECUTE ON FUNCTION app.list_pricing_apply_requests() TO service_role;
GRANT EXECUTE ON FUNCTION app.list_pricing_apply_requests() TO CURRENT_USER;

-- C2 入帳日: internal-admin sets the paid-received clock. NULL p_on = correction.
CREATE OR REPLACE FUNCTION app.set_pricing_apply_paid_received(
  p_id uuid,
  p_on date,
  p_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_on IS NULL THEN
    UPDATE public.pricing_apply_requests
      SET paid_received_on     = NULL,
          paid_received_set_at = NULL,
          paid_received_set_by = NULL
      WHERE id = p_id;
  ELSE
    UPDATE public.pricing_apply_requests
      SET paid_received_on     = p_on,
          paid_received_set_at = now(),
          paid_received_set_by = p_by
      WHERE id = p_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.set_pricing_apply_paid_received(uuid, date, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_pricing_apply_paid_received(uuid, date, uuid) FROM anon;
REVOKE ALL ON FUNCTION app.set_pricing_apply_paid_received(uuid, date, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION app.set_pricing_apply_paid_received(uuid, date, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION app.set_pricing_apply_paid_received(uuid, date, uuid) TO CURRENT_USER;

COMMIT;
