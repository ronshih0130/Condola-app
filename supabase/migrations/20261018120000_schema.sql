-- =============================================================================
-- PropertyOS (working name) - MVP schema, Postgres 15+ / Supabase
-- Source of truth: MVP_Scope_v0.2.md, Personas_Journeys_Needs_v0.3.md
-- Scope: long-term residential, Taiwan (lead market) + US, global-first core.
--
-- Conventions
--   * Every tenant-owned row carries org_id; child rows use composite FKs
--     (org_id, parent_id) so a row can never point at another org's data.
--   * Money = bigint in ISO-4217 minor units + char(3) currency code.
--     Rates (e.g. per kWh) = numeric minor units per usage unit (fractional OK).
--   * Ledger is append-only (no UPDATE/DELETE); corrections are reversals.
--   * Jurisdiction rules (deposit cap, electricity cap, late fee) are DATA.
--   * Secrets (LINE channel secret/token, ID-doc keys) are only REFERENCES to
--     Supabase Vault / KMS, never plaintext.
--   * RLS on every table in public. service_role bypasses RLS (backend jobs).
-- On plain Postgres, run supabase_stub.sql first (auth schema + auth.uid()).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

SET search_path = public;

-- -----------------------------------------------------------------------------
-- 0. Enums
-- -----------------------------------------------------------------------------
CREATE TYPE org_role            AS ENUM ('admin','manager','accountant','maintenance');
CREATE TYPE member_status       AS ENUM ('invited','active','suspended','removed');
CREATE TYPE invitation_kind     AS ENUM ('team_member','owner','tenant');
CREATE TYPE invitation_status   AS ENUM ('pending','accepted','revoked','expired');
CREATE TYPE rental_mode         AS ENUM ('whole_unit','by_room');
CREATE TYPE room_type           AS ENUM ('suite','shared_bath','studio','other');   -- suite=套房, shared_bath=雅房
CREATE TYPE lease_status        AS ENUM ('draft','pending_signature','active','ended','terminated','cancelled');
CREATE TYPE esign_status        AS ENUM ('not_sent','sent','partially_signed','fully_signed','declined','voided');
CREATE TYPE signature_status    AS ENUM ('pending','viewed','signed','declined');
CREATE TYPE signer_role         AS ENUM ('tenant','manager','owner','guarantor');
CREATE TYPE lease_party_role    AS ENUM ('primary','co_tenant','occupant','guarantor');
CREATE TYPE renewal_status      AS ENUM ('none','reminder_sent','offered','renewed','declined','month_to_month');
CREATE TYPE calendar_display    AS ENUM ('gregorian','roc');                           -- ROC/Minguo year option
CREATE TYPE fee_rule_kind       AS ENUM ('fixed','percent','hybrid','per_usage');
CREATE TYPE hybrid_mode         AS ENUM ('percent_with_minimum','greater_of','fixed_plus_percent');
CREATE TYPE fee_rule_purpose    AS ENUM ('management_fee','late_fee','add_on','utility');
CREATE TYPE fee_basis           AS ENUM ('collected_rent','billed_rent','flat','usage');
CREATE TYPE rounding_mode       AS ENUM ('half_up','half_even','down','up');
CREATE TYPE charge_frequency    AS ENUM ('one_time','monthly','quarterly','yearly','per_reading');
CREATE TYPE charge_type         AS ENUM ('rent','deposit','utility','add_on','late_fee','one_off','maintenance','credit','deposit_refund','adjustment');
CREATE TYPE utility_type        AS ENUM ('electricity','water','gas','internet','other');
CREATE TYPE split_method        AS ENUM ('none','even','days_occupied','sub_meter');
CREATE TYPE utility_payer       AS ENUM ('tenant','owner','manager','included_in_rent');
CREATE TYPE rate_source         AS ENUM ('fixed_rate','bill_average','pass_through_total');
CREATE TYPE allocation_status   AS ENUM ('draft','approved','posted','void');
CREATE TYPE invoice_status      AS ENUM ('draft','open','partially_paid','paid','void','written_off');
CREATE TYPE einvoice_status     AS ENUM ('not_applicable','pending','issued','voided','allowance_issued','failed');
CREATE TYPE einvoice_carrier    AS ENUM ('none','mobile_barcode','citizen_cert','member_carrier','donation','paper');
CREATE TYPE ledger_account      AS ENUM ('tenant_receivable','tenant_credit','deposits_held','cash_clearing',
                                         'rental_income','other_income','owner_payable','management_fee_income',
                                         'expense','reimbursement_payable','write_off');
CREATE TYPE ledger_txn_kind     AS ENUM ('invoice','payment','deposit_received','deposit_refund','credit_note',
                                         'expense','management_fee','owner_payout','reimbursement','reversal','adjustment');
CREATE TYPE payment_method      AS ENUM ('bank_transfer','cash','check','zelle','ach','card_offline','other');
CREATE TYPE payment_status      AS ENUM ('submitted','confirmed','rejected','reversed');
CREATE TYPE payment_source      AS ENUM ('tenant_portal','manager_entry','bank_import');
CREATE TYPE import_status       AS ENUM ('uploaded','parsing','parsed','failed','completed');
CREATE TYPE bank_txn_status     AS ENUM ('unmatched','suggested','matched','ignored');
CREATE TYPE match_status        AS ENUM ('suggested','approved','rejected','superseded');
CREATE TYPE ticket_status       AS ENUM ('open','triaged','assigned','in_progress','on_hold','resolved','closed','cancelled');
CREATE TYPE ticket_priority     AS ENUM ('low','normal','high','urgent');
CREATE TYPE ticket_category     AS ENUM ('plumbing','electrical','appliance','hvac','structural','pest','locks_keys','internet','cleaning','other');
CREATE TYPE cost_bearer         AS ENUM ('owner','tenant','manager','split','undecided');
CREATE TYPE approval_status     AS ENUM ('not_required','pending','approved','declined');
CREATE TYPE expense_status      AS ENUM ('draft','submitted','approved','rejected','posted','void');
CREATE TYPE reimbursement_status AS ENUM ('not_applicable','pending','approved','paid','rejected');
CREATE TYPE statement_status    AS ENUM ('draft','issued','void');
CREATE TYPE thread_kind         AS ENUM ('lease','announcement');
CREATE TYPE channel_type        AS ENUM ('in_app','email','sms','push','line');
CREATE TYPE delivery_status     AS ENUM ('queued','sent','delivered','read','failed','skipped');
CREATE TYPE line_oa_mode        AS ENUM ('platform_default','org_owned');
CREATE TYPE line_link_status    AS ENUM ('pending','linked','unlinked','blocked');
CREATE TYPE job_status          AS ENUM ('queued','running','succeeded','failed','cancelled','expired');
CREATE TYPE export_format       AS ENUM ('csv_zip','xlsx','json');
CREATE TYPE rule_enforcement    AS ENUM ('info','warn','override_required','hard_block');
CREATE TYPE rule_check_outcome  AS ENUM ('pass','warn','block','not_applicable','overridden');
CREATE TYPE legal_review_status AS ENUM ('unverified','verified','legal_reviewed');
CREATE TYPE id_doc_type         AS ENUM ('tw_national_id','arc_resident_cert','passport','drivers_license','other');
CREATE TYPE plan_tier           AS ENUM ('beta','free','pro','business');
CREATE TYPE audit_action        AS ENUM ('insert','update','delete');

-- -----------------------------------------------------------------------------
-- 1. Reference data (global, not org-scoped)
-- -----------------------------------------------------------------------------
CREATE TABLE currencies (
  code               char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_unit         smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4), -- ISO 4217 exponent (storage)
  display_decimals   smallint NOT NULL CHECK (display_decimals BETWEEN 0 AND 4), -- UI default (TWD shows 0)
  name               text NOT NULL
);
INSERT INTO currencies VALUES ('TWD',2,0,'New Taiwan Dollar'), ('USD',2,2,'US Dollar');

-- Platform-wide limits that orgs may tighten but never loosen.
CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value, description) VALUES
  ('id_documents.max_retention_days_after_close', '90',
   'Max days tenant ID documents are kept after the last lease ends AND its deposit is settled. Orgs may set fewer days, never more.');

CREATE TABLE jurisdictions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,              -- 'TW', 'TW-TPE', 'US', 'US-CA'
  parent_id     uuid REFERENCES jurisdictions(id),
  country_code  char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  name          text NOT NULL,
  default_currency char(3) REFERENCES currencies(code),
  default_locale   text,
  default_timezone text
);

-- Rules as data. org_id NULL = platform default; non-NULL = org override.
-- value schema per rule_key, e.g.
--   deposit.max_months                {"max_months": 2}
--   electricity.per_kwh_cap           {"basis":"bill_average_per_kwh","applies_to_leases_signed_on_or_after":"2024-07-15",
--                                      "non_per_kwh_cap":"bill_total"}
--   late_fee.warning_threshold        {"max_percent_of_rent": 10}
-- enforcement: warn = record + show; override_required = save only with a manager's
-- reason (audited); hard_block = never save. Lawyers move rules between modes as data.
CREATE TABLE jurisdiction_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id uuid NOT NULL REFERENCES jurisdictions(id),
  org_id          uuid,                              -- FK added after organizations
  rule_key        text NOT NULL,
  value           jsonb NOT NULL,
  enforcement     rule_enforcement NOT NULL DEFAULT 'warn', -- info | warn | override_required | hard_block
  effective_from  date NOT NULL DEFAULT '1900-01-01',
  effective_to    date,
  legal_status    legal_review_status NOT NULL DEFAULT 'unverified',
  source_url      text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX jurisdiction_rules_uniq
  ON jurisdiction_rules (jurisdiction_id, coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid), rule_key, effective_from);

-- -----------------------------------------------------------------------------
-- 2. Organizations, users, team
-- -----------------------------------------------------------------------------
CREATE TABLE organizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  legal_name       text,
  tax_id           text,                          -- TW 統一編號 / US EIN (optional)
  country_code     char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  jurisdiction_id  uuid REFERENCES jurisdictions(id),
  default_currency char(3) NOT NULL REFERENCES currencies(code),
  default_locale   text NOT NULL DEFAULT 'zh-TW' CHECK (default_locale ~ '^[a-z]{2}(-[A-Za-z0-9]{2,4})?$'),
  timezone         text NOT NULL DEFAULT 'Asia/Taipei',
  date_calendar    calendar_display NOT NULL DEFAULT 'gregorian',
  id_doc_retention_days smallint NOT NULL DEFAULT 90 CHECK (id_doc_retention_days >= 0), -- <= platform max (trigger)
  is_rental_mgmt_business boolean NOT NULL DEFAULT false, -- licensed 代管業者 vs self-managing landlord
  rental_mgmt_license_no  text,
  plan_tier        plan_tier NOT NULL DEFAULT 'beta',
  data_region      text NOT NULL DEFAULT 'ap-northeast-1',  -- Supabase project region; enables later US split
  feature_flags    jsonb NOT NULL DEFAULT '{"line_alerts": true, "branded_line_oa": false}'::jsonb, -- branded OA = paid add-on later
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- reminder defaults, misc
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE jurisdiction_rules ADD CONSTRAINT jurisdiction_rules_org_fk
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;

-- One row per auth user (Supabase pattern). A person can be team member in one org,
-- owner in another and tenant in a third: identity is the user, roles are relationships.
CREATE TABLE profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text,
  email         citext,
  phone_e164    text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  locale        text NOT NULL DEFAULT 'zh-TW' CHECK (locale ~ '^[a-z]{2}(-[A-Za-z0-9]{2,4})?$'),
  timezone      text NOT NULL DEFAULT 'Asia/Taipei',
  date_calendar calendar_display NOT NULL DEFAULT 'gregorian',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        org_role NOT NULL,
  is_billing_owner boolean NOT NULL DEFAULT false,   -- the account owner (always an admin)
  status      member_status NOT NULL DEFAULT 'active',
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id),
  UNIQUE (org_id, id),
  CHECK (NOT is_billing_owner OR role = 'admin')
);
CREATE UNIQUE INDEX org_members_one_billing_owner ON org_members(org_id) WHERE is_billing_owner;
CREATE INDEX org_members_user_idx ON org_members(user_id);

-- External parties of an org: owners, tenants, vendors, guarantors.
-- user_id is set once the person accepts a portal invite (owner portal / tenant app).
CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_owner      boolean NOT NULL DEFAULT false,
  is_tenant     boolean NOT NULL DEFAULT false,
  is_vendor     boolean NOT NULL DEFAULT false,
  display_name  text NOT NULL,
  legal_name    text,
  company_name  text,
  email         citext,
  phone_e164    text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  locale        text NOT NULL DEFAULT 'zh-TW',
  timezone      text,
  preferred_channel channel_type,
  vendor_trade  text,                                -- for vendors (no vendor app in MVP)
  bank_account_last5 text[] NOT NULL DEFAULT '{}',   -- known payer accounts (TW 末五碼) for matching
  notes         text,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (array_to_string(bank_account_last5, ',') ~ '^([0-9]{5}(,[0-9]{5})*)?$')
);
CREATE INDEX contacts_org_idx  ON contacts(org_id);
CREATE INDEX contacts_user_idx ON contacts(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX contacts_org_user_uniq ON contacts(org_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind          invitation_kind NOT NULL,
  role          org_role,                      -- team_member only
  contact_id    uuid,                          -- owner / tenant
  lease_id      uuid,                          -- tenant invites bind to a lease (FK added later)
  email         citext,
  phone_e164    text,
  code_hash     text NOT NULL UNIQUE,          -- sha256 of one-time invite code (LINE QR / link)
  status        invitation_status NOT NULL DEFAULT 'pending',
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '14 days',
  accepted_by   uuid REFERENCES auth.users(id),
  accepted_at   timestamptz,
  invited_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE,
  CHECK ((kind = 'team_member') = (role IS NOT NULL)),
  CHECK (kind = 'team_member' OR contact_id IS NOT NULL)
);
CREATE INDEX invitations_org_idx ON invitations(org_id, status);

-- Encrypted ID documents (tenant 身分證 / ARC / passport). File lives in a private
-- Storage bucket, encrypted client- or server-side with an envelope key in Vault/KMS.
CREATE TABLE identity_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  contact_id       uuid NOT NULL,
  doc_type         id_doc_type NOT NULL,
  issuing_country  char(2),
  number_masked    text,                       -- e.g. 'A12******9' only; full number never stored in clear
  number_hash      text,                       -- keyed HMAC for dedupe/lookup
  storage_bucket   text NOT NULL DEFAULT 'id-documents-private',
  storage_path     text NOT NULL,
  encryption_key_ref text NOT NULL,            -- Vault/KMS key id used to wrap the DEK
  encryption_alg   text NOT NULL DEFAULT 'AES-256-GCM',
  sha256_ciphertext text,
  expires_on       date,
  verified_by      uuid REFERENCES auth.users(id),
  verified_at      timestamptz,
  -- retention: due date computed by view id_documents_due_for_purge (org setting <= platform max)
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE
);
CREATE INDEX identity_documents_contact_idx ON identity_documents(org_id, contact_id);

-- Generic storage-object reference (Supabase Storage). Linked from specific tables.
CREATE TABLE files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  storage_bucket text NOT NULL,
  storage_path   text NOT NULL,
  file_name      text NOT NULL,
  mime_type      text,
  size_bytes     bigint CHECK (size_bytes >= 0),
  sha256         text,
  uploaded_by    uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (storage_bucket, storage_path)
);

