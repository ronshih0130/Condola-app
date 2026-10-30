BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Preserve immutable case retention while recording every additional horizon.
-- The live case table has UNIQUE (org_id, id), so use its tenant-bound key.
CREATE TABLE public.esign_retention_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  case_id uuid NOT NULL,
  retention_until timestamptz NOT NULL,
  lease_end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, case_id) REFERENCES public.esign_cases(org_id, id)
);

CREATE INDEX esign_retention_extensions_case_idx
  ON public.esign_retention_extensions(case_id, retention_until DESC);

COMMENT ON TABLE public.esign_retention_extensions IS
  'Append-only retention increases; removed with their case only by authorized post-retention disposal.';

ALTER TABLE public.esign_retention_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_retention_extensions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.esign_retention_extensions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.esign_retention_extensions
  TO authenticated, service_role;

CREATE POLICY esign_retention_extensions_read
  ON public.esign_retention_extensions FOR SELECT TO authenticated
  USING (public.esign_can_read(case_id));

-- No foreign key to the case: this minimal record must survive disposal.
CREATE TABLE public.esign_disposals (
  case_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  effective_retention timestamptz NOT NULL,
  final_digests text[] NOT NULL,
  disposed_at timestamptz NOT NULL DEFAULT now(),
  disposed_by text NOT NULL DEFAULT current_user
);

COMMENT ON TABLE public.esign_disposals IS
  'Permanent disposal tombstones containing identifiers and final digests only; no document bytes or signer details.';

ALTER TABLE public.esign_disposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_disposals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.esign_disposals
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.esign_disposals TO service_role;

-- Missing cases return NULL. Infinity remains infinity under greatest().
CREATE FUNCTION public.esign_effective_retention(p_case uuid)
RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT greatest(
    c.retention_until,
    (SELECT max(e.retention_until)
     FROM public.esign_retention_extensions e
     WHERE e.case_id = c.id)
  )
  FROM public.esign_cases c
  WHERE c.id = p_case;
$$;

