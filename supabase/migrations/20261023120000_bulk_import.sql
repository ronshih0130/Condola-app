-- Bulk import match keys and an explicit imported e-sign state.
-- Version 20261023120000 is assigned. 20261023130000 belongs to another change.
-- Address keys use the same normalization as addressKey(): NFKC, lower case, no whitespace.
-- Duplicate unit keys are cleared before the unique index so a deploy cannot abort.

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_entity_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_entity_check
  CHECK (entity IN ('portfolio', 'contacts', 'leases', 'opening_balances', 'bulk'));

ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_key text;
ALTER TABLE units ADD COLUMN IF NOT EXISTS import_address_key text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS id_number_hash text;

ALTER TYPE esign_status ADD VALUE IF NOT EXISTS 'imported';

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_electricity_method_chk;
ALTER TABLE units ADD CONSTRAINT units_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'tenant_direct', 'included'));

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_electricity_method_chk;
ALTER TABLE rooms ADD CONSTRAINT rooms_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'tenant_direct', 'included'));

UPDATE properties
   SET address_key = NULLIF(
         lower(regexp_replace(normalize(address_display, NFKC), '\s+', '', 'g')),
         ''
       )
 WHERE address_key IS NULL
   AND address_display IS NOT NULL;

UPDATE units u
   SET import_address_key = p.address_key
  FROM properties p
 WHERE p.id = u.property_id
   AND u.import_address_key IS NULL
   AND p.address_key IS NOT NULL;

WITH ranked AS (
  SELECT u.id,
         row_number() OVER (
           PARTITION BY u.org_id, u.import_address_key, u.label
           ORDER BY u.created_at, u.id
         ) AS n
    FROM units u
   WHERE u.import_address_key IS NOT NULL
     AND u.archived_at IS NULL
)
UPDATE units u
   SET import_address_key = NULL
  FROM ranked r
 WHERE u.id = r.id
   AND r.n > 1;

CREATE INDEX IF NOT EXISTS properties_org_address_key_idx
  ON properties (org_id, address_key)
  WHERE address_key IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS units_import_address_label_uniq
  ON units (org_id, import_address_key, label)
  WHERE import_address_key IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS contacts_org_tenant_id_hash_idx
  ON contacts (org_id, id_number_hash)
  WHERE id_number_hash IS NOT NULL AND archived_at IS NULL AND is_tenant;

CREATE INDEX IF NOT EXISTS contacts_org_phone_idx
  ON contacts (org_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND archived_at IS NULL;
