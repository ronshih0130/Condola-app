-- B-031 slice 2 AUDIT_DETAIL. Additive only; default OFF.
-- Authorized before/after/reason detail for a small allowlist of important row
-- updates that the existing fn_audit trigger already writes to audit_log.
--
-- Write: an AFTER INSERT trigger on audit_log reads the row the existing trigger
--   just wrote and, only when the organization's audit_detail flag is ON, stores
--   a masked field-level diff for allowlisted columns in a private table. Values
--   are masked at write; columns outside the allowlist are counted, never copied.
--   OFF writes nothing and existing audit_log rows are never changed.
-- Read: app.b031_audit_detail_rows is the only reader. It checks the caller is an
--   active admin of the pinned organization, the flag is ON, and the audit row
--   belongs to that organization. Anyone else receives zero rows.
-- Retention: detail rows follow their audit_log rows (append-only, no purge);
--   no retention policy is introduced here.

INSERT INTO public.platform_settings(key, value)
VALUES ('audit_detail', '{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b031_audit_details (
  audit_id bigint PRIMARY KEY,
  org_id uuid NOT NULL,
  table_name text NOT NULL CHECK (table_name IN ('leases', 'contacts', 'org_members', 'properties', 'units', 'rooms')),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) BETWEEN 1 AND 40),
  withheld integer NOT NULL DEFAULT 0 CHECK (withheld >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- No FK to audit_log: existing local fixtures delete audit_log rows with
-- replica triggers. The capture trigger is the only writer and uses NEW.id.
CREATE INDEX b031_audit_details_org_idx ON app.b031_audit_details (org_id, audit_id);
REVOKE ALL ON app.b031_audit_details FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE app.b031_audit_details ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_b031_audit_details_append_only BEFORE UPDATE OR DELETE ON app.b031_audit_details
  FOR EACH ROW EXECUTE FUNCTION public.fn_append_only();

-- Strict flag: global switch with an allowlist that names the org, plus the org's own flag.
CREATE FUNCTION app.b031_audit_detail_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_org IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.platform_settings f
      JOIN public.organizations o ON o.id = p_org
     WHERE f.key = 'audit_detail'
       AND f.value->'enabled' = 'true'::jsonb
       AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
       AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
       AND o.feature_flags->'audit_detail' = 'true'::jsonb
  )
$$;

