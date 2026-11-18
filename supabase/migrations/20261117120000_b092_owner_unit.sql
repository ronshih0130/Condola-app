-- B-092 RO-UNIT (OWN-33-AC2/AC4; frame 「總覽・我的物件・信義路 2 樓」; PR-023). One NEW service-only read gateway:
-- the owner's read-only panel for ONE authorised space (a whole unit, or a room of a by_room unit) exactly as
-- app.b092_owner_units lists it. Returns the current lease's tenant name (only when the company-wide MGT-138
-- name switch allows it), the tenant phone (only when the company phone switch is on AND the actor's current
-- property_owners row allows it: the legacy owner page rule), the lease term and rent, the last six months'
-- payment status on the property's own date (PLT-54) and up to five open repairs (also while vacant). A space the
-- owner is not authorised for is errors.forbidden (42501). No existing object, table grant, policy, flag or data change.
-- Admission is B-093's (PR-015): the selected env/live tuple, app.b013_actor, and the org-local current
-- property-owner predicate. Never an email. Migration-owned, fixed search_path.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- VOLATILE: b013_actor takes FOR SHARE; never call in READ ONLY.
CREATE FUNCTION app.b092_owner_unit(p_org uuid,p_live uuid,p_env text,p_session uuid,p_unit uuid,p_room uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record; s record; cl record; show_name boolean; show_phone boolean; tenant record;
 months jsonb; repairs jsonb;
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
 IF p_unit IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT o.settings->'show_tenant_name' IS DISTINCT FROM 'false'::jsonb,
  coalesce(o.settings->'show_tenant_phone' = 'true'::jsonb, false)
 INTO show_name, show_phone FROM public.organizations o WHERE o.id=p_org;
 -- The space, exactly as b092_owner_units defines the owner's authorised spaces: the actor's current,
 -- non-archived owner contact on the property (PR-015, on the organization's date); a whole unit with no room,
 -- or a non-archived room of a by_room unit. can_phone: any such current ownership row allows the phone.
 WITH org AS (
  SELECT (clock_timestamp() AT TIME ZONE o.timezone)::date org_today FROM public.organizations o WHERE o.id=p_org
 ), owned AS (
  SELECT pr.id property_id, pr.name property, (clock_timestamp() AT TIME ZONE pr.timezone)::date property_today,
   bool_or(po.can_view_tenant_phone) can_phone
  FROM public.properties pr
  JOIN public.property_owners po ON po.org_id=pr.org_id AND po.property_id=pr.id
  JOIN public.contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
  CROSS JOIN org
  WHERE pr.org_id=p_org AND pr.archived_at IS NULL
   AND c.user_id=a.actor AND c.is_owner AND c.archived_at IS NULL
   AND po.effective_from <= org.org_today AND (po.effective_to IS NULL OR po.effective_to > org.org_today)
  GROUP BY pr.id, pr.name, pr.timezone
 )
 SELECT o.property_id, o.property, o.property_today, o.can_phone, u.id unit_id, r.id room_id,
  CASE WHEN r.id IS NULL THEN u.label ELSE u.label || ' ' || r.label END space_label
 INTO s
 FROM owned o JOIN public.units u ON u.org_id=p_org AND u.property_id=o.property_id AND u.id=p_unit
 LEFT JOIN public.rooms r ON r.org_id=p_org AND r.unit_id=u.id AND r.id=p_room AND r.archived_at IS NULL
 WHERE u.archived_at IS NULL
  AND ((p_room IS NULL AND u.rental_mode='whole_unit') OR (p_room IS NOT NULL AND u.rental_mode='by_room' AND r.id IS NOT NULL));
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 -- Open repairs of this space, newest first, at most five, whether or not it is leased right now. A whole unit:
 -- unit_id = the unit (whole_unit spaces have no rooms); a room: room_id = the room. Only id, title, raw status.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'status',t.status::text)
   ORDER BY t.created_at DESC, t.id DESC),'[]'::jsonb)
 INTO repairs FROM (
  SELECT mt.id, mt.title, mt.status, mt.created_at FROM public.maintenance_tickets mt
  WHERE mt.org_id=p_org AND mt.property_id=s.property_id
   AND ((s.room_id IS NULL AND mt.unit_id=s.unit_id) OR (s.room_id IS NOT NULL AND mt.room_id=s.room_id))
   AND mt.status NOT IN ('resolved','closed','cancelled')
  ORDER BY mt.created_at DESC, mt.id DESC LIMIT 5
 ) t;
 -- The space's current lease (as the list): active (or awaiting signature) and already started on the property's date.
 SELECT l.id lease_id, l.rent_amount_minor rent, l.currency::text currency, l.start_date, l.end_date INTO cl
 FROM public.leases l
 WHERE l.org_id=p_org AND l.unit_id=s.unit_id
  AND ((s.room_id IS NULL AND l.target_room_id IS NULL) OR l.target_room_id=s.room_id)
  AND l.status IN ('active','pending_signature') AND l.start_date <= s.property_today
 ORDER BY l.start_date DESC, l.id LIMIT 1;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('property',s.property,'space',s.space_label,'vacant',true,'tenant',NULL,'phone',NULL,
   'startDate',NULL,'endDate',NULL,'rentMinor',NULL,'currency',NULL,'months','[]'::jsonb,'repairs',repairs);
 END IF;
 SELECT c.display_name name, c.phone_e164 phone INTO tenant FROM public.lease_parties lp
 JOIN public.contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
 WHERE lp.org_id=p_org AND lp.lease_id=cl.lease_id AND lp.role='primary' ORDER BY c.id LIMIT 1;
 -- The current month and the five before it on the property's date; current lease only; eligible invoices only.
 -- Per month, the list's logic: paid when confirmed covers the total; overdue on the earliest due date of an
 -- invoice that is not fully confirmed (as b3-money-month); partial (+ remaining) when something is confirmed.
 WITH inv AS (
  SELECT date_trunc('month', i.period_start)::date m, i.total_minor, i.due_date,
   coalesce((SELECT sum(pa.amount_minor) FROM public.payment_allocations pa
     JOIN public.payments p ON p.id=pa.payment_id AND p.org_id=p_org AND p.status='confirmed'
     WHERE pa.org_id=p_org AND pa.invoice_id=i.id),0) confirmed
  FROM public.invoices i
  WHERE i.org_id=p_org AND i.lease_id=cl.lease_id AND i.status NOT IN ('draft','void') AND i.total_minor > 0
   AND i.period_start IS NOT NULL
   AND date_trunc('month', i.period_start)::date BETWEEN (date_trunc('month', s.property_today) - interval '5 months')::date
    AND date_trunc('month', s.property_today)::date
 ), bill AS (
  SELECT m, sum(total_minor) total, sum(least(confirmed, total_minor)) confirmed,
   min(due_date) FILTER (WHERE confirmed < total_minor) open_due_date
  FROM inv GROUP BY m
 ), st AS (
  SELECT m, total - confirmed outstanding,
   CASE WHEN confirmed >= total THEN 'paid'
        WHEN open_due_date < s.property_today THEN 'overdue'
        WHEN confirmed > 0 THEN 'partial'
        ELSE 'none' END status
  FROM bill
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('month',to_char(m,'YYYY-MM'),'status',status,
   'remainingMinor',CASE WHEN status='partial' THEN outstanding::text END) ORDER BY m DESC),'[]'::jsonb)
 INTO months FROM st;
 RETURN jsonb_build_object('property',s.property,'space',s.space_label,'vacant',false,
  'tenant',CASE WHEN show_name THEN tenant.name END,
  'phone',CASE WHEN show_phone AND s.can_phone THEN tenant.phone END,
  'startDate',to_char(cl.start_date,'YYYY-MM-DD'),'endDate',to_char(cl.end_date,'YYYY-MM-DD'),
  'rentMinor',cl.rent::text,'currency',cl.currency,'months',months,'repairs',repairs);
END $$;
REVOKE ALL ON FUNCTION app.b092_owner_unit(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b092_owner_unit(uuid,uuid,text,uuid,uuid,uuid) TO service_role;
COMMIT;