-- -----------------------------------------------------------------------------
-- 3. Portfolio: Property > Unit > Room
-- -----------------------------------------------------------------------------
CREATE TABLE properties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  address         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- locale-aware parts; TW largest->smallest, US street-first
  address_display text,
  country_code    char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  jurisdiction_id uuid REFERENCES jurisdictions(id),    -- most specific, e.g. TW-TPE or US-CA
  currency        char(3) NOT NULL REFERENCES currencies(code),  -- one currency per property (scope F4)
  timezone        text NOT NULL,
  default_rental_mode rental_mode NOT NULL DEFAULT 'whole_unit',
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX properties_org_idx ON properties(org_id);

CREATE TABLE property_owners (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  property_id    uuid NOT NULL,
  owner_contact_id uuid NOT NULL,
  ownership_bp   integer NOT NULL DEFAULT 10000 CHECK (ownership_bp BETWEEN 1 AND 10000), -- basis points
  is_primary     boolean NOT NULL DEFAULT true,
  repair_approval_threshold_minor bigint CHECK (repair_approval_threshold_minor >= 0), -- P1 owner approval
  can_view_tenant_phone boolean NOT NULL DEFAULT false,   -- firm opt-in; owners never see ID docs
  effective_from date NOT NULL DEFAULT current_date,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (property_id, owner_contact_id, effective_from),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES contacts(org_id, id)
);
CREATE INDEX property_owners_owner_idx ON property_owners(owner_contact_id);

-- rental_mode is per unit: 'whole_unit' (整層) or 'by_room' (分房). It can be switched
-- while no active/pending lease conflicts (enforced in fn_lease_target_guard).
CREATE TABLE units (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  property_id   uuid NOT NULL,
  label         text NOT NULL,                       -- '5F-1', 'Apt 2B'
  floor         text,
  rental_mode   rental_mode NOT NULL DEFAULT 'whole_unit',
  bedrooms      smallint,
  bathrooms     numeric(3,1),
  area_value    numeric(10,2),
  area_unit     text CHECK (area_unit IN ('ping','m2','sqft')),   -- 坪 common in TW
  base_rent_minor bigint CHECK (base_rent_minor >= 0),
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (property_id, label),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE CASCADE
);

CREATE TABLE rooms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  unit_id       uuid NOT NULL,
  label         text NOT NULL,                       -- 'A', 'Room 1'
  room_type     room_type NOT NULL DEFAULT 'suite',
  area_value    numeric(10,2),
  area_unit     text CHECK (area_unit IN ('ping','m2','sqft')),
  base_rent_minor bigint CHECK (base_rent_minor >= 0),
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (unit_id, label),
  UNIQUE (unit_id, id),
  FOREIGN KEY (org_id, unit_id) REFERENCES units(org_id, id) ON DELETE CASCADE
);

CREATE TABLE import_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity       text NOT NULL CHECK (entity IN ('portfolio','contacts','leases','opening_balances')),
  file_id      uuid,
  column_map   jsonb,
  status       job_status NOT NULL DEFAULT 'queued',
  rows_total   integer, rows_ok integer, rows_failed integer,
  error_report jsonb,
  requested_by uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id)
);

-- -----------------------------------------------------------------------------
-- 4. Fee rules (management fee, late fee, add-ons, utility rates)
-- -----------------------------------------------------------------------------
-- fixed:    amount = fixed_amount_minor
-- percent:  amount = basis * percent_bp / 10000
-- hybrid:   percent_with_minimum -> max(percent, minimum_minor)
--           greater_of           -> max(percent, fixed_amount_minor)
--           fixed_plus_percent   -> fixed_amount_minor + percent
-- per_usage: amount = usage * rate_minor_per_unit   (e.g. NT$/kWh)
-- All rules may also cap at maximum_minor.
CREATE TABLE fee_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                text NOT NULL,
  purpose             fee_rule_purpose NOT NULL,
  kind                fee_rule_kind NOT NULL,
  hybrid_mode         hybrid_mode,
  basis               fee_basis NOT NULL DEFAULT 'flat',
  currency            char(3) NOT NULL REFERENCES currencies(code),
  fixed_amount_minor  bigint CHECK (fixed_amount_minor >= 0),
  percent_bp          integer CHECK (percent_bp BETWEEN 0 AND 100000),  -- 850 = 8.5%
  minimum_minor       bigint CHECK (minimum_minor >= 0),
  maximum_minor       bigint CHECK (maximum_minor >= 0),
  rate_minor_per_unit numeric(18,6) CHECK (rate_minor_per_unit >= 0),
  usage_unit          text,                                -- 'kWh', 'm3'
  grace_days          smallint CHECK (grace_days >= 0),    -- late fee
  rounding            rounding_mode NOT NULL DEFAULT 'half_up',
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (kind <> 'fixed'     OR fixed_amount_minor IS NOT NULL),
  CHECK (kind <> 'percent'   OR percent_bp IS NOT NULL),
  CHECK (kind <> 'hybrid'    OR (percent_bp IS NOT NULL AND hybrid_mode IS NOT NULL AND
         (hybrid_mode <> 'percent_with_minimum' OR minimum_minor IS NOT NULL) AND
         (hybrid_mode =  'percent_with_minimum' OR fixed_amount_minor IS NOT NULL))),
  CHECK (kind <> 'per_usage' OR (rate_minor_per_unit IS NOT NULL AND usage_unit IS NOT NULL)),
  CHECK ((kind = 'hybrid') = (hybrid_mode IS NOT NULL)),
  CHECK (minimum_minor IS NULL OR maximum_minor IS NULL OR minimum_minor <= maximum_minor)
);

-- Management agreement: which fee rule applies to an owner (optionally per property).
CREATE TABLE management_agreements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  owner_contact_id uuid NOT NULL,
  property_id      uuid,                         -- NULL = all of this owner's properties
  fee_rule_id      uuid NOT NULL,
  effective_from   date NOT NULL,
  effective_to     date,
  document_file_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES contacts(org_id, id),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, fee_rule_id) REFERENCES fee_rules(org_id, id),
  FOREIGN KEY (org_id, document_file_id) REFERENCES files(org_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX management_agreements_owner_idx ON management_agreements(org_id, owner_contact_id);

-- -----------------------------------------------------------------------------
-- 5. Lease templates (versioned; incl. TW government standard residential lease)
-- -----------------------------------------------------------------------------
CREATE TABLE lease_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = platform template
  jurisdiction_id uuid REFERENCES jurisdictions(id),
  code            text NOT NULL,             -- 'TW_GOV_STANDARD_RESIDENTIAL', 'US_GENERIC'
  name            text NOT NULL,
  is_government_standard boolean NOT NULL DEFAULT false,
  source_authority text,                     -- e.g. 內政部 (MOI)
  forked_from_template_id uuid REFERENCES lease_templates(id),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX lease_templates_code_uniq
  ON lease_templates (coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid), code);

-- Versions are immutable once published (trigger below).
CREATE TABLE lease_template_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES lease_templates(id) ON DELETE CASCADE,
  version         integer NOT NULL CHECK (version > 0),
  version_label   text,                      -- official revision label / date
  locales         text[] NOT NULL DEFAULT '{zh-TW}',
  body_storage_path text,                    -- template source (HTML/Markdown) in storage
  body            text,
  variables_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  disclaimer_key  text,                      -- i18n key, e.g. 'lease.disclaimer.no_legal_guarantee'
  source_url      text,
  official_effective_from date,
  legal_status    legal_review_status NOT NULL DEFAULT 'unverified',
  published_at    timestamptz,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

-- -----------------------------------------------------------------------------
-- 6. Leases
-- -----------------------------------------------------------------------------
-- Target: exactly one of target_unit_id / target_room_id. unit_id is ALWAYS the
-- containing unit (for room leases it is the room's unit), kept consistent by trigger
-- and composite FK (unit_id, target_room_id) -> rooms(unit_id, id).
CREATE TABLE leases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  property_id        uuid NOT NULL,
  unit_id            uuid NOT NULL,
  target_unit_id     uuid,
  target_room_id     uuid,
  status             lease_status NOT NULL DEFAULT 'draft',
  esign_status       esign_status NOT NULL DEFAULT 'not_sent',
  start_date         date NOT NULL,
  end_date           date,                                   -- NULL = open-ended / month-to-month
  term               daterange GENERATED ALWAYS AS (daterange(start_date, end_date, '[]')) STORED,
  currency           char(3) NOT NULL REFERENCES currencies(code),
  rent_amount_minor  bigint NOT NULL CHECK (rent_amount_minor >= 0),
  rent_frequency     charge_frequency NOT NULL DEFAULT 'monthly' CHECK (rent_frequency IN ('monthly','quarterly','yearly')),
  due_day            smallint NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 31), -- 31 = last day of month
  prorate_first_period boolean NOT NULL DEFAULT true,
  deposit_amount_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_amount_minor >= 0),
  deposit_months     numeric(4,2) CHECK (deposit_months >= 0),  -- as entered ("2 months"), for cap checks
  late_fee_rule_id   uuid,
  template_version_id uuid REFERENCES lease_template_versions(id),   -- reserved per scope v0.2 Q3
  template_variables jsonb,
  document_file_id   uuid,                                    -- uploaded or generated PDF
  document_sha256    text,                                    -- hash of exactly what was signed
  date_calendar      calendar_display NOT NULL DEFAULT 'gregorian',
  document_locales   text[] NOT NULL DEFAULT '{zh-TW}',      -- bilingual option
  signed_at          timestamptz,                             -- fully executed; drives TW electricity cap applicability
  previous_lease_id  uuid,                                    -- renewal chain
  renewal_status     renewal_status NOT NULL DEFAULT 'none',
  renewal_reminder_days smallint[] NOT NULL DEFAULT '{60,30}',
  terminated_on      date,
  termination_reason text,
  deposit_settled_at timestamptz,                          -- deposit refunded/applied; starts ID-doc retention clock
  notes              text,
  created_by         uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, unit_id)     REFERENCES units(org_id, id),
  FOREIGN KEY (org_id, target_room_id) REFERENCES rooms(org_id, id),
  FOREIGN KEY (unit_id, target_room_id) REFERENCES rooms(unit_id, id),
  FOREIGN KEY (org_id, late_fee_rule_id) REFERENCES fee_rules(org_id, id),
  FOREIGN KEY (org_id, document_file_id) REFERENCES files(org_id, id),
  FOREIGN KEY (org_id, previous_lease_id) REFERENCES leases(org_id, id),
  CHECK (num_nonnulls(target_unit_id, target_room_id) = 1),
  CHECK (target_unit_id IS NULL OR target_unit_id = unit_id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (previous_lease_id IS NULL OR previous_lease_id <> id),
  -- no double-booking of the same space (draft/cancelled leases don't block)
  EXCLUDE USING gist (target_unit_id WITH =, term WITH &&)
    WHERE (target_unit_id IS NOT NULL AND status IN ('pending_signature','active')),
  EXCLUDE USING gist (target_room_id WITH =, term WITH &&)
    WHERE (target_room_id IS NOT NULL AND status IN ('pending_signature','active'))
);
CREATE INDEX leases_org_status_idx ON leases(org_id, status);
CREATE INDEX leases_unit_idx  ON leases(unit_id);
CREATE INDEX leases_room_idx  ON leases(target_room_id) WHERE target_room_id IS NOT NULL;
CREATE INDEX leases_end_idx   ON leases(org_id, end_date) WHERE status = 'active';
CREATE INDEX leases_term_gist ON leases USING gist (unit_id, term);
ALTER TABLE invitations ADD CONSTRAINT invitations_lease_fk FOREIGN KEY (org_id, lease_id) REFERENCES leases(org_id, id) ON DELETE CASCADE;

CREATE TABLE lease_parties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  lease_id    uuid NOT NULL,
  contact_id  uuid NOT NULL,
  role        lease_party_role NOT NULL DEFAULT 'primary',
  rent_share_bp integer CHECK (rent_share_bp BETWEEN 0 AND 10000),  -- optional split between co-tenants
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lease_id, contact_id),
  FOREIGN KEY (org_id, lease_id)   REFERENCES leases(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)
);
CREATE INDEX lease_parties_contact_idx ON lease_parties(contact_id);

-- Click-to-sign. One row per required signer; events table is the append-only trail.
CREATE TABLE lease_signatures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  lease_id      uuid NOT NULL,
  signer_role   signer_role NOT NULL,
  contact_id    uuid,                    -- tenant / owner / guarantor
  member_id     uuid,                    -- manager countersign
  status        signature_status NOT NULL DEFAULT 'pending',
  signing_order smallint NOT NULL DEFAULT 1,
  signed_name   text,
  signature_file_id uuid,                -- drawn signature image
  document_sha256 text,                  -- hash of the version signed
  consent_text_key text,                 -- i18n key + version of the e-sign consent
  signed_at     timestamptz,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lease_id)   REFERENCES leases(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id),
  FOREIGN KEY (org_id, member_id)  REFERENCES org_members(org_id, id),
  FOREIGN KEY (org_id, signature_file_id) REFERENCES files(org_id, id),
  CHECK (num_nonnulls(contact_id, member_id) = 1),
  CHECK (status <> 'signed' OR (signed_at IS NOT NULL AND document_sha256 IS NOT NULL))
);

CREATE TABLE lease_signature_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL,
  signature_id  uuid NOT NULL,
  event         text NOT NULL CHECK (event IN ('sent','opened','viewed_document','consented','signed','declined','reminded','voided')),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES auth.users(id),
  ip_address    inet,
  user_agent    text,
  document_sha256 text,
  details       jsonb,
  FOREIGN KEY (org_id, signature_id) REFERENCES lease_signatures(org_id, id) ON DELETE CASCADE
);

-- Recurring add-on charges on a lease (fixed management/cleaning/internet fee,
-- or metered utility linked to a meter + allocation).
CREATE TABLE lease_charges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  lease_id      uuid NOT NULL,
  charge_type   charge_type NOT NULL DEFAULT 'add_on' CHECK (charge_type IN ('add_on','utility','rent')),
  label_key     text,                     -- i18n key or free text
  description   text,
  fee_rule_id   uuid,                     -- fixed / percent / per_usage
  meter_id      uuid,                     -- metered utility (FK added after meters)
  frequency     charge_frequency NOT NULL DEFAULT 'monthly',
  start_date    date NOT NULL,
  end_date      date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lease_id)    REFERENCES leases(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, fee_rule_id) REFERENCES fee_rules(org_id, id),
  CHECK (fee_rule_id IS NOT NULL OR meter_id IS NOT NULL)
);

-- Results of jurisdiction-rule checks (deposit cap, late fee, electricity cap),
-- stored so the warning shown and any override are auditable.
CREATE TABLE rule_check_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id       uuid NOT NULL REFERENCES jurisdiction_rules(id),
  entity_table  text NOT NULL,
  entity_id     uuid NOT NULL,
  outcome       rule_check_outcome NOT NULL,
  observed      jsonb NOT NULL,          -- e.g. {"deposit_months":2.5}
  limit_value   jsonb NOT NULL,          -- e.g. {"max_months":2}
  message_key   text,
  overridden_by uuid REFERENCES auth.users(id),
  override_reason text,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome <> 'overridden' OR (overridden_by IS NOT NULL AND override_reason IS NOT NULL))
);
CREATE INDEX rule_check_results_entity_idx ON rule_check_results(entity_table, entity_id);

-- Every access to an ID document (signed URL issued, download) is logged.
CREATE TABLE identity_document_access_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL,
  document_id   uuid NOT NULL REFERENCES identity_documents(id) ON DELETE CASCADE,
  accessed_by   uuid REFERENCES auth.users(id),
  purpose       text NOT NULL,
  signed_url_expires_at timestamptz,
  accessed_at   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 7. Utilities: meters, readings, source bills, auditable allocations
