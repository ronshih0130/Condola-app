-- Self-serve sign-up: firm profile, partner prices, funnel events, emergency go-live pause.
-- Unconfirmed accounts are kept. Purging them after 7 days is deferred.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS firm_kind text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS dup_name_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS signup_source text,
  ADD COLUMN IF NOT EXISTS live_started_at timestamptz;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_firm_kind_chk;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_firm_kind_chk
  CHECK (firm_kind IS NULL OR firm_kind IN ('firm', 'self'));

CREATE INDEX IF NOT EXISTS organizations_dup_name_idx
  ON organizations (created_at DESC) WHERE dup_name_flag;

-- Platform-wide. false means 開始正式使用 is allowed. This replaces the per-firm live_enabled gate.
INSERT INTO platform_settings (key, value, description)
VALUES (
  'go_live_lock',
  'false'::jsonb,
  'Emergency pause 「緊急暫停正式使用」. Off by default; when on, go-live is refused.'
)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS partner_codes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{4,20}$'),
  partner_name       text NOT NULL,
  standard_price     integer NOT NULL CHECK (standard_price >= 0),
  pro_price          integer NOT NULL CHECK (pro_price >= 0),
  free_units         integer NOT NULL DEFAULT 4 CHECK (free_units >= 0),
  trial_months       integer NOT NULL DEFAULT 3 CHECK (trial_months >= 0),
  price_lock_months  integer NOT NULL DEFAULT 12 CHECK (price_lock_months >= 0),
  max_uses           integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses               integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at         timestamptz,
  active             boolean NOT NULL DEFAULT true,
  created_by         uuid REFERENCES auth.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Standard NT$20, free 4 units. Pro partner price is NT$30 (list Pro is NT$40).
INSERT INTO partner_codes (
  code, partner_name, standard_price, pro_price, free_units, trial_months, price_lock_months, max_uses, active
) VALUES (
  'ANJU2026', '安居', 20, 30, 4, 3, 12, 100000, true
)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS firm_partner_prices (
  org_id             uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  code               text NOT NULL,
  partner_name       text NOT NULL,
  standard_price     integer NOT NULL,
  pro_price          integer NOT NULL,
  free_units         integer NOT NULL,
  trial_months       integer NOT NULL,
  price_lock_months  integer NOT NULL,
  redeemed_at        timestamptz NOT NULL DEFAULT now(),
  locked_until       timestamptz,
  redeemed_where     text NOT NULL CHECK (redeemed_where IN ('signup', 'upgrade'))
);

CREATE TABLE IF NOT EXISTS firm_price_overrides (
  org_id        uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  rate          integer NOT NULL CHECK (rate >= 0),
  locked_until  timestamptz,
  set_by        uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signup_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_verifications_user_idx ON signup_verifications (user_id);

CREATE TABLE IF NOT EXISTS signup_drafts (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_code  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS funnel_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  text NOT NULL CHECK (event_type IN ('signup_started', 'email_confirmed', 'firm_created', 'golive')),
  user_id     uuid,
  org_id      uuid,
  email       text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funnel_events_type_idx ON funnel_events (event_type, created_at);

CREATE TABLE IF NOT EXISTS upgrade_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES auth.users(id),
  tier          text NOT NULL CHECK (tier IN ('standard', 'pro')),
  units         integer,
  partner_code  text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
