BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Recognize a newly observed move-out for a previously open legacy lease.
-- Existing ambiguous provenance is never backfilled or accepted from a client.
CREATE OR REPLACE FUNCTION app.b002_capture_end_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.id_retention_auto_end := NEW.status IN ('terminated','cancelled') AND NEW.end_date IS NULL;
  ELSE
    NEW.id_retention_auto_end := OLD.id_retention_auto_end;
    IF OLD.end_date IS NULL AND NEW.end_date IS NULL AND NEW.status IN ('terminated','cancelled') THEN
      NEW.id_retention_auto_end := true;
    ELSIF OLD.id_retention_auto_end IS NULL
      AND OLD.status = 'active' AND NEW.status = 'active'
      AND OLD.end_date IS NULL AND NEW.end_date IS NULL
      AND OLD.terminated_on IS NULL AND NEW.terminated_on IS NULL
      AND OLD.moved_out_on IS NULL AND NEW.moved_out_on IS NOT NULL THEN
      NEW.id_retention_auto_end := false;
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
