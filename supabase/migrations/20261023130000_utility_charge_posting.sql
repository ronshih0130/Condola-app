-- Post a confirmed electricity allocation onto the tenant bill.
-- Constraints are added NOT VALID, backfilled, then validated so a database that
-- already has void runs or older electricity methods can migrate.
-- 20261023120000 is reserved by a parallel change. 20261024100000 comes later.

ALTER TABLE units DROP CONSTRAINT IF EXISTS units_electricity_method_chk;
ALTER TABLE units ADD CONSTRAINT units_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'by_reading', 'shared', 'tenant_direct'))
  NOT VALID;
-- Unknown electricity methods stay put. VALIDATE fails the migration instead of erasing them.
ALTER TABLE units VALIDATE CONSTRAINT units_electricity_method_chk;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_electricity_method_chk;
ALTER TABLE rooms ADD CONSTRAINT rooms_electricity_method_chk
  CHECK (electricity_method IS NULL OR electricity_method IN ('submeter', 'by_reading', 'shared', 'tenant_direct'))
  NOT VALID;
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
DROP TABLE IF EXISTS utility_meter_dupes;
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

-- Moving a run onto the keeper is fine. Voiding an approved or posted run is not.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM utility_allocation_runs r
      JOIN utility_meter_dupes d ON r.meter_id = d.dupe_id
     WHERE r.status IN ('approved', 'posted')
       AND EXISTS (
         SELECT 1 FROM utility_allocation_runs keeper_run
          WHERE keeper_run.meter_id = d.keeper_id
            AND keeper_run.period_start = r.period_start
            AND keeper_run.period_end = r.period_end
            AND keeper_run.status <> 'void'
            AND keeper_run.id <> r.id
       )
  ) THEN
    RAISE EXCEPTION 'cannot merge meters: an approved or posted allocation run would have to be voided'
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

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
   AND r.status = 'draft';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM utility_allocation_runs r
      JOIN utility_meter_dupes d ON r.meter_id = d.dupe_id
     WHERE r.status IN ('approved', 'posted')
  ) THEN
    RAISE EXCEPTION 'cannot merge meters: an approved or posted allocation run is still on a duplicate meter'
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

UPDATE meters m
   SET archived_at = coalesce(m.archived_at, now())
  FROM utility_meter_dupes d
 WHERE m.id = d.dupe_id;

DROP TABLE utility_meter_dupes;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM utility_allocation_runs
     WHERE status IN ('approved', 'posted')
     GROUP BY meter_id, period_start, period_end
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot merge allocation runs: a meter period has more than one approved or posted run'
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY meter_id, period_start, period_end
           ORDER BY CASE WHEN status IN ('approved', 'posted') THEN 0 ELSE 1 END,
                    computed_at DESC, id DESC
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
 WHERE r.id = x.id
    AND x.rn > 1
    AND r.status = 'draft';

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

-- Inclusive periods. 10/01–10/31 and 10/31–11/30 overlap; 10/01–10/31 and 11/01–11/30 do not.
-- A row does not conflict with itself, so re-editing that run is allowed. Void drops out of the predicate.
ALTER TABLE utility_allocation_runs ADD COLUMN IF NOT EXISTS unit_id uuid;

UPDATE utility_allocation_runs r
   SET unit_id = m.unit_id
  FROM meters m
 WHERE r.meter_id = m.id
   AND r.unit_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM utility_allocation_runs WHERE unit_id IS NULL) THEN
    RAISE EXCEPTION 'cannot backfill allocation run unit: a run has no meter unit'
      USING ERRCODE = 'not_null_violation';
  END IF;
END $$;

ALTER TABLE utility_allocation_runs ALTER COLUMN unit_id SET NOT NULL;

ALTER TABLE utility_allocation_runs DROP CONSTRAINT IF EXISTS utility_allocation_runs_unit_fk;
ALTER TABLE utility_allocation_runs
  ADD CONSTRAINT utility_allocation_runs_unit_fk
  FOREIGN KEY (org_id, unit_id) REFERENCES units (org_id, id) NOT VALID;
ALTER TABLE utility_allocation_runs VALIDATE CONSTRAINT utility_allocation_runs_unit_fk;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM utility_allocation_runs a
      JOIN utility_allocation_runs b
        ON a.unit_id = b.unit_id
       AND a.id < b.id
       AND a.status <> 'void'
       AND b.status <> 'void'
       AND daterange(a.period_start, a.period_end, '[]') && daterange(b.period_start, b.period_end, '[]')
  ) THEN
    RAISE EXCEPTION 'cannot exclude overlapping allocation periods: non-void runs on a unit share a date'
      USING ERRCODE = 'exclusion_violation';
  END IF;
