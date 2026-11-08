-- PROP-06 (L1-NOTI): notification + three-portal LINE entry foundation.
-- One trusted read that tells delivery code (B-028, B-037..B-039) which channels a recipient
-- contact can actually use and which portal entry belongs to them. Returns booleans and a
-- portal kind only — never e-mail addresses, phone numbers or LINE user ids. Staff of the
-- pinned organization only. No writes, no flag, no behaviour change (no callers yet).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION app.prop06_recipient_channels(p_org uuid, p_contact uuid, p_persona text)
RETURNS TABLE(portal text, email_available boolean, in_app_available boolean, line_bound boolean, line_friend boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_channel uuid;
BEGIN
  IF nullif(current_setting('app.active_org_id', true), '') IS DISTINCT FROM p_org::text
     OR nullif(current_setting('app.env', true), '') IS DISTINCT FROM (SELECT o.environment::text FROM public.organizations o WHERE o.id = p_org)
     OR NOT coalesce(app.is_member(p_org), false) THEN
    RAISE EXCEPTION 'Recipient channels unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_persona IS NULL OR p_persona NOT IN ('tenant', 'owner', 'vendor') THEN
    RAISE EXCEPTION 'Recipient persona required' USING ERRCODE = '22023';
  END IF;
  -- The OA this organization actually pushes through: its selected channel when active and in
  -- scope (its own org_owned OA or the platform default), else the active platform default.
  SELECT ch.id INTO v_channel FROM public.organizations o JOIN public.line_channels ch ON ch.id = o.line_channel_id
   WHERE o.id = p_org AND ch.is_active AND ((ch.mode = 'org_owned' AND ch.org_id = p_org) OR ch.mode = 'platform_default');
  IF v_channel IS NULL THEN
    SELECT ch.id INTO v_channel FROM public.line_channels ch WHERE ch.mode = 'platform_default' AND ch.is_active;
  END IF;
  RETURN QUERY
    SELECT CASE WHEN (p_persona = 'tenant' AND c.is_tenant) OR (p_persona = 'owner' AND c.is_owner) OR (p_persona = 'vendor' AND c.is_vendor)
                THEN p_persona ELSE NULL END,
           nullif(btrim(coalesce(c.email::text, '')), '') IS NOT NULL,
           c.user_id IS NOT NULL,
           v_channel IS NOT NULL AND EXISTS (SELECT 1 FROM public.line_account_links l
                    WHERE l.org_id = c.org_id AND l.contact_id = c.id AND l.line_channel_id = v_channel AND l.status = 'linked'
                      AND l.line_user_id IS NOT NULL AND l.unlinked_at IS NULL),
           v_channel IS NOT NULL AND EXISTS (SELECT 1 FROM public.line_account_links l
                    WHERE l.org_id = c.org_id AND l.contact_id = c.id AND l.line_channel_id = v_channel AND l.status = 'linked'
                      AND l.line_user_id IS NOT NULL AND l.unlinked_at IS NULL AND l.is_friend)
      FROM public.contacts c
     WHERE c.org_id = p_org AND c.id = p_contact AND c.archived_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION app.prop06_recipient_channels(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.prop06_recipient_channels(uuid, uuid, text) TO authenticated;
COMMIT;
