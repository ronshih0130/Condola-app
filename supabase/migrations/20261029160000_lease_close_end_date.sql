-- Version 20261029160000.
-- A terminated or cancelled lease with no end date gets one, so the 90-day
-- ID deletion clock can leave 9999-12-31. An end date that is already set
-- stays. The date is the termination date when that column is set, otherwise
-- the Taipei calendar day of the status change, and never earlier than the
-- start date. No new constraint.

CREATE OR REPLACE FUNCTION public.fn_lease_close_end_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('terminated', 'cancelled') AND NEW.end_date IS NULL THEN
    NEW.end_date := greatest(
      NEW.start_date,
      coalesce(NEW.terminated_on, (timezone('Asia/Taipei', now()))::date)
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lease_close_end_date ON public.leases;
CREATE TRIGGER trg_lease_close_end_date
  BEFORE INSERT OR UPDATE OF status, end_date, terminated_on
  ON public.leases
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_lease_close_end_date();

UPDATE public.leases
   SET end_date = greatest(start_date, coalesce(terminated_on, (timezone('Asia/Taipei', now()))::date))
 WHERE status IN ('terminated', 'cancelled')
   AND end_date IS NULL;
