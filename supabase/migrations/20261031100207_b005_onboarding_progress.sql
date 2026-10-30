BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key,value,description)
VALUES ('onboarding_progress','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'Formal live onboarding checklist rollout')
ON CONFLICT (key) DO NOTHING;

-- Only the server-owned path may change this subtree; ordinary settings edits
-- remain available to existing clients. The server writes an audit in the
-- same transaction and derives actor, time and organization from its session.
CREATE FUNCTION app.b005_protect_onboarding_progress() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_user IN ('anon','authenticated') THEN
    IF TG_OP = 'INSERT' AND NEW.settings ? 'onboarding_progress' THEN
      RAISE EXCEPTION 'Onboarding configuration is server managed' USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE' AND (NEW.settings->'onboarding_progress') IS DISTINCT FROM (OLD.settings->'onboarding_progress') THEN
      RAISE EXCEPTION 'Onboarding configuration is server managed' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b005_protect_onboarding_progress() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER b005_protect_onboarding_progress BEFORE INSERT OR UPDATE OF settings ON public.organizations
FOR EACH ROW EXECUTE FUNCTION app.b005_protect_onboarding_progress();
COMMIT;