-- Width folding: a character whose NFKC form is one ASCII letter, digit, @ or + is
-- replaced by that form (full-width ０-９ Ａ-Ｚ ＠ ＋, circled digits, ...). Other
-- characters, including Chinese punctuation, are kept as written.
CREATE FUNCTION app.b031_fold_width(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE coalesce((
    SELECT string_agg(CASE WHEN s.n ~ '^[0-9A-Za-z@+]$' THEN s.n ELSE s.c END, '' ORDER BY s.i)
      FROM (SELECT t.c, t.i, normalize(t.c, NFKC) AS n
              FROM regexp_split_to_table(p, '') WITH ORDINALITY AS t(c, i)) s
  ), '') END
$$;

-- Free text, after width folding. Separators S = space, ideographic space, - . ( )
-- and their full-width forms; digit groups may be joined by up to two of them.
--   emails; UUIDs; national ID / resident certificate numbers (separators allowed);
--   token-like runs: 16+ of [A-Za-z0-9_+/=.-] containing both a letter and a digit
--   (snake_case reason codes and ordinary words have no digit and are kept);
--   any 10+ digits joined by separators (bank accounts, cards); then Taiwan phone
--   numbers (+886 or a leading 0, 8+ digits). Mirrored by maskDetailText in audit-read.ts.
CREATE FUNCTION app.b031_mask_text(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m constant text := '••••••••••';
  sep constant text := '[- ().．（）－　]';
  tok constant text := '[A-Za-z0-9_+/=.-]';
  t text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  t := app.b031_fold_width(p);
  t := regexp_replace(t, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', m, 'g');
  t := regexp_replace(t, '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}', m, 'g');
  t := regexp_replace(t, '(?<![A-Za-z])[A-Za-z]' || sep || '?[1289](' || sep || '?[0-9]){8}', m, 'g');
  t := regexp_replace(t, '(?<![A-Za-z])[A-Za-z]{2}(' || sep || '?[0-9]){8}', m, 'g');
  t := regexp_replace(t, '(^|[^A-Za-z0-9_+/=.-])(?=' || tok || '*[0-9])(?=' || tok || '*[A-Za-z])' || tok || '{16,}(?!' || tok || ')', '\1' || m, 'g');
  t := regexp_replace(t, '(?<![0-9])[+(（]?[0-9](' || sep || '{0,2}[0-9]){9,}(?![0-9])', m, 'g');
  t := regexp_replace(t, '(\+' || sep || '?886|(?<![0-9A-Za-z])\(?0)' || sep || '{0,2}[0-9](' || sep || '{0,2}[0-9]){6,9}(?![0-9])', m, 'g');
  RETURN t;
END
$$;

-- One allowlisted scalar to masked text. Unexpected shapes are fully masked.
CREATE FUNCTION app.b031_mask_value(p_kind text, p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v text;
  at_position integer;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) IN ('object', 'array') THEN RETURN '••••••••••'; END IF;
  v := p #>> '{}';
  CASE p_kind
    WHEN 'money', 'number' THEN
      RETURN CASE WHEN jsonb_typeof(p) = 'number' AND v ~ '^-?[0-9]{1,19}(\.[0-9]{1,6})?$' THEN v ELSE '••••••••••' END;
    WHEN 'date' THEN
      RETURN CASE WHEN v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v ELSE '••••••••••' END;
    WHEN 'time' THEN
      RETURN CASE WHEN v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+([+-][0-9:]+|Z)?$' THEN v ELSE '••••••••••' END;
    WHEN 'bool' THEN
      RETURN CASE WHEN jsonb_typeof(p) = 'boolean' THEN v ELSE '••••••••••' END;
    WHEN 'code' THEN
      RETURN CASE WHEN v ~ '^[a-z_]{1,40}$' THEN v ELSE '••••••••••' END;
    WHEN 'email' THEN
      v := app.b031_fold_width(v);
      at_position := strpos(v, '@');
      IF at_position < 2 THEN RETURN '••••••••••'; END IF;
      RETURN left(v, 1) || '***@' || left(app.b031_mask_text(substr(v, at_position + 1)), 120);
    WHEN 'phone' THEN
      v := regexp_replace(app.b031_fold_width(v), '[^0-9+]', '', 'g');
      IF length(v) < 6 THEN RETURN '••••••••••'; END IF;
      IF v ~ '^\+886[0-9]+$' THEN
        RETURN '+886' || repeat('*', length(v) - 6) || right(v, 2);
      END IF;
      RETURN left(v, 1) || repeat('*', length(v) - 3) || right(v, 2);
    WHEN 'text' THEN
      RETURN left(app.b031_mask_text(v), 200);
    ELSE
      RETURN '••••••••••';
  END CASE;
END
$$;

-- Allowlist. A column not listed here is counted in withheld and never copied.
CREATE FUNCTION app.b031_audit_detail_kind(p_table text, p_column text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN p_column ~* '(token|secret|password|hash|session|encrypt|storage|legal_name|id_number|national|passport|bank|account|line_user|einvoice|tax)' THEN NULL
    ELSE (SELECT s.kind FROM (VALUES
      ('leases', 'rent_amount_minor', 'money'),
      ('leases', 'deposit_amount_minor', 'money'),
      ('leases', 'deposit_months', 'number'),
      ('leases', 'start_date', 'date'),
      ('leases', 'end_date', 'date'),
      ('leases', 'due_day', 'number'),
      ('leases', 'status', 'code'),
      ('leases', 'renewal_status', 'code'),
      ('leases', 'terminated_on', 'date'),
      ('leases', 'moved_out_on', 'date'),
      ('leases', 'termination_reason', 'text'),
      ('leases', 'deposit_override_reason', 'text'),
      ('contacts', 'display_name', 'text'),
      ('contacts', 'company_name', 'text'),
      ('contacts', 'email', 'email'),
      ('contacts', 'phone_e164', 'phone'),
      ('contacts', 'is_tenant', 'bool'),
      ('contacts', 'is_owner', 'bool'),
      ('contacts', 'is_vendor', 'bool'),
      ('contacts', 'archived_at', 'time'),
      ('org_members', 'role', 'code'),
      ('org_members', 'status', 'code'),
      ('org_members', 'is_billing_owner', 'bool'),
      ('org_members', 'title', 'text'),
      ('properties', 'name', 'text'),
      ('properties', 'address_display', 'text'),
      ('properties', 'default_rental_mode', 'code'),
      ('properties', 'archived_at', 'time'),
      ('units', 'label', 'text'),
      ('units', 'rental_mode', 'code'),
      ('units', 'base_rent_minor', 'money'),
      ('units', 'archived_at', 'time'),
      ('rooms', 'label', 'text'),
      ('rooms', 'base_rent_minor', 'money'),
      ('rooms', 'archived_at', 'time')
    ) AS s(tbl, col, kind) WHERE s.tbl = p_table AND s.col = p_column)
  END
$$;

CREATE FUNCTION app.b031_capture_audit_detail() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  col text;
  kind text;
  cur text;
  entry jsonb;
  changes jsonb := '[]'::jsonb;
  withheld integer := 0;
BEGIN
  -- Detail capture must never roll back the audited business write: any error
  -- skips the detail row only. The warning carries the SQLSTATE, never values.
  BEGIN
    IF NEW.old_row IS NULL OR NEW.new_row IS NULL OR NEW.changed_cols IS NULL THEN RETURN NULL; END IF;
    IF NOT app.b031_audit_detail_on(NEW.org_id) THEN RETURN NULL; END IF;
    FOREACH col IN ARRAY NEW.changed_cols LOOP
      CONTINUE WHEN col IN ('updated_at', 'created_at');
      kind := app.b031_audit_detail_kind(NEW.table_name, col);
      IF kind IS NULL THEN
        withheld := withheld + 1;
        CONTINUE;
      END IF;
      entry := jsonb_build_object(
        'f', col,
        'k', kind,
        'b', app.b031_mask_value(kind, NEW.old_row -> col),
        'a', app.b031_mask_value(kind, NEW.new_row -> col)
      );
      IF kind = 'money' THEN
        IF cur IS NULL THEN
          cur := btrim(coalesce(NEW.new_row ->> 'currency', NEW.old_row ->> 'currency', ''));
          IF cur = '' AND NEW.table_name = 'units' THEN
            SELECT btrim(p.currency) INTO cur FROM public.properties p
             WHERE p.id = (NEW.new_row ->> 'property_id')::uuid AND p.org_id = NEW.org_id;
          ELSIF cur = '' AND NEW.table_name = 'rooms' THEN
            SELECT btrim(p.currency) INTO cur FROM public.units u
              JOIN public.properties p ON p.id = u.property_id AND p.org_id = u.org_id
             WHERE u.id = (NEW.new_row ->> 'unit_id')::uuid AND u.org_id = NEW.org_id;
          END IF;
          IF cur IS NULL OR cur !~ '^[A-Z]{3}$' THEN cur := 'TWD'; END IF;
        END IF;
        entry := entry || jsonb_build_object('c', cur);
      END IF;
      changes := changes || jsonb_build_array(entry);
    END LOOP;
    IF jsonb_array_length(changes) = 0 THEN RETURN NULL; END IF;
    INSERT INTO app.b031_audit_details (audit_id, org_id, table_name, reason, changes, withheld)
    VALUES (NEW.id, NEW.org_id, NEW.table_name, left(app.b031_mask_text(nullif(btrim(NEW.reason), '')), 500), changes, withheld)
    ON CONFLICT (audit_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'b031 audit detail skipped: %', SQLSTATE;
  END;
  RETURN NULL;
END
$$;

CREATE TRIGGER trg_b031_audit_detail AFTER INSERT ON public.audit_log
  FOR EACH ROW
  WHEN (NEW.action = 'update' AND NEW.org_id IS NOT NULL
        AND NEW.table_name IN ('leases', 'contacts', 'org_members', 'properties', 'units', 'rooms'))
  EXECUTE FUNCTION app.b031_capture_audit_detail();

-- The only reader. Zero rows unless: signed-in caller, pinned org matches,
-- caller is an active admin of that org, and the flag is ON for it.
CREATE FUNCTION app.b031_audit_detail_rows(p_org uuid, p_ids bigint[])
RETURNS TABLE (audit_id text, reason text, changes jsonb, withheld integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_org IS NULL OR p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 100 THEN RETURN; END IF;
  IF auth.uid() IS NULL THEN RETURN; END IF;
  IF nullif(current_setting('app.active_org_id', true), '') IS DISTINCT FROM p_org::text THEN RETURN; END IF;
  IF NOT app.has_role(p_org, '{admin}'::public.org_role[]) THEN RETURN; END IF;
  IF NOT app.b031_audit_detail_on(p_org) THEN RETURN; END IF;
  RETURN QUERY
    SELECT d.audit_id::text, d.reason, d.changes, d.withheld
      FROM app.b031_audit_details d
      JOIN public.audit_log a ON a.id = d.audit_id AND a.org_id = d.org_id AND a.table_name = d.table_name
     WHERE d.org_id = p_org AND d.audit_id = ANY (p_ids)
     ORDER BY d.audit_id;
END
$$;

REVOKE ALL ON FUNCTION app.b031_audit_detail_on(uuid), app.b031_fold_width(text), app.b031_mask_text(text), app.b031_mask_value(text, jsonb),
  app.b031_audit_detail_kind(text, text), app.b031_capture_audit_detail(), app.b031_audit_detail_rows(uuid, bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
-- tx() reads as authenticated with request.jwt.claim.sub and app.active_org_id set.
GRANT EXECUTE ON FUNCTION app.b031_audit_detail_rows(uuid, bigint[]) TO authenticated;
