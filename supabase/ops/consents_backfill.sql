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
       OR (consent ->> 'accepted_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$'
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
    BEGIN
      INSERT INTO public.consents (user_id, accepted_at, terms_version, privacy_version, source)
      VALUES (candidate.id, accepted, consent ->> 'terms_version', consent ->> 'privacy_version', consent ->> 'source')
      ON CONFLICT (user_id, accepted_at, terms_version, privacy_version, source) DO NOTHING;
    EXCEPTION WHEN foreign_key_violation THEN
      -- A candidate may have been deleted since the loop's snapshot.
      CONTINUE;
    END;
  END LOOP;
END
$backfill$;
