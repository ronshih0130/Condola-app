-- PROP-13 (BLK-MAC-04): trusted owner-contact login linking + API-role guard
-- on contacts.user_id. Build-only; new flag owner_contact_linking default OFF.

INSERT INTO public.platform_settings(key, value)
VALUES ('owner_contact_linking', '{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Eligibility helpers run as definer so RLS cannot hide memberships/contacts
-- of other organizations from the check (invoker visibility is not proof).
-- A binding is allowed only for a login created in THIS transaction (auth.users
-- created_at = now(), i.e. the onboarding/linking flow's own provisioning),
-- that is not the caller, has no org membership anywhere and no other contact.
CREATE FUNCTION app.prop13_fresh_login_ok(p_user uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT p_user IS NOT NULL AND p_user IS DISTINCT FROM auth.uid()
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user AND u.created_at = now())
     AND NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.user_id = p_user)
     AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.user_id = p_user AND c.id IS DISTINCT FROM p_contact)
$$;
REVOKE ALL ON FUNCTION app.prop13_fresh_login_ok(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.prop13_fresh_login_ok(uuid,uuid) TO authenticated;

-- Answers only for a member of p_org (no cross-org contact oracle); fails closed otherwise.
CREATE FUNCTION app.prop13_is_owner_contact(p_org uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT app.is_member(p_org) AND (p_contact IS NULL OR EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.id = p_contact AND c.org_id = p_org AND c.is_owner))
$$;
REVOKE ALL ON FUNCTION app.prop13_is_owner_contact(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.prop13_is_owner_contact(uuid,uuid) TO authenticated;

-- Guard: only the API role is restricted; trusted server paths (service_role,
-- SECURITY DEFINER functions, seeds/migrations) are unaffected.
CREATE FUNCTION app.prop13_contacts_link_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF current_user NOT IN ('authenticated','anon') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.user_id IS NOT NULL AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
    RAISE EXCEPTION 'Contact login binding is managed by a trusted flow' USING ERRCODE='42501';
  END IF;
  -- Owner contacts (incl. tenant+owner dual-role) are bound only by the trusted
  -- linking RPC: freshness alone never authorizes an owner identity.
  IF NEW.user_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.user_id IS NULL)
     AND (NEW.is_owner IS TRUE OR NOT app.prop13_fresh_login_ok(NEW.user_id, NEW.id)) THEN
    RAISE EXCEPTION 'Contact login binding is managed by a trusted flow' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND NEW.is_owner IS TRUE AND OLD.is_owner IS NOT TRUE AND NEW.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Contact login binding is managed by a trusted flow' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.prop13_contacts_link_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER prop13_contacts_link_guard BEFORE INSERT OR UPDATE OF user_id, is_owner, org_id ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION app.prop13_contacts_link_guard();

-- Owner identity references (owner portal access via app.is_property_owner /
-- app.is_my_contact) written by the API role must point at an owner contact,
-- so a tenant-bound contact cannot be made an owner by reference.
CREATE FUNCTION app.prop13_owner_ref_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF current_user NOT IN ('authenticated','anon') THEN RETURN NEW; END IF;
  IF (TG_OP='INSERT' OR NEW.owner_contact_id IS DISTINCT FROM OLD.owner_contact_id OR NEW.org_id IS DISTINCT FROM OLD.org_id)
     AND NOT app.prop13_is_owner_contact(NEW.org_id, NEW.owner_contact_id) THEN
    RAISE EXCEPTION 'Owner reference must be an owner contact' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.prop13_owner_ref_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER prop13_owner_ref_guard BEFORE INSERT OR UPDATE OF owner_contact_id, org_id ON public.property_owners
  FOR EACH ROW EXECUTE FUNCTION app.prop13_owner_ref_guard();
CREATE TRIGGER prop13_owner_ref_guard BEFORE INSERT OR UPDATE OF owner_contact_id, org_id ON public.owner_statements
  FOR EACH ROW EXECUTE FUNCTION app.prop13_owner_ref_guard();
CREATE TRIGGER prop13_owner_ref_guard BEFORE INSERT OR UPDATE OF owner_contact_id, org_id ON public.management_agreements
  FOR EACH ROW EXECUTE FUNCTION app.prop13_owner_ref_guard();
CREATE TRIGGER prop13_owner_ref_guard BEFORE INSERT OR UPDATE OF owner_contact_id, org_id ON public.bank_accounts
  FOR EACH ROW EXECUTE FUNCTION app.prop13_owner_ref_guard();

-- Trusted linking: admin provisions a NEW portal login for an unbound owner contact.
CREATE FUNCTION app.prop13_link_owner_contact(p_org uuid, p_contact uuid, p_email text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_enabled boolean; v_contact public.contacts%ROWTYPE; v_user uuid;
BEGIN
  IF auth.uid() IS NULL OR p_org IS NULL OR p_contact IS NULL THEN
    RAISE EXCEPTION 'Owner linking unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.platform_settings WHERE key='owner_contact_linking' FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  SELECT EXISTS (
    SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='owner_contact_linking'
     WHERE o.id=p_org AND (o.feature_flags->'owner_contact_linking')='true'::jsonb
       AND (f.value->'enabled')='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
       AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF v_enabled IS NOT TRUE THEN RAISE EXCEPTION 'Owner linking unavailable' USING ERRCODE='42501'; END IF;
  IF NOT app.has_role(p_org, '{admin}'::org_role[]) THEN
    RAISE EXCEPTION 'Owner linking unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_contact FROM public.contacts c
   WHERE c.id=p_contact AND c.org_id=p_org AND c.is_owner AND c.archived_at IS NULL AND c.user_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owner linking unavailable' USING ERRCODE='42501'; END IF;
  IF p_email IS NULL OR btrim(p_email)='' THEN RAISE EXCEPTION 'Owner linking email required' USING ERRCODE='22023'; END IF;
  v_user := app.provision_portal_user(p_email, v_contact.display_name, v_contact.phone_e164);
  UPDATE public.contacts SET user_id=v_user, updated_at=now() WHERE id=p_contact AND org_id=p_org AND user_id IS NULL;
  RETURN v_user;
END $$;
REVOKE ALL ON FUNCTION app.prop13_link_owner_contact(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.prop13_link_owner_contact(uuid,uuid,text) TO authenticated;
