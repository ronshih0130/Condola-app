-- Post a confirmed electricity allocation onto the tenant bill.
-- Constraints are added NOT VALID, backfilled, then validated so a database that
-- already has void runs or older electricity methods can migrate.
-- 20261023120000 is reserved by a parallel change. 20261024100000 comes later.

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_electricity_method_chk;
ALTER TABLE units ADD CONSTRAINT units_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'by_reading', 'shared', 'tenant_direct'))
  NOT VALID;
UPDATE units
   SET electricity_method = NULL
 WHERE electricity_method IS NOT NULL
   AND electricity_method NOT IN ('submeter', 'by_reading', 'shared', 'tenant_direct');
ALTER TABLE units VALIDATE CONSTRAINT units_electricity_method_chk;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_electricity_method_chk;
ALTER TABLE rooms ADD CONSTRAINT rooms_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'by_reading', 'shared', 'tenant_direct'))
  NOT VALID;
UPDATE rooms
   SET electricity_method = NULL
 WHERE electricity_method IS NOT NULL
   AND electricity_method NOT IN ('submeter', 'by_reading', 'shared', 'tenant_direct');
ALTER TABLE rooms VALIDATE CONSTRAINT rooms_electricity_method_chk;

ALTER TABLE utility_allocation_runs
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid;

ALTER TABLE utility_allocation_lines
  ADD COLUMN IF NOT EXISTS posted_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS posted_invoice_line_id uuid,
  ADD COLUMN IF NOT EXISTS posted_ledger_transaction_id uuid,
  ADD COLUMN IF NOT EXISTS posted_amount_minor bigint,
  ADD COLUMN IF NOT EXISTS posted_description text;

-- One active main electricity meter per unit, and one non-void run per meter period.
-- Duplicate drafts from the lease wizard are merged before the unique indexes.
CREATE TEMP TABLE utility_meter_dupes AS
SELECT d.id AS dupe_id, k.id AS keeper_id
  FROM (
    SELECT id, unit_id, row_number() OVER (PARTITION BY unit_id ORDER BY created_at, id) AS rn
      FROM meters
     WHERE utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
  ) d
  JOIN (
    SELECT id, unit_id, row_number() OVER (PARTITION BY unit_id ORDER BY created_at, id) AS rn
      FROM meters
     WHERE utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
  ) k ON k.unit_id = d.unit_id AND k.rn = 1
 WHERE d.rn > 1;

UPDATE utility_allocation_runs r
   SET meter_id = d.keeper_id
  FROM utility_meter_dupes d
 WHERE r.meter_id = d.dupe_id
   AND r.status <> 'void'
   AND NOT EXISTS (
     SELECT 1 FROM utility_allocation_runs keeper_run
      WHERE keeper_run.meter_id = d.keeper_id
        AND keeper_run.period_start = r.period_start
        AND keeper_run.period_end = r.period_end
        AND keeper_run.status <> 'void'
        AND keeper_run.id <> r.id
   );

UPDATE utility_allocation_runs r
   SET status = 'void',
       void_reason = '重複分攤（遷移合併）',
       voided_at = coalesce(r.voided_at, now()),
       voided_by = coalesce(
         r.voided_by, r.approved_by, r.computed_by,
         (SELECT m.user_id FROM org_members m
           WHERE m.org_id = r.org_id AND m.status = 'active'
           ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, m.created_at
           LIMIT 1)
       )
  FROM utility_meter_dupes d
 WHERE r.meter_id = d.dupe_id
   AND r.status <> 'void';

UPDATE meters m
   SET archived_at = coalesce(m.archived_at, now())
  FROM utility_meter_dupes d
 WHERE m.id = d.dupe_id;

DROP TABLE utility_meter_dupes;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY meter_id, period_start, period_end
           ORDER BY computed_at DESC, id DESC
         ) AS rn
    FROM utility_allocation_runs
   WHERE status <> 'void'
)
UPDATE utility_allocation_runs r
   SET status = 'void',
       void_reason = '重複分攤（遷移合併）',
       voided_at = coalesce(r.voided_at, now()),
       voided_by = coalesce(
         r.voided_by, r.approved_by, r.computed_by,
         (SELECT m.user_id FROM org_members m
           WHERE m.org_id = r.org_id AND m.status = 'active'
           ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, m.created_at
           LIMIT 1)
       )
  FROM ranked x
 WHERE r.id = x.id AND x.rn > 1;

UPDATE utility_allocation_runs r
   SET void_reason = CASE
         WHEN nullif(btrim(r.void_reason), '') IS NULL THEN '既有作廢分攤（遷移補記）'
         ELSE r.void_reason
       END,
       voided_at = coalesce(r.voided_at, r.computed_at, now()),
       voided_by = coalesce(
         r.voided_by, r.approved_by, r.computed_by,
         (SELECT m.user_id FROM org_members m
           WHERE m.org_id = r.org_id AND m.status = 'active'
           ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, m.created_at
           LIMIT 1)
       )
 WHERE r.status = 'void'
   AND (nullif(btrim(r.void_reason), '') IS NULL OR r.voided_by IS NULL OR r.voided_at IS NULL);

