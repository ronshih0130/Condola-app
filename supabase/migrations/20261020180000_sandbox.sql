-- Version 20261020180000.
-- Test mode is a separate firm, not a flag on live rows.
-- One live firm has at most one sandbox. Child rows stay in their own org_id,
-- and app.is_member hides the other environment unless the transaction is pinned
-- to it (app.active_org_id + app.env). service_role still bypasses RLS.

CREATE TYPE org_environment AS ENUM ('live', 'sandbox');

ALTER TABLE organizations
  ADD COLUMN environment org_environment NOT NULL DEFAULT 'live',
  ADD COLUMN live_org_id uuid,
  ADD COLUMN sample_loaded_at timestamptz;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_live_org_fk
  FOREIGN KEY (live_org_id) REFERENCES organizations(id) ON DELETE CASCADE;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_environment_shape CHECK (
    (environment = 'live' AND live_org_id IS NULL)
    OR (environment = 'sandbox' AND live_org_id IS NOT NULL AND live_org_id <> id)
  );

CREATE UNIQUE INDEX organizations_one_sandbox
  ON organizations (live_org_id) WHERE environment = 'sandbox';

CREATE OR REPLACE FUNCTION fn_org_environment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.environment = 'sandbox' THEN
    IF NEW.live_org_id IS NULL OR NEW.live_org_id = NEW.id THEN
      RAISE EXCEPTION 'sandbox requires a different live firm' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM organizations parent
       WHERE parent.id = NEW.live_org_id AND parent.environment = 'live'
    ) THEN
      RAISE EXCEPTION 'sandbox can only link to a live firm' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.live_org_id IS NOT NULL THEN
    RAISE EXCEPTION 'live firm cannot link to another firm' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_org_environment_guard
  BEFORE INSERT OR UPDATE OF environment, live_org_id ON organizations
  FOR EACH ROW EXECUTE FUNCTION fn_org_environment_guard();

-- Every seeded sandbox row is tagged here so the label does not depend on a
-- column the portfolio tables may not have yet.
CREATE TABLE sample_marks (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_table text NOT NULL,
  entity_id    uuid NOT NULL,
  label        text NOT NULL DEFAULT '範例資料',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_table, entity_id)
);
CREATE INDEX sample_marks_entity_idx ON sample_marks (entity_table, entity_id);

ALTER TABLE sample_marks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON sample_marks TO authenticated, service_role;

CREATE POLICY team_read ON sample_marks FOR SELECT TO authenticated
  USING (app.is_member(org_id));
CREATE POLICY team_insert ON sample_marks FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY team_delete ON sample_marks FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'));

-- Pin: set_config('app.active_org_id', <uuid>, true) and set_config('app.env', 'live'|'sandbox', true).
-- Unpinned sessions keep today's live membership. Sandbox rows stay invisible until pinned.
CREATE OR REPLACE FUNCTION app.is_member(p_org uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  active text := nullif(current_setting('app.active_org_id', true), '');
  env_name text := nullif(current_setting('app.env', true), '');
  org_env text;
  live_id uuid;
BEGIN
  SELECT environment::text, live_org_id INTO org_env, live_id FROM organizations WHERE id = p_org;
  IF org_env IS NULL THEN
    RETURN false;
  END IF;
  IF org_env = 'sandbox' THEN
    IF active IS NULL OR active <> p_org::text OR env_name IS DISTINCT FROM 'sandbox' THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM org_members m
       WHERE m.user_id = auth.uid() AND m.status = 'active'
         AND (m.org_id = p_org OR m.org_id = live_id)
    );
  END IF;
  IF active IS NOT NULL AND active <> p_org::text THEN
    RETURN false;
  END IF;
  IF env_name = 'sandbox' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM org_members m
     WHERE m.org_id = p_org AND m.user_id = auth.uid() AND m.status = 'active'
  );
END $$;

CREATE OR REPLACE FUNCTION app.has_role(p_org uuid, p_roles org_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.is_member(p_org) AND EXISTS (
    SELECT 1
      FROM org_members m
      JOIN organizations o ON o.id = p_org
     WHERE m.user_id = auth.uid()
       AND m.status = 'active'
       AND m.role = ANY (p_roles)
       AND (m.org_id = p_org OR m.org_id = o.live_org_id)
  )
$$;
