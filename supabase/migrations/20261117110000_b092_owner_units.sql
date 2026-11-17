-- B-092 OWN-UNITS (OWN-33-AC1/AC4, RO-UNITS; Ron's owner round 2026-11-15; PR-014 closed → this item; OQ-095).
-- One NEW service-only read gateway: the owner's own authorised spaces (whole units, and rooms of by_room units)
-- with the current tenant name (only when the company-wide MGT-138 name switch allows it), the lease rent, and
-- this month's status on the property's own date (PLT-54): paid / partial (+ remaining) / overdue, or vacant
-- with its day count. No existing object, table grant, policy, flag or data change.
-- Admission is B-093's (PR-015): the selected env/live tuple, app.b013_actor, and per property the org-local
-- current property-owner predicate (a former owner, another org's owner or a non-owner sees no row).
-- Never a tenant phone (RO-UNITS: the list never shows phones). Migration-owned, fixed search_path.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- VOLATILE: b013_actor takes FOR SHARE; never call in READ ONLY.
CREATE FUNCTION app.b092_owner_units(p_org uuid,p_live uuid,p_env text,p_session uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record; result jsonb;
BEGIN
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app.b013_actor(p_org,p_session);
 WITH org AS (
  SELECT o.id, (clock_timestamp() AT TIME ZONE o.timezone)::date org_today,
   o.settings->'show_tenant_name' IS DISTINCT FROM 'false'::jsonb show_name
  FROM public.organizations o WHERE o.id=p_org
 ), owned AS MATERIALIZED (
  -- PR-015: the actor's current, non-archived owner contact on the property, on the organization's date.
  SELECT DISTINCT pr.id property_id, pr.name property, pr.timezone,
   (clock_timestamp() AT TIME ZONE pr.timezone)::date property_today
  FROM public.properties pr
  JOIN public.property_owners po ON po.org_id=pr.org_id AND po.property_id=pr.id
  JOIN public.contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
  CROSS JOIN org
  WHERE pr.org_id=p_org AND pr.archived_at IS NULL
   AND c.user_id=a.actor AND c.is_owner AND c.archived_at IS NULL
   AND po.effective_from <= org.org_today AND (po.effective_to IS NULL OR po.effective_to > org.org_today)
 ), spaces AS MATERIALIZED (
  SELECT o.property_id, o.property, o.property_today, u.id unit_id, NULL::uuid room_id,
   u.label space_label, (u.created_at AT TIME ZONE o.timezone)::date created_on
  FROM owned o JOIN public.units u ON u.org_id=p_org AND u.property_id=o.property_id
  WHERE u.archived_at IS NULL AND u.rental_mode='whole_unit'
  UNION ALL
  SELECT o.property_id, o.property, o.property_today, u.id, r.id, u.label || ' ' || r.label,
   (r.created_at AT TIME ZONE o.timezone)::date
  FROM owned o JOIN public.units u ON u.org_id=p_org AND u.property_id=o.property_id
  JOIN public.rooms r ON r.org_id=p_org AND r.unit_id=u.id
  WHERE u.archived_at IS NULL AND u.rental_mode='by_room' AND r.archived_at IS NULL
 ), current_lease AS MATERIALIZED (
  -- The space's current lease: active (or awaiting signature) and already started on the property's date.
  SELECT DISTINCT ON (s.unit_id, s.room_id) s.unit_id, s.room_id, l.id lease_id, l.rent_amount_minor rent,
   l.currency::text currency
  FROM spaces s JOIN public.leases l ON l.org_id=p_org AND l.unit_id=s.unit_id
   AND ((s.room_id IS NULL AND l.target_room_id IS NULL) OR l.target_room_id=s.room_id)
  WHERE l.status IN ('active','pending_signature') AND l.start_date <= s.property_today
  ORDER BY s.unit_id, s.room_id, l.start_date DESC, l.id
 ), month_invoices AS (
  -- This month's bill on the property's date: eligible invoices only; confirmed allocations decide paid/partial.
  SELECT cl.lease_id, i.total_minor, i.due_date,
   coalesce((SELECT sum(pa.amount_minor) FROM public.payment_allocations pa
     JOIN public.payments p ON p.id=pa.payment_id AND p.org_id=p_org AND p.status='confirmed'
     WHERE pa.org_id=p_org AND pa.invoice_id=i.id),0) confirmed
  FROM current_lease cl JOIN spaces s ON s.unit_id=cl.unit_id AND s.room_id IS NOT DISTINCT FROM cl.room_id
  JOIN public.invoices i ON i.org_id=p_org AND i.lease_id=cl.lease_id
  WHERE i.status NOT IN ('draft','void') AND i.total_minor > 0
   AND i.period_start IS NOT NULL AND date_trunc('month', i.period_start)::date = date_trunc('month', s.property_today)::date
 ), month_bill AS (
  -- Overdue is judged on the earliest due date of an invoice that is not fully confirmed (as b3-money-month).
  SELECT lease_id, sum(total_minor) total, sum(least(confirmed, total_minor)) confirmed,
   min(due_date) FILTER (WHERE confirmed < total_minor) open_due_date
  FROM month_invoices GROUP BY lease_id
 ), last_end AS (
  SELECT s.unit_id, s.room_id, max(coalesce(l.end_date, s.created_on)) ended_on
  FROM spaces s JOIN public.leases l ON l.org_id=p_org AND l.unit_id=s.unit_id
   AND ((s.room_id IS NULL AND l.target_room_id IS NULL) OR l.target_room_id=s.room_id)
  WHERE l.status IN ('ended','terminated') AND coalesce(l.end_date, s.created_on) <= s.property_today
  GROUP BY s.unit_id, s.room_id
 ), states AS (
  SELECT s.property_id, s.property, s.unit_id, s.room_id, s.space_label,
   CASE WHEN cl.lease_id IS NULL THEN NULL WHEN org.show_name THEN tenant.name ELSE NULL END tenant_name,
   cl.rent, cl.currency,
   CASE WHEN cl.lease_id IS NULL THEN 'vacant'
        WHEN b.total IS NULL THEN 'none'
        WHEN b.confirmed >= b.total THEN 'paid'
        WHEN b.open_due_date < s.property_today THEN 'overdue'
        WHEN b.confirmed > 0 THEN 'partial'
        ELSE 'none' END status,
   b.total - b.confirmed outstanding,
   -- Vacant since the last lease of the space ended, else since the space was created (both on the property's date).
   CASE WHEN cl.lease_id IS NULL THEN greatest(s.property_today - coalesce(le.ended_on, s.created_on), 0) END vacant_days
  FROM spaces s CROSS JOIN org
  LEFT JOIN current_lease cl ON cl.unit_id=s.unit_id AND cl.room_id IS NOT DISTINCT FROM s.room_id
  LEFT JOIN month_bill b ON b.lease_id=cl.lease_id
  LEFT JOIN last_end le ON le.unit_id=s.unit_id AND le.room_id IS NOT DISTINCT FROM s.room_id
  LEFT JOIN LATERAL (
   SELECT c.display_name name FROM public.lease_parties lp
   JOIN public.contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
   WHERE lp.org_id=p_org AND lp.lease_id=cl.lease_id AND lp.role='primary' ORDER BY c.id LIMIT 1
  ) tenant ON true
 ), rows AS (
  -- The remaining amount belongs to 部分已繳・還差 only; an overdue or other row never carries one.
  SELECT st.*, CASE WHEN st.status='partial' THEN st.outstanding END remaining FROM states st
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'propertyId',r.property_id,'property',r.property,'unitId',r.unit_id,'roomId',r.room_id,'space',r.space_label,
   'tenant',r.tenant_name,'rentMinor',r.rent::text,'currency',r.currency,'status',r.status,
   'remainingMinor',r.remaining::text,'vacantDays',r.vacant_days)
   ORDER BY r.property, r.space_label, r.unit_id, r.room_id NULLS FIRST),'[]'::jsonb)
 INTO result FROM rows r;
 RETURN jsonb_build_object('rows',result);
END $$;
REVOKE ALL ON FUNCTION app.b092_owner_units(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b092_owner_units(uuid,uuid,text,uuid) TO service_role;
COMMIT;
