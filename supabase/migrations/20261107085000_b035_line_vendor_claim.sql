-- B-035: private job scope on the existing B-033 flow. No account provisioning.
BEGIN;
CREATE TABLE app.b035_vendor_flows (
 flow_id uuid PRIMARY KEY REFERENCES app.b033_line_flows(id) ON DELETE CASCADE,
 job_id uuid NOT NULL REFERENCES public.repair_vendor_jobs(id),
 token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 claim_hash text UNIQUE CHECK(claim_hash ~ '^[0-9a-f]{64}$'),
 claim_expires_at timestamptz,
 identity_id uuid REFERENCES app.b033_line_identities(id),
 link_id uuid REFERENCES public.line_account_links(id),
 CHECK ((claim_hash IS NULL) = (claim_expires_at IS NULL)),
 CHECK ((identity_id IS NULL) = (link_id IS NULL))
);
ALTER TABLE app.b035_vendor_flows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b035_vendor_flows FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON app.b035_vendor_flows TO service_role;
-- The flow remains a vendor login, and its scope cannot be retargeted on claim.
CREATE FUNCTION app.b035_vendor_flow_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.flow_id,NEW.job_id,NEW.token_hash) IS DISTINCT FROM ROW(OLD.flow_id,OLD.job_id,OLD.token_hash)
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.b033_line_flows f JOIN public.repair_vendor_jobs j ON j.id=NEW.job_id
  WHERE f.id=NEW.flow_id AND f.persona='vendor' AND f.kind='login' AND f.org_id=j.org_id
   AND f.user_id IS NULL AND f.contact_id IS NULL AND f.invitation_id IS NULL AND j.token_hash=NEW.token_hash)
 THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b035_vendor_flow_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b035_vendor_flow_guard() TO service_role;
CREATE TRIGGER b035_vendor_flow_guard BEFORE INSERT OR UPDATE ON app.b035_vendor_flows
 FOR EACH ROW EXECUTE FUNCTION app.b035_vendor_flow_guard();
COMMIT;
