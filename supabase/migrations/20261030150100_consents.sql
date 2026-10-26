-- Version 20261030150100: server-recorded, append-only legal acceptances.
CREATE TABLE IF NOT EXISTS public.consents (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  accepted_at timestamptz NOT NULL,
  terms_version text NOT NULL CHECK (pg_catalog.btrim(terms_version) <> ''),
  privacy_version text NOT NULL CHECK (pg_catalog.btrim(privacy_version) <> ''),
  source text NOT NULL CHECK (source IN ('signup', 'reconsent', 'invite', 'portal')),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, accepted_at, terms_version, privacy_version, source)
);
CREATE INDEX IF NOT EXISTS consents_user_latest_idx
  ON public.consents (user_id, recorded_at DESC, id DESC);

ALTER TABLE public.consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.consents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.consents TO authenticated;
GRANT SELECT, INSERT ON TABLE public.consents TO service_role;
DROP POLICY IF EXISTS consents_select_own ON public.consents;
CREATE POLICY consents_select_own ON public.consents
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.consents_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  -- FK cascades run inside the auth.users DELETE trigger. Require the parent
  -- to be gone too, so unrelated nested triggers cannot delete evidence.
  IF TG_OP = 'DELETE' AND pg_catalog.pg_trigger_depth() > 1 THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'consents are append-only' USING ERRCODE = '42501';
END
$function$;
REVOKE EXECUTE ON FUNCTION public.consents_append_only() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS consents_append_only ON public.consents;
CREATE TRIGGER consents_append_only BEFORE UPDATE OR DELETE ON public.consents
  FOR EACH ROW EXECUTE FUNCTION public.consents_append_only();
DROP TRIGGER IF EXISTS consents_no_truncate ON public.consents;
CREATE TRIGGER consents_no_truncate BEFORE TRUNCATE ON public.consents
  FOR EACH STATEMENT EXECUTE FUNCTION public.consents_append_only();

-- Re-run once after the old Workers drain; metadata is migration input only.
DO $backfill$
DECLARE
  candidate record;
  consent jsonb;
  accepted timestamptz;
BEGIN
  FOR candidate IN
    SELECT id, raw_app_meta_data -> 'consent' AS value FROM auth.users
  LOOP
    consent := candidate.value;
    IF pg_catalog.jsonb_typeof(consent) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(consent -> 'accepted_at') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(consent -> 'terms_version') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(consent -> 'privacy_version') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(consent -> 'source') IS DISTINCT FROM 'string'
       OR pg_catalog.btrim(consent ->> 'accepted_at') = ''
       OR pg_catalog.btrim(consent ->> 'terms_version') = ''
       OR pg_catalog.btrim(consent ->> 'privacy_version') = ''
       OR (consent ->> 'source') NOT IN ('signup', 'reconsent', 'invite', 'portal')
    THEN
      CONTINUE;
    END IF;
    BEGIN
      accepted := (consent ->> 'accepted_at')::timestamptz;
    EXCEPTION WHEN data_exception THEN
      CONTINUE;
    END;
    IF NOT pg_catalog.isfinite(accepted) THEN
      CONTINUE;
    END IF;
    INSERT INTO public.consents (user_id, accepted_at, terms_version, privacy_version, source)
    VALUES (candidate.id, accepted, consent ->> 'terms_version', consent ->> 'privacy_version', consent ->> 'source')
    ON CONFLICT (user_id, accepted_at, terms_version, privacy_version, source) DO NOTHING;
  END LOOP;
END
$backfill$;
