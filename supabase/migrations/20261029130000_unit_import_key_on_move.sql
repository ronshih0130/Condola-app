-- 20261029130000. A unit keeps its import key when the row is edited, and
-- still fills a null key from its property. Moving the unit to another
-- property refreshes the key from that property. Existing rows are not
-- rewritten here. scripts/backfill-unit-import-address-keys.sql does that,
-- and it can be run more than once.

CREATE OR REPLACE FUNCTION public.condola_set_unit_import_address_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    SELECT coalesce(p.address_key, public.condola_property_address_key(p.address_display))
      INTO NEW.import_address_key
      FROM public.properties p
     WHERE p.id = NEW.property_id
       AND p.org_id = NEW.org_id;
  ELSIF NEW.import_address_key IS NULL THEN
    SELECT coalesce(p.address_key, public.condola_property_address_key(p.address_display))
      INTO NEW.import_address_key
      FROM public.properties p
     WHERE p.id = NEW.property_id
       AND p.org_id = NEW.org_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.condola_set_unit_import_address_key() FROM PUBLIC, anon, authenticated;