-- -----------------------------------------------------------------------------
-- A meter hangs off exactly one space: a unit (shared meter) or a room (sub-meter).
-- Room sub-meters point at their parent unit meter via parent_meter_id.
CREATE TABLE meters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  property_id      uuid NOT NULL,
  unit_id          uuid NOT NULL,                 -- containing unit (always set)
  room_id          uuid,                          -- set => room sub-meter
  parent_meter_id  uuid,
  utility          utility_type NOT NULL,
  usage_unit       text NOT NULL DEFAULT 'kWh',   -- 'kWh', 'm3', 'degree(度)' = kWh
  label            text,
  serial_number    text,                          -- Taipower 電號 for the main meter
  payer            utility_payer NOT NULL DEFAULT 'tenant',
  split_method     split_method NOT NULL DEFAULT 'none',  -- for unit meters shared across rooms
  rate_source      rate_source NOT NULL DEFAULT 'fixed_rate',
  rate_minor_per_unit numeric(18,6) CHECK (rate_minor_per_unit >= 0),  -- e.g. 550.000000 = NT$5.50/kWh
  billing_cycle_months smallint NOT NULL DEFAULT 2 CHECK (billing_cycle_months BETWEEN 1 AND 12), -- Taipower bills bi-monthly
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, unit_id)     REFERENCES units(org_id, id),
  FOREIGN KEY (unit_id, room_id)    REFERENCES rooms(unit_id, id),
  FOREIGN KEY (org_id, parent_meter_id) REFERENCES meters(org_id, id),
  CHECK (room_id IS NULL OR split_method = 'none'),            -- sub-meters don't split further
  CHECK (parent_meter_id IS NULL OR room_id IS NOT NULL),      -- only room meters have a parent
  CHECK (rate_source <> 'fixed_rate' OR rate_minor_per_unit IS NOT NULL OR payer IN ('owner','included_in_rent'))
);
CREATE INDEX meters_unit_idx ON meters(unit_id);
ALTER TABLE lease_charges ADD CONSTRAINT lease_charges_meter_fk FOREIGN KEY (org_id, meter_id) REFERENCES meters(org_id, id);

-- Readings are append-only; a correction is a new row with supersedes_id.
CREATE TABLE meter_readings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  meter_id       uuid NOT NULL,
  read_on        date NOT NULL,
  value          numeric(14,3) NOT NULL CHECK (value >= 0),
  is_estimate    boolean NOT NULL DEFAULT false,
  photo_file_id  uuid,
  supersedes_id  uuid REFERENCES meter_readings(id),
  read_by        uuid REFERENCES auth.users(id),
  submitted_by_contact_id uuid,                   -- tenant-submitted reading
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, meter_id) REFERENCES meters(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, photo_file_id) REFERENCES files(org_id, id),
  FOREIGN KEY (org_id, submitted_by_contact_id) REFERENCES contacts(org_id, id)
);
CREATE INDEX meter_readings_meter_idx ON meter_readings(meter_id, read_on DESC);

-- The utility's own bill for a period (e.g. Taipower). avg price per unit is the
-- TW legal cap basis: 當期每度平均電價 = total amount / total kWh.
CREATE TABLE utility_bills (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  meter_id           uuid NOT NULL,
  provider           text,                         -- 'Taipower', 'Taipei Water'
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  currency           char(3) NOT NULL REFERENCES currencies(code),
  total_amount_minor bigint NOT NULL CHECK (total_amount_minor >= 0),
  total_usage        numeric(14,3) NOT NULL CHECK (total_usage > 0),
  avg_price_minor_per_unit numeric(18,6) GENERATED ALWAYS AS (round(total_amount_minor::numeric / total_usage, 6)) STORED,
  bill_avg_price_as_printed numeric(18,6),        -- if the bill prints its own average, store it too
  bill_file_id       uuid,
  entered_by         uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (meter_id, period_start, period_end),
  FOREIGN KEY (org_id, meter_id) REFERENCES meters(org_id, id),
  FOREIGN KEY (org_id, bill_file_id) REFERENCES files(org_id, id),
  CHECK (period_end > period_start)
);

-- One run = one computed split of a (unit) meter's usage/cost for a period.
-- Every input is snapshotted so the result can be re-derived and audited.
CREATE TABLE utility_allocation_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  meter_id            uuid NOT NULL,
  utility_bill_id     uuid,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  split_method        split_method NOT NULL,   -- 'none' = single-lease meter (still records rate cap check)
  rate_source         rate_source NOT NULL,
  currency            char(3) NOT NULL REFERENCES currencies(code),
  start_reading_id    uuid,
  end_reading_id      uuid,
  total_usage         numeric(14,3) NOT NULL CHECK (total_usage >= 0),
  common_area_usage   numeric(14,3) NOT NULL DEFAULT 0,  -- sub_meter: parent minus sum(sub-meters)
  common_area_policy  text NOT NULL DEFAULT 'split_evenly' CHECK (common_area_policy IN ('split_evenly','split_by_days','owner_absorbs','ignore')),
  rate_minor_per_unit numeric(18,6) NOT NULL CHECK (rate_minor_per_unit >= 0),
  cap_rule_id         uuid REFERENCES jurisdiction_rules(id),
  cap_minor_per_unit  numeric(18,6),                      -- snapshot of the bill average at compute time
  rate_exceeds_cap    boolean,
  cap_override_reason text,                               -- required to save an over-cap charge (override_required)
  cap_overridden_by   uuid REFERENCES auth.users(id),
  cap_overridden_at   timestamptz,
  total_amount_minor  bigint NOT NULL CHECK (total_amount_minor >= 0),
  inputs              jsonb NOT NULL DEFAULT '{}'::jsonb, -- occupancy days, readings, rounding, algorithm version
  algorithm_version   text NOT NULL DEFAULT 'v1',
  status              allocation_status NOT NULL DEFAULT 'draft',
  computed_by         uuid REFERENCES auth.users(id),
  computed_at         timestamptz NOT NULL DEFAULT now(),
  approved_by         uuid REFERENCES auth.users(id),
  approved_at         timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, meter_id)        REFERENCES meters(org_id, id),
  FOREIGN KEY (org_id, utility_bill_id) REFERENCES utility_bills(org_id, id),
  FOREIGN KEY (org_id, start_reading_id) REFERENCES meter_readings(org_id, id),
  FOREIGN KEY (org_id, end_reading_id)   REFERENCES meter_readings(org_id, id),
  CHECK (period_end > period_start),
  CHECK (status NOT IN ('approved','posted') OR approved_by IS NOT NULL),
  CHECK (cap_override_reason IS NULL OR btrim(cap_override_reason) <> ''),
  CHECK ((cap_override_reason IS NULL) = (cap_overridden_by IS NULL))
);
CREATE INDEX utility_allocation_runs_meter_idx ON utility_allocation_runs(meter_id, period_start);

CREATE TABLE utility_allocation_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  run_id          uuid NOT NULL,
  lease_id        uuid,                   -- NULL => vacant room / common area share absorbed by owner
  room_id         uuid,
  days_occupied   integer CHECK (days_occupied >= 0),
  sub_meter_usage numeric(14,3),
  share_ratio     numeric(12,10) NOT NULL CHECK (share_ratio BETWEEN 0 AND 1),
  allocated_usage numeric(14,3) NOT NULL CHECK (allocated_usage >= 0),
  amount_minor    bigint NOT NULL CHECK (amount_minor >= 0),
  bearer          utility_payer NOT NULL DEFAULT 'tenant',
  cap_applies     boolean NOT NULL DEFAULT false,   -- e.g. TW lease signed on/after 2024-07-15
  explanation     jsonb,                            -- human-readable derivation for the tenant (kWh x rate)
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, run_id)   REFERENCES utility_allocation_runs(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, lease_id) REFERENCES leases(org_id, id),
  FOREIGN KEY (org_id, room_id)  REFERENCES rooms(org_id, id)
);
CREATE INDEX utility_allocation_lines_run_idx ON utility_allocation_lines(run_id);

-- -----------------------------------------------------------------------------
-- 8. Billing: invoices (tenant charges)
-- -----------------------------------------------------------------------------
CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  property_id     uuid NOT NULL,
  lease_id        uuid NOT NULL,
  bill_to_contact_id uuid,
  invoice_number  text NOT NULL,                  -- org-sequential, human readable
  currency        char(3) NOT NULL REFERENCES currencies(code),
  issue_date      date NOT NULL DEFAULT current_date,
  due_date        date NOT NULL,
  period_start    date,
  period_end      date,
  status          invoice_status NOT NULL DEFAULT 'draft',
  total_minor     bigint NOT NULL DEFAULT 0,      -- maintained from lines
  paid_minor      bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  balance_minor   bigint GENERATED ALWAYS AS (total_minor - paid_minor) STORED,
  source          text NOT NULL DEFAULT 'recurring' CHECK (source IN ('recurring','one_off','utility','move_in','late_fee','import')),
  ledger_transaction_id uuid,
  -- TW e-invoice (電子發票) placeholders: not issued in MVP (scope v0.3 Q3)
  einvoice_status       einvoice_status NOT NULL DEFAULT 'not_applicable',
  einvoice_number       text CHECK (einvoice_number IS NULL OR einvoice_number ~ '^[A-Z]{2}[0-9]{8}$'),
  einvoice_random_code  char(4),
  einvoice_carrier_type einvoice_carrier,
  einvoice_carrier_id   text,
  einvoice_buyer_ubn    char(8),                  -- 統一編號 for B2B
  einvoice_issued_at    timestamptz,
  voided_at       timestamptz,
  void_reason     text,
  created_by      uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, invoice_number),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, lease_id)    REFERENCES leases(org_id, id),
  FOREIGN KEY (org_id, bill_to_contact_id) REFERENCES contacts(org_id, id),
  CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
CREATE INDEX invoices_lease_idx ON invoices(lease_id, due_date);
CREATE INDEX invoices_open_idx  ON invoices(org_id, due_date) WHERE status IN ('open','partially_paid');

CREATE TABLE invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  invoice_id      uuid NOT NULL,
  line_no         smallint NOT NULL,
  charge_type     charge_type NOT NULL,
  description     text NOT NULL,
  quantity        numeric(14,3) NOT NULL DEFAULT 1,
  unit_amount_minor numeric(18,6) NOT NULL,       -- may be fractional (per kWh)
  amount_minor    bigint NOT NULL,                -- rounded line total; negative for credits
  lease_charge_id uuid,
  allocation_line_id uuid,
  ticket_id       uuid,                           -- maintenance cost charged to tenant (FK later)
  fee_rule_id     uuid,
  service_period  daterange,
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, lease_charge_id) REFERENCES lease_charges(org_id, id),
  FOREIGN KEY (org_id, allocation_line_id) REFERENCES utility_allocation_lines(org_id, id),
  FOREIGN KEY (org_id, fee_rule_id) REFERENCES fee_rules(org_id, id),
  CHECK (charge_type IN ('credit','adjustment','deposit_refund') OR amount_minor >= 0)
);
CREATE UNIQUE INDEX invoice_lines_alloc_uniq ON invoice_lines(allocation_line_id) WHERE allocation_line_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 9. Ledger (append-only, double-entry-style; balanced per currency)
-- -----------------------------------------------------------------------------
-- Not full trust accounting (out of MVP) but every transaction has entries that
-- sum to zero, so it can grow into double-entry. No UPDATE/DELETE: fix = reversal.
-- Convention: amount_minor > 0 = debit, < 0 = credit.
CREATE TABLE ledger_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  property_id      uuid,
  lease_id         uuid,
  kind             ledger_txn_kind NOT NULL,
  currency         char(3) NOT NULL REFERENCES currencies(code),
  effective_date   date NOT NULL,
  description      text,
  source_table     text,                     -- 'invoices','payments','expenses',...
  source_id        uuid,
  reverses_transaction_id uuid,
  reason           text,                     -- required for reversals/adjustments
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, lease_id)    REFERENCES leases(org_id, id),
  FOREIGN KEY (org_id, reverses_transaction_id) REFERENCES ledger_transactions(org_id, id),
  CHECK (kind NOT IN ('reversal','adjustment') OR reason IS NOT NULL),
  CHECK ((kind = 'reversal') = (reverses_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_one_reversal ON ledger_transactions(reverses_transaction_id) WHERE reverses_transaction_id IS NOT NULL;
CREATE INDEX ledger_transactions_source_idx ON ledger_transactions(source_table, source_id);
CREATE INDEX ledger_transactions_lease_idx ON ledger_transactions(lease_id, effective_date);

CREATE TABLE ledger_entries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           uuid NOT NULL,
  transaction_id   uuid NOT NULL,
  account          ledger_account NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor <> 0),
  currency         char(3) NOT NULL REFERENCES currencies(code),
  contact_id       uuid,                    -- tenant or owner sub-ledger
  property_id      uuid,
  lease_id         uuid,
  invoice_id       uuid,
  memo             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, transaction_id) REFERENCES ledger_transactions(org_id, id),
  FOREIGN KEY (org_id, contact_id)  REFERENCES contacts(org_id, id),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, lease_id)    REFERENCES leases(org_id, id),
  FOREIGN KEY (org_id, invoice_id)  REFERENCES invoices(org_id, id)
);
CREATE INDEX ledger_entries_txn_idx ON ledger_entries(transaction_id);
CREATE INDEX ledger_entries_acct_idx ON ledger_entries(org_id, account, currency);
CREATE INDEX ledger_entries_contact_idx ON ledger_entries(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX ledger_entries_lease_idx ON ledger_entries(lease_id) WHERE lease_id IS NOT NULL;
ALTER TABLE invoices ADD CONSTRAINT invoices_ledger_txn_fk FOREIGN KEY (org_id, ledger_transaction_id) REFERENCES ledger_transactions(org_id, id);

-- -----------------------------------------------------------------------------
-- 10. Payments (recorded, never processed: no money moves through us)
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  property_id        uuid NOT NULL,
  lease_id           uuid NOT NULL,
  payer_contact_id   uuid,
  currency           char(3) NOT NULL REFERENCES currencies(code),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  paid_on            date NOT NULL,
  method             payment_method NOT NULL,
  payer_account_last5 char(5) CHECK (payer_account_last5 ~ '^[0-9]{5}$'),  -- TW 帳號末五碼
  reference          text,                    -- Zelle conf / check no / memo
  proof_file_id      uuid,
  status             payment_status NOT NULL DEFAULT 'submitted',
  source             payment_source NOT NULL,
  submitted_by       uuid REFERENCES auth.users(id),
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_by       uuid REFERENCES auth.users(id),
  confirmed_at       timestamptz,
  rejected_reason    text,
  bank_transaction_id uuid,                   -- set when matched to a bank line
  ledger_transaction_id uuid,
  is_deposit         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, lease_id) REFERENCES leases(org_id, id),
  FOREIGN KEY (org_id, payer_contact_id) REFERENCES contacts(org_id, id),
  FOREIGN KEY (org_id, proof_file_id) REFERENCES files(org_id, id),
  FOREIGN KEY (org_id, ledger_transaction_id) REFERENCES ledger_transactions(org_id, id),
  CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (status <> 'rejected'  OR rejected_reason IS NOT NULL)
);
CREATE INDEX payments_inbox_idx ON payments(org_id, status, submitted_at) WHERE status = 'submitted';
CREATE INDEX payments_last5_idx ON payments(org_id, payer_account_last5, amount_minor) WHERE payer_account_last5 IS NOT NULL;
CREATE INDEX payments_lease_idx ON payments(lease_id, paid_on);

