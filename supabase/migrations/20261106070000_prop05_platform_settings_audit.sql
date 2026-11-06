-- PROP-05 (L1-FLAG): override audit. organizations.feature_flags changes are already
-- captured by the generic fn_audit trigger on organizations; platform_settings (global
-- kill switches and allowlists) had no audit. fn_audit cannot be reused because the
-- table key is `key`, not `id`. Append-only rows go to public.audit_log.
-- No value or behaviour change; no grants.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION app.prop05_audit_platform_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN jsonb_build_object('key', OLD.key, 'value', OLD.value, 'description', OLD.description) END;
  n jsonb := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN jsonb_build_object('key', NEW.key, 'value', NEW.value, 'description', NEW.description) END;
  cols text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO cols FROM jsonb_each(n) e(k, v) WHERE o -> k IS DISTINCT FROM v;
    IF cols IS NULL THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO public.audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, old_row, new_row, changed_cols, reason, request_id)
  -- current_user is the definer here; the `role` setting still reflects the caller's SET ROLE.
  VALUES (NULL, auth.uid(), coalesce(nullif(current_setting('role', true), 'none'), session_user::text), 'platform_settings', coalesce(NEW.key, OLD.key), lower(TG_OP)::audit_action, o, n, cols,
          nullif(current_setting('app.change_reason', true), ''), nullif(current_setting('app.request_id', true), ''));
  RETURN coalesce(NEW, OLD);
END $$;
REVOKE ALL ON FUNCTION app.prop05_audit_platform_settings() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS prop05_platform_settings_audit ON public.platform_settings;
CREATE TRIGGER prop05_platform_settings_audit AFTER INSERT OR UPDATE OR DELETE ON public.platform_settings
FOR EACH ROW EXECUTE FUNCTION app.prop05_audit_platform_settings();
COMMIT;
