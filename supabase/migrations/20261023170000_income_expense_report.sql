-- Version 20261023170000.
-- Income vs expense by property, computed in Postgres so the Worker does not sum rows.
-- Income follows the same charge waterfall as attributePayment and skips deposit.
-- deposit_refund is not a waterfall charge. attributePayment sorts that unknown type
-- first because its rank is -1, then counts it as other income rather than deposit.
-- ord 0 matches that sort. The income sum keeps every charge except deposit.
-- Expenses use the owner-statement predicate: approved/posted and bill_to = owner.

CREATE INDEX IF NOT EXISTS payments_confirmed_period_idx
  ON payments (org_id, paid_on)
  WHERE status = 'confirmed';

CREATE OR REPLACE FUNCTION app.income_expense_report(
  p_org uuid,
  p_property uuid,
  p_owner uuid,
  p_start date,
  p_end date
)
RETURNS TABLE (
  property_id uuid,
  property_name text,
  owner_name text,
  currency text,
  income_minor bigint,
  expense_minor bigint,
  net_minor bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH props AS (
    SELECT
      p.id,
      p.name,
      p.currency,
      (
        SELECT c.display_name
          FROM property_owners po
          JOIN contacts c ON c.id = po.owner_contact_id
         WHERE po.property_id = p.id
           AND po.org_id = p.org_id
           AND po.effective_from <= p_end
           AND (po.effective_to IS NULL OR po.effective_to >= p_start)
         ORDER BY po.is_primary DESC, po.effective_from DESC
         LIMIT 1
      ) AS owner_name
      FROM properties p
     WHERE p.org_id = p_org
       AND app.is_member(p.org_id)
       AND p.archived_at IS NULL
       AND (p_property IS NULL OR p.id = p_property)
       AND (
         p_owner IS NULL
         OR EXISTS (
           SELECT 1
             FROM property_owners po
            WHERE po.property_id = p.id
              AND po.org_id = p.org_id
              AND po.owner_contact_id = p_owner
              AND po.effective_from <= p_end
              AND (po.effective_to IS NULL OR po.effective_to >= p_start)
         )
       )
  ),
  alloc AS (
    SELECT
      p.id AS property_id,
      a.id AS allocation_id,
      a.amount_minor AS paid,
      il.line_no,
      il.charge_type::text AS charge_type,
      il.amount_minor AS line_amount,
      CASE il.charge_type
        WHEN 'rent' THEN 1
        WHEN 'add_on' THEN 2
        WHEN 'late_fee' THEN 3
        WHEN 'one_off' THEN 4
        WHEN 'maintenance' THEN 5
        WHEN 'utility' THEN 6
        WHEN 'deposit' THEN 7
        WHEN 'adjustment' THEN 8
        WHEN 'credit' THEN 9
        ELSE 0
      END AS ord
      FROM payments pay
      JOIN leases l ON l.id = pay.lease_id
      JOIN props p ON p.id = l.property_id
      JOIN payment_allocations a ON a.payment_id = pay.id
      JOIN invoice_lines il ON il.invoice_id = a.invoice_id
     WHERE pay.org_id = p_org
       AND pay.status = 'confirmed'
       AND pay.paid_on BETWEEN p_start AND p_end
       AND pay.currency = p.currency
  ),
  taken AS (
    SELECT
      property_id,
      charge_type,
      LEAST(
        GREATEST(
          0,
          paid - COALESCE(
            SUM(GREATEST(line_amount, 0)) OVER (
              PARTITION BY allocation_id
              ORDER BY ord, line_no
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ),
            0
          )
        ),
        GREATEST(line_amount, 0)
      )::bigint AS take
      FROM alloc
  ),
  income AS (
    SELECT property_id, COALESCE(SUM(take), 0)::bigint AS income_minor
      FROM taken
     WHERE charge_type <> 'deposit'
     GROUP BY property_id
  ),
  expense_rows AS (
    SELECT e.property_id, e.amount_minor
      FROM expenses e
      JOIN props p ON p.id = e.property_id
     WHERE e.org_id = p_org
       AND status IN ('approved','posted') AND bill_to = 'owner'
       AND e.incurred_on BETWEEN p_start AND p_end
       AND e.currency = p.currency
  ),
  expense AS (
    SELECT property_id, COALESCE(SUM(amount_minor), 0)::bigint AS expense_minor
      FROM expense_rows
     GROUP BY property_id
  ),
  detail AS (
    SELECT
      p.id AS property_id,
      p.name AS property_name,
      p.owner_name,
      p.currency::text AS currency,
      COALESCE(i.income_minor, 0)::bigint AS income_minor,
      COALESCE(x.expense_minor, 0)::bigint AS expense_minor,
      (COALESCE(i.income_minor, 0) - COALESCE(x.expense_minor, 0))::bigint AS net_minor
      FROM props p
      LEFT JOIN income i ON i.property_id = p.id
      LEFT JOIN expense x ON x.property_id = p.id
  )
  SELECT property_id, property_name, owner_name, currency, income_minor, expense_minor, net_minor
    FROM detail
  UNION ALL
  SELECT
    NULL::uuid,
    NULL::text,
    NULL::text,
    currency,
    COALESCE(SUM(income_minor), 0)::bigint,
    COALESCE(SUM(expense_minor), 0)::bigint,
    COALESCE(SUM(net_minor), 0)::bigint
    FROM detail
   GROUP BY currency
  ORDER BY currency, property_id NULLS LAST, property_name NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION app.income_expense_report(uuid, uuid, uuid, date, date) TO authenticated, service_role;
