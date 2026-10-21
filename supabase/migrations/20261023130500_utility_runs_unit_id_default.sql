-- Lease create on main inserts utility_allocation_runs without unit_id.
-- 20261023130000 made that column NOT NULL, so those inserts fail with 23502.
-- Fill the column from the run's meter when it is omitted or null.
-- Staging may already have public.utility_runs_fill_unit_id() and
-- trg_utility_runs_fill_unit_id. Replace both. BEFORE ROW triggers fire in
-- name order, and trg_allocation_rate_cap is the other BEFORE INSERT trigger,
-- so the fill trigger is named to run first.

CREATE OR REPLACE FUNCTION public.utility_runs_fill_unit_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.unit_id IS NULL THEN
    SELECT m.unit_id INTO NEW.unit_id
      FROM meters m
     WHERE m.id = NEW.meter_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_utility_runs_fill_unit_id ON utility_allocation_runs;
DROP TRIGGER IF EXISTS trg_a_fill_unit_id ON utility_allocation_runs;
CREATE TRIGGER trg_a_fill_unit_id
  BEFORE INSERT ON utility_allocation_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.utility_runs_fill_unit_id();

GRANT EXECUTE ON FUNCTION public.utility_runs_fill_unit_id() TO authenticated, service_role;
