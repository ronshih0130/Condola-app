-- BLK-MAC-15 follow-up (B-025 slice 2 compatibility, build-only, flags unchanged).
-- Profiles written before slice 2 have no vendor_profile_versions rows. Their
-- object-backed seal is read from the live profile, but only when the profile
-- has NO version history at all; a versioned profile keeps reading the seal
-- reference from the selected immutable version (unchanged). Admission
-- (org, grant capability, flags) is the same app.b025_seal_scope check.
CREATE OR REPLACE FUNCTION app.b025_legacy_seal_path(p_org uuid,p_grant uuid,p_profile uuid,p_version integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE path text;
BEGIN
  PERFORM app.b025_seal_scope(p_org,p_grant,p_profile);
  SELECT f.storage_path INTO path FROM public.vendor_profile_versions v
    JOIN public.files f ON f.id=v.seal_file_id AND f.org_id=v.org_id
    WHERE v.org_id=p_org AND v.vendor_profile_id=p_profile AND v.version=p_version
      AND v.kind='business' AND NOT (v.snapshot ? 'seal')
      AND f.storage_bucket='ticket-photos-private' AND f.size_bytes BETWEEN 1 AND 5242880
    FOR SHARE OF f;
  IF NOT FOUND THEN
    -- Zero-history legacy profile: the live profile is the only issuer record.
    SELECT f.storage_path INTO path FROM public.vendor_profiles p
      JOIN public.files f ON f.id=p.seal_file_id AND f.org_id=p.org_id
      WHERE p.org_id=p_org AND p.id=p_profile AND p.kind='business'
        AND NOT EXISTS (SELECT 1 FROM public.vendor_profile_versions v
                         WHERE v.org_id=p.org_id AND v.vendor_profile_id=p.id)
        AND f.storage_bucket='ticket-photos-private' AND f.size_bytes BETWEEN 1 AND 5242880
      FOR SHARE OF p, f;
    IF NOT FOUND THEN RAISE EXCEPTION 'document unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN path;
END $$;
REVOKE ALL ON FUNCTION app.b025_legacy_seal_path(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b025_legacy_seal_path(uuid,uuid,uuid,integer) TO service_role;