CREATE TABLE payment_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  payment_id   uuid NOT NULL,
  invoice_id   uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_by   uuid REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, invoice_id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);

-- -----------------------------------------------------------------------------
-- 11. Bank reconciliation (CSV upload -> suggested matches -> manager approves)
-- -----------------------------------------------------------------------------
CREATE TABLE bank_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id   uuid,                         -- optional: account dedicated to a property/owner
  owner_contact_id uuid,                      -- landlord's own account (we never hold funds)
  nickname      text NOT NULL,
  bank_name     text,
  bank_code     text,                         -- TW 3-digit bank code
  branch_code   text,
  account_last5 char(5) CHECK (account_last5 ~ '^[0-9]{5}$'),
  account_number_enc_ref text,                -- full number for tenant instructions: Vault ref only
  currency      char(3) NOT NULL REFERENCES currencies(code),
  show_to_tenants boolean NOT NULL DEFAULT true,  -- payment instructions in tenant app
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES contacts(org_id, id)
);

CREATE TABLE bank_csv_mappings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  name          text NOT NULL,
  encoding      text NOT NULL DEFAULT 'UTF-8',   -- many TW banks export Big5
  delimiter     text NOT NULL DEFAULT ',',
  date_format   text NOT NULL DEFAULT 'YYYY-MM-DD', -- may be ROC e.g. 'ROC/MM/DD'
  header_rows   smallint NOT NULL DEFAULT 1,
  column_map    jsonb NOT NULL,                  -- {"date":"交易日期","amount":"存入","memo":"備註","counterparty_account":"帳號"}
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts(org_id, id) ON DELETE CASCADE
);

CREATE TABLE bank_statement_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  mapping_id    uuid,
  file_id       uuid NOT NULL,
  status        import_status NOT NULL DEFAULT 'uploaded',
  period_start  date,
  period_end    date,
  row_count     integer,
  error         text,
  uploaded_by   uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts(org_id, id),
  FOREIGN KEY (org_id, mapping_id) REFERENCES bank_csv_mappings(org_id, id),
  FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id)
);

CREATE TABLE bank_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  bank_account_id  uuid NOT NULL,
  import_id        uuid NOT NULL,
  row_number       integer NOT NULL,
  posted_on        date NOT NULL,
  amount_minor     bigint NOT NULL,             -- + credit (money in), - debit
  currency         char(3) NOT NULL REFERENCES currencies(code),
  description      text,
  counterparty_name text,
  counterparty_account_last5 char(5) CHECK (counterparty_account_last5 ~ '^[0-9]{5}$'),
  reference        text,
  raw              jsonb NOT NULL,
  dedupe_hash      text NOT NULL,              -- hash(account, date, amount, memo, running balance)
  status           bank_txn_status NOT NULL DEFAULT 'unmatched',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (bank_account_id, dedupe_hash),
  FOREIGN KEY (org_id, bank_account_id) REFERENCES bank_accounts(org_id, id),
  FOREIGN KEY (org_id, import_id) REFERENCES bank_statement_imports(org_id, id) ON DELETE CASCADE
);
CREATE INDEX bank_transactions_match_idx ON bank_transactions(org_id, counterparty_account_last5, amount_minor, posted_on) WHERE status IN ('unmatched','suggested');
ALTER TABLE payments ADD CONSTRAINT payments_bank_txn_fk FOREIGN KEY (org_id, bank_transaction_id) REFERENCES bank_transactions(org_id, id);
CREATE UNIQUE INDEX payments_bank_txn_uniq ON payments(bank_transaction_id) WHERE bank_transaction_id IS NOT NULL AND status <> 'rejected';

-- Suggested match: a bank line vs an existing tenant-recorded payment, or directly
-- vs an open invoice (approval then creates a confirmed payment).
CREATE TABLE bank_match_suggestions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  bank_transaction_id uuid NOT NULL,
  payment_id        uuid,
  invoice_id        uuid,
  score             numeric(5,4) NOT NULL CHECK (score BETWEEN 0 AND 1),
  reasons           jsonb NOT NULL,   -- {"amount_exact":true,"last5":"12345","date_delta_days":1,"name_similarity":0.8}
  matcher_version   text NOT NULL DEFAULT 'v1',
  status            match_status NOT NULL DEFAULT 'suggested',
  decided_by        uuid REFERENCES auth.users(id),
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, bank_transaction_id) REFERENCES bank_transactions(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id),
  CHECK (num_nonnulls(payment_id, invoice_id) >= 1),
  CHECK (status IN ('suggested','superseded') OR decided_by IS NOT NULL)
);
CREATE UNIQUE INDEX bank_match_one_approved ON bank_match_suggestions(bank_transaction_id) WHERE status = 'approved';

-- -----------------------------------------------------------------------------
-- 12. Maintenance
-- -----------------------------------------------------------------------------
CREATE TABLE maintenance_tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  ticket_number      integer NOT NULL,
  property_id        uuid NOT NULL,
  unit_id            uuid,
  room_id            uuid,
  lease_id           uuid,
  category           ticket_category NOT NULL DEFAULT 'other',
  priority           ticket_priority NOT NULL DEFAULT 'normal',
  status             ticket_status NOT NULL DEFAULT 'open',
  title              text NOT NULL,
  description        text,
  preferred_times    text,
  reported_by_user   uuid REFERENCES auth.users(id),
  reported_by_contact_id uuid,
  assigned_member_id uuid,
  assigned_vendor_contact_id uuid,           -- vendor = contact, no app
  currency           char(3) REFERENCES currencies(code),
  estimated_cost_minor bigint CHECK (estimated_cost_minor >= 0),
  final_cost_minor   bigint CHECK (final_cost_minor >= 0),
  cost_bearer        cost_bearer NOT NULL DEFAULT 'undecided',
  owner_approval     approval_status NOT NULL DEFAULT 'not_required',  -- P1, field reserved
  owner_approval_by  uuid REFERENCES auth.users(id),
  owner_approval_at  timestamptz,
  resolved_at        timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, ticket_number),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, unit_id) REFERENCES units(org_id, id),
  FOREIGN KEY (unit_id, room_id) REFERENCES rooms(unit_id, id),
  FOREIGN KEY (org_id, lease_id) REFERENCES leases(org_id, id),
  FOREIGN KEY (org_id, reported_by_contact_id) REFERENCES contacts(org_id, id),
  FOREIGN KEY (org_id, assigned_member_id) REFERENCES org_members(org_id, id),
  FOREIGN KEY (org_id, assigned_vendor_contact_id) REFERENCES contacts(org_id, id),
  CHECK (room_id IS NULL OR unit_id IS NOT NULL),
  CHECK ((estimated_cost_minor IS NULL AND final_cost_minor IS NULL) OR currency IS NOT NULL)
);
CREATE INDEX maintenance_tickets_status_idx ON maintenance_tickets(org_id, status);
CREATE INDEX maintenance_tickets_lease_idx ON maintenance_tickets(lease_id);
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_ticket_fk FOREIGN KEY (org_id, ticket_id) REFERENCES maintenance_tickets(org_id, id);

CREATE TABLE ticket_comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  ticket_id     uuid NOT NULL,
  author_user_id uuid REFERENCES auth.users(id),
  body          text,
  is_internal   boolean NOT NULL DEFAULT false,   -- hidden from tenant/owner
  status_from   ticket_status,
  status_to     ticket_status,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES maintenance_tickets(org_id, id) ON DELETE CASCADE,
  CHECK (body IS NOT NULL OR status_to IS NOT NULL)
);
CREATE INDEX ticket_comments_ticket_idx ON ticket_comments(ticket_id, created_at);

CREATE TABLE ticket_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  ticket_id   uuid NOT NULL,
  comment_id  uuid,
  file_id     uuid NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, ticket_id) REFERENCES maintenance_tickets(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, comment_id) REFERENCES ticket_comments(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id)
);

-- -----------------------------------------------------------------------------
-- 13. Expenses and reimbursements
-- -----------------------------------------------------------------------------
CREATE TABLE expenses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  property_id        uuid NOT NULL,
  unit_id            uuid,
  ticket_id          uuid,
  vendor_contact_id  uuid,
  category           text NOT NULL,           -- 'repair','cleaning','utility','tax','insurance',...
  description        text,
  currency           char(3) NOT NULL REFERENCES currencies(code),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  incurred_on        date NOT NULL,
  paid_by            text NOT NULL CHECK (paid_by IN ('manager_firm','owner','team_member','tenant')),
  paid_by_member_id  uuid,                    -- staff who fronted cash
  bill_to            cost_bearer NOT NULL DEFAULT 'owner',
  receipt_file_id    uuid,
  status             expense_status NOT NULL DEFAULT 'draft',
  reimbursement_status reimbursement_status NOT NULL DEFAULT 'not_applicable',
  reimbursed_on      date,
  reimbursement_reference text,
  approved_by        uuid REFERENCES auth.users(id),
  approved_at        timestamptz,
  ledger_transaction_id uuid,
  created_by         uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, unit_id) REFERENCES units(org_id, id),
  FOREIGN KEY (org_id, ticket_id) REFERENCES maintenance_tickets(org_id, id),
  FOREIGN KEY (org_id, vendor_contact_id) REFERENCES contacts(org_id, id),
  FOREIGN KEY (org_id, paid_by_member_id) REFERENCES org_members(org_id, id),
  FOREIGN KEY (org_id, receipt_file_id) REFERENCES files(org_id, id),
  FOREIGN KEY (org_id, ledger_transaction_id) REFERENCES ledger_transactions(org_id, id),
  CHECK (paid_by <> 'team_member' OR paid_by_member_id IS NOT NULL),
  CHECK (reimbursement_status = 'not_applicable' OR paid_by = 'team_member')
);
CREATE INDEX expenses_property_idx ON expenses(property_id, incurred_on);

-- -----------------------------------------------------------------------------
-- 14. Owner statements
-- -----------------------------------------------------------------------------
CREATE TABLE owner_statements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  owner_contact_id   uuid NOT NULL,
  currency           char(3) NOT NULL REFERENCES currencies(code),   -- one statement per currency
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  status             statement_status NOT NULL DEFAULT 'draft',
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  rent_received_minor   bigint NOT NULL DEFAULT 0,   -- "recorded as received by your manager"
  other_income_minor    bigint NOT NULL DEFAULT 0,
  management_fee_minor  bigint NOT NULL DEFAULT 0,
  expenses_minor        bigint NOT NULL DEFAULT 0,
  payouts_minor         bigint NOT NULL DEFAULT 0,
  closing_balance_minor bigint NOT NULL DEFAULT 0,
  fee_rule_snapshot  jsonb,                     -- rule as applied (hybrid minimum etc.)
  pdf_file_id        uuid,
  locale             text NOT NULL DEFAULT 'zh-TW',
  -- TW e-invoice placeholders for the management fee billed to the owner
  einvoice_status       einvoice_status NOT NULL DEFAULT 'not_applicable',
  einvoice_number       text CHECK (einvoice_number IS NULL OR einvoice_number ~ '^[A-Z]{2}[0-9]{8}$'),
  einvoice_random_code  char(4),
  einvoice_carrier_type einvoice_carrier,
  einvoice_carrier_id   text,
  einvoice_buyer_ubn    char(8),
  einvoice_issued_at    timestamptz,
  issued_at          timestamptz,
  issued_by          uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES contacts(org_id, id),
  FOREIGN KEY (org_id, pdf_file_id) REFERENCES files(org_id, id),
  CHECK (period_end >= period_start),
  CHECK (closing_balance_minor = opening_balance_minor + rent_received_minor + other_income_minor
                                 - management_fee_minor - expenses_minor - payouts_minor)
);
CREATE UNIQUE INDEX owner_statements_period_uniq ON owner_statements(owner_contact_id, currency, period_start) WHERE status <> 'void';

CREATE TABLE owner_statement_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  statement_id    uuid NOT NULL,
  property_id     uuid,
  line_type       text NOT NULL CHECK (line_type IN ('rent','other_income','management_fee','expense','payout','adjustment')),
  description     text NOT NULL,
  amount_minor    bigint NOT NULL,
  ledger_transaction_id uuid,
  expense_id      uuid,
  FOREIGN KEY (org_id, statement_id) REFERENCES owner_statements(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  FOREIGN KEY (org_id, ledger_transaction_id) REFERENCES ledger_transactions(org_id, id),
  FOREIGN KEY (org_id, expense_id) REFERENCES expenses(org_id, id)
);

-- -----------------------------------------------------------------------------
-- 15. Messaging: one thread per lease + property announcements
-- -----------------------------------------------------------------------------
CREATE TABLE message_threads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  kind         thread_kind NOT NULL,
  lease_id     uuid,
  property_id  uuid NOT NULL,
  subject      text,
  last_message_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lease_id) REFERENCES leases(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id),
  CHECK ((kind = 'lease') = (lease_id IS NOT NULL))
);
CREATE UNIQUE INDEX message_threads_one_per_lease ON message_threads(lease_id) WHERE kind = 'lease';

-- Participants: team members (member_id) and tenants (contact_id).
CREATE TABLE thread_participants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  thread_id    uuid NOT NULL,
  member_id    uuid,
  contact_id   uuid,
  muted        boolean NOT NULL DEFAULT false,
  last_read_at timestamptz,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  FOREIGN KEY (org_id, thread_id) REFERENCES message_threads(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, member_id) REFERENCES org_members(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE,
  CHECK (num_nonnulls(member_id, contact_id) = 1)
);
CREATE UNIQUE INDEX thread_participants_member_uniq  ON thread_participants(thread_id, member_id)  WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX thread_participants_contact_uniq ON thread_participants(thread_id, contact_id) WHERE contact_id IS NOT NULL;

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  thread_id        uuid NOT NULL,
  sender_user_id   uuid REFERENCES auth.users(id),   -- NULL = system message
  sender_contact_id uuid,
  sender_member_id uuid,
  body             text,
  body_locale      text,
  inbound_channel  channel_type NOT NULL DEFAULT 'in_app',  -- 'line' when two-way bridging ships (Next)
  external_message_id text,
  edited_at        timestamptz,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, thread_id) REFERENCES message_threads(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, sender_contact_id) REFERENCES contacts(org_id, id),
  FOREIGN KEY (org_id, sender_member_id) REFERENCES org_members(org_id, id),
  CHECK (num_nonnulls(sender_contact_id, sender_member_id) <= 1)
);
CREATE INDEX messages_thread_idx ON messages(thread_id, created_at);

CREATE TABLE message_attachments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  message_id uuid NOT NULL,
  file_id    uuid NOT NULL,
  FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id)
);

