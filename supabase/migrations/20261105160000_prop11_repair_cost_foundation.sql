-- PROP-11 L1-RPR repair cost foundation. Additive, forward-only.
-- Build-only: no flag seed, public API, approval UI or money movement.
-- Cost allocation is not payment. Reuse public.cost_bearer and existing writers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The stack names tickets public.maintenance_tickets, with UNIQUE (org_id, id).
-- repair_vendor_jobs already has (org_id, id) unique via migration 20261030150700.
-- Reuse those keys; do not alter or index any existing table.
CREATE TABLE app.repair_cost_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  repair_vendor_job_id uuid,
  work_content text NOT NULL CHECK (char_length(work_content) BETWEEN 1 AND 4000),
  category text CHECK (category IN ('labor','material','service','other')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  incurred_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','void')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id),
  FOREIGN KEY (org_id, repair_vendor_job_id)
    REFERENCES public.repair_vendor_jobs(org_id, id)
);

CREATE TABLE app.repair_cost_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  cost_item_id uuid NOT NULL,
  bearer public.cost_bearer NOT NULL DEFAULT 'undecided',
  tenant_share_bp integer CHECK (tenant_share_bp BETWEEN 0 AND 10000),
  owner_share_bp integer CHECK (owner_share_bp BETWEEN 0 AND 10000),
  management_share_bp integer CHECK (management_share_bp BETWEEN 0 AND 10000),
  default_source text NOT NULL DEFAULT 'manual'
    CHECK (default_source IN ('lease','company','manual','undecided')),
  prior_bearer public.cost_bearer,
  prior_tenant_share_bp integer,
  prior_owner_share_bp integer,
  prior_management_share_bp integer,
  correction_reason text CHECK (char_length(correction_reason) <= 2000),
  corrected_at timestamptz,
  set_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (cost_item_id),
  CHECK (
    (bearer = 'split'
       AND tenant_share_bp IS NOT NULL AND owner_share_bp IS NOT NULL AND management_share_bp IS NOT NULL
       AND tenant_share_bp + owner_share_bp + management_share_bp = 10000)
    OR (bearer <> 'split'
       AND tenant_share_bp IS NULL AND owner_share_bp IS NULL AND management_share_bp IS NULL)
  ),
  CHECK (corrected_at IS NULL OR correction_reason IS NOT NULL),
  FOREIGN KEY (org_id, cost_item_id)
    REFERENCES app.repair_cost_items(org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id)
);

-- Future writers must check the attachment and vendor job belong to this ticket
-- and org, and any selected cost_item_id belongs to this same ticket.
-- ticket_attachment_id is a soft reference; no attachment writer changes here.
CREATE TABLE app.repair_cost_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  cost_item_id uuid,
  repair_vendor_job_id uuid,
  kind text NOT NULL CHECK (kind IN ('quote','receipt','invoice','work_photo','other')),
  ticket_attachment_id uuid,
  storage_path text UNIQUE,
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime text CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  is_ticket_photo boolean GENERATED ALWAYS AS (kind = 'work_photo') STORED,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (
    (ticket_attachment_id IS NOT NULL AND storage_path IS NULL)
    OR (storage_path IS NOT NULL AND ticket_attachment_id IS NULL)
  ),
  FOREIGN KEY (org_id, cost_item_id)
    REFERENCES app.repair_cost_items(org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id),
  FOREIGN KEY (org_id, repair_vendor_job_id)
    REFERENCES public.repair_vendor_jobs(org_id, id)
);

-- owner_statement_lines lacks UNIQUE (org_id, id): keep a soft UUID reference.
-- Before any future write/read, resolve owner_statement_line_id with BOTH
-- owner_statement_lines.id = owner_statement_line_id AND org_id = scoped org_id.
-- Reject missing/cross-org targets; this foundation has no writer or public read.
-- Future writers must also check vendor job / item / allocation ticket agreement.
CREATE TABLE app.repair_cost_statement_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  cost_item_id uuid NOT NULL,
  owner_statement_line_id uuid NOT NULL,
  repair_vendor_job_id uuid,
  link_kind text NOT NULL CHECK (link_kind IN ('expense','vendor_job','manual')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (owner_statement_line_id, cost_item_id),
  FOREIGN KEY (org_id, cost_item_id)
    REFERENCES app.repair_cost_items(org_id, id),
  FOREIGN KEY (org_id, repair_vendor_job_id)
    REFERENCES public.repair_vendor_jobs(org_id, id)
);

-- Visibility data only; B-013/B-021 must enforce viewers and exclude ticket
-- photos for accountants before exposing any reads. No policies are added here.
CREATE TABLE app.repair_cost_visibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  cost_item_id uuid NOT NULL,
  party_kind text NOT NULL CHECK (party_kind IN ('owner','tenant','vendor','accountant','manager')),
  can_view_financial boolean NOT NULL DEFAULT false,
  can_view_photos boolean NOT NULL DEFAULT false,
  basis text NOT NULL CHECK (basis IN ('bearer','property_owner','vendor_job','role_default','manual')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (cost_item_id, party_kind),
  FOREIGN KEY (org_id, cost_item_id)
    REFERENCES app.repair_cost_items(org_id, id)
);

-- FR-Q6-01 / B-018 reserve: per-period/component due amounts, record/display only.
-- source_ref_id is a soft reference across feature boundaries. Future consumers
-- must resolve it by source_ref_kind and verify the target org and lease scope.
CREATE TABLE app.tenant_period_due_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  period_ym text NOT NULL CHECK (period_ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  component_key text NOT NULL CHECK (char_length(component_key) BETWEEN 1 AND 120),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  source_ref_kind text NOT NULL
    CHECK (source_ref_kind IN ('lease_charge','repair_cost_item','deposit_settlement','manual','other')),
  source_ref_id uuid,
  note text CHECK (char_length(note) <= 2000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, lease_id, period_ym, component_key, source_ref_kind, source_ref_id),
  FOREIGN KEY (org_id, lease_id) REFERENCES public.leases(org_id, id)
);

ALTER TABLE app.repair_cost_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repair_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repair_cost_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repair_cost_statement_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.repair_cost_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_period_due_components ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  app.repair_cost_items,
  app.repair_cost_allocations,
  app.repair_cost_documents,
  app.repair_cost_statement_links,
  app.repair_cost_visibility,
  app.tenant_period_due_components
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON TABLE
  app.repair_cost_items,
  app.repair_cost_allocations,
  app.repair_cost_documents,
  app.repair_cost_statement_links,
  app.repair_cost_visibility,
  app.tenant_period_due_components
TO service_role;

-- Column-level UPDATE only; no DELETE grant (append-only evidence/links).
GRANT UPDATE (status, amount_minor, work_content, category, incurred_at)
  ON app.repair_cost_items TO service_role;
GRANT UPDATE (bearer, tenant_share_bp, owner_share_bp, management_share_bp,
  default_source, prior_bearer, prior_tenant_share_bp, prior_owner_share_bp,
  prior_management_share_bp, correction_reason, corrected_at, updated_at)
  ON app.repair_cost_allocations TO service_role;
GRANT UPDATE (can_view_financial, can_view_photos, basis)
  ON app.repair_cost_visibility TO service_role;

COMMIT;
