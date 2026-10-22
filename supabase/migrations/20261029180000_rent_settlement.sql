-- Version 20261029180000.
-- Rent payment records and owner settlement, behind feature flag rent_settlement.
--
-- Additive only and safe to apply again. No new NOT NULL, CHECK, or foreign key
-- is added to an existing table. organizations.feature_flags already exists;
-- this only sets a jsonb key on sample (sandbox) and beta firms.
-- payment_corrections is a new append-only audit table. Older Workers do not read it.

UPDATE organizations
   SET feature_flags = coalesce(feature_flags, '{}'::jsonb) || '{"rent_settlement": true}'::jsonb
 WHERE environment = 'sandbox'
    OR plan_tier = 'beta';

CREATE TABLE IF NOT EXISTS payment_corrections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  payment_id           uuid NOT NULL,
  replaces_payment_id  uuid,
  kind                 text NOT NULL CHECK (kind IN ('record', 'correct', 'reverse')),
  reason               text NOT NULL CHECK (length(btrim(reason)) > 0),
  before_amount_minor  bigint,
  after_amount_minor   bigint,
  before_paid_on       date,
  after_paid_on        date,
  before_method        text,
  after_method         text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id),
  FOREIGN KEY (org_id, replaces_payment_id) REFERENCES payments (org_id, id)
);

CREATE INDEX IF NOT EXISTS payment_corrections_org_idx
  ON payment_corrections (org_id, created_at DESC);

ALTER TABLE payment_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_read ON payment_corrections;
CREATE POLICY team_read ON payment_corrections
  FOR SELECT TO authenticated
  USING (app.is_member(org_id));

DROP POLICY IF EXISTS team_insert ON payment_corrections;
CREATE POLICY team_insert ON payment_corrections
  FOR INSERT TO authenticated
  WITH CHECK (
    app.is_member(org_id)
    AND EXISTS (
      SELECT 1
        FROM organizations o
       WHERE o.id = org_id
         AND (o.environment = 'sandbox' OR o.plan_tier = 'beta')
         AND o.feature_flags ->> 'rent_settlement' = 'true'
    )
    AND (
      (kind IN ('record', 'correct') AND app.has_role(org_id, '{admin,manager,accountant}'::org_role[]))
      OR (kind = 'reverse' AND app.has_role(org_id, '{admin,accountant}'::org_role[]))
    )
  );

DROP TRIGGER IF EXISTS trg_payment_corrections_audit ON payment_corrections;
CREATE TRIGGER trg_payment_corrections_audit
  AFTER INSERT ON payment_corrections
  FOR EACH ROW EXECUTE FUNCTION fn_audit();

REVOKE ALL ON TABLE payment_corrections FROM PUBLIC, anon;
GRANT SELECT, INSERT ON TABLE payment_corrections TO authenticated, service_role;
REVOKE UPDATE, DELETE ON TABLE payment_corrections FROM authenticated;