-- -----------------------------------------------------------------------------
-- 16. Channels, LINE, notifications, deliveries
-- -----------------------------------------------------------------------------
-- LINE OA configuration. Beta: ONE shared platform-default OA (org_id NULL,
-- mode platform_default). Later (paid add-on): each firm connects its own OA
-- (org_id set, mode org_owned). Our marketing OA is NOT stored here.
-- Secrets are Vault/KMS references only.
CREATE TABLE line_channels (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid REFERENCES organizations(id) ON DELETE CASCADE,
  mode                  line_oa_mode NOT NULL,
  display_name          text NOT NULL,
  line_provider_id      text NOT NULL,        -- LINE user IDs are unique per provider
  messaging_channel_id  text NOT NULL,        -- Messaging API channel
  messaging_channel_secret_ref text NOT NULL, -- vault ref (webhook signature)
  messaging_access_token_ref   text NOT NULL, -- vault ref (long-lived / v2.1 token)
  login_channel_id      text,                 -- LINE Login channel (hosts LIFF)
  login_channel_secret_ref text,
  liff_app_id           text,                 -- e.g. '1234567890-AbCdEfGh' (plan MINI App migration)
  oa_basic_id           text,                 -- '@abc1234' for add-friend links
  rich_menu_linked_id   text,                 -- 4-button menu: 繳租/報修/我的租約/聯絡管理員
  rich_menu_unlinked_id text,                 -- single "綁定租約" menu
  webhook_url           text,
  monthly_push_quota    integer,
  is_active             boolean NOT NULL DEFAULT true,
  connected_by          uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (messaging_channel_id),
  CHECK ((mode = 'platform_default') = (org_id IS NULL))
);
CREATE UNIQUE INDEX line_channels_one_platform_default ON line_channels((true)) WHERE mode = 'platform_default' AND is_active;
CREATE UNIQUE INDEX line_channels_one_per_org ON line_channels(org_id) WHERE org_id IS NOT NULL AND is_active;

-- Which OA an org uses (NULL line_channel_id = fall back to platform default).
ALTER TABLE organizations ADD COLUMN line_channel_id uuid REFERENCES line_channels(id);

-- LINE user id binding, scoped per OA (channel) AND per contact.
-- The same human has different userIds under different providers.
CREATE TABLE line_account_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  contact_id       uuid NOT NULL,
  line_channel_id  uuid NOT NULL REFERENCES line_channels(id),
  line_user_id     text CHECK (line_user_id IS NULL OR line_user_id ~ '^U[0-9a-f]{32}$'),
  status           line_link_status NOT NULL DEFAULT 'pending',
  invitation_id    uuid REFERENCES invitations(id),
  is_friend        boolean NOT NULL DEFAULT false,     -- follow/unfollow webhook
  line_display_name text,
  consent_text_key text,
  consented_at     timestamptz,
  linked_at        timestamptz,
  unlinked_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE,
  CHECK (status <> 'linked' OR (line_user_id IS NOT NULL AND linked_at IS NOT NULL))
);
CREATE UNIQUE INDEX line_links_contact_channel_uniq ON line_account_links(contact_id, line_channel_id) WHERE status IN ('pending','linked');
-- On the shared platform OA one LINE user can be a tenant of several orgs: unique per (channel, user, org).
CREATE UNIQUE INDEX line_links_user_uniq ON line_account_links(line_channel_id, line_user_id, org_id) WHERE status = 'linked';
CREATE INDEX line_links_lookup_idx ON line_account_links(line_channel_id, line_user_id);

-- Email / SMS / web-push endpoints per person (user or contact) with consent.
CREATE TABLE contact_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid,                         -- NULL for user-level (profile) endpoints
  contact_id    uuid,
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  channel       channel_type NOT NULL CHECK (channel IN ('email','sms','push')),
  address       text NOT NULL,                -- email / E.164 / push endpoint URL
  push_keys     jsonb,                        -- web push p256dh/auth
  verified_at   timestamptz,
  opted_in      boolean NOT NULL DEFAULT true,
  consent_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE,
  CHECK (num_nonnulls(contact_id, user_id) >= 1),
  CHECK (contact_id IS NULL OR org_id IS NOT NULL)
);
CREATE INDEX contact_channels_contact_idx ON contact_channels(contact_id);
CREATE INDEX contact_channels_user_idx ON contact_channels(user_id);

CREATE TABLE reminder_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type   text NOT NULL CHECK (event_type IN ('rent_due','rent_overdue','lease_renewal','lease_to_sign','payment_confirmed','ticket_update')),
  offsets_days smallint[] NOT NULL DEFAULT '{}',   -- rent_due {-3,0}, overdue {1,7}, renewal {-60,-30}
  channels     channel_type[] NOT NULL DEFAULT '{line,email,push}', -- priority order with fallback
  is_enabled   boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, event_type)
);

CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type     text NOT NULL,
  template_key   text NOT NULL,              -- i18n template id; rendered in recipient locale
  recipient_user_id uuid REFERENCES auth.users(id),
  recipient_contact_id uuid,
  lease_id       uuid,                        -- lease context (required for tenant-facing events)
  context_prefix text,                         -- snapshot e.g. 【好房代管｜大安區…, A房】 (trigger-filled)
  locale         text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  related_table  text,
  related_id     uuid,
  scheduled_for  timestamptz NOT NULL DEFAULT now(),
  dedupe_key     text,                        -- e.g. 'rent_due:<invoice>:-3'
  status         job_status NOT NULL DEFAULT 'queued',
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, dedupe_key),
  FOREIGN KEY (org_id, recipient_contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, lease_id) REFERENCES leases(org_id, id) ON DELETE CASCADE,
  CHECK (num_nonnulls(recipient_user_id, recipient_contact_id) >= 1),
  CHECK (lease_id IS NOT NULL OR event_type NOT IN
         ('rent_due','rent_overdue','payment_confirmed','payment_rejected','ticket_update','lease_to_sign','lease_renewal','message'))
);
CREATE INDEX notifications_lease_idx ON notifications(lease_id);
CREATE INDEX notifications_due_idx ON notifications(scheduled_for) WHERE status = 'queued';

-- One row per (notification or message) x channel attempt.
CREATE TABLE deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  notification_id    uuid,
  message_id         uuid,
  channel            channel_type NOT NULL,
  recipient_contact_id uuid,
  recipient_user_id  uuid REFERENCES auth.users(id),
  line_account_link_id uuid REFERENCES line_account_links(id),
  line_channel_id    uuid REFERENCES line_channels(id),
  address            text,                   -- email / phone / LINE userId used
  status             delivery_status NOT NULL DEFAULT 'queued',
  provider           text,                   -- 'line_messaging_api','resend','twilio','webpush'
  provider_message_id text,
  counts_toward_quota boolean,               -- LINE push vs reply
  error              text,
  attempt            smallint NOT NULL DEFAULT 1,
  queued_at          timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  delivered_at       timestamptz,
  read_at            timestamptz,
  FOREIGN KEY (org_id, notification_id) REFERENCES notifications(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, recipient_contact_id) REFERENCES contacts(org_id, id),
  CHECK (num_nonnulls(notification_id, message_id) = 1)
);
CREATE INDEX deliveries_notification_idx ON deliveries(notification_id);
CREATE INDEX deliveries_message_idx ON deliveries(message_id);
CREATE INDEX deliveries_status_idx ON deliveries(org_id, status, queued_at);

-- -----------------------------------------------------------------------------
-- 17. Data export (P0 #11): async job -> ZIP of CSVs + documents -> expiring link
-- -----------------------------------------------------------------------------
CREATE TABLE export_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL REFERENCES auth.users(id),
  scope         text[] NOT NULL DEFAULT '{properties,units,rooms,contacts,leases,invoices,payments,ledger,tickets,expenses,owner_statements,documents}',
  format        export_format NOT NULL DEFAULT 'csv_zip',
  include_documents boolean NOT NULL DEFAULT true,
  include_identity_documents boolean NOT NULL DEFAULT false,   -- admin only, logged
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,           -- property ids, date range
  locale        text NOT NULL DEFAULT 'zh-TW',
  status        job_status NOT NULL DEFAULT 'queued',
  progress_pct  smallint CHECK (progress_pct BETWEEN 0 AND 100),
  result_file_id uuid,
  row_counts    jsonb,
  error         text,
  expires_at    timestamptz,                   -- signed link expiry
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, result_file_id) REFERENCES files(org_id, id)
);
CREATE INDEX export_jobs_org_idx ON export_jobs(org_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 18. Audit log (append-only; every money and lease change)
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid,
  actor_user_id uuid,
  actor_role    text,                          -- db role / app role at time of change
  table_name    text NOT NULL,
  row_id        text NOT NULL,
  action        audit_action NOT NULL,
  old_row       jsonb,
  new_row       jsonb,
  changed_cols  text[],
  reason        text,                          -- from app via set_config('app.change_reason', ...)
  request_id    text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log(org_id, occurred_at DESC);
CREATE INDEX audit_log_row_idx ON audit_log(table_name, row_id);

-- =============================================================================
-- 19. Functions and triggers
-- =============================================================================

-- updated_at ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables tb USING (table_schema, table_name)
           WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at()', t, t);
  END LOOP;
END $$;

-- Append-only guard -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % not allowed (post a reversal / superseding row instead)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_transactions','ledger_entries','audit_log','lease_signature_events',
                           'meter_readings','identity_document_access_log']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fn_append_only()', t, t);
  END LOOP;
END $$;

-- Published lease template versions are immutable.
CREATE OR REPLACE FUNCTION fn_template_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'lease_template_versions % v% is published and immutable; create a new version', OLD.template_id, OLD.version;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_template_version_immutable BEFORE UPDATE OR DELETE ON lease_template_versions
  FOR EACH ROW EXECUTE FUNCTION fn_template_version_immutable();

-- Audit log (generic) -----------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  cols text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k) INTO cols FROM jsonb_each(n) e(k, v) WHERE o -> k IS DISTINCT FROM v AND k <> 'updated_at';
    IF cols IS NULL THEN RETURN NEW; END IF;   -- no-op update
  END IF;
  INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, old_row, new_row, changed_cols, reason, request_id)
  VALUES (coalesce((n->>'org_id')::uuid, (o->>'org_id')::uuid), auth.uid(), current_user, TG_TABLE_NAME,
          coalesce(n->>'id', o->>'id'), lower(TG_OP)::audit_action, o, n, cols,
          nullif(current_setting('app.change_reason', true), ''), nullif(current_setting('app.request_id', true), ''));
  RETURN coalesce(NEW, OLD);
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','org_members','invitations','contacts','properties','property_owners','units','rooms',
    'fee_rules','management_agreements','leases','lease_parties','lease_signatures','lease_charges',
    'meters','utility_bills','utility_allocation_runs','utility_allocation_lines',
    'invoices','invoice_lines','payments','payment_allocations','bank_accounts','bank_match_suggestions',
    'ledger_transactions','expenses','owner_statements','owner_statement_lines','maintenance_tickets',
    'identity_documents','line_channels','line_account_links','jurisdiction_rules','rule_check_results','export_jobs']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fn_audit()', t, t);
  END LOOP;
END $$;

-- Ledger: entries must balance per transaction and match its currency ----------
CREATE OR REPLACE FUNCTION fn_ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT t.id, t.currency, coalesce(sum(e.amount_minor),0) AS total,
         bool_or(e.currency <> t.currency) AS ccy_mismatch, count(e.id) AS n
    INTO bad
    FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
   WHERE t.id = NEW.transaction_id
   GROUP BY t.id, t.currency;
  IF bad.n < 2 OR bad.total <> 0 OR bad.ccy_mismatch THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (entries=%, sum=%, currency mismatch=%)',
      bad.id, bad.n, bad.total, bad.ccy_mismatch USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ledger_balanced();

-- Reversal helper: posts the mirror image of a transaction.
CREATE OR REPLACE FUNCTION post_reversal(p_txn uuid, p_reason text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE t ledger_transactions; new_id uuid;
BEGIN
  SELECT * INTO t FROM ledger_transactions WHERE id = p_txn;
  IF NOT FOUND THEN RAISE EXCEPTION 'transaction % not found', p_txn; END IF;
  INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description,
                                   source_table, source_id, reverses_transaction_id, reason, created_by)
  VALUES (t.org_id, t.property_id, t.lease_id, 'reversal', t.currency, current_date, 'Reversal of '||t.id,
          t.source_table, t.source_id, t.id, p_reason, auth.uid())
  RETURNING id INTO new_id;
  INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo)
  SELECT org_id, new_id, account, -amount_minor, currency, contact_id, property_id, lease_id, invoice_id, 'reversal'
    FROM ledger_entries WHERE transaction_id = p_txn;
  RETURN new_id;
END $$;

-- Jurisdiction rule lookup: org override > most specific jurisdiction > parent.
CREATE OR REPLACE FUNCTION effective_rule(p_jurisdiction uuid, p_org uuid, p_key text, p_on date DEFAULT current_date)
RETURNS jurisdiction_rules LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, 0 AS depth FROM jurisdictions WHERE id = p_jurisdiction
    UNION ALL
    SELECT j.id, j.parent_id, c.depth + 1 FROM jurisdictions j JOIN chain c ON j.id = c.parent_id
  )
  SELECT r.* FROM jurisdiction_rules r JOIN chain c ON r.jurisdiction_id = c.id
   WHERE r.rule_key = p_key
     AND (r.org_id IS NULL OR r.org_id = p_org)
     AND r.effective_from <= p_on AND (r.effective_to IS NULL OR r.effective_to > p_on)
   ORDER BY (r.org_id IS NOT NULL) DESC, c.depth, r.effective_from DESC
   LIMIT 1
$$;

-- Lease target guard: room vs whole unit, containing unit, currency, cross-level overlap.
CREATE OR REPLACE FUNCTION fn_lease_target_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u units; p properties; conflict uuid;
BEGIN
  IF num_nonnulls(NEW.target_unit_id, NEW.target_room_id) <> 1 THEN
    RAISE EXCEPTION 'lease must target exactly one of a whole unit or a room' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.target_room_id IS NOT NULL THEN
    SELECT unit_id INTO NEW.unit_id FROM rooms WHERE id = NEW.target_room_id AND org_id = NEW.org_id;
    IF NEW.unit_id IS NULL THEN RAISE EXCEPTION 'room % not found in org', NEW.target_room_id; END IF;
  ELSE
    NEW.unit_id := NEW.target_unit_id;
  END IF;
  SELECT * INTO u FROM units WHERE id = NEW.unit_id;
  NEW.property_id := u.property_id;
  SELECT * INTO p FROM properties WHERE id = u.property_id;
  IF NEW.currency IS DISTINCT FROM p.currency THEN
    RAISE EXCEPTION 'lease currency % must equal property currency %', NEW.currency, p.currency;
  END IF;
  IF NEW.target_room_id IS NOT NULL AND u.rental_mode <> 'by_room' THEN
    RAISE EXCEPTION 'unit % is rented as whole_unit; switch it to by_room before leasing a room', u.label;
  END IF;
  IF NEW.target_unit_id IS NOT NULL AND u.rental_mode <> 'whole_unit' THEN
    RAISE EXCEPTION 'unit % is rented by_room; switch it to whole_unit before leasing the whole unit', u.label;
  END IF;
  -- whole-unit lease must not overlap any room lease in that unit, and vice versa
  IF NEW.status IN ('pending_signature','active') THEN
    SELECT l.id INTO conflict FROM leases l
     WHERE l.unit_id = NEW.unit_id AND l.id <> NEW.id
       AND l.status IN ('pending_signature','active')
       AND l.term && daterange(NEW.start_date, NEW.end_date, '[]')  -- NEW.term not yet generated in BEFORE trigger
       AND ((NEW.target_unit_id IS NOT NULL AND l.target_room_id IS NOT NULL)
         OR (NEW.target_room_id IS NOT NULL AND l.target_unit_id IS NOT NULL))
     LIMIT 1;
    IF conflict IS NOT NULL THEN
      RAISE EXCEPTION 'lease overlaps lease % at the other level (whole unit vs room)', conflict USING ERRCODE = 'exclusion_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lease_target_guard BEFORE INSERT OR UPDATE OF target_unit_id, target_room_id, status, start_date, end_date, currency
  ON leases FOR EACH ROW EXECUTE FUNCTION fn_lease_target_guard();

