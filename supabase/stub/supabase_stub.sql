-- Plain-Postgres stand-in for Supabase Auth and the API roles.
-- Do NOT run this on hosted Supabase or `supabase start` (those already
-- provide auth, anon, authenticated and service_role).
--
-- Adaptation vs schema.sql: the schema calls auth.uid() and GRANTs to
-- authenticated / service_role / anon, and it uses citext. Supabase creates
-- those for you. This stub is the only extra DDL, and it is not part of the
-- Supabase migration history.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS auth;

-- Hosted GoTrue: id has no default, and token columns are text GoTrue scans.
-- Empty-string defaults here keep older local inserts working. The provision
-- function still writes them explicitly, because hosted columns may not default.
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid,
  id uuid PRIMARY KEY,
  aud text,
  role text,
  email text UNIQUE,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  phone text,
  confirmation_token text NOT NULL DEFAULT '',
  recovery_token text NOT NULL DEFAULT '',
  email_change_token_new text NOT NULL DEFAULT '',
  email_change text NOT NULL DEFAULT '',
  email_change_token_current text NOT NULL DEFAULT '',
  email_change_confirm_status smallint NOT NULL DEFAULT 0,
  phone_change text NOT NULL DEFAULT '',
  phone_change_token text NOT NULL DEFAULT '',
  reauthentication_token text NOT NULL DEFAULT '',
  is_sso_user boolean NOT NULL DEFAULT false,
  is_anonymous boolean NOT NULL DEFAULT false
);

-- Same contract as Supabase: auth.uid() reads the JWT sub claim that PostgREST
-- sets. The demo app sets request.jwt.claim.sub for the selected persona.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

DO $$ BEGIN CREATE ROLE anon NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- authenticated may read auth.users. service_role gets no table grants.
-- Portal users are created by app.provision_portal_user (SECURITY DEFINER).
GRANT SELECT ON auth.users TO authenticated;