END $$;

ALTER TABLE utility_allocation_runs DROP CONSTRAINT IF EXISTS utility_allocation_runs_unit_period_excl;
ALTER TABLE utility_allocation_runs
  ADD CONSTRAINT utility_allocation_runs_unit_period_excl
  EXCLUDE USING gist (
    unit_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  )
  WHERE (status <> 'void');

-- The posted-line foreign key depends on invoice_lines_org_uniq, so drop that key first.
ALTER TABLE utility_allocation_lines DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_invoice_fk;
ALTER TABLE utility_allocation_lines DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_line_fk;
ALTER TABLE utility_allocation_lines DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_ledger_fk;
ALTER TABLE utility_allocation_lines DROP CONSTRAINT IF EXISTS utility_allocation_lines_posted_pair_chk;

-- invoice_lines had no (org_id, id) unique key, so a composite foreign key could not point at a line.
ALTER TABLE invoice_lines DROP CONSTRAINT IF EXISTS invoice_lines_org_uniq;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_org_uniq UNIQUE (org_id, id);

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

-- Edited after posting. Not used in this file, so ADD VALUE is safe inside one transaction.
ALTER TYPE allocation_status ADD VALUE IF NOT EXISTS 'pending_repost' BEFORE 'void';

-- Issued-statement freeze follows this column, not invoices.ledger_transaction_id.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS owner_statement_id uuid;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_owner_statement_fk;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_owner_statement_fk
  FOREIGN KEY (org_id, owner_statement_id) REFERENCES owner_statements (org_id, id) NOT VALID;

UPDATE invoices i
   SET owner_statement_id = picked.statement_id
  FROM (
    SELECT DISTINCT ON (inv.id) inv.id AS invoice_id, s.id AS statement_id
      FROM invoices inv
      JOIN payment_allocations a ON a.invoice_id = inv.id
      JOIN payments pay ON pay.id = a.payment_id AND pay.status = 'confirmed'
      JOIN leases l ON l.id = inv.lease_id
      JOIN property_owners po ON po.property_id = l.property_id
      JOIN owner_statements s ON s.owner_contact_id = po.owner_contact_id
       AND s.org_id = inv.org_id
       AND s.status = 'issued'
       AND pay.paid_on >= s.period_start
       AND pay.paid_on <= s.period_end
     ORDER BY inv.id, s.period_end DESC, s.id DESC
  ) picked
 WHERE i.id = picked.invoice_id
   AND i.owner_statement_id IS NULL;

ALTER TABLE invoices VALIDATE CONSTRAINT invoices_owner_statement_fk;
CREATE INDEX IF NOT EXISTS invoices_owner_statement_idx
  ON invoices (owner_statement_id) WHERE owner_statement_id IS NOT NULL;

-- p_invoice retargets the reversed entries at a credit invoice. Two-argument callers keep the original invoice.
DROP FUNCTION IF EXISTS post_reversal(uuid, text);
CREATE OR REPLACE FUNCTION post_reversal(p_txn uuid, p_reason text, p_invoice uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE t ledger_transactions; new_id uuid;
BEGIN
  SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', p_txn; END IF;
  IF p_invoice IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invoices WHERE id = p_invoice AND org_id = t.org_id
  ) THEN
    RAISE EXCEPTION 'credit invoice % is not in the transaction organization', p_invoice
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description,
                                   source_table, source_id, reverses_transaction_id, reason, created_by)
  VALUES (t.org_id, t.property_id, t.lease_id, 'reversal', t.currency, (timezone('Asia/Taipei', now()))::date,
          'Reversal of '||t.id, t.source_table, t.source_id, t.id, p_reason, auth.uid())
  RETURNING id INTO new_id;
  INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo)
  SELECT org_id, new_id, account, -amount_minor, currency, contact_id, property_id, lease_id,
         COALESCE(p_invoice, invoice_id), 'reversal'
    FROM ledger_entries WHERE transaction_id = p_txn;
  RETURN new_id;
END $$;

GRANT EXECUTE ON FUNCTION post_reversal(uuid, text, uuid) TO authenticated, service_role;