-- A unit's rental_mode can only change when it has no pending/active leases.
CREATE OR REPLACE FUNCTION fn_unit_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rental_mode <> OLD.rental_mode AND EXISTS (
       SELECT 1 FROM leases WHERE unit_id = NEW.id AND status IN ('pending_signature','active')) THEN
    RAISE EXCEPTION 'cannot change rental_mode of unit % while it has pending/active leases', NEW.label;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_unit_mode_guard BEFORE UPDATE OF rental_mode ON units FOR EACH ROW EXECUTE FUNCTION fn_unit_mode_guard();

-- Meter consistency: property/unit align; parent must be a unit-level meter in same unit.
CREATE OR REPLACE FUNCTION fn_meter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent meters;
BEGIN
  SELECT property_id INTO NEW.property_id FROM units WHERE id = NEW.unit_id;
  IF NEW.parent_meter_id IS NOT NULL THEN
    SELECT * INTO parent FROM meters WHERE id = NEW.parent_meter_id;
    IF parent.room_id IS NOT NULL OR parent.unit_id <> NEW.unit_id OR parent.utility <> NEW.utility THEN
      RAISE EXCEPTION 'sub-meter parent must be a unit-level % meter of the same unit', NEW.utility;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_meter_guard BEFORE INSERT OR UPDATE ON meters FOR EACH ROW EXECUTE FUNCTION fn_meter_guard();

-- Deposit cap check (TW: max 2 months, rule-as-data). Records a rule_check_result;
-- enforcement override_required / hard_block raises for pending/active leases
-- (no deposit override path in MVP).
CREATE OR REPLACE FUNCTION fn_lease_deposit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p properties; r jurisdiction_rules; months numeric; maxm numeric; outcome rule_check_outcome;
BEGIN
  SELECT * INTO p FROM properties WHERE id = NEW.property_id;
  r := effective_rule(p.jurisdiction_id, NEW.org_id, 'deposit.max_months', NEW.start_date);
  IF r.id IS NULL THEN RETURN NEW; END IF;
  maxm := (r.value->>'max_months')::numeric;
  IF maxm IS NULL THEN RETURN NEW; END IF;          -- informational rule, no numeric cap
  months := coalesce(NEW.deposit_months,
                     CASE WHEN NEW.rent_amount_minor > 0 THEN NEW.deposit_amount_minor::numeric / NEW.rent_amount_minor END, 0);
  outcome := CASE WHEN months <= maxm THEN 'pass' WHEN r.enforcement IN ('override_required','hard_block') THEN 'block' ELSE 'warn' END;
  INSERT INTO rule_check_results (org_id, rule_id, entity_table, entity_id, outcome, observed, limit_value, message_key)
  VALUES (NEW.org_id, r.id, 'leases', NEW.id, outcome,
          jsonb_build_object('deposit_months', round(months, 2), 'deposit_amount_minor', NEW.deposit_amount_minor),
          r.value, 'rules.deposit.max_months');
  IF outcome = 'block' AND NEW.status IN ('pending_signature','active') THEN
    RAISE EXCEPTION 'deposit of % months exceeds cap of % months', round(months,2), maxm USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_lease_deposit_check AFTER INSERT OR UPDATE OF deposit_amount_minor, deposit_months, rent_amount_minor, status
  ON leases FOR EACH ROW EXECUTE FUNCTION fn_lease_deposit_check();

-- Electricity per-kWh cap (TW, leases signed on/after 2024-07-15): charged rate may not
-- exceed the period's Taipower bill average (total / kWh). Enforcement is data
-- (jurisdiction_rules.enforcement), seeded override_required for TW:
--   warn              -> flag only
--   override_required -> lines for cap-applicable leases can be saved only if the run
--                        carries cap_override_reason + cap_overridden_by (admin/manager);
--                        the override is written to rule_check_results + audit_log
--   hard_block        -> over-cap lines for cap-applicable leases are never saved
CREATE OR REPLACE FUNCTION fn_allocation_rate_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m meters; p properties; b utility_bills; r jurisdiction_rules; applicable boolean;
        override_new boolean;
BEGIN
  SELECT * INTO m FROM meters WHERE id = NEW.meter_id;
  IF m.utility <> 'electricity' THEN RETURN NEW; END IF;
  SELECT * INTO p FROM properties WHERE id = m.property_id;
  r := effective_rule(p.jurisdiction_id, NEW.org_id, 'electricity.per_kwh_cap', NEW.period_end);
  IF r.id IS NULL THEN RETURN NEW; END IF;
  NEW.cap_rule_id := r.id;
  IF NEW.utility_bill_id IS NULL THEN
    IF NEW.status IN ('approved','posted') THEN
      RAISE EXCEPTION 'electricity allocation needs the period''s source bill (total + kWh) to check the per-kWh cap';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO b FROM utility_bills WHERE id = NEW.utility_bill_id;
  NEW.cap_minor_per_unit := b.avg_price_minor_per_unit;
  IF NEW.rate_source = 'bill_average' THEN
    NEW.rate_minor_per_unit := b.avg_price_minor_per_unit;
  END IF;
  NEW.rate_exceeds_cap := NEW.rate_minor_per_unit > b.avg_price_minor_per_unit;

  -- Override bookkeeping: who/when are stamped server-side; client can't impersonate.
  override_new := NEW.cap_override_reason IS NOT NULL AND
                  (TG_OP = 'INSERT' OR OLD.cap_override_reason IS DISTINCT FROM NEW.cap_override_reason
                                    OR OLD.cap_overridden_by IS DISTINCT FROM NEW.cap_overridden_by);
  IF override_new THEN
    IF btrim(NEW.cap_override_reason) = '' OR NEW.cap_overridden_by IS NULL THEN
      RAISE EXCEPTION 'cap override needs a non-empty reason and the overriding user' USING ERRCODE = 'check_violation';
    END IF;
    IF auth.uid() IS NOT NULL THEN
      IF NEW.cap_overridden_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'cap_overridden_by must be the current user' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT app.has_role(NEW.org_id, '{admin,manager}') THEN
        RAISE EXCEPTION 'only an admin or manager can override the electricity rate cap' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    NEW.cap_overridden_at := now();
  ELSIF NEW.cap_override_reason IS NULL THEN
    NEW.cap_overridden_at := NULL;
  END IF;

  IF NEW.rate_exceeds_cap AND TG_OP = 'UPDATE' THEN
    applicable := EXISTS (SELECT 1 FROM utility_allocation_lines l WHERE l.run_id = NEW.id AND l.cap_applies);
    IF applicable AND r.enforcement = 'hard_block' THEN
      RAISE EXCEPTION 'rate % exceeds bill average % per kWh; rule % is hard_block',
        NEW.rate_minor_per_unit, b.avg_price_minor_per_unit, r.id USING ERRCODE = 'check_violation';
    ELSIF applicable AND r.enforcement = 'override_required' AND NEW.cap_override_reason IS NULL THEN
      RAISE EXCEPTION 'rate % exceeds bill average % per kWh; a manager override reason is required',
        NEW.rate_minor_per_unit, b.avg_price_minor_per_unit USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF override_new AND NEW.rate_exceeds_cap THEN
    INSERT INTO rule_check_results (org_id, rule_id, entity_table, entity_id, outcome, observed, limit_value,
                                    message_key, overridden_by, override_reason)
    VALUES (NEW.org_id, r.id, 'utility_allocation_runs', NEW.id, 'overridden',
            jsonb_build_object('rate_minor_per_unit', NEW.rate_minor_per_unit),
            jsonb_build_object('cap_minor_per_unit', b.avg_price_minor_per_unit, 'utility_bill_id', b.id, 'enforcement', r.enforcement),
            'rules.electricity.per_kwh_cap.overridden', NEW.cap_overridden_by, NEW.cap_override_reason);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_allocation_rate_cap BEFORE INSERT OR UPDATE ON utility_allocation_runs
  FOR EACH ROW EXECUTE FUNCTION fn_allocation_rate_cap();

-- Per line: does the cap apply (lease signed on/after rule date)? If so and the run's
-- rate is over the cap, enforce the rule's mode before the charge line can be saved.
CREATE OR REPLACE FUNCTION fn_allocation_line_cap_applies() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run utility_allocation_runs; r jurisdiction_rules; signed date;
BEGIN
  SELECT * INTO run FROM utility_allocation_runs WHERE id = NEW.run_id;
  IF run.cap_rule_id IS NULL OR NEW.lease_id IS NULL THEN NEW.cap_applies := false; RETURN NEW; END IF;
  SELECT * INTO r FROM jurisdiction_rules WHERE id = run.cap_rule_id;
  SELECT coalesce(signed_at::date, start_date) INTO signed FROM leases WHERE id = NEW.lease_id;
  NEW.cap_applies := signed >= coalesce((r.value->>'applies_to_leases_signed_on_or_after')::date, '1900-01-01');
  IF NEW.cap_applies AND run.rate_exceeds_cap AND NEW.amount_minor > 0 THEN
    IF r.enforcement = 'hard_block' THEN
      RAISE EXCEPTION 'electricity rate % exceeds bill average % per kWh; rule % is hard_block',
        run.rate_minor_per_unit, run.cap_minor_per_unit, r.id USING ERRCODE = 'check_violation';
    ELSIF r.enforcement = 'override_required' AND run.cap_override_reason IS NULL THEN
      RAISE EXCEPTION 'electricity rate % exceeds bill average % per kWh; record a manager override reason on run % first',
        run.rate_minor_per_unit, run.cap_minor_per_unit, run.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_allocation_line_cap BEFORE INSERT OR UPDATE ON utility_allocation_lines
  FOR EACH ROW EXECUTE FUNCTION fn_allocation_line_cap_applies();

-- ID-document retention: org setting may never exceed the platform max -----------
CREATE OR REPLACE FUNCTION platform_max_id_retention_days() RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::int FROM platform_settings WHERE key = 'id_documents.max_retention_days_after_close'), 90)
$$;

CREATE OR REPLACE FUNCTION fn_org_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id_doc_retention_days > platform_max_id_retention_days() THEN
    RAISE EXCEPTION 'id_doc_retention_days % exceeds platform maximum %', NEW.id_doc_retention_days, platform_max_id_retention_days()
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_org_retention_guard BEFORE INSERT OR UPDATE OF id_doc_retention_days ON organizations
  FOR EACH ROW EXECUTE FUNCTION fn_org_retention_guard();

