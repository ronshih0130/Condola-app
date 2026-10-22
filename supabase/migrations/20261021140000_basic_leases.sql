-- Version 20261021140000.
-- Basic leases: optional tenant LINE id, deposit-cap reason, paper-signed PDF.
--
-- A lease targets one portfolio space. A room uses rooms.id (leases.target_room_id).
-- A whole unit uses units.id (leases.target_unit_id). Portfolio spaces are that
-- union (see listSpaces); this migration does not add a spaces table.

ALTER TABLE contacts ADD COLUMN line_user_id text;
ALTER TABLE contacts ADD CONSTRAINT contacts_line_user_id_len
  CHECK (line_user_id IS NULL OR char_length(line_user_id) BETWEEN 1 AND 64);

ALTER TABLE leases
  ADD COLUMN deposit_override_reason text,
  ADD COLUMN deposit_overridden_by uuid REFERENCES auth.users(id),
  ADD COLUMN deposit_overridden_at timestamptz,
  ADD CONSTRAINT leases_deposit_override_pair CHECK (
    (deposit_override_reason IS NULL AND deposit_overridden_by IS NULL)
    OR (btrim(deposit_override_reason) <> '' AND deposit_overridden_by IS NOT NULL)
  );

-- TW Art. 7 cap is two months. Saving over the cap now requires a typed reason.
UPDATE jurisdiction_rules
   SET enforcement = 'override_required'
 WHERE org_id IS NULL
   AND rule_key = 'deposit.max_months'
   AND jurisdiction_id = (SELECT id FROM jurisdictions WHERE code = 'TW');

-- Private bytes for a paper-signed lease. files stores the object key only.
-- Bucket name matches a private Supabase Storage bucket (never public).
CREATE TABLE lease_signed_pdfs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id     uuid NOT NULL,
  file_id      uuid NOT NULL,
  bucket       text NOT NULL DEFAULT 'lease-documents-private'
                 CHECK (bucket = 'lease-documents-private'),
  object_path  text NOT NULL,
  content      bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_path),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lease_id) REFERENCES leases(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id) ON DELETE CASCADE,
  CHECK (octet_length(content) BETWEEN 5 AND 8388608),
  CHECK (
    get_byte(content, 0) = 37 AND get_byte(content, 1) = 80
    AND get_byte(content, 2) = 68 AND get_byte(content, 3) = 70
  )
);
CREATE INDEX lease_signed_pdfs_lease_idx ON lease_signed_pdfs(lease_id, created_at DESC);

ALTER TABLE lease_signed_pdfs ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_read ON lease_signed_pdfs FOR SELECT TO authenticated
  USING (app.is_member(org_id));
CREATE POLICY team_insert ON lease_signed_pdfs FOR INSERT TO authenticated
  WITH CHECK (app.has_role(org_id, '{admin,manager}'));
CREATE POLICY team_delete ON lease_signed_pdfs FOR DELETE TO authenticated
  USING (app.has_role(org_id, '{admin,manager}'));

GRANT SELECT, INSERT, DELETE ON lease_signed_pdfs TO authenticated, service_role;

-- Deposit cap. Jurisdiction hard_block never saves. override_required (TW) and the
-- product rule (more than 2 months' rent) save only with a non-blank reason typed
-- by the current admin or manager. Warn-only caps under 2 months stay warnings.
CREATE OR REPLACE FUNCTION fn_lease_deposit_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p properties;
  r jurisdiction_rules;
  months numeric;
  maxm numeric;
  outcome rule_check_outcome;
  reason text;
  reason_ok boolean;
BEGIN
  SELECT * INTO p FROM properties WHERE id = NEW.property_id;
  r := effective_rule(p.jurisdiction_id, NEW.org_id, 'deposit.max_months', NEW.start_date);
  maxm := CASE WHEN r.id IS NULL THEN NULL ELSE (r.value->>'max_months')::numeric END;
  months := coalesce(
    NEW.deposit_months,
    CASE WHEN NEW.rent_amount_minor > 0 THEN NEW.deposit_amount_minor::numeric / NEW.rent_amount_minor END,
    0
  );
  reason := btrim(coalesce(NEW.deposit_override_reason, ''));
  reason_ok := reason <> '' AND NEW.deposit_overridden_by IS NOT NULL;
  IF reason_ok AND auth.uid() IS NOT NULL THEN
    IF NEW.deposit_overridden_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'deposit_overridden_by must be the current user' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.has_role(NEW.org_id, '{admin,manager}') THEN
      RAISE EXCEPTION 'only an admin or manager can override the deposit cap' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  outcome := 'pass';
  IF r.id IS NOT NULL AND maxm IS NOT NULL AND months > maxm THEN
    IF r.enforcement = 'hard_block' THEN
      outcome := 'block';
    ELSIF r.enforcement = 'override_required' THEN
      outcome := CASE WHEN reason_ok THEN 'overridden'::rule_check_outcome ELSE 'block'::rule_check_outcome END;
    ELSIF r.enforcement = 'warn' THEN
      outcome := 'warn';
    END IF;
  END IF;

  IF months > 2 AND outcome IS DISTINCT FROM 'block' THEN
    outcome := CASE WHEN reason_ok THEN 'overridden'::rule_check_outcome ELSE 'block'::rule_check_outcome END;
  END IF;

  IF outcome = 'block' AND NEW.status IN ('draft', 'pending_signature', 'active') THEN
    RAISE EXCEPTION 'deposit of % months exceeds cap of % months', round(months, 2), coalesce(maxm, 2)
      USING ERRCODE = 'check_violation';
  END IF;

  IF r.id IS NOT NULL THEN
    INSERT INTO rule_check_results (
      org_id, rule_id, entity_table, entity_id, outcome, observed, limit_value, message_key, overridden_by, override_reason
    ) VALUES (
      NEW.org_id, r.id, 'leases', NEW.id, outcome,
      jsonb_build_object('deposit_months', round(months, 2), 'deposit_amount_minor', NEW.deposit_amount_minor),
      coalesce(r.value, jsonb_build_object('max_months', 2)),
      'rules.deposit.max_months',
      CASE WHEN outcome = 'overridden' THEN NEW.deposit_overridden_by END,
      CASE WHEN outcome = 'overridden' THEN reason END
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lease_deposit_check ON leases;
CREATE TRIGGER trg_lease_deposit_check
  AFTER INSERT OR UPDATE OF deposit_amount_minor, deposit_months, rent_amount_minor, status,
                         deposit_override_reason, deposit_overridden_by
  ON leases
  FOR EACH ROW EXECUTE FUNCTION fn_lease_deposit_check();
