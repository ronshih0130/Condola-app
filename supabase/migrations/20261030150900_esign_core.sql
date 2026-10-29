BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.esign_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  lease_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retention_until timestamptz NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lease_id) REFERENCES public.leases(org_id, id)
);

CREATE TABLE public.esign_versions (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES public.esign_cases(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','partially_signed','fully_signed','voided','superseded')),
  body text NOT NULL CHECK (length(trim(body)) > 0),
  pdf_bytes bytea NOT NULL CHECK (octet_length(pdf_bytes) > 0),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  final_pdf_bytes bytea,
  final_digest text CHECK (final_digest ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz,
  previous_version_id uuid,
  supersedes_version_id uuid,
  replacement_text text,
  void_reason text,
  voided_by uuid,
  voided_at timestamptz,
  state jsonb NOT NULL,
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, id),
  FOREIGN KEY (case_id, previous_version_id) REFERENCES public.esign_versions(case_id, id),
  FOREIGN KEY (case_id, supersedes_version_id) REFERENCES public.esign_versions(case_id, id),
  CHECK (previous_version_id IS DISTINCT FROM id),
  CHECK (supersedes_version_id IS DISTINCT FROM id),
  CHECK (content_digest = encode(sha256(pdf_bytes), 'hex')),
  CHECK ((final_pdf_bytes IS NULL) = (final_digest IS NULL)),
  CHECK (final_digest IS NULL OR final_digest = encode(sha256(final_pdf_bytes), 'hex')),
  CHECK (status NOT IN ('fully_signed','superseded') OR
    (completed_at IS NOT NULL AND final_digest IS NOT NULL)),
  CHECK (status <> 'voided' OR
    (length(trim(void_reason)) > 0 AND voided_by IS NOT NULL AND voided_at IS NOT NULL))
);

CREATE UNIQUE INDEX esign_one_pending_replacement
  ON public.esign_versions(supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL
    AND status IN ('draft','sent','partially_signed');

CREATE INDEX esign_versions_case_idx ON public.esign_versions(case_id);

CREATE TABLE public.esign_signers (
  version_id uuid NOT NULL REFERENCES public.esign_versions(id),
  id uuid NOT NULL REFERENCES auth.users(id),
  party_role text NOT NULL CHECK (party_role IN ('owner','tenant')),
  email text NOT NULL CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  email_step_state text NOT NULL DEFAULT 'pending'
    CHECK (email_step_state IN ('pending','completed','failed')),
  email_step_at timestamptz,
  signed_at timestamptz,
  state jsonb NOT NULL,
  PRIMARY KEY (version_id, id)
);

COMMENT ON COLUMN public.esign_signers.email_step_state IS
  'Email 身分確認步驟: pending, completed, failed. This describes a workflow step only.';

CREATE TABLE public.esign_signature_images (
  version_id uuid NOT NULL,
  signer_id uuid NOT NULL,
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) BETWEEN 8 AND 2097152),
  image_digest text NOT NULL CHECK (image_digest ~ '^[a-f0-9]{64}$'),
  document_digest text NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
  signed_at timestamptz NOT NULL,
  ip_address inet NOT NULL,
  device_id text NOT NULL CHECK (length(trim(device_id)) > 0),
  user_agent text NOT NULL CHECK (length(trim(user_agent)) > 0),
  PRIMARY KEY (version_id, signer_id),
  FOREIGN KEY (version_id, signer_id)
    REFERENCES public.esign_signers(version_id, id),
  CHECK (image_digest = encode(sha256(image_bytes), 'hex'))
);

CREATE TABLE public.esign_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.esign_cases(id),
  version_id uuid,
  sequence_no bigint NOT NULL,
  actor_id uuid,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[a-f0-9]{64}$'),
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  retention_until timestamptz NOT NULL,
  UNIQUE (case_id, sequence_no),
  FOREIGN KEY (case_id, version_id) REFERENCES public.esign_versions(case_id, id)
);

COMMENT ON TABLE public.esign_cases IS
  'Retain through lease end + 15 years; open-ended leases retain indefinitely. The 90-day ID-photo purge job must never touch these tables.';