-- Lowering the platform max clamps every org down to it (never leaves an org above).
CREATE OR REPLACE FUNCTION fn_platform_retention_clamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key = 'id_documents.max_retention_days_after_close' THEN
    UPDATE organizations SET id_doc_retention_days = (NEW.value #>> '{}')::int
     WHERE id_doc_retention_days > (NEW.value #>> '{}')::int;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_platform_retention_clamp AFTER INSERT OR UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION fn_platform_retention_clamp();

-- Invoice totals from lines; paid amount + status from payment allocations.
CREATE OR REPLACE FUNCTION fn_invoice_recalc(p_invoice uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE invoices i SET
    total_minor = coalesce((SELECT sum(amount_minor) FROM invoice_lines WHERE invoice_id = i.id), 0),
    paid_minor  = coalesce((SELECT sum(a.amount_minor) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                             WHERE a.invoice_id = i.id AND p.status = 'confirmed'), 0)
  WHERE i.id = p_invoice;
  UPDATE invoices SET status = CASE
      WHEN balance_minor <= 0 AND total_minor > 0 THEN 'paid'::invoice_status
      WHEN paid_minor > 0 THEN 'partially_paid'::invoice_status
      ELSE 'open'::invoice_status END
  WHERE id = p_invoice AND status IN ('open','partially_paid','paid');
END $$;

CREATE OR REPLACE FUNCTION fn_invoice_lines_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM fn_invoice_recalc(coalesce(NEW.invoice_id, OLD.invoice_id)); RETURN NULL; END $$;
CREATE TRIGGER trg_invoice_lines_recalc AFTER INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_lines_changed();
CREATE TRIGGER trg_payment_alloc_recalc AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_lines_changed();

CREATE OR REPLACE FUNCTION fn_payment_status_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv uuid;
BEGIN
  FOR inv IN SELECT invoice_id FROM payment_allocations WHERE payment_id = NEW.id LOOP
    PERFORM fn_invoice_recalc(inv);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_payment_status_recalc AFTER UPDATE OF status, amount_minor ON payments
  FOR EACH ROW EXECUTE FUNCTION fn_payment_status_changed();

-- Allocations may not exceed the payment amount; currencies must agree.
CREATE OR REPLACE FUNCTION fn_payment_alloc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pay payments; inv_ccy char(3);
BEGIN
  SELECT * INTO pay FROM payments WHERE id = NEW.payment_id;
  SELECT currency INTO inv_ccy FROM invoices WHERE id = NEW.invoice_id;
  IF inv_ccy <> pay.currency THEN RAISE EXCEPTION 'payment and invoice currency differ'; END IF;
  IF (SELECT coalesce(sum(amount_minor),0) FROM payment_allocations WHERE payment_id = NEW.payment_id AND id <> NEW.id)
     + NEW.amount_minor > pay.amount_minor THEN
    RAISE EXCEPTION 'allocations exceed payment amount';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payment_alloc_guard BEFORE INSERT OR UPDATE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION fn_payment_alloc_guard();

-- Creator of an org becomes its admin + billing owner (Supabase client inserts org).
CREATE OR REPLACE FUNCTION fn_org_bootstrap() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status)
    VALUES (NEW.id, auth.uid(), 'admin', true, 'active') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_org_bootstrap AFTER INSERT ON organizations FOR EACH ROW EXECUTE FUNCTION fn_org_bootstrap();

-- =============================================================================
-- 20. Row-level security
-- =============================================================================
-- Model
--   * Team members (org_members, status active) see their org's rows; writes are
--     gated by role (admin / manager / accountant / maintenance).
--   * Tenants (contacts.user_id = auth.uid(), linked via lease_parties) see only
--     their own leases and what hangs off them; they can INSERT payments (status
--     'submitted'), tickets, comments, messages.
--   * Owners (contacts linked via property_owners) get read-only access to their
--     properties, statements, occupancy and arrears.
--   * Signing, confirming payments, posting ledger, LINE webhooks, exports and
--     notifications run server-side as service_role (bypasses RLS).
-- Helper functions are SECURITY DEFINER so policies don't recurse through RLS.

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app.is_member(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p_org AND m.user_id = auth.uid() AND m.status = 'active')
$$;

CREATE OR REPLACE FUNCTION app.has_role(p_org uuid, p_roles org_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p_org AND m.user_id = auth.uid()
                  AND m.status = 'active' AND m.role = ANY (p_roles))
$$;

CREATE OR REPLACE FUNCTION app.my_contact_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM contacts WHERE user_id = auth.uid() AND archived_at IS NULL
$$;

CREATE OR REPLACE FUNCTION app.is_my_contact(p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact AND user_id = auth.uid() AND archived_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION app.is_lease_tenant(p_lease uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id
                  WHERE lp.lease_id = p_lease AND c.user_id = auth.uid() AND c.archived_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION app.is_property_owner(p_property uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p_property AND c.user_id = auth.uid()
                    AND (po.effective_to IS NULL OR po.effective_to > current_date))
$$;

CREATE OR REPLACE FUNCTION app.tenant_of_property(p_property uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM leases l JOIN lease_parties lp ON lp.lease_id = l.id JOIN contacts c ON c.id = lp.contact_id
                  WHERE l.property_id = p_property AND c.user_id = auth.uid()
                    AND l.status IN ('pending_signature','active','ended'))
$$;

CREATE OR REPLACE FUNCTION app.can_see_ticket(p_ticket uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM maintenance_tickets t WHERE t.id = p_ticket AND (
           app.is_member(t.org_id)
        OR (t.lease_id IS NOT NULL AND app.is_lease_tenant(t.lease_id))
        OR app.is_my_contact(t.reported_by_contact_id)
        OR app.is_property_owner(t.property_id)))
$$;

CREATE OR REPLACE FUNCTION app.in_thread(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM thread_participants tp JOIN contacts c ON c.id = tp.contact_id
                  WHERE tp.thread_id = p_thread AND c.user_id = auth.uid() AND tp.left_at IS NULL)
      OR EXISTS (SELECT 1 FROM message_threads t WHERE t.id = p_thread AND t.kind = 'announcement'
                  AND app.tenant_of_property(t.property_id))
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated, service_role;

-- Enable RLS everywhere --------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Generic team policies ------------------------------------------------------------
-- team_read: any active member reads org rows.
-- team_write: listed roles get INSERT/UPDATE/DELETE (or INSERT only for append-only).
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    -- table,                        writer roles,                                  insert_only
    ('properties',                  '{admin,manager}',                              false),
    ('property_owners',             '{admin,manager}',                              false),
    ('units',                       '{admin,manager}',                              false),
    ('rooms',                       '{admin,manager}',                              false),
    ('contacts',                    '{admin,manager,accountant}',                   false),
    ('invitations',                 '{admin,manager}',                              false),
    ('files',                       '{admin,manager,accountant,maintenance}',       false),
    ('import_jobs',                 '{admin,manager}',                              false),
    ('fee_rules',                   '{admin,manager,accountant}',                   false),
    ('management_agreements',       '{admin,manager,accountant}',                   false),
    ('leases',                      '{admin,manager}',                              false),
    ('lease_parties',               '{admin,manager}',                              false),
    ('lease_signatures',            '{admin,manager}',                              false),
    ('lease_signature_events',      '{admin,manager}',                              true),
    ('lease_charges',               '{admin,manager,accountant}',                   false),
    ('rule_check_results',          '{admin,manager,accountant}',                   false),
    ('meters',                      '{admin,manager}',                              false),
    ('meter_readings',              '{admin,manager,accountant,maintenance}',       true),
    ('utility_bills',               '{admin,manager,accountant}',                   false),
    ('utility_allocation_runs',     '{admin,manager,accountant}',                   false),
    ('utility_allocation_lines',    '{admin,manager,accountant}',                   false),
    ('invoices',                    '{admin,manager,accountant}',                   false),
    ('invoice_lines',               '{admin,manager,accountant}',                   false),
    ('ledger_transactions',         '{admin,manager,accountant}',                   true),
    ('ledger_entries',              '{admin,manager,accountant}',                   true),
    ('payments',                    '{admin,manager,accountant}',                   false),
    ('payment_allocations',         '{admin,manager,accountant}',                   false),
    ('bank_accounts',               '{admin,accountant}',                           false),
    ('bank_csv_mappings',           '{admin,manager,accountant}',                   false),
    ('bank_statement_imports',      '{admin,manager,accountant}',                   false),
    ('bank_transactions',           '{admin,manager,accountant}',                   false),
    ('bank_match_suggestions',      '{admin,manager,accountant}',                   false),
    ('maintenance_tickets',         '{admin,manager,maintenance}',                  false),
    ('ticket_comments',             '{admin,manager,maintenance}',                  false),
    ('ticket_attachments',          '{admin,manager,maintenance}',                  false),
    ('expenses',                    '{admin,manager,accountant,maintenance}',       false),
    ('owner_statements',            '{admin,manager,accountant}',                   false),
    ('owner_statement_lines',       '{admin,manager,accountant}',                   false),
    ('message_threads',             '{admin,manager,accountant,maintenance}',       false),
    ('thread_participants',         '{admin,manager}',                              false),
    ('messages',                    '{admin,manager,accountant,maintenance}',       false),
    ('message_attachments',         '{admin,manager,accountant,maintenance}',       false),
    ('line_account_links',          '{admin,manager}',                              false),
    ('contact_channels',            '{admin,manager}',                              false),
    ('reminder_rules',              '{admin,manager}',                              false),
    ('notifications',               '{admin,manager}',                              false),
    ('deliveries',                  '{}',                                           false),   -- server only
    ('export_jobs',                 '{admin,manager,accountant}',                   true)
  ) AS s(tbl, roles, insert_only)
  LOOP
    EXECUTE format('CREATE POLICY team_read ON %I FOR SELECT TO authenticated USING (app.is_member(org_id))', spec.tbl);
    IF spec.roles <> '{}' THEN
      IF spec.insert_only THEN
        EXECUTE format('CREATE POLICY team_insert ON %I FOR INSERT TO authenticated WITH CHECK (app.has_role(org_id, %L::org_role[]))', spec.tbl, spec.roles);
      ELSE
        EXECUTE format('CREATE POLICY team_insert ON %I FOR INSERT TO authenticated WITH CHECK (app.has_role(org_id, %L::org_role[]))', spec.tbl, spec.roles);
        EXECUTE format('CREATE POLICY team_update ON %I FOR UPDATE TO authenticated USING (app.has_role(org_id, %L::org_role[])) WITH CHECK (app.has_role(org_id, %L::org_role[]))', spec.tbl, spec.roles, spec.roles);
        EXECUTE format('CREATE POLICY team_delete ON %I FOR DELETE TO authenticated USING (app.has_role(org_id, %L::org_role[]))', spec.tbl, spec.roles);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Org-level / sensitive tables --------------------------------------------------------
CREATE POLICY org_read ON organizations FOR SELECT TO authenticated
  USING (app.is_member(id) OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.org_id = organizations.id AND ct.user_id = auth.uid()));
CREATE POLICY org_create ON organizations FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY org_update ON organizations FOR UPDATE TO authenticated USING (app.has_role(id, '{admin}')) WITH CHECK (app.has_role(id, '{admin}'));

CREATE POLICY members_read  ON org_members FOR SELECT TO authenticated USING (app.is_member(org_id) OR user_id = auth.uid());
CREATE POLICY members_admin ON org_members FOR ALL TO authenticated USING (app.has_role(org_id, '{admin}')) WITH CHECK (app.has_role(org_id, '{admin}'));

CREATE POLICY profiles_self ON profiles FOR ALL TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY profiles_teammates ON profiles FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members a JOIN org_members b ON a.org_id = b.org_id
                  WHERE a.user_id = auth.uid() AND a.status = 'active' AND b.user_id = profiles.id));

-- ID documents: admin + manager only (not accountant/maintenance); tenant sees/uploads own.
CREATE POLICY iddoc_team ON identity_documents FOR ALL TO authenticated
  USING (app.has_role(org_id, '{admin,manager}')) WITH CHECK (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY iddoc_self_read ON identity_documents FOR SELECT TO authenticated USING (app.is_my_contact(contact_id) AND deleted_at IS NULL);
CREATE POLICY iddoc_self_insert ON identity_documents FOR INSERT TO authenticated WITH CHECK (app.is_my_contact(contact_id) AND created_by = auth.uid());
CREATE POLICY iddoc_access_read ON identity_document_access_log FOR SELECT TO authenticated USING (app.has_role(org_id, '{admin}'));

-- Audit log: admins and accountants read; nobody writes directly (trigger only).
CREATE POLICY audit_read ON audit_log FOR SELECT TO authenticated USING (app.has_role(org_id, '{admin,accountant}'));

-- LINE channel config: org admins read their own OA row; secrets are refs anyway.
CREATE POLICY line_channel_read ON line_channels FOR SELECT TO authenticated USING (org_id IS NULL OR app.is_member(org_id));
CREATE POLICY line_channel_admin ON line_channels FOR ALL TO authenticated
  USING (org_id IS NOT NULL AND app.has_role(org_id, '{admin}')) WITH CHECK (org_id IS NOT NULL AND app.has_role(org_id, '{admin}'));

-- Reference / platform data: readable by any signed-in user.
CREATE POLICY ref_read ON currencies    FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read ON jurisdictions FOR SELECT TO authenticated USING (true);
CREATE POLICY rules_read ON jurisdiction_rules FOR SELECT TO authenticated USING (org_id IS NULL OR app.is_member(org_id));
CREATE POLICY rules_org_override ON jurisdiction_rules FOR ALL TO authenticated
  USING (org_id IS NOT NULL AND app.has_role(org_id, '{admin}')) WITH CHECK (org_id IS NOT NULL AND app.has_role(org_id, '{admin}'));
CREATE POLICY tpl_read ON lease_templates FOR SELECT TO authenticated USING (org_id IS NULL OR app.is_member(org_id));
CREATE POLICY tpl_write ON lease_templates FOR ALL TO authenticated
  USING (org_id IS NOT NULL AND app.has_role(org_id, '{admin,manager}')) WITH CHECK (org_id IS NOT NULL AND app.has_role(org_id, '{admin,manager}'));
CREATE POLICY tplv_read ON lease_template_versions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM lease_templates t WHERE t.id = template_id AND (t.org_id IS NULL OR app.is_member(t.org_id))));
CREATE POLICY tplv_write ON lease_template_versions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM lease_templates t WHERE t.id = template_id AND t.org_id IS NOT NULL AND app.has_role(t.org_id, '{admin,manager}')))
  WITH CHECK (EXISTS (SELECT 1 FROM lease_templates t WHERE t.id = template_id AND t.org_id IS NOT NULL AND app.has_role(t.org_id, '{admin,manager}')));

-- Tenant portal --------------------------------------------------------------------
CREATE POLICY tenant_contact_self ON contacts FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY tenant_lease_read ON leases FOR SELECT TO authenticated USING (status <> 'draft' AND app.is_lease_tenant(id));
CREATE POLICY tenant_parties_read ON lease_parties FOR SELECT TO authenticated USING (app.is_lease_tenant(lease_id));
CREATE POLICY tenant_sig_read ON lease_signatures FOR SELECT TO authenticated USING (app.is_lease_tenant(lease_id));
CREATE POLICY tenant_charges_read ON lease_charges FOR SELECT TO authenticated USING (app.is_lease_tenant(lease_id));
CREATE POLICY tenant_property_read ON properties FOR SELECT TO authenticated USING (app.tenant_of_property(id));
CREATE POLICY tenant_unit_read ON units FOR SELECT TO authenticated USING (app.tenant_of_property(property_id));
CREATE POLICY tenant_room_read ON rooms FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM leases l WHERE l.target_room_id = rooms.id AND app.is_lease_tenant(l.id)));
CREATE POLICY tenant_invoice_read ON invoices FOR SELECT TO authenticated USING (status <> 'draft' AND app.is_lease_tenant(lease_id));
CREATE POLICY tenant_invoice_lines_read ON invoice_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND i.status <> 'draft' AND app.is_lease_tenant(i.lease_id)));
CREATE POLICY tenant_alloc_lines_read ON utility_allocation_lines FOR SELECT TO authenticated USING (lease_id IS NOT NULL AND app.is_lease_tenant(lease_id));
CREATE POLICY tenant_alloc_runs_read ON utility_allocation_runs FOR SELECT TO authenticated
  USING (status IN ('approved','posted') AND EXISTS (SELECT 1 FROM utility_allocation_lines l WHERE l.run_id = utility_allocation_runs.id AND app.is_lease_tenant(l.lease_id)));
CREATE POLICY tenant_payments_read ON payments FOR SELECT TO authenticated USING (app.is_lease_tenant(lease_id));
-- Tenant records a payment: only as 'submitted', from the portal, by themselves.
CREATE POLICY tenant_payments_insert ON payments FOR INSERT TO authenticated
  WITH CHECK (app.is_lease_tenant(lease_id) AND status = 'submitted' AND source = 'tenant_portal'
              AND submitted_by = auth.uid() AND confirmed_by IS NULL AND bank_transaction_id IS NULL
              AND ledger_transaction_id IS NULL AND (payer_contact_id IS NULL OR app.is_my_contact(payer_contact_id)));
CREATE POLICY tenant_pay_alloc_read ON payment_allocations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND app.is_lease_tenant(p.lease_id)));
CREATE POLICY tenant_bank_accounts_read ON bank_accounts FOR SELECT TO authenticated
  USING (show_to_tenants AND archived_at IS NULL AND
         (property_id IS NULL AND EXISTS (SELECT 1 FROM contacts c WHERE c.org_id = bank_accounts.org_id AND c.user_id = auth.uid() AND c.is_tenant)
          OR property_id IS NOT NULL AND app.tenant_of_property(property_id)));
CREATE POLICY portal_files_insert ON files FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid() AND EXISTS (SELECT 1 FROM contacts c WHERE c.org_id = files.org_id AND c.user_id = auth.uid()));
CREATE POLICY portal_files_own_read ON files FOR SELECT TO authenticated USING (uploaded_by = auth.uid());
CREATE POLICY tenant_ticket_read ON maintenance_tickets FOR SELECT TO authenticated USING (app.can_see_ticket(id));
CREATE POLICY tenant_ticket_insert ON maintenance_tickets FOR INSERT TO authenticated
  WITH CHECK (lease_id IS NOT NULL AND app.is_lease_tenant(lease_id) AND reported_by_user = auth.uid()
              AND status = 'open' AND assigned_member_id IS NULL AND final_cost_minor IS NULL);
CREATE POLICY portal_comment_read ON ticket_comments FOR SELECT TO authenticated USING (NOT is_internal AND app.can_see_ticket(ticket_id));
CREATE POLICY portal_comment_insert ON ticket_comments FOR INSERT TO authenticated
  WITH CHECK (NOT is_internal AND author_user_id = auth.uid() AND status_to IS NULL AND app.can_see_ticket(ticket_id));
CREATE POLICY portal_ticket_att_read ON ticket_attachments FOR SELECT TO authenticated USING (NOT is_internal AND app.can_see_ticket(ticket_id));
CREATE POLICY portal_ticket_att_insert ON ticket_attachments FOR INSERT TO authenticated WITH CHECK (NOT is_internal AND app.can_see_ticket(ticket_id));
CREATE POLICY portal_thread_read ON message_threads FOR SELECT TO authenticated USING (app.in_thread(id));
CREATE POLICY portal_participants_read ON thread_participants FOR SELECT TO authenticated USING (app.in_thread(thread_id));
CREATE POLICY portal_messages_read ON messages FOR SELECT TO authenticated USING (deleted_at IS NULL AND app.in_thread(thread_id));
CREATE POLICY portal_messages_insert ON messages FOR INSERT TO authenticated
  WITH CHECK (app.in_thread(thread_id) AND sender_user_id = auth.uid() AND app.is_my_contact(sender_contact_id)
              AND EXISTS (SELECT 1 FROM message_threads t WHERE t.id = thread_id AND t.kind = 'lease'));
CREATE POLICY portal_msg_att_read ON message_attachments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id AND app.in_thread(m.thread_id)));
CREATE POLICY portal_notifications_read ON notifications FOR SELECT TO authenticated
  USING (recipient_user_id = auth.uid() OR app.is_my_contact(recipient_contact_id));
CREATE POLICY portal_line_link_read ON line_account_links FOR SELECT TO authenticated USING (app.is_my_contact(contact_id));
CREATE POLICY portal_channels_self ON contact_channels FOR ALL TO authenticated
  USING (user_id = auth.uid() OR app.is_my_contact(contact_id)) WITH CHECK (user_id = auth.uid() OR app.is_my_contact(contact_id));

