-- Point each unit's import key at the property it belongs to now.
-- This is not a migration. Apply it by hand after 20261029130000.
-- A second run changes nothing once every key already matches.
-- The updated_at trigger is paused so a key repair does not stamp the row,
-- and it is turned back on if the statement fails.

DO $backfill$
DECLARE
  updated_count integer;
BEGIN
  ALTER TABLE public.units DISABLE TRIGGER trg_units_updated_at;
  UPDATE public.units AS u
     SET import_address_key = coalesce(p.address_key, public.condola_property_address_key(p.address_display))
    FROM public.properties AS p
   WHERE p.id = u.property_id
     AND p.org_id = u.org_id
     AND u.import_address_key IS DISTINCT FROM coalesce(p.address_key, public.condola_property_address_key(p.address_display));
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  ALTER TABLE public.units ENABLE TRIGGER trg_units_updated_at;
  RAISE NOTICE 'backfill-unit-import-address-keys updated %', updated_count;
EXCEPTION WHEN OTHERS THEN
  ALTER TABLE public.units ENABLE TRIGGER trg_units_updated_at;
  RAISE;
END
$backfill$;
