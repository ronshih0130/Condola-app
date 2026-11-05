BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- #5: A source charge must belong to the line's organization and lease.
-- Preserve the existing organization-scoped foreign key.
ALTER TABLE public.lease_charges
  ADD CONSTRAINT b011_charge_org_lease_id_uq
  UNIQUE (org_id, lease_id, id);

ALTER TABLE app.deposit_settlement_lines
  ADD CONSTRAINT b011_line_charge_same_lease_fk
  FOREIGN KEY (org_id, lease_id, source_lease_charge_id)
  REFERENCES public.lease_charges (org_id, lease_id, id)
  MATCH SIMPLE
  ON UPDATE NO ACTION ON DELETE NO ACTION;

-- #6: Line-level evidence must reference a line in the same settlement.
-- Preserve the existing header and line foreign keys.
ALTER TABLE app.deposit_settlement_lines
  ADD CONSTRAINT b011_line_settlement_identity_uq
  UNIQUE (org_id, lease_id, settlement_id, id);

ALTER TABLE app.deposit_settlement_evidence
  ADD CONSTRAINT b011_evidence_line_same_settlement_fk
  FOREIGN KEY (org_id, lease_id, settlement_id, line_id)
  REFERENCES app.deposit_settlement_lines
    (org_id, lease_id, settlement_id, id)
  MATCH SIMPLE
  ON UPDATE NO ACTION ON DELETE NO ACTION;

-- Both foreign keys above validate existing rows when added.

-- #4: Caller-supplied payment retry keys are unique across the organization.
-- No generated default; external_ref remains an optional annotation.
ALTER TABLE app.deposit_settlement_payments
  ADD COLUMN request_id uuid,
  ADD COLUMN record_note text
    CHECK (record_note IS NULL OR char_length(record_note) <= 4000);

ALTER TABLE app.deposit_settlement_payments
  ADD CONSTRAINT b011_payment_org_request_uq
  UNIQUE (org_id, request_id);

ALTER TABLE app.deposit_settlement_payments
  ADD CONSTRAINT b011_payment_request_required
  CHECK (request_id IS NOT NULL) NOT VALID;

-- The payment baseline is empty; validate within this transaction.
ALTER TABLE app.deposit_settlement_payments
  VALIDATE CONSTRAINT b011_payment_request_required;

-- Document revisions are append-only. Existing headers retain revision zero.
ALTER TABLE app.deposit_settlement_records
  ADD COLUMN document_revision bigint NOT NULL DEFAULT 0
    CHECK (document_revision >= 0);

CREATE TABLE app.deposit_settlement_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  operation text NOT NULL
    CHECK (operation IN ('open','add_line','update_line','attach_evidence')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, settlement_id, revision),
  FOREIGN KEY (org_id, lease_id, settlement_id)
    REFERENCES app.deposit_settlement_records (org_id, lease_id, id)
);

ALTER TABLE app.deposit_settlement_confirmations
  ADD COLUMN document_revision bigint;

ALTER TABLE app.deposit_settlement_confirmations
  ADD CONSTRAINT b011_confirmation_revision_fk
  FOREIGN KEY (org_id, lease_id, settlement_id, document_revision)
  REFERENCES app.deposit_settlement_revisions
    (org_id, lease_id, settlement_id, revision);

ALTER TABLE app.deposit_settlement_confirmations
  ADD CONSTRAINT b011_confirmation_revision_required
  CHECK (document_revision IS NOT NULL AND document_revision > 0)
  NOT VALID;

-- The confirmation baseline is empty; no historical consent is inferred.
ALTER TABLE app.deposit_settlement_confirmations
  VALIDATE CONSTRAINT b011_confirmation_revision_required;

-- Fail-closed RLS with service-role-only append access.
ALTER TABLE app.deposit_settlement_revisions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON app.deposit_settlement_revisions
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT ON app.deposit_settlement_revisions TO service_role;

GRANT UPDATE (document_revision)
  ON app.deposit_settlement_records TO service_role;

-- Seed the single settlement flag OFF without overwriting an existing setting.
INSERT INTO public.platform_settings (key, value)
VALUES (
  'deposit_settlement',
  '{"enabled":false,"allowed_org_ids":[]}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