ALTER TABLE utility_allocation_runs DROP CONSTRAINT IF EXISTS utility_allocation_runs_void_chk;
ALTER TABLE utility_allocation_runs
  ADD CONSTRAINT utility_allocation_runs_void_chk
  CHECK (status <> 'void' OR (nullif(btrim(void_reason), '') IS NOT NULL AND voided_by IS NOT NULL))
  NOT VALID;
ALTER TABLE utility_allocation_runs VALIDATE CONSTRAINT utility_allocation_runs_void_chk;

ALTER TABLE utility_allocation_runs DROP CONSTRAINT IF EXISTS utility_allocation_runs_voided_by_fkey;
ALTER TABLE utility_allocation_runs
  ADD CONSTRAINT utility_allocation_runs_voided_by_fkey
  FOREIGN KEY (voided_by) REFERENCES auth.users(id) NOT VALID;
ALTER TABLE utility_allocation_runs VALIDATE CONSTRAINT utility_allocation_runs_voided_by_fkey;

DROP INDEX IF EXISTS utility_allocation_runs_open_period_idx;
CREATE UNIQUE INDEX IF NOT EXISTS meters_active_main_electricity_uidx
  ON meters (unit_id)
  WHERE utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS utility_allocation_runs_open_period_uidx
  ON utility_allocation_runs (meter_id, period_start, period_end)
  WHERE status <> 'void';

-- invoice_lines had no (org_id, id) unique key, so a composite foreign key could not point at a line.
ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_org_uniq;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_org_uniq UNIQUE (org_id, id);

ALTER TABLE utility_allocation_lines DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_invoice_fk;
ALTER TABLE utility_allocation_lines DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_line_fk;
ALTER TABLE utility_allocation_lines DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_ledger_fk;
ALTER TABLE utility_allocation_lines DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_pair_chk;

ALTER TABLE utility_allocation_lines
  ADD CONSTRAINT utility_allocation_lines_posted_invoice_fk
    FOREIGN KEY (org_id, posted_invoice_id) REFERENCES invoices (org_id, id) NOT VALID,
  ADD CONSTRAINT utility_allocation_lines_posted_line_fk
    FOREIGN KEY (org_id, posted_invoice_line_id) REFERENCES invoice_lines (org_id, id) NOT VALID,
  ADD CONSTRAINT utility_allocation_lines_posted_ledger_fk
    FOREIGN KEY (org_id, posted_ledger_transaction_id) REFERENCES ledger_transactions (org_id, id) NOT VALID,
  ADD CONSTRAINT utility_allocation_lines_posted_pair_chk
    CHECK (
      (posted_invoice_id IS NULL AND posted_invoice_line_id IS NULL AND posted_ledger_transaction_id IS NULL
        AND posted_amount_minor IS NULL AND posted_description IS NULL)
      OR (posted_invoice_id IS NOT NULL AND posted_invoice_line_id IS NOT NULL AND posted_ledger_transaction_id IS NOT NULL
        AND posted_amount_minor IS NOT NULL AND posted_description IS NOT NULL)
    ) NOT VALID;

ALTER TABLE utility_allocation_lines VALIDATE CONSTRAINT utility_allocation_lines_posted_invoice_fk;
ALTER TABLE utility_allocation_lines VALIDATE CONSTRAINT utility_allocation_lines_posted_line_fk;
ALTER TABLE utility_allocation_lines VALIDATE CONSTRAINT utility_allocation_lines_posted_ledger_fk;
ALTER TABLE utility_allocation_lines VALIDATE CONSTRAINT utility_allocation_lines_posted_pair_chk;

-- Reversal dates follow Taipei, same as a newly posted electricity charge.
CREATE OR REPLACE FUNCTION post_reversal(p_txn uuid, p_reason text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t ledger_transactions; new_id uuid;
BEGIN
  SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', p_txn; END IF;
  INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description,
                                   source_table, source_id, reverses_transaction_id, reason, created_by)
  VALUES (t.org_id, t.property_id, t.lease_id, 'reversal', t.currency, (timezone('Asia/Taipei', now()))::date,
          'Reversal of '||t.id, t.source_table, t.source_id, t.id, p_reason, auth.uid())
  RETURNING id INTO new_id;
  INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo)
  SELECT org_id, new_id, account, -amount_minor, currency, contact_id, property_id, lease_id, invoice_id, 'reversal'
    FROM ledger_entries WHERE transaction_id = p_txn;
  RETURN new_id;
END $$;

-- audit_log rejects inserts from the authenticated role. This writes one allowlisted event inside the posting transaction.
CREATE OR REPLACE FUNCTION app.audit_event(p_org uuid, p_event text, p_detail jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT app.has_role(p_org, '{admin,manager}') THEN
    RAISE EXCEPTION 'not allowed to audit this event' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_event NOT IN ('utility_charge_posted', 'utility_charge_reposted', 'utility_charge_voided') THEN
    RAISE EXCEPTION 'event not allowed' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row, reason)
  VALUES (
    p_org, auth.uid(), 'app', 'auth_events', p_event, 'insert', p_event,
    jsonb_build_object('event', p_event) || coalesce(p_detail, '{}'::jsonb),
    p_event
  );
END $$;

REVOKE ALL ON FUNCTION app.audit_event(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit_event(uuid, text, jsonb) TO authenticated;