COMMENT ON TABLE public.esign_versions IS
  'Immutable document bytes and digests. The 90-day ID-photo purge job must never touch these tables.';
COMMENT ON TABLE public.esign_signers IS
  'Version-local consent, review and Email 身分確認步驟. The 90-day ID-photo purge job must never touch these tables.';
COMMENT ON TABLE public.esign_signature_images IS
  'Immutable signature evidence. The 90-day ID-photo purge job must never touch these tables.';
COMMENT ON TABLE public.esign_audit_events IS
  'Append-only hash chain; retained permanently by this migration. The 90-day ID-photo purge job must never touch these tables.';

CREATE FUNCTION public.esign_reject_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'E-sign evidence is read-only' USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION public.esign_case_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  lease_end date;
BEGIN
  SELECT end_date INTO STRICT lease_end
    FROM public.leases WHERE org_id = NEW.org_id AND id = NEW.lease_id
    FOR SHARE;
  NEW.retention_until := CASE WHEN lease_end IS NULL THEN 'infinity'::timestamptz
    ELSE (lease_end::timestamp + interval '15 years') AT TIME ZONE 'UTC' END;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.esign_lease_retention_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.end_date IS DISTINCT FROM OLD.end_date AND EXISTS (
    SELECT 1 FROM public.esign_cases c
    WHERE c.lease_id = OLD.id AND c.org_id = OLD.org_id
      AND c.retention_until < (CASE WHEN NEW.end_date IS NULL
        THEN 'infinity'::timestamptz
        ELSE (NEW.end_date::timestamp + interval '15 years') AT TIME ZONE 'UTC' END)
  ) THEN
    RAISE EXCEPTION 'Lease extension requires a separate retained e-sign case'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.esign_version_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  keep_until timestamptz;
  predecessor public.esign_versions;
  marker text;
