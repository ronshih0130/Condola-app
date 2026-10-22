-- Lease renewal and move-out. Additive only.
-- Older app builds keep working: new columns on leases are nullable, and this
-- file adds no NOT NULL and no check on existing columns that an old writer
-- could violate. A before trigger still fills end_date when a lease is closed,
-- which the 90-day ID-document purge reads.
--
-- Trigger functions revoke EXECUTE from PUBLIC, anon, and authenticated.
-- Firing a trigger does not check EXECUTE. app.lease_lifecycle_on is called
-- from row-level security as authenticated, so that role keeps EXECUTE and
-- the signature is listed in supabase/rpc-allowlist.txt.

CREATE OR REPLACE FUNCTION app.lease_lifecycle_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM organizations o
     WHERE o.id = p_org
       AND (o.environment = 'sandbox' OR o.plan_tier = 'beta')
  );
$$;
REVOKE EXECUTE ON FUNCTION app.lease_lifecycle_on(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.lease_lifecycle_on(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_sync_lease_lifecycle_flag() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.feature_flags := jsonb_set(
    coalesce(NEW.feature_flags, '{}'::jsonb),
    '{lease_lifecycle}',
    to_jsonb(NEW.environment = 'sandbox' OR NEW.plan_tier = 'beta'),
    true
  );
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.fn_sync_lease_lifecycle_flag() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_org_lease_lifecycle
  BEFORE INSERT OR UPDATE OF plan_tier, environment, feature_flags
  ON organizations
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_lease_lifecycle_flag();

UPDATE organizations
   SET feature_flags = jsonb_set(
         coalesce(feature_flags, '{}'::jsonb),
         '{lease_lifecycle}',
         to_jsonb(environment = 'sandbox' OR plan_tier = 'beta'),
         true
       );

UPDATE leases
   SET end_date = coalesce(terminated_on, start_date)
 WHERE status IN ('ended', 'terminated', 'cancelled')
   AND end_date IS NULL;

CREATE OR REPLACE FUNCTION public.fn_lease_close_end_date() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('ended', 'terminated', 'cancelled') AND NEW.end_date IS NULL THEN
    NEW.end_date := coalesce(NEW.terminated_on, NEW.start_date);
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.fn_lease_close_end_date() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_lease_close_end_date
  BEFORE INSERT OR UPDATE OF status, end_date, terminated_on
  ON leases
  FOR EACH ROW EXECUTE FUNCTION public.fn_lease_close_end_date();

CREATE OR REPLACE VIEW id_documents_due_for_purge WITH (security_invoker = true) AS
WITH lease_close AS (
  SELECT lp.contact_id,
         bool_or(l.status IN ('draft','pending_signature','active')) AS has_open_lease,
         bool_or(l.status IN ('ended','terminated') AND l.deposit_amount_minor > 0
                 AND l.deposit_settled_at IS NULL) AS deposit_unsettled,
         bool_or(l.status IN ('ended','terminated','cancelled') AND l.end_date IS NULL) AS missing_end,
         max(CASE
               WHEN l.status = 'cancelled' THEN l.end_date
               WHEN l.status IN ('ended','terminated') THEN greatest(l.end_date, l.deposit_settled_at::date)
               ELSE NULL
             END) AS closed_on,
         max(l.deposit_settled_at) AS last_deposit_settled_at
    FROM lease_parties lp
    JOIN leases l ON l.id = lp.lease_id
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

ALTER TABLE leases
  ADD COLUMN end_reason text,
  ADD COLUMN moveout_on date,
  ADD COLUMN handover_at timestamptz,
  ADD COLUMN renewed_from_id uuid;

ALTER TABLE leases
  ADD CONSTRAINT leases_end_reason_chk
  CHECK (end_reason IS NULL OR end_reason IN ('expired', 'early', 'other'));

ALTER TABLE leases
  ADD CONSTRAINT leases_renewed_from_fk
  FOREIGN KEY (org_id, renewed_from_id) REFERENCES leases (org_id, id);

-- Scheduled move-out. The lease stays active until the settlement is confirmed.
CREATE TABLE lease_moveouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  move_out_on date NOT NULL,
  end_reason text NOT NULL CHECK (end_reason IN ('expired', 'early', 'other')),
  handover_at timestamptz,
  monthly_rent_minor bigint NOT NULL CHECK (monthly_rent_minor >= 0),
  period_start date NOT NULL,
  period_end date NOT NULL,
  prorated_days integer NOT NULL CHECK (prorated_days > 0),
  prorated_default_minor bigint NOT NULL CHECK (prorated_default_minor >= 0),
  override_minor bigint CHECK (override_minor IS NULL OR override_minor >= 0),
  final_rent_minor bigint NOT NULL CHECK (final_rent_minor >= 0),
  overridden_by uuid REFERENCES auth.users (id),
  overridden_at timestamptz,
  currency char(3) NOT NULL REFERENCES currencies (code),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'settled')),
  created_by uuid REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lease_id) REFERENCES leases (org_id, id) ON DELETE CASCADE,
  CHECK (period_end >= period_start),
  CHECK (
    (override_minor IS NULL AND overridden_by IS NULL AND overridden_at IS NULL)
    OR (override_minor IS NOT NULL AND overridden_by IS NOT NULL AND overridden_at IS NOT NULL)
  ),
  CHECK (final_rent_minor = coalesce(override_minor, prorated_default_minor))
);
CREATE INDEX lease_moveouts_org_idx ON lease_moveouts (org_id, lease_id);

