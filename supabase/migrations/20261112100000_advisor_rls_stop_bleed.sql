-- Version 20261112100000.
-- CEO stop-bleed for advisor findings (INC-RLS-1112).
-- llm-route confirmed (partners.ts, signup.ts, signup-mail.ts, funnel.ts) that
-- all app SQL to the seven tables uses query() or withClient() with no SET ROLE:
-- it runs as the table owner, which bypasses RLS unless RLS is FORCED.
-- previewPartnerCodeOn and redeemPartnerCode receive that same owner client from
-- signup.ts / requestUpgrade. recordFunnel's optional client is also that owner
-- client or query(). Therefore we ENABLE RLS with NO policies on the seven
-- tables, and we do NOT FORCE ROW LEVEL SECURITY (the app keeps working as owner).
-- Supabase grants anon and authenticated every new table, so we REVOKE ALL on
-- those tables from anon and authenticated. No policies are added on them.
-- Views stay security_invoker=true. owner_lease_tenants' body is moved behind a
-- SECURITY DEFINER function so an owner keeps read access without a direct SELECT
-- policy on lease_parties / contacts (which would widen access to email/phone).
-- Data fix: expire every unused signup verification token (UPDATE only, never
-- DELETE); token_hash was exposed to anon. One audit_log row, no PII.

SET LOCAL lock_timeout = '5s';

-- 1) Enable RLS (no policies, not forced) and drop anon/authenticated grants on
--    the seven owner-client tables.
ALTER TABLE public.partner_codes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_partner_prices    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_price_overrides   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_verifications   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_drafts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funnel_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upgrade_requests       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.partner_codes          FROM anon, authenticated;
REVOKE ALL ON TABLE public.firm_partner_prices    FROM anon, authenticated;
REVOKE ALL ON TABLE public.firm_price_overrides   FROM anon, authenticated;
REVOKE ALL ON TABLE public.signup_verifications   FROM anon, authenticated;
REVOKE ALL ON TABLE public.signup_drafts          FROM anon, authenticated;
REVOKE ALL ON TABLE public.funnel_events          FROM anon, authenticated;
REVOKE ALL ON TABLE public.upgrade_requests       FROM anon, authenticated;

-- 2) tenant_lease_picker: already SELECT * FROM app.my_tenant_leases()
--    (SECURITY DEFINER), authenticated already has EXECUTE. Flip invoker and
--    re-assert grants.
ALTER VIEW public.tenant_lease_picker SET (security_invoker = true);

REVOKE ALL ON TABLE public.tenant_lease_picker FROM anon;
GRANT SELECT ON TABLE public.tenant_lease_picker TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.tenant_lease_picker FROM authenticated;

-- 3) owner_lease_tenants: wrap the current view body in a SECURITY DEFINER
--    function so an owner keeps read access without a direct SELECT policy on
--    lease_parties / contacts (which would expose contact email/phone). Same
--    SELECT list, JOINs, WHERE and GROUP BY as the current view.
CREATE OR REPLACE FUNCTION app.owner_lease_tenants()
RETURNS TABLE (
  lease_id uuid,
  org_id uuid,
  property_id uuid,
  property_name text,
  unit_label text,
  room_label text,
  lease_status lease_status,
  start_date date,
  end_date date,
  currency char(3),
  rent_amount_minor bigint,
  deposit_amount_minor bigint,
  due_day smallint,
  tenant_contact_id uuid,
  tenant_name text,
  tenant_role lease_party_role,
  tenant_phone text,
  phone_visible boolean,
  open_balance_minor numeric,
  overdue_invoices bigint,
  latest_invoice_status invoice_status
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id               AS lease_id,
         l.org_id,
         l.property_id,
         pr.name            AS property_name,
         u.label            AS unit_label,
         r.label            AS room_label,
         l.status           AS lease_status,
         l.start_date, l.end_date, l.currency, l.rent_amount_minor, l.deposit_amount_minor, l.due_day,
         c.id               AS tenant_contact_id,
         c.display_name     AS tenant_name,
         lp.role            AS tenant_role,
         CASE WHEN bool_or(po.can_view_tenant_phone) OR app.is_member(l.org_id) THEN c.phone_e164 END AS tenant_phone,
         bool_or(po.can_view_tenant_phone) OR app.is_member(l.org_id)                                  AS phone_visible,
         (SELECT coalesce(sum(i.balance_minor), 0) FROM invoices i
           WHERE i.lease_id = l.id AND i.status IN ('open','partially_paid'))                         AS open_balance_minor,
         (SELECT count(*) FROM invoices i
           WHERE i.lease_id = l.id AND i.status IN ('open','partially_paid') AND i.due_date < current_date) AS overdue_invoices,
         (SELECT i.status FROM invoices i WHERE i.lease_id = l.id AND i.status <> 'draft'
           ORDER BY i.due_date DESC LIMIT 1)                                                           AS latest_invoice_status
  FROM leases l
  JOIN properties pr      ON pr.id = l.property_id
  JOIN units u            ON u.id = l.unit_id
  LEFT JOIN rooms r       ON r.id = l.target_room_id
  JOIN lease_parties lp   ON lp.lease_id = l.id
  JOIN contacts c         ON c.id = lp.contact_id
  JOIN property_owners po ON po.property_id = l.property_id
                         AND (po.effective_to IS NULL OR po.effective_to > current_date)
  JOIN contacts oc        ON oc.id = po.owner_contact_id
  WHERE l.status <> 'draft'
    AND (oc.user_id = auth.uid() OR app.is_member(l.org_id))
  GROUP BY l.id, pr.name, u.label, r.label, c.id, lp.role;
$$;

REVOKE ALL ON FUNCTION app.owner_lease_tenants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.owner_lease_tenants() TO authenticated, service_role;

CREATE OR REPLACE VIEW public.owner_lease_tenants
  WITH (security_invoker = true, security_barrier = true) AS
  SELECT * FROM app.owner_lease_tenants();

REVOKE ALL ON TABLE public.owner_lease_tenants FROM anon;
GRANT SELECT ON TABLE public.owner_lease_tenants TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.owner_lease_tenants FROM authenticated;

-- 4) Data fix: expire every unused, not-yet-expired signup verification token.
--    token_hash was readable by anon, so all live tokens must be burned.
--    UPDATE only (never DELETE), no mail/SMS, no NOTIFY, used rows untouched.
--    One audit_log row carrying only the affected count (no PII).
WITH expired AS (
  UPDATE public.signup_verifications
     SET expires_at = now()
   WHERE used_at IS NULL
     AND (expires_at IS NULL OR expires_at > now())
  RETURNING 1
)
INSERT INTO public.audit_log
  (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row, reason)
SELECT
  NULL,
  NULL,
  'migration',
  'signup_verifications',
  'INC-RLS-1112',
  'update',
  'inc_rls_1112_expire_unused',
  jsonb_build_object('unused_expired', (SELECT count(*) FROM expired)),
  'INC-RLS-1112 token_hash exposed to anon';