-- Owner portal (read-only) ------------------------------------------------------------
CREATE POLICY owner_property_read ON properties FOR SELECT TO authenticated USING (app.is_property_owner(id));
CREATE POLICY owner_po_read ON property_owners FOR SELECT TO authenticated USING (app.is_my_contact(owner_contact_id));
CREATE POLICY owner_unit_read ON units FOR SELECT TO authenticated USING (app.is_property_owner(property_id));
CREATE POLICY owner_room_read ON rooms FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM units u WHERE u.id = unit_id AND app.is_property_owner(u.property_id)));
CREATE POLICY owner_lease_read ON leases FOR SELECT TO authenticated USING (status <> 'draft' AND app.is_property_owner(property_id));
CREATE POLICY owner_invoice_read ON invoices FOR SELECT TO authenticated USING (status <> 'draft' AND app.is_property_owner(property_id));
CREATE POLICY owner_payments_read ON payments FOR SELECT TO authenticated USING (status = 'confirmed' AND app.is_property_owner(property_id));
CREATE POLICY owner_expenses_read ON expenses FOR SELECT TO authenticated USING (status IN ('approved','posted') AND app.is_property_owner(property_id));
CREATE POLICY owner_agreements_read ON management_agreements FOR SELECT TO authenticated USING (app.is_my_contact(owner_contact_id));
CREATE POLICY owner_fee_rule_read ON fee_rules FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM management_agreements a WHERE a.fee_rule_id = fee_rules.id AND app.is_my_contact(a.owner_contact_id)));
CREATE POLICY owner_statement_read ON owner_statements FOR SELECT TO authenticated USING (status = 'issued' AND app.is_my_contact(owner_contact_id));
CREATE POLICY owner_statement_lines_read ON owner_statement_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM owner_statements s WHERE s.id = statement_id AND s.status = 'issued' AND app.is_my_contact(s.owner_contact_id)));

-- =============================================================================
-- 20b. Views and functions for portals, LINE lease picker, retention purge
-- =============================================================================

-- Owner view of tenants. Owners have NO direct read on contacts; this view shows
-- tenant names, lease terms and payment status, and the tenant phone only when the
-- firm enabled property_owners.can_view_tenant_phone (or the viewer is a team member,
-- e.g. a self-managing owner). Email and ID documents are never exposed here.
-- Definer view (owner = table owner) with an explicit auth.uid() filter.
CREATE VIEW owner_lease_tenants WITH (security_barrier = true) AS
SELECT l.id               AS lease_id,
       l.org_id,
       l.property_id,
       pr.name            AS property_name,
       u.label            AS unit_label,
       r.label            AS room_label,
       l.status           AS lease_status,
       l.start_date, l.end_date, l.currency, l.rent_amount_minor, l.deposit_amount_minor, l.due_day,
       c.id               AS tenant_contact_id,
       c.display_name     AS tenant_name,
       lp.role            AS tenant_role,
       CASE WHEN bool_or(po.can_view_tenant_phone) OR app.is_member(l.org_id) THEN c.phone_e164 END AS tenant_phone,
       bool_or(po.can_view_tenant_phone) OR app.is_member(l.org_id)                                  AS phone_visible,
       (SELECT coalesce(sum(i.balance_minor), 0) FROM invoices i
         WHERE i.lease_id = l.id AND i.status IN ('open','partially_paid'))                         AS open_balance_minor,
       (SELECT count(*) FROM invoices i
         WHERE i.lease_id = l.id AND i.status IN ('open','partially_paid') AND i.due_date < current_date) AS overdue_invoices,
       (SELECT i.status FROM invoices i WHERE i.lease_id = l.id AND i.status <> 'draft'
         ORDER BY i.due_date DESC LIMIT 1)                                                           AS latest_invoice_status
FROM leases l
JOIN properties pr      ON pr.id = l.property_id
JOIN units u            ON u.id = l.unit_id
LEFT JOIN rooms r       ON r.id = l.target_room_id
JOIN lease_parties lp   ON lp.lease_id = l.id
JOIN contacts c         ON c.id = lp.contact_id
JOIN property_owners po ON po.property_id = l.property_id
                       AND (po.effective_to IS NULL OR po.effective_to > current_date)
JOIN contacts oc        ON oc.id = po.owner_contact_id
WHERE l.status <> 'draft'
  AND (oc.user_id = auth.uid() OR app.is_member(l.org_id))
GROUP BY l.id, pr.name, u.label, r.label, c.id, lp.role;

-- "【Firm｜Address, Room】" prefix for alerts on the shared platform LINE OA.
CREATE OR REPLACE FUNCTION app.lease_context_prefix(p_lease uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT '【' || o.name || '｜' || coalesce(nullif(p.address_display, ''), p.name) || ', '
         || u.label || coalesce(' ' || r.label, '') || '】'
    FROM leases l JOIN organizations o ON o.id = l.org_id JOIN properties p ON p.id = l.property_id
    JOIN units u ON u.id = l.unit_id LEFT JOIN rooms r ON r.id = l.target_room_id
   WHERE l.id = p_lease
$$;

-- Lease picker: every lease the signed-in tenant has, across firms (LIFF / PWA).
CREATE OR REPLACE FUNCTION app.my_tenant_leases()
RETURNS TABLE (lease_id uuid, org_id uuid, firm_name text, property_name text, address_display text,
               unit_label text, room_label text, lease_status lease_status, start_date date, end_date date,
               thread_id uuid, context_prefix text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.org_id, o.name, p.name, p.address_display, u.label, r.label, l.status, l.start_date, l.end_date,
         t.id, app.lease_context_prefix(l.id)
    FROM contacts c
    JOIN lease_parties lp ON lp.contact_id = c.id
    JOIN leases l ON l.id = lp.lease_id AND l.status IN ('pending_signature','active')
    JOIN organizations o ON o.id = l.org_id
    JOIN properties p ON p.id = l.property_id
    JOIN units u ON u.id = l.unit_id
    LEFT JOIN rooms r ON r.id = l.target_room_id
    LEFT JOIN message_threads t ON t.lease_id = l.id AND t.kind = 'lease'
   WHERE c.user_id = auth.uid() AND c.archived_at IS NULL
   ORDER BY o.name, p.name, u.label, r.label
$$;
CREATE VIEW tenant_lease_picker AS SELECT * FROM app.my_tenant_leases();

-- Same picker for the LINE webhook / rich-menu handler (service_role only): resolve a
-- LINE userId on a given OA to all leases of all orgs that userId is linked to.
CREATE OR REPLACE FUNCTION line_lease_picker(p_line_channel_id uuid, p_line_user_id text)
RETURNS TABLE (lease_id uuid, org_id uuid, contact_id uuid, firm_name text, context_prefix text, lease_status lease_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.org_id, ll.contact_id, o.name, app.lease_context_prefix(l.id), l.status
    FROM line_account_links ll
    JOIN lease_parties lp ON lp.contact_id = ll.contact_id
    JOIN leases l ON l.id = lp.lease_id AND l.status IN ('pending_signature','active')
    JOIN organizations o ON o.id = l.org_id
   WHERE ll.line_channel_id = p_line_channel_id AND ll.line_user_id = p_line_user_id AND ll.status = 'linked'
   ORDER BY o.name
$$;
REVOKE ALL ON FUNCTION line_lease_picker(uuid, text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION line_lease_picker(uuid, text) TO service_role;

-- Notifications always carry org + lease context; prefix is snapshotted at insert.
CREATE OR REPLACE FUNCTION fn_notification_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lease_id IS NOT NULL AND NEW.context_prefix IS NULL THEN
    NEW.context_prefix := app.lease_context_prefix(NEW.lease_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_notification_context BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION fn_notification_context();

-- ID-document retention ---------------------------------------------------------
-- Clock starts when ALL of the contact's leases in that org are closed AND each
-- deposit is settled (or was zero); due = clock start + org.id_doc_retention_days
-- (<= platform max 90). No leases at all (e.g. applicant): clock starts at upload.
CREATE VIEW id_documents_due_for_purge WITH (security_invoker = true) AS
WITH lease_close AS (
  SELECT lp.contact_id,
         bool_or(l.status IN ('draft','pending_signature','active'))                       AS has_open_lease,
         bool_or(l.status IN ('ended','terminated') AND l.deposit_amount_minor > 0
                 AND l.deposit_settled_at IS NULL)                                         AS deposit_unsettled,
         bool_or(l.status IN ('ended','terminated') AND coalesce(l.terminated_on, l.end_date) IS NULL) AS missing_end,
         max(CASE WHEN l.status = 'cancelled' THEN coalesce(l.terminated_on, l.start_date)
                  ELSE greatest(coalesce(l.terminated_on, l.end_date), l.deposit_settled_at::date) END) AS closed_on,
         max(l.deposit_settled_at)                                                         AS last_deposit_settled_at
    FROM lease_parties lp JOIN leases l ON l.id = lp.lease_id
   GROUP BY lp.contact_id
)
SELECT d.id AS document_id, d.org_id, d.contact_id, d.doc_type, d.storage_bucket, d.storage_path, d.encryption_key_ref,
       lc.closed_on, lc.last_deposit_settled_at, o.id_doc_retention_days AS retention_days,
       coalesce(lc.closed_on, d.created_at::date) + o.id_doc_retention_days AS due_on
  FROM identity_documents d
  JOIN organizations o ON o.id = d.org_id
  LEFT JOIN lease_close lc ON lc.contact_id = d.contact_id
 WHERE d.deleted_at IS NULL
   AND coalesce(lc.has_open_lease, false) = false
   AND coalesce(lc.deposit_unsettled, false) = false
   AND coalesce(lc.missing_end, false) = false
   AND coalesce(lc.closed_on, d.created_at::date) + o.id_doc_retention_days <= current_date;

-- Purge job entry point (pg_cron / Vercel cron as service_role). Marks rows deleted,
-- logs the purge, returns storage objects + key refs for the worker to delete/shred.
CREATE OR REPLACE FUNCTION purge_due_identity_documents(p_limit integer DEFAULT 500)
RETURNS TABLE (document_id uuid, storage_bucket text, storage_path text, encryption_key_ref text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH due AS (SELECT v.document_id FROM id_documents_due_for_purge v ORDER BY v.due_on LIMIT p_limit),
  upd AS (
    UPDATE identity_documents d SET deleted_at = now()
      FROM due WHERE d.id = due.document_id
    RETURNING d.id, d.org_id, d.storage_bucket, d.storage_path, d.encryption_key_ref
  ), logged AS (
    INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
    SELECT upd.org_id, upd.id, auth.uid(), 'retention_purge' FROM upd RETURNING 1
  )
  SELECT upd.id, upd.storage_bucket, upd.storage_path, upd.encryption_key_ref FROM upd;
END $$;
REVOKE ALL ON FUNCTION purge_due_identity_documents(integer) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION purge_due_identity_documents(integer) TO service_role;

CREATE POLICY platform_settings_read ON platform_settings FOR SELECT TO authenticated USING (true);

-- Grants (Supabase grants these by default; explicit for plain Postgres) -----------
GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE INSERT, UPDATE, DELETE ON platform_settings FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON owner_lease_tenants, tenant_lease_picker, id_documents_due_for_purge FROM authenticated;
REVOKE ALL ON id_documents_due_for_purge FROM authenticated;   -- purge job (service_role) only
GRANT SELECT ON id_documents_due_for_purge TO service_role;
-- Tables written only by triggers / server: no direct client writes even if a policy slipped.
REVOKE INSERT, UPDATE, DELETE ON audit_log, deliveries, identity_document_access_log FROM authenticated;
REVOKE UPDATE, DELETE ON ledger_transactions, ledger_entries, lease_signature_events, meter_readings FROM authenticated;

-- =============================================================================
-- 21. Seed: jurisdictions and rules-as-data (values flagged for legal review)
-- =============================================================================
INSERT INTO jurisdictions (code, country_code, name, default_currency, default_locale, default_timezone) VALUES
  ('TW', 'TW', 'Taiwan', 'TWD', 'zh-TW', 'Asia/Taipei'),
  ('US', 'US', 'United States', 'USD', 'en-US', 'America/New_York');
INSERT INTO jurisdictions (code, parent_id, country_code, name, default_currency, default_locale, default_timezone)
  SELECT 'US-CA', id, 'US', 'California', 'USD', 'en-US', 'America/Los_Angeles' FROM jurisdictions WHERE code = 'US';

INSERT INTO jurisdiction_rules (jurisdiction_id, rule_key, value, enforcement, effective_from, legal_status, source_url, notes)
SELECT j.id, r.rule_key, r.value::jsonb, r.enforcement::rule_enforcement, r.eff::date, r.ls::legal_review_status, r.url, r.notes
FROM jurisdictions j JOIN (VALUES
  ('TW', 'deposit.max_months', '{"max_months": 2}', 'warn', '1900-01-01', 'verified',
   'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=D0060125', '租賃住宅市場發展及管理條例 Art. 7; Land Act Art. 99. Legal review for edge cases.'),
  ('TW', 'electricity.per_kwh_cap',
   '{"basis":"bill_average_per_kwh","applies_to_leases_signed_on_or_after":"2024-07-15","non_per_kwh_cap":"bill_total"}',
   'override_required', '2024-07-15', 'verified', 'https://www.moi.gov.tw/News_Content.aspx?n=145&s=317657',
   'Per-kWh charge <= 當期每度平均電價 on the Taipower bill. Replaces old summer-max-rate rule. Over-cap needs manager override reason; lawyer decides on hard_block.'),
  ('TW', 'late_fee.warning_threshold', '{"max_percent_of_rent": null}', 'warn', '1900-01-01', 'unverified', NULL, 'Flexible; warn if large (verify)'),
  ('TW', 'lease.date_calendar_options', '{"options":["gregorian","roc"]}', 'info', '1900-01-01', 'verified', NULL, 'ROC/Minguo display option'),
  ('US', 'deposit.max_months', '{"max_months": null}', 'info', '1900-01-01', 'unverified', NULL, 'Varies by state; warning only'),
  ('US-CA', 'deposit.max_months', '{"max_months": 1}', 'warn', '2024-07-01', 'unverified', NULL, 'CA AB 12 (verify; small-landlord exception)'),
  ('US', 'late_fee.warning_threshold', '{"max_percent_of_rent": null}', 'info', '1900-01-01', 'unverified', NULL, 'State limits vary')
) AS r(code, rule_key, value, enforcement, eff, ls, url, notes) ON r.code = j.code;

-- Platform lease templates (content to verify / license; versions unpublished until legal review)
INSERT INTO lease_templates (org_id, jurisdiction_id, code, name, is_government_standard, source_authority)
SELECT NULL, j.id, t.code, t.name, t.gov, t.auth FROM jurisdictions j JOIN (VALUES
  ('TW', 'TW_GOV_STANDARD_RESIDENTIAL', '住宅租賃契約書範本 (Residential lease standard template)', true,  '內政部 Ministry of the Interior'),
  ('US', 'US_GENERIC_RESIDENTIAL',      'Generic residential lease (editable, no legal compliance promise)', false, NULL)
) AS t(code_j, code, name, gov, auth) ON t.code_j = j.code;

INSERT INTO lease_template_versions (template_id, version, version_label, locales, disclaimer_key, legal_status)
SELECT id, 1, 'v1 draft', CASE WHEN code LIKE 'TW%' THEN '{zh-TW,en}'::text[] ELSE '{en}'::text[] END,
       CASE WHEN code LIKE 'US%' THEN 'lease.disclaimer.no_legal_guarantee' END, 'unverified'
FROM lease_templates WHERE org_id IS NULL;
