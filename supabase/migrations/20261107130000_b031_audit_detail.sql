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
  -- Copied from the audit_log row; the reader requires all of them to match.
  row_id text NOT NULL,
  audit_occurred_at timestamptz NOT NULL,
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

-- Detail text masking. One specification, implemented identically here (authoritative)
-- and in maskDetailText (src/server/audit-read.ts, defence in depth):
--  0. Cap: more than 1000 characters keeps the first 1000 and discards the cut final
--     non-CJK word, so no partial number or token survives the cut.
--  1. Normalise: NFKC; remove format/zero-width characters and combining marks; map the
--     dash/minus family to '-', every space character and control whitespace to ' ',
--     '。' to '.'; collapse spaces and trim.
--  2. Any word containing '@', a spaced 'x @ y', and '(at)' / '[at]' forms: masked whole.
--  3. UUIDs. Token-like runs of [A-Za-z0-9_+/=.-]: 16+ with a letter and a digit;
--     6+ with 2+ letters and 4+ digits (LINE ids, passports, IBANs); 20+ with 3+
--     upper- and 3+ lower-case letters (base64/JWT). Snake_case reason codes and
--     ordinary words have no digit and stay readable.
--  4. One Latin letter glued to 7+ digits (national ID, ARC, passport).
--  5. Number scan: digit groups joined by 1-3 separator characters (ASCII punctuation,
--     space, · ・ 、 ‧) form one number, optionally led by '+' or '('. A plain-space
--     join needs both groups of at most 4 digits, unless the number starts with 0 or
--     '+'. A number of 8+ digits is masked. A number that starts with an ISO-like date
--     (YYYY-MM-DD, YYYY/MM/DD, optional HH:MM[:SS]) or a thousands-grouped amount
--     (25,000 / 1,250,000.50) keeps that date or amount as written, and a join never
--     continues into a following date.
CREATE FUNCTION app.b031_normalize_text(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  t := p;
  IF char_length(t) > 1000 THEN
    t := regexp_replace(left(t, 1000), '[^ \t\n\u3000\u3400-\u9FFF\uF900-\uFAFF]+$', '');
  END IF;
  t := normalize(t, NFKC);
  t := regexp_replace(t, '[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]', '', 'g');
  t := regexp_replace(t, '[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]', '-', 'g');
  t := regexp_replace(t, '[\u0009-\u000D\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]', ' ', 'g');
  t := regexp_replace(t, '[\u3002\uFF0E\uFF61]', '.', 'g');
  t := regexp_replace(t, ' {2,}', ' ', 'g');
  RETURN btrim(t, ' ');
END
$$;

CREATE FUNCTION app.b031_mask_text(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m constant text := '••••••••••';
  tok constant text := '[A-Za-z0-9_+/=.-]';
  edge constant text := '(^|[^A-Za-z0-9_+/=.-])';
  seps constant text := '!"#$%&''()*+,-./:;<=>?@[\]^_`{|}~·・、‧ ';
  digits constant text := '0123456789';
  date_re constant text := '^((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])( [0-9]{1,2}:[0-9]{2}(:[0-9]{2})?)?)(?![0-9]|[-/.][0-9])';
  amount_re constant text := '^([0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?)(?![0-9]|,[0-9])';
  t text;
  c text[];
  n integer;
  i integer;
  j integer;
  k integer;
  sepn integer;
  ns boolean;
  glen integer;
  prev integer;
  total integer;
  zero boolean;
  plus boolean;
  kept text;
  out text[] := '{}';
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  t := app.b031_normalize_text(p);
  t := regexp_replace(t, '[^ @]+ @ [^ @]+', m, 'g');
  t := regexp_replace(t, '[^ @]*@[^ ]*', m, 'g');
  t := regexp_replace(t, '[^ ]*[\[(]([Aa][Tt])[\])][^ ]*', m, 'g');
  t := regexp_replace(t, '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}', m, 'g');
  t := regexp_replace(t, edge || '(?=' || tok || '*[0-9])(?=' || tok || '*[A-Za-z])' || tok || '{16,}(?!' || tok || ')', '\1' || m, 'g');
  t := regexp_replace(t, edge || '(?=' || tok || '*[A-Za-z]' || tok || '*[A-Za-z])(?=' || tok || '*[0-9]' || tok || '*[0-9]' || tok || '*[0-9]' || tok || '*[0-9])' || tok || '{6,}(?!' || tok || ')', '\1' || m, 'g');
  t := regexp_replace(t, edge || '(?=' || tok || '*[A-Z]' || tok || '*[A-Z]' || tok || '*[A-Z])(?=' || tok || '*[a-z]' || tok || '*[a-z]' || tok || '*[a-z])' || tok || '{20,}(?!' || tok || ')', '\1' || m, 'g');
  t := regexp_replace(t, '[A-Za-z][0-9]{7,}', m, 'g');

  c := regexp_split_to_array(t, '');
  n := coalesce(array_length(c, 1), 0);
  i := 1;
  WHILE i <= n LOOP
    IF position(c[i] IN digits) > 0 OR (c[i] IN ('+', '(') AND i < n AND position(c[i + 1] IN digits) > 0) THEN
      plus := c[i] = '+';
      j := CASE WHEN c[i] IN ('+', '(') THEN i + 1 ELSE i END;
      kept := NULL;
      IF j = i THEN
        kept := substring(array_to_string(c[i:n], '') FROM date_re);
        IF kept IS NULL THEN kept := substring(array_to_string(c[i:n], '') FROM amount_re); END IF;
      END IF;
      IF kept IS NOT NULL THEN
        out := out || kept;
        i := i + char_length(kept);
        CONTINUE;
      END IF;
      zero := c[j] = '0';
      glen := 0;
      WHILE j <= n AND position(c[j] IN digits) > 0 LOOP glen := glen + 1; j := j + 1; END LOOP;
      total := glen;
      prev := glen;
      LOOP
        k := j;
        sepn := 0;
        ns := false;
        WHILE k <= n AND sepn < 3 AND position(c[k] IN seps) > 0 LOOP
          IF c[k] <> ' ' THEN ns := true; END IF;
          sepn := sepn + 1;
          k := k + 1;
        END LOOP;
        EXIT WHEN sepn = 0 OR k > n OR position(c[k] IN digits) = 0;
        EXIT WHEN substring(array_to_string(c[k:n], '') FROM date_re) IS NOT NULL;
        glen := 0;
        WHILE k + glen <= n AND position(c[k + glen] IN digits) > 0 LOOP glen := glen + 1; END LOOP;
        EXIT WHEN NOT ns AND NOT (prev <= 4 AND glen <= 4) AND NOT zero AND NOT plus;
        total := total + glen;
        prev := glen;
        j := k + glen;
      END LOOP;
      IF total >= 8 THEN out := out || m; ELSE out := out || array_to_string(c[i:j - 1], ''); END IF;
      i := j;
    ELSE
      out := out || c[i];
      i := i + 1;
    END IF;
  END LOOP;
  RETURN array_to_string(out, '');
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
      v := app.b031_normalize_text(v);
      at_position := strpos(v, '@');
      IF at_position < 2 THEN RETURN '••••••••••'; END IF;
      RETURN left(v, 1) || '***@' || left(app.b031_mask_text(substr(v, at_position + 1)), 120);
    WHEN 'phone' THEN
      v := regexp_replace(app.b031_normalize_text(v), '[^0-9+]', '', 'g');
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
  IF NEW.old_row IS NULL OR NEW.new_row IS NULL OR NEW.changed_cols IS NULL THEN RETURN NULL; END IF;
  -- OFF returns here, before the guarded block, so OFF writes open no subtransaction.
  IF NOT app.b031_audit_detail_on(NEW.org_id) THEN RETURN NULL; END IF;
  -- Detail capture must never roll back the audited business write: any error
  -- skips the detail row only. The warning carries the SQLSTATE, never values.
  BEGIN
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
    -- A pre-existing row under this id is left alone; it cannot match this event's
    -- org/table/row/time in the reader, so no older detail is attached to a new event.
    INSERT INTO app.b031_audit_details (audit_id, org_id, table_name, row_id, audit_occurred_at, reason, changes, withheld)
    VALUES (NEW.id, NEW.org_id, NEW.table_name, NEW.row_id, NEW.occurred_at,
            left(app.b031_mask_text(nullif(btrim(NEW.reason), '')), 500), changes, withheld)
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
                             AND a.row_id = d.row_id AND a.occurred_at = d.audit_occurred_at
     WHERE d.org_id = p_org AND d.audit_id = ANY (p_ids)
     ORDER BY d.audit_id;
END
$$;

REVOKE ALL ON FUNCTION app.b031_audit_detail_on(uuid), app.b031_normalize_text(text), app.b031_mask_text(text), app.b031_mask_value(text, jsonb),
  app.b031_audit_detail_kind(text, text), app.b031_capture_audit_detail(), app.b031_audit_detail_rows(uuid, bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
-- tx() reads as authenticated with request.jwt.claim.sub and app.active_org_id set.
GRANT EXECUTE ON FUNCTION app.b031_audit_detail_rows(uuid, bigint[]) TO authenticated;