-- Managers can record only the three electricity events, and only with runId / lines / reversed.
-- new_row is built here. The run must already be posted or void by the same person.
CREATE OR REPLACE FUNCTION app.audit_event(p_org uuid, p_event text, p_detail jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_run uuid;
  v_status allocation_status;
  v_approved uuid;
  v_voided uuid;
  v_lines int;
  v_reversed int;
  v_computed timestamptz;
  v_row jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT app.has_role(p_org, '{admin,manager}') THEN
    RAISE EXCEPTION 'not allowed to audit this event' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_event NOT IN ('utility_charge_posted', 'utility_charge_reposted', 'utility_charge_voided') THEN
    RAISE EXCEPTION 'event not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_detail IS NULL OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'audit detail must be an object' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_detail) AS k(key)
     WHERE k.key NOT IN ('runId', 'lines', 'reversed')
  ) THEN
    RAISE EXCEPTION 'audit detail has unknown keys' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (p_detail ? 'runId') OR jsonb_typeof(p_detail->'runId') <> 'string' THEN
    RAISE EXCEPTION 'audit detail needs runId' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    v_run := (p_detail->>'runId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'audit runId is not a uuid' USING ERRCODE = 'check_violation';
  END;
  IF p_detail ? 'lines' THEN
    IF jsonb_typeof(p_detail->'lines') <> 'number'
       OR (p_detail->>'lines') !~ '^[0-9]+$'
       OR length(p_detail->>'lines') > 4
       OR (p_detail->>'lines')::int > 1000 THEN
      RAISE EXCEPTION 'audit lines out of range' USING ERRCODE = 'check_violation';
    END IF;
    v_lines := (p_detail->>'lines')::int;
  END IF;
  IF p_detail ? 'reversed' THEN
    IF jsonb_typeof(p_detail->'reversed') <> 'number'
       OR (p_detail->>'reversed') !~ '^[0-9]+$'
       OR length(p_detail->>'reversed') > 4
       OR (p_detail->>'reversed')::int > 1000 THEN
      RAISE EXCEPTION 'audit reversed out of range' USING ERRCODE = 'check_violation';
    END IF;
    v_reversed := (p_detail->>'reversed')::int;
  END IF;
  IF p_detail ? 'lines' AND p_detail ? 'reversed' AND v_reversed > v_lines THEN
    RAISE EXCEPTION 'audit reversed exceeds lines' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, approved_by, voided_by, computed_at
    INTO v_status, v_approved, v_voided, v_computed
    FROM utility_allocation_runs
   WHERE id = v_run AND org_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation run is not in this organization' USING ERRCODE = 'check_violation';
  END IF;
  IF p_event = 'utility_charge_voided' THEN
    IF v_status <> 'void' OR v_voided IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'void audit does not match the run' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_status <> 'posted' OR v_approved IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'post audit does not match the run' USING ERRCODE = 'check_violation';
  END IF;
  -- A posted run records that event once. A repost is recorded once per prepare (computed_at moves).
  IF p_event = 'utility_charge_posted' AND EXISTS (
    SELECT 1 FROM audit_log a
     WHERE a.org_id = p_org
       AND a.event_type = 'utility_charge_posted'
       AND a.new_row->>'runId' = v_run::text
  ) THEN
    RAISE EXCEPTION 'posted audit already recorded for this run' USING ERRCODE = 'check_violation';
  END IF;
  IF p_event = 'utility_charge_reposted' AND EXISTS (
    SELECT 1 FROM audit_log a
     WHERE a.org_id = p_org
       AND a.event_type = 'utility_charge_reposted'
       AND a.new_row->>'runId' = v_run::text
       AND a.occurred_at >= v_computed
  ) THEN
    RAISE EXCEPTION 'reposted audit already recorded for this run' USING ERRCODE = 'check_violation';
  END IF;
  v_row := jsonb_build_object('event', p_event, 'runId', v_run);
  IF p_detail ? 'lines' THEN
    v_row := v_row || jsonb_build_object('lines', v_lines);
  END IF;
  IF p_detail ? 'reversed' THEN
    v_row := v_row || jsonb_build_object('reversed', v_reversed);
  END IF;
  INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row, reason)
  VALUES (p_org, auth.uid(), 'app', 'auth_events', p_event, 'insert', p_event, v_row, p_event);
END $$;

REVOKE ALL ON FUNCTION app.audit_event(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit_event(uuid, text, jsonb) TO authenticated;