CREATE TABLE lease_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  moveout_id uuid NOT NULL,
  deposit_minor bigint NOT NULL CHECK (deposit_minor >= 0),
  deductions_minor bigint NOT NULL CHECK (deductions_minor >= 0),
  refund_minor bigint NOT NULL CHECK (refund_minor >= 0),
  shortfall_minor bigint NOT NULL CHECK (shortfall_minor >= 0),
  currency char(3) NOT NULL REFERENCES currencies (code),
  refund_on date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  created_by uuid REFERENCES auth.users (id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lease_id) REFERENCES leases (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, moveout_id) REFERENCES lease_moveouts (org_id, id) ON DELETE CASCADE,
  CHECK (refund_minor = greatest(deposit_minor - deductions_minor, 0)),
  CHECK (shortfall_minor = greatest(deductions_minor - deposit_minor, 0))
);
CREATE INDEX lease_settlements_org_idx ON lease_settlements (org_id, lease_id);

CREATE TABLE lease_settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  line_no integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('unpaid_rent', 'repair', 'electricity')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  item text,
  day_start integer,
  day_end integer,
  photo_count integer NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, settlement_id, line_no),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, settlement_id) REFERENCES lease_settlements (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, lease_id) REFERENCES leases (org_id, id) ON DELETE CASCADE
);
CREATE INDEX lease_settlement_lines_org_idx ON lease_settlement_lines (org_id, settlement_id);

ALTER TABLE lease_moveouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_settlement_lines ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON lease_moveouts, lease_settlements, lease_settlement_lines TO authenticated, service_role;
GRANT DELETE ON lease_settlement_lines TO authenticated, service_role;
REVOKE ALL ON lease_moveouts, lease_settlements, lease_settlement_lines FROM anon;

CREATE POLICY team_read ON lease_moveouts FOR SELECT TO authenticated
  USING (app.is_member(org_id));
CREATE POLICY team_insert ON lease_moveouts FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id));
CREATE POLICY team_update ON lease_moveouts FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id))
  WITH CHECK (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id));

CREATE POLICY team_read ON lease_settlements FOR SELECT TO authenticated
  USING (app.is_member(org_id));
CREATE POLICY team_insert ON lease_settlements FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id));
CREATE POLICY team_update ON lease_settlements FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id))
  WITH CHECK (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id));

CREATE POLICY team_read ON lease_settlement_lines FOR SELECT TO authenticated
  USING (app.is_member(org_id));
CREATE POLICY team_insert ON lease_settlement_lines FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id));
CREATE POLICY team_update ON lease_settlement_lines FOR UPDATE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id))
  WITH CHECK (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id));
CREATE POLICY team_delete ON lease_settlement_lines FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}') AND app.lease_lifecycle_on(org_id));