REVOKE ALL ON FUNCTION public.esign_effective_retention(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.esign_effective_retention(uuid)
  TO service_role;

-- A lease update already holds the lease row lock. Lock associated cases in
-- deterministic order before extending their horizons. Disposal takes locks
-- in the same lease-then-case order and rechecks retention after both locks.
CREATE OR REPLACE FUNCTION public.esign_lease_retention_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  horizon timestamptz;
  retained_case record;
BEGIN
  IF NEW.end_date IS DISTINCT FROM OLD.end_date THEN
    horizon := CASE WHEN NEW.end_date IS NULL THEN 'infinity'::timestamptz
      ELSE (NEW.end_date::timestamp + interval '15 years')
        AT TIME ZONE 'UTC' END;

    FOR retained_case IN
      SELECT c.id, c.org_id
      FROM public.esign_cases c
      WHERE c.lease_id = OLD.id AND c.org_id = OLD.org_id
      ORDER BY c.id
      FOR UPDATE OF c
    LOOP
      IF horizon > public.esign_effective_retention(retained_case.id) THEN
        INSERT INTO public.esign_retention_extensions(
          org_id, case_id, retention_until, lease_end_date
        ) VALUES (
          retained_case.org_id, retained_case.id, horizon, NEW.end_date
        );
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- PRINCIPLES 16: disposal ships disabled and defaults to a read-only preview.
-- There is intentionally no migration INSERT enabling the platform setting.
CREATE FUNCTION public.esign_dispose_expired(
  p_dry_run boolean DEFAULT true,
  p_limit integer DEFAULT 100
)
RETURNS TABLE(
  case_id uuid,
  org_id uuid,
  effective_retention timestamptz,
  disposed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate record;
  horizon timestamptz;
  final_hashes text[];
BEGIN
  IF p_dry_run IS NULL THEN
    RAISE EXCEPTION 'p_dry_run must not be null' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 10000'
      USING ERRCODE = '22023';
  END IF;

  IF p_dry_run THEN
    RETURN QUERY
      SELECT c.id, c.org_id, public.esign_effective_retention(c.id), false
      FROM public.esign_cases c
      WHERE public.esign_effective_retention(c.id) < now()
      ORDER BY public.esign_effective_retention(c.id), c.id
      LIMIT p_limit;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.platform_settings s
    WHERE s.key = 'esign_disposal_enabled' AND s.value = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'esign disposal disabled' USING ERRCODE = '55000';
  END IF;

  -- Keep the capability off except during the guarded deletion sequence.
  PERFORM set_config('esign.disposal', 'off', true);

  FOR candidate IN
    SELECT c.id, c.org_id, c.lease_id
    FROM public.esign_cases c
    WHERE public.esign_effective_retention(c.id) < now()
    ORDER BY c.org_id, c.lease_id, c.id
    LIMIT p_limit
  LOOP
    -- Serialize against lease edits and new case/version evidence.
    PERFORM 1 FROM public.leases l
    WHERE l.org_id = candidate.org_id AND l.id = candidate.lease_id
    FOR UPDATE;

    PERFORM 1 FROM public.esign_cases c
    WHERE c.id = candidate.id
    FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- Recompute after locking: a concurrent extension may have committed
    -- after candidate selection. Never dispose based on a stale horizon.
    horizon := public.esign_effective_retention(candidate.id);
    IF horizon IS NULL OR horizon >= now() THEN
      CONTINUE;
    END IF;

    SELECT coalesce(
      array_agg(DISTINCT v.final_digest ORDER BY v.final_digest)
        FILTER (WHERE v.final_digest IS NOT NULL),
      ARRAY[]::text[]
    ) INTO final_hashes
    FROM public.esign_versions v WHERE v.case_id = candidate.id;

    INSERT INTO public.esign_disposals(
      case_id, org_id, lease_id, effective_retention, final_digests
    ) VALUES (
      candidate.id, candidate.org_id, candidate.lease_id, horizon, final_hashes
    );

    PERFORM set_config('esign.disposal', 'on', true);

    -- Delete in foreign-key order. Deleting all versions in one statement
    -- also satisfies their immediate self-referencing foreign keys.
    DELETE FROM public.esign_signature_images i
    USING public.esign_versions v
    WHERE i.version_id = v.id AND v.case_id = candidate.id;

    DELETE FROM public.esign_signers s
    USING public.esign_versions v
    WHERE s.version_id = v.id AND v.case_id = candidate.id;

    DELETE FROM public.esign_audit_events a WHERE a.case_id = candidate.id;
    DELETE FROM public.esign_versions v WHERE v.case_id = candidate.id;
    DELETE FROM public.esign_retention_extensions e
      WHERE e.case_id = candidate.id;
    DELETE FROM public.esign_cases c WHERE c.id = candidate.id;

    PERFORM set_config('esign.disposal', 'off', true);

    case_id := candidate.id;
    org_id := candidate.org_id;
    effective_retention := horizon;
    disposed := true;
    RETURN NEXT;
  END LOOP;

  PERFORM set_config('esign.disposal', 'off', true);
  RETURN;
EXCEPTION WHEN OTHERS THEN
  -- The exception rolls back this block's writes; do not leave its capability
  -- enabled if an enclosing caller catches the error.
  PERFORM set_config('esign.disposal', 'off', true);
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.esign_dispose_expired(boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.esign_dispose_expired(boolean, integer)
  TO service_role;

-- SECURITY INVOKER is essential: a definer trigger would replace the caller's
-- identity with its own owner and let a manually set GUC impersonate disposal.
-- In the live migration esign_no_delete is a trigger name on versions/signers;
-- both triggers already call this shared function, so no rebinding is needed.
CREATE OR REPLACE FUNCTION public.esign_reject_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  disposal_owner name;
  retained_case uuid;
BEGIN
  -- UPDATE and statement-level TRUNCATE always fail. Tombstones are permanent.
  IF TG_OP = 'DELETE'
    AND TG_TABLE_SCHEMA = 'public'
    AND TG_TABLE_NAME IN (
      'esign_cases', 'esign_versions', 'esign_signers',
      'esign_signature_images', 'esign_audit_events',
      'esign_retention_extensions'
    )
    AND current_setting('esign.disposal', true) = 'on'
  THEN
    SELECT r.rolname INTO disposal_owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE p.oid =
      'public.esign_dispose_expired(boolean,integer)'::pg_catalog.regprocedure;

    IF current_user = disposal_owner THEN
      IF TG_TABLE_NAME = 'esign_cases' THEN
        retained_case := OLD.id;
      ELSIF TG_TABLE_NAME IN ('esign_signers', 'esign_signature_images') THEN
        SELECT v.case_id INTO retained_case
        FROM public.esign_versions v WHERE v.id = OLD.version_id;
      ELSE
        retained_case := OLD.case_id;
      END IF;

      IF public.esign_effective_retention(retained_case) < now() THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;

  RAISE EXCEPTION 'E-sign evidence is read-only' USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.esign_reject_change()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.esign_reject_change() TO service_role;

CREATE TRIGGER esign_extensions_readonly
  BEFORE UPDATE OR DELETE ON public.esign_retention_extensions
  FOR EACH ROW EXECUTE FUNCTION public.esign_reject_change();
CREATE TRIGGER esign_extensions_no_truncate
  BEFORE TRUNCATE ON public.esign_retention_extensions
  FOR EACH STATEMENT EXECUTE FUNCTION public.esign_reject_change();

CREATE TRIGGER esign_disposals_readonly
  BEFORE UPDATE OR DELETE ON public.esign_disposals
  FOR EACH ROW EXECUTE FUNCTION public.esign_reject_change();
CREATE TRIGGER esign_disposals_no_truncate
  BEFORE TRUNCATE ON public.esign_disposals
  FOR EACH STATEMENT EXECUTE FUNCTION public.esign_reject_change();

COMMIT;
