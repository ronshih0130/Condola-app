-- Bulk import of properties, units, tenants, and leases.
-- Idempotent match keys: unit address + number, tenant ID hash, tenant phone.
-- Version is after 20261023090000 so it stays unique against that slot.

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_entity_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_entity_check
  CHECK (entity IN ('portfolio', 'contacts', 'leases', 'opening_balances', 'bulk'));

ALTER TABLE properties ADD COLUMN address_key text;
ALTER TABLE units ADD COLUMN import_address_key text;
ALTER TABLE contacts ADD COLUMN id_number_hash text;

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_electricity_method_chk;
ALTER TABLE units ADD CONSTRAINT units_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'tenant_direct', 'included'));

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_electricity_method_chk;
ALTER TABLE rooms ADD CONSTRAINT rooms_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'tenant_direct', 'included'));

UPDATE properties
   SET address_key = NULLIF(lower(regexp_replace(address_display, '\s+', '', 'g')), '')
 WHERE address_key IS NULL AND address_display IS NOT NULL;

UPDATE units u
   SET import_address_key = p.address_key
  FROM properties p
 WHERE p.id = u.property_id
   AND u.import_address_key IS NULL
   AND p.address_key IS NOT NULL;

CREATE INDEX properties_org_address_key_idx
  ON properties (org_id, address_key)
  WHERE address_key IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX units_import_address_label_uniq
  ON units (org_id, import_address_key, label)
  WHERE import_address_key IS NOT NULL AND archived_at IS NULL;

CREATE INDEX contacts_org_tenant_id_hash_idx
  ON contacts (org_id, id_number_hash)
  WHERE id_number_hash IS NOT NULL AND archived_at IS NULL AND is_tenant;

CREATE INDEX contacts_org_phone_idx
  ON contacts (org_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND archived_at IS NULL;
