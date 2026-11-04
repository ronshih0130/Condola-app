BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_audit_invitations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  cols text[];
  j jsonb;
  email text;
  domain text;
  phone text;
  at_position integer;
  row_index integer;
BEGIN
  -- Compare the original rows so secret-only changes are still audited.
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k) INTO cols
    FROM jsonb_each(n) e(k, v)
    WHERE o -> k IS DISTINCT FROM v AND k <> 'updated_at';
    IF cols IS NULL THEN RETURN NEW; END IF;
  END IF;

  BEGIN
  -- Portal tokens live in portal_invite_secrets, not invitations.
  -- Also exclude token fields if present in an invitation row.
  FOR row_index IN 1..2 LOOP
    j := CASE WHEN row_index = 1 THEN o ELSE n END;
    IF j IS NOT NULL THEN
      j := j - ARRAY['code_hash', 'token', 'token_hash', 'invite_token',
                     'invite_token_hash', 'portal_token', 'portal_token_hash'];

      IF jsonb_typeof(j -> 'email') = 'string' THEN
        email := j ->> 'email';
        IF email !~ '^[^@]?\*{3}(@.*)?$' THEN
          at_position := strpos(email, '@');
          domain := CASE
            WHEN at_position > 0 THEN substr(email, at_position + 1)
            ELSE ''
          END;
          j := jsonb_set(
            j,
            '{email}',
            to_jsonb(
              CASE WHEN at_position > 0
                THEN left(email, 1) || '***@' || domain
                ELSE left(email, 1) || '***'
              END
            ),
            false
          );
        END IF;
      END IF;

      -- Preserve existing masks and safely redact any non-empty phone.
      IF jsonb_typeof(j -> 'phone_e164') = 'string' THEN
        phone := j ->> 'phone_e164';
        IF phone <> '' AND strpos(phone, '*') = 0 THEN
          j := jsonb_set(
            j,
            '{phone_e164}',
            to_jsonb(
              CASE WHEN phone ~ '^\+886[0-9]+$' THEN
                '+886'
                || repeat('*', greatest(length(phone) - 6, 0))
                || right(phone, 2)
              ELSE
                left(phone, 1)
                || repeat('*', greatest(length(phone) - 3, 0))
                || right(phone, 2)
              END
            ),
            false
          );
        END IF;
      END IF;
    END IF;

    IF row_index = 1 THEN
      o := j;
    ELSE
      n := j;
    END IF;
  END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_audit_invitations masking fallback: %', SQLSTATE;

    FOR row_index IN 1..2 LOOP
      j := CASE WHEN row_index = 1 THEN o ELSE n END;
      IF j IS NOT NULL THEN
        j := j - ARRAY['code_hash', 'token', 'token_hash', 'invite_token',
                       'invite_token_hash', 'portal_token', 'portal_token_hash'];
        IF j ? 'email' THEN
          j := jsonb_set(j, '{email}', to_jsonb('[redacted]'::text), false);
        END IF;
        IF j ? 'phone_e164' THEN
          j := jsonb_set(j, '{phone_e164}', to_jsonb('[redacted]'::text), false);
        END IF;
      END IF;

      IF row_index = 1 THEN
        o := j;
      ELSE
        n := j;
      END IF;
    END LOOP;
  END;

  INSERT INTO audit_log (
    org_id, actor_user_id, actor_role, table_name, row_id, action,
    old_row, new_row, changed_cols, reason, request_id
  )
  VALUES (
    coalesce((n->>'org_id')::uuid, (o->>'org_id')::uuid),
    auth.uid(), current_user, TG_TABLE_NAME,
    coalesce(n->>'id', o->>'id'), lower(TG_OP)::audit_action,
    o, n, cols,
    nullif(current_setting('app.change_reason', true), ''),
    nullif(current_setting('app.request_id', true), '')
  );
  RETURN coalesce(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_audit_invitations() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_invitations_audit ON public.invitations;
CREATE TRIGGER trg_invitations_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_invitations();

COMMIT;
