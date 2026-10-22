-- Version 20261020120000.
-- P0 sign-in, sessions, lockout, password reset, TOTP, and month-close.
-- Applied after 20261018120000_schema.sql. Do not edit the original migration.

CREATE TABLE auth_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,
  user_agent     text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

-- Keyed by normalized email so an unknown address locks the same way as a real one.
CREATE TABLE auth_login_attempts (
  email         citext PRIMARY KEY,
  failed_count  integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('2fa', 'enroll')),
  remember    boolean NOT NULL DEFAULT false,
  totp_secret text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_mfa (
  user_id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  totp_secret         text,
  enabled             boolean NOT NULL DEFAULT false,
  backup_code_hashes  text[] NOT NULL DEFAULT '{}',
  confirmed_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE month_closes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_month  date NOT NULL,
  closed_by     uuid REFERENCES auth.users(id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, period_month)
);

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE month_closes ENABLE ROW LEVEL SECURITY;

-- Credential tables are server-only (the pool role). No authenticated policies.
CREATE POLICY sessions_self ON auth_sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY mfa_self ON user_mfa FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY month_close_read ON month_closes FOR SELECT TO authenticated
  USING (app.is_member(org_id));
CREATE POLICY month_close_insert ON month_closes FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,accountant}'));

GRANT EXECUTE ON FUNCTION post_reversal(uuid, text) TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions, auth_login_attempts, auth_password_resets,
  auth_challenges, user_mfa, month_closes TO service_role;
GRANT SELECT ON auth_sessions, user_mfa, month_closes TO authenticated;
GRANT INSERT ON month_closes TO authenticated;

-- Align write policies with the permission matrix. Org isolation (team_read) stays.
DROP POLICY IF EXISTS team_insert ON owner_statements;
DROP POLICY IF EXISTS team_update ON owner_statements;
DROP POLICY IF EXISTS team_delete ON owner_statements;
CREATE POLICY team_insert ON owner_statements FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,accountant}'));
CREATE POLICY team_update ON owner_statements FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,accountant}')) WITH CHECK (app.has_role(org_id, '{admin,accountant}'));
CREATE POLICY team_delete ON owner_statements FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,accountant}'));

DROP POLICY IF EXISTS team_insert ON owner_statement_lines;
DROP POLICY IF EXISTS team_update ON owner_statement_lines;
DROP POLICY IF EXISTS team_delete ON owner_statement_lines;
CREATE POLICY team_insert ON owner_statement_lines FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,accountant}'));
CREATE POLICY team_update ON owner_statement_lines FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,accountant}')) WITH CHECK (app.has_role(org_id, '{admin,accountant}'));
CREATE POLICY team_delete ON owner_statement_lines FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,accountant}'));

DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['bank_csv_mappings','bank_statement_imports','bank_transactions','bank_match_suggestions']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS team_insert ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS team_update ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS team_delete ON %I', tbl);
    EXECUTE format('CREATE POLICY team_insert ON %I FOR INSERT TO authenticated WITH CHECK (app.has_role(org_id, %L::org_role[]))', tbl, '{admin,accountant}');
    EXECUTE format('CREATE POLICY team_update ON %I FOR UPDATE TO authenticated USING (app.has_role(org_id, %L::org_role[])) WITH CHECK (app.has_role(org_id, %L::org_role[]))', tbl, '{admin,accountant}', '{admin,accountant}');
    EXECUTE format('CREATE POLICY team_delete ON %I FOR DELETE TO authenticated USING (app.has_role(org_id, %L::org_role[]))', tbl, '{admin,accountant}');
  END LOOP;
END $$;

DROP POLICY IF EXISTS team_insert ON expenses;
DROP POLICY IF EXISTS team_update ON expenses;
DROP POLICY IF EXISTS team_delete ON expenses;
CREATE POLICY team_insert ON expenses FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager,accountant}'));
CREATE POLICY team_update ON expenses FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,manager,accountant}')) WITH CHECK (app.has_role(org_id, '{admin,manager,accountant}'));
CREATE POLICY team_delete ON expenses FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,manager,accountant}'));

DROP POLICY IF EXISTS team_insert ON messages;
DROP POLICY IF EXISTS team_update ON messages;
DROP POLICY IF EXISTS team_delete ON messages;
CREATE POLICY team_insert ON messages FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY team_update ON messages FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}')) WITH CHECK (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY team_delete ON messages FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'));

-- Demo LINE Login links a member without calling LINE. Real OAuth stays out of this build.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS line_linked boolean NOT NULL DEFAULT false;
