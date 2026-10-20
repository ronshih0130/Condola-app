-- Portfolio fields from the sample import (物件 / 空間 / 屋主).
-- Lease and tenant columns live on listing_terms so a file can be seeded.
-- They are not tenant accounts; the lease product is a later change.
-- Do not edit earlier migrations.

-- Space-level columns shared by a whole unit and a room.
-- CSV: 電費方式, 每度電價, 台電帳單度數, 台電帳單金額, 電價超過上限原因, 備註.
-- 坪數 and 月租 already live on area_value / base_rent_minor.
ALTER TABLE units
  ADD COLUMN electricity_method text,
  ADD COLUMN rate_per_kwh numeric(12,4),
  ADD COLUMN taipower_kwh numeric(12,2),
  ADD COLUMN taipower_amount_minor bigint,
  ADD COLUMN rate_cap_reason text,
  ADD COLUMN notes text;

ALTER TABLE units
  ADD CONSTRAINT units_electricity_method_chk
    CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'tenant_direct')),
  ADD CONSTRAINT units_rate_chk CHECK (rate_per_kwh IS NULL OR rate_per_kwh >= 0),
  ADD CONSTRAINT units_taipower_kwh_chk CHECK (taipower_kwh IS NULL OR taipower_kwh >= 0),
  ADD CONSTRAINT units_taipower_amt_chk CHECK (taipower_amount_minor IS NULL OR taipower_amount_minor >= 0);

ALTER TABLE rooms
  ADD COLUMN electricity_method text,
  ADD COLUMN rate_per_kwh numeric(12,4),
  ADD COLUMN taipower_kwh numeric(12,2),
  ADD COLUMN taipower_amount_minor bigint,
  ADD COLUMN rate_cap_reason text,
  ADD COLUMN notes text;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_electricity_method_chk
    CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'tenant_direct')),
  ADD CONSTRAINT rooms_rate_chk CHECK (rate_per_kwh IS NULL OR rate_per_kwh >= 0),
  ADD CONSTRAINT rooms_taipower_kwh_chk CHECK (taipower_kwh IS NULL OR taipower_kwh >= 0),
  ADD CONSTRAINT rooms_taipower_amt_chk CHECK (taipower_amount_minor IS NULL OR taipower_amount_minor >= 0);

-- One row per CSV line's lease-shaped columns, attached to the space that was seeded.
-- CSV: 租客姓名, 租客電話, 租客 Email, 起租日, 到期日, 押金, 繳租日, 期初欠款, 押金超過上限原因.
-- Exactly one of unit_id (整戶／整層) or room_id (大樓中的一間房).
CREATE TABLE listing_terms (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  unit_id                uuid,
  room_id                uuid,
  tenant_name            text,
  tenant_phone           text,
  tenant_email           citext,
  lease_start            date,
  lease_end              date,
  deposit_minor          bigint CHECK (deposit_minor IS NULL OR deposit_minor >= 0),
  rent_due_day           smallint CHECK (rent_due_day IS NULL OR rent_due_day BETWEEN 1 AND 31),
  deposit_cap_reason     text,
  opening_arrears_minor  bigint NOT NULL DEFAULT 0 CHECK (opening_arrears_minor >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((unit_id IS NULL) <> (room_id IS NULL)),
  CHECK (lease_end IS NULL OR lease_start IS NULL OR lease_end >= lease_start),
  FOREIGN KEY (org_id, unit_id) REFERENCES units(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, room_id) REFERENCES rooms(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX listing_terms_unit_uniq ON listing_terms(unit_id) WHERE unit_id IS NOT NULL;
CREATE UNIQUE INDEX listing_terms_room_uniq ON listing_terms(room_id) WHERE room_id IS NOT NULL;
CREATE INDEX listing_terms_org_idx ON listing_terms(org_id);

ALTER TABLE listing_terms ENABLE ROW LEVEL SECURITY;

-- Tenant names and phones from a seeded file stay with the people who edit the portfolio.
CREATE POLICY team_read ON listing_terms FOR SELECT TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY team_insert ON listing_terms FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY team_update ON listing_terms FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'))
  WITH CHECK (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY team_delete ON listing_terms FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'));

GRANT SELECT, INSERT, UPDATE, DELETE ON listing_terms TO authenticated, service_role;