BEGIN
  SELECT retention_until INTO STRICT keep_until
    FROM public.esign_cases WHERE id = NEW.case_id FOR UPDATE;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.final_digest IS NOT NULL
      OR NEW.completed_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'New versions start as drafts' USING ERRCODE = '23514';
    END IF;
    NEW.retention_until := keep_until;
    IF NEW.supersedes_version_id IS NOT NULL THEN
      SELECT * INTO STRICT predecessor FROM public.esign_versions
        WHERE id = NEW.supersedes_version_id AND case_id = NEW.case_id;
      IF predecessor.status <> 'fully_signed' THEN
        RAISE EXCEPTION 'Predecessor is not effective' USING ERRCODE = '23514';
      END IF;
      marker := '本版取代 ' ||
        to_char(predecessor.completed_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') ||
        ' 簽署之前版';
      IF NEW.replacement_text IS DISTINCT FROM marker OR NOT EXISTS (
        SELECT 1 FROM regexp_split_to_table(NEW.body, E'\r?\n') AS line
          WHERE trim(line) = marker
      ) THEN
        RAISE EXCEPTION 'Replacement text required' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.replacement_text IS NOT NULL THEN
      RAISE EXCEPTION 'Replacement text requires a predecessor' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY[
      'status','state','final_pdf_bytes','final_digest','completed_at',
      'void_reason','voided_by','voided_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'status','state','final_pdf_bytes','final_digest','completed_at',
      'void_reason','voided_by','voided_at'
    ]) THEN
      RAISE EXCEPTION 'Document content and retention are immutable' USING ERRCODE = '23514';
    END IF;

    IF OLD.status IN ('voided','superseded') THEN
      RAISE EXCEPTION 'Old version is read-only' USING ERRCODE = '23514';
    END IF;

    IF OLD.status = 'fully_signed' THEN
      IF NEW.status <> 'superseded' OR
        (to_jsonb(NEW) - ARRAY['status','state']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['status','state']) OR
        (NEW.state - ARRAY['status','effect']) IS DISTINCT FROM
        (OLD.state - ARRAY['status','effect']) OR NOT EXISTS (
          SELECT 1 FROM public.esign_versions v
          WHERE v.case_id = OLD.case_id AND v.supersedes_version_id = OLD.id
            AND v.status = 'fully_signed'
        ) THEN
        RAISE EXCEPTION 'Both parties must complete the replacement first'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.status = 'superseded' THEN
      RAISE EXCEPTION 'Only a fully signed version can be superseded' USING ERRCODE = '23514';
    ELSIF NEW.status <> 'voided' AND NOT (
      (OLD.status = 'draft' AND NEW.status IN ('draft','sent')) OR
      (OLD.status = 'sent' AND NEW.status IN ('sent','partially_signed','fully_signed')) OR
      (OLD.status = 'partially_signed' AND NEW.status IN ('partially_signed','fully_signed'))
    ) THEN
      RAISE EXCEPTION 'Invalid version transition' USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'voided' AND NOT EXISTS (
      SELECT 1 FROM public.esign_cases c JOIN public.org_members m ON m.org_id = c.org_id
      WHERE c.id = NEW.case_id AND m.user_id = NEW.voided_by
        AND m.role = 'admin' AND m.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Company admin required to void' USING ERRCODE = '42501';
    END IF;

    IF NEW.status = 'fully_signed' AND OLD.status <> 'fully_signed' THEN
      IF EXISTS (
        SELECT 1 FROM public.esign_signers s
        WHERE s.version_id = NEW.id AND
          (s.signed_at IS NULL OR s.email_step_state <> 'completed' OR NOT EXISTS (
            SELECT 1 FROM public.esign_signature_images i
            WHERE i.version_id = s.version_id AND i.signer_id = s.id
              AND i.document_digest = NEW.content_digest
          ))
      ) OR NOT EXISTS (
        SELECT 1 FROM public.esign_signers WHERE version_id = NEW.id AND party_role = 'owner'
      ) OR NOT EXISTS (
        SELECT 1 FROM public.esign_signers WHERE version_id = NEW.id AND party_role = 'tenant'
      ) THEN
        RAISE EXCEPTION 'Both parties must sign' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status <> 'fully_signed' AND
      (NEW.final_digest IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Final artifact requires both signatures' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.state->>'id' IS DISTINCT FROM NEW.id::text OR
    NEW.state->>'body' IS DISTINCT FROM NEW.body OR
    NEW.state->>'documentDigest' IS DISTINCT FROM NEW.content_digest OR
    NEW.state->>'status' IS DISTINCT FROM (CASE NEW.status
      WHEN 'fully_signed' THEN 'completed'
      WHEN 'partially_signed' THEN 'signing'
      ELSE NEW.status END) THEN
    RAISE EXCEPTION 'Domain state mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.esign_child_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v public.esign_versions;
BEGIN
  SELECT * INTO STRICT v FROM public.esign_versions WHERE id = NEW.version_id;
  PERFORM 1 FROM public.esign_cases WHERE id = v.case_id FOR UPDATE;
  SELECT * INTO STRICT v FROM public.esign_versions WHERE id = NEW.version_id;

  IF v.status IN ('fully_signed','voided','superseded') THEN
    RAISE EXCEPTION 'Old version evidence is read-only' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'esign_signers' THEN
    IF TG_OP = 'INSERT' AND v.status <> 'draft' THEN
      RAISE EXCEPTION 'Signers can only be added to drafts' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      OLD.signed_at IS NOT NULL OR
      (NEW.version_id, NEW.id, NEW.party_role, NEW.email) IS DISTINCT FROM
      (OLD.version_id, OLD.id, OLD.party_role, OLD.email)
    ) THEN
      RAISE EXCEPTION 'Signer identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state->>'id' IS DISTINCT FROM NEW.id::text OR
      NEW.state->>'role' IS DISTINCT FROM NEW.party_role THEN
      RAISE EXCEPTION 'Signer state mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.signed_at IS NOT NULL AND (
      NEW.email_step_state <> 'completed' OR NOT EXISTS (
        SELECT 1 FROM public.esign_signature_images i
        WHERE i.version_id = NEW.version_id AND i.signer_id = NEW.id
          AND i.signed_at = NEW.signed_at
      )
    ) THEN
      RAISE EXCEPTION 'Signature evidence required' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.document_digest <> v.content_digest OR NOT EXISTS (
      SELECT 1 FROM public.esign_signers s
      WHERE s.version_id = NEW.version_id AND s.id = NEW.signer_id
        AND s.email_step_state = 'completed'
        AND s.state->>'status' = 'pending_signature'
        AND s.state->'consent' IS NOT NULL
        AND s.state->>'reviewedAt' IS NOT NULL
        AND (NOT coalesce((s.state->>'documentCheckRequired')::boolean, false)
          OR s.state->'foreignDocumentCheck' IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Signature prerequisites required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.esign_audit_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  preceding public.esign_audit_events;
BEGIN
  SELECT retention_until INTO STRICT NEW.retention_until
    FROM public.esign_cases WHERE id = NEW.case_id FOR UPDATE;
  SELECT * INTO preceding FROM public.esign_audit_events
    WHERE case_id = NEW.case_id ORDER BY sequence_no DESC LIMIT 1;
  NEW.sequence_no := coalesce(preceding.sequence_no, 0) + 1;
  NEW.prev_hash := coalesce(preceding.hash, repeat('0', 64));
  NEW.actor_id := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  NEW.occurred_at := clock_timestamp();
  NEW.hash := encode(sha256(convert_to(
    (to_jsonb(NEW) - 'hash')::text, 'UTF8'
  )), 'hex');
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.esign_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c uuid;
  v uuid;
  data jsonb;
BEGIN
  data := to_jsonb(NEW) - ARRAY['pdf_bytes','final_pdf_bytes','image_bytes'];
  IF TG_TABLE_NAME = 'esign_cases' THEN
    c := NEW.id;
  ELSIF TG_TABLE_NAME = 'esign_versions' THEN
    c := NEW.case_id;
    v := NEW.id;
  ELSE
    v := NEW.version_id;
    SELECT case_id INTO STRICT c FROM public.esign_versions WHERE id = v;
  END IF;
  INSERT INTO public.esign_audit_events(case_id, version_id, event_type, payload)
    VALUES (c, v, TG_TABLE_NAME || '.' || lower(TG_OP), data);
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.esign_can_read(p_case uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.esign_cases c WHERE c.id = p_case AND (
      app.is_member(c.org_id) OR EXISTS (
        SELECT 1 FROM public.esign_versions v JOIN public.esign_signers s ON s.version_id = v.id
        WHERE v.case_id = c.id AND s.id = auth.uid()
      )
    )
  );
$$;

CREATE FUNCTION public.esign_is_management(p_case uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.esign_cases c WHERE c.id = p_case
      AND app.has_role(c.org_id, ARRAY['admin','manager']::public.org_role[])
  );
$$;

COMMENT ON FUNCTION public.esign_is_management(uuid) IS
  'Company management for technical audit access means active admin and manager roles.';

CREATE FUNCTION public.esign_audit_summary(p_case uuid)
RETURNS TABLE (version_id uuid, signer_id uuid, signed_at timestamptz, email_step_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.version_id, s.id, s.signed_at, s.email_step_state
  FROM public.esign_versions v JOIN public.esign_signers s ON s.version_id = v.id
  WHERE v.case_id = p_case AND public.esign_can_read(p_case)
    AND (app.is_member((SELECT org_id FROM public.esign_cases WHERE id = p_case))
      OR s.id = auth.uid());
$$;

CREATE TRIGGER esign_case_insert BEFORE INSERT ON public.esign_cases
  FOR EACH ROW EXECUTE FUNCTION public.esign_case_insert();
CREATE TRIGGER esign_case_readonly BEFORE UPDATE OR DELETE ON public.esign_cases
  FOR EACH ROW EXECUTE FUNCTION public.esign_reject_change();
CREATE TRIGGER esign_lease_retention BEFORE UPDATE OF end_date ON public.leases
  FOR EACH ROW EXECUTE FUNCTION public.esign_lease_retention_guard();
CREATE TRIGGER esign_version_guard BEFORE INSERT OR UPDATE ON public.esign_versions
  FOR EACH ROW EXECUTE FUNCTION public.esign_version_guard();
CREATE TRIGGER esign_signer_guard BEFORE INSERT OR UPDATE ON public.esign_signers
  FOR EACH ROW EXECUTE FUNCTION public.esign_child_guard();
CREATE TRIGGER esign_image_guard BEFORE INSERT ON public.esign_signature_images
  FOR EACH ROW EXECUTE FUNCTION public.esign_child_guard();
CREATE TRIGGER esign_images_readonly BEFORE UPDATE OR DELETE ON public.esign_signature_images
  FOR EACH ROW EXECUTE FUNCTION public.esign_reject_change();
CREATE TRIGGER esign_audit_chain BEFORE INSERT ON public.esign_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.esign_audit_chain();
CREATE TRIGGER esign_audit_readonly BEFORE UPDATE OR DELETE ON public.esign_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.esign_reject_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'esign_cases','esign_versions','esign_signers','esign_signature_images'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER esign_row_audit AFTER INSERT OR UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.esign_audit_row()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['esign_versions','esign_signers'] LOOP
    EXECUTE format(
      'CREATE TRIGGER esign_no_delete BEFORE DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.esign_reject_change()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'esign_cases','esign_versions','esign_signers','esign_signature_images','esign_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO service_role', t);
    EXECUTE format(
      'CREATE TRIGGER esign_no_truncate BEFORE TRUNCATE ON public.%I
       FOR EACH STATEMENT EXECUTE FUNCTION public.esign_reject_change()', t);
  END LOOP;
END;
$$;

-- SELECT ... FOR UPDATE in EsignRepo.lock requires UPDATE on at least one
-- column. Case rows remain immutable: esign_case_readonly rejects all updates.
GRANT UPDATE (id) ON public.esign_cases TO service_role;
GRANT UPDATE ON public.esign_versions, public.esign_signers TO service_role;

GRANT SELECT ON public.esign_cases TO authenticated;
GRANT SELECT (
  id, case_id, status, body, pdf_bytes, content_digest, final_pdf_bytes,
  final_digest, completed_at, previous_version_id, supersedes_version_id,
  replacement_text, retention_until, created_at
) ON public.esign_versions TO authenticated;
GRANT SELECT (
  version_id, id, party_role, email, email_step_state, email_step_at, signed_at
) ON public.esign_signers TO authenticated;
GRANT SELECT ON public.esign_signature_images, public.esign_audit_events TO authenticated;

CREATE POLICY esign_cases_read ON public.esign_cases FOR SELECT TO authenticated
  USING (public.esign_can_read(id));
CREATE POLICY esign_versions_read ON public.esign_versions FOR SELECT TO authenticated
  USING (public.esign_can_read(case_id));
CREATE POLICY esign_signers_read ON public.esign_signers FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.esign_is_management(
    (SELECT case_id FROM public.esign_versions WHERE id = version_id)
  ));
CREATE POLICY esign_images_read ON public.esign_signature_images FOR SELECT TO authenticated
  USING (public.esign_is_management(
    (SELECT case_id FROM public.esign_versions WHERE id = version_id)
  ));
CREATE POLICY esign_audit_read ON public.esign_audit_events FOR SELECT TO authenticated
  USING (public.esign_is_management(case_id));

REVOKE ALL ON FUNCTION public.esign_reject_change(),
  public.esign_case_insert(), public.esign_lease_retention_guard(),
  public.esign_version_guard(), public.esign_child_guard(),
  public.esign_audit_chain(), public.esign_audit_row(),
  public.esign_can_read(uuid), public.esign_is_management(uuid),
  public.esign_audit_summary(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.esign_reject_change(),
  public.esign_case_insert(), public.esign_lease_retention_guard(),
  public.esign_version_guard(), public.esign_child_guard(),
  public.esign_audit_chain(), public.esign_audit_row(),
  public.esign_can_read(uuid), public.esign_is_management(uuid),
  public.esign_audit_summary(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.esign_can_read(uuid),
  public.esign_is_management(uuid), public.esign_audit_summary(uuid) TO authenticated;

COMMIT;
