-- 20261029120000. Address-key sync used to swallow every unit-key error and return NEW.
-- Log the failure instead, then still return NEW so the property write commits.
-- Additive: a new table and a replacement of condola_sync_unit_address_keys()
-- with the same signature. Older app builds do not read this table. No column
-- on properties or units changes, and no existing row is rewritten.

CREATE TABLE IF NOT EXISTS public.condola_sync_errors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL,
  org_id      uuid,
  row_id      uuid,
  sqlstate    text,
  message     text,
  detail      text
);

CREATE INDEX IF NOT EXISTS condola_sync_errors_occurred_at_idx
  ON public.condola_sync_errors (occurred_at);

REVOKE ALL ON TABLE public.condola_sync_errors FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.condola_sync_errors TO service_role;

CREATE OR REPLACE FUNCTION public.condola_sync_unit_address_keys()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  err_state text;
  err_message text;
  err_detail text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.address_key IS DISTINCT FROM OLD.address_key THEN
    BEGIN
      UPDATE public.units
         SET import_address_key = NEW.address_key
       WHERE property_id = NEW.id
         AND org_id = NEW.org_id
         AND import_address_key IS DISTINCT FROM NEW.address_key;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS
        err_state = RETURNED_SQLSTATE,
        err_message = MESSAGE_TEXT,
        err_detail = PG_EXCEPTION_DETAIL;
      BEGIN
        INSERT INTO public.condola_sync_errors (source, org_id, row_id, sqlstate, message, detail)
        VALUES (
          'condola_sync_unit_address_keys',
          NEW.org_id,
          NEW.id,
          err_state,
          err_message,
          NULLIF(err_detail, '')
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'condola_sync_unit_address_keys could not log %: %', err_state, err_message;
      END;
    END;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.condola_sync_unit_address_keys() FROM PUBLIC, anon, authenticated;
