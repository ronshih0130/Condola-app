-- Additive only. Older app builds keep working:
-- * door_supplement is nullable and unused by old inserts
-- * whole_home is a new enum value old code never writes
-- * settings.country is backfilled; an explicit country is left alone
-- * no new NOT NULL, unique index, rename, or drop
--
-- PG 15 allows ADD VALUE in a transaction, but the new value cannot be used
-- in that same transaction. This file only adds it.

ALTER TYPE room_type ADD VALUE IF NOT EXISTS 'whole_home';

ALTER TABLE units ADD COLUMN IF NOT EXISTS door_supplement text;

UPDATE organizations
   SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{country}', to_jsonb(country_code), true)
 WHERE settings IS NULL OR NOT (settings ? 'country');

CREATE OR REPLACE FUNCTION fn_org_country_setting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.settings IS NULL OR NOT (NEW.settings ? 'country') THEN
    NEW.settings := jsonb_set(coalesce(NEW.settings, '{}'::jsonb), '{country}', to_jsonb(NEW.country_code), true);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_country_setting ON organizations;
CREATE TRIGGER trg_org_country_setting
  BEFORE INSERT OR UPDATE OF country_code, settings ON organizations
  FOR EACH ROW EXECUTE FUNCTION fn_org_country_setting();
