-- Additive. Older workers still insert the original electricity methods and one positive
-- 電費（空房） expense. 平均分攤 is a new allowed method. Two more owner lines
-- (公共用電, 電費（帳單差額）) can share a run, and the bill gap may be negative.

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_electricity_method_chk;
ALTER TABLE units ADD CONSTRAINT units_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'by_reading', 'shared', 'tenant_direct', 'even'))
  NOT VALID;
ALTER TABLE units VALIDATE CONSTRAINT units_electricity_method_chk;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_electricity_method_chk;
ALTER TABLE rooms ADD CONSTRAINT rooms_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'by_reading', 'shared', 'tenant_direct', 'even'))
  NOT VALID;
ALTER TABLE rooms VALIDATE CONSTRAINT rooms_electricity_method_chk;

CREATE UNIQUE INDEX IF NOT EXISTS expenses_utility_run_desc_live_uidx
  ON expenses (org_id, utility_run_id, description)
  WHERE utility_run_id IS NOT NULL AND status <> 'void';

DROP INDEX IF EXISTS expenses_utility_run_live_uidx;

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_amount_minor_check;
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_amount_minor_chk;
ALTER TABLE expenses ADD CONSTRAINT expenses_amount_minor_chk
  CHECK (
    amount_minor > 0
    OR (
      utility_run_id IS NOT NULL
      AND description IN ('公共用電', '電費（帳單差額）')
      AND amount_minor <> 0
    )
  );
