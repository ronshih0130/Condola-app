-- Bulk import match keys. Version 20261023120000 stays assigned.
-- Shared staging runs this while older app builds are still serving.
-- Additive and idempotent: nullable columns, non-unique indexes, and triggers.
-- Existing rows keep their current values. Older writes are not rejected.
-- A second apply is a no-op for columns, indexes, the enum label, and triggers.
-- Address keys use the same normalization as addressKey(): NFKC, lower case, no whitespace.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_key text;
ALTER TABLE units ADD COLUMN IF NOT EXISTS import_address_key text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS id_number_hash text;

-- Rent-included electricity cannot use the existing method check
-- ('submeter', 'tenant_direct'). A nullable flag records it instead.
ALTER TABLE units ADD COLUMN IF NOT EXISTS electricity_included boolean;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS electricity_included boolean;

-- New label only. Existing leases stay on the previous labels.
-- Older code keeps writing those labels; this does not reject them.
ALTER TYPE esign_status ADD VALUE IF NOT EXISTS 'imported';

CREATE OR REPLACE FUNCTION public.condola_property_address_key(display text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(
    lower(regexp_replace(normalize(coalesce(display, ''), NFKC), '\s+', '', 'g')),
    ''
  )
$$;

CREATE OR REPLACE FUNCTION public.condola_set_property_address_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.address_key := public.condola_property_address_key(NEW.address_display);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.condola_set_unit_import_address_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.import_address_key IS NULL THEN
    SELECT coalesce(p.address_key, public.condola_property_address_key(p.address_display))
      INTO NEW.import_address_key
      FROM public.properties p
     WHERE p.id = NEW.property_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.condola_sync_unit_address_keys()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.address_key IS DISTINCT FROM OLD.address_key THEN
    BEGIN
      UPDATE public.units
         SET import_address_key = NEW.address_key
       WHERE property_id = NEW.id
         AND import_address_key IS DISTINCT FROM NEW.address_key;
    EXCEPTION WHEN OTHERS THEN
      RETURN NEW;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'properties_address_key_biu'
       AND tgrelid = 'public.properties'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER properties_address_key_biu
      BEFORE INSERT OR UPDATE OF address_display ON public.properties
      FOR EACH ROW
      EXECUTE FUNCTION public.condola_set_property_address_key();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'properties_address_key_sync'
       AND tgrelid = 'public.properties'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER properties_address_key_sync
      AFTER UPDATE OF address_display, address_key ON public.properties
      FOR EACH ROW
      EXECUTE FUNCTION public.condola_sync_unit_address_keys();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'units_import_address_key_biu'
       AND tgrelid = 'public.units'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER units_import_address_key_biu
      BEFORE INSERT OR UPDATE ON public.units
      FOR EACH ROW
      EXECUTE FUNCTION public.condola_set_unit_import_address_key();
  END IF;
END
$do$;

UPDATE properties
   SET address_key = public.condola_property_address_key(address_display)
 WHERE address_key IS NULL
   AND address_display IS NOT NULL;

UPDATE units u
   SET import_address_key = coalesce(p.address_key, public.condola_property_address_key(p.address_display))
  FROM properties p
 WHERE p.id = u.property_id
   AND u.import_address_key IS NULL
   AND coalesce(p.address_key, public.condola_property_address_key(p.address_display)) IS NOT NULL;

CREATE INDEX IF NOT EXISTS properties_org_address_key_idx
  ON properties (org_id, address_key)
  WHERE address_key IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS units_import_address_label_idx
  ON units (org_id, import_address_key, label)
  WHERE import_address_key IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS contacts_org_tenant_id_hash_idx
  ON contacts (org_id, id_number_hash)
  WHERE id_number_hash IS NOT NULL AND archived_at IS NULL AND is_tenant;

CREATE INDEX IF NOT EXISTS contacts_org_phone_idx
  ON contacts (org_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND archived_at IS NULL;
