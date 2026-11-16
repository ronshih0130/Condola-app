-- MF-3 / MGT-151-AC1…AC5 (MO-TOPUP, 租約 › {租客} › 退租結算): the tenant's top-up record after a sent
-- settlement whose deductions exceed the deposit (應補 > 0). Additive, forward-only.
-- One NEW table (RLS on, no application grants) and two NEW migration-owned VOLATILE service-only
-- SECURITY DEFINER gateways with a pinned search_path. No existing object, grant, policy, flag or data
-- changes; no new flag (the existing `deposit_settlement` flag gates both gateways, as in B-011).
-- Admission copies B-011's: the selected env/live tuple (org scope), a live auth session, the role
-- (pay.record: admin, manager, accountant) and the `deposit_settlement` org + platform flag predicate of
-- isDepositSettlementEnabled. Tenants and owners read the same version; nobody stores a payment method;
-- nothing is sent outside the app. Money is integer minor units with currency and minor unit.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE app.deposit_settlement_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
  currency char(3) NOT NULL REFERENCES public.currencies(code),
  minor_unit smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4),
  received_on date NOT NULL CHECK (received_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  request_id uuid NOT NULL,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, id),
  UNIQUE (org_id, request_id),
  FOREIGN KEY (org_id, lease_id, settlement_id)
    REFERENCES app.deposit_settlement_records (org_id, lease_id, id)
);
CREATE INDEX deposit_settlement_topups_settlement_idx
  ON app.deposit_settlement_topups (org_id, lease_id, settlement_id, received_on);

ALTER TABLE app.deposit_settlement_topups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.deposit_settlement_topups FROM PUBLIC, anon, authenticated, service_role;

-- MGT-151-AC1/AC3/AC4 writer. Over the amount owed is saved (the form warns first); the result says by how much.
-- Statuses: recorded | disabled | invalid | unavailable | conflict. Denials raise 42501.
CREATE FUNCTION app.mf3_topup_record(p_org uuid,p_live uuid,p_env text,p_session uuid,p_request uuid,
 p_lease uuid,p_settlement uuid,p_amount_minor bigint,p_received_on date,p_note text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; s record; prior record; unit smallint; note text;
 owed bigint; paid bigint; topup_id uuid; replayed boolean:=false; result jsonb;
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
 SELECT x.user_id INTO actor FROM public.auth_sessions x
 WHERE x.id=p_session AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o
  WHERE o.id=p_org AND o.environment::text=p_env AND coalesce(o.live_org_id,o.id)=p_live
   AND o.feature_flags->'deposit_settlement'='true'::jsonb
   AND EXISTS (SELECT 1 FROM public.platform_settings p
    WHERE p.key='deposit_settlement' AND p.value->'enabled'='true'::jsonb
     AND jsonb_typeof(p.value->'allowed_org_ids')='array'
     AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text))) THEN
  RETURN jsonb_build_object('status','disabled');
 END IF;
 SELECT m.role::text INTO member_role FROM public.org_members m
 WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active' FOR SHARE;
 IF member_role IS NULL OR member_role NOT IN ('admin','manager','accountant') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 note:=nullif(btrim(p_note),'');
 IF p_request IS NULL OR p_lease IS NULL OR p_settlement IS NULL OR p_amount_minor IS NULL
   OR p_amount_minor<=0 OR p_amount_minor>1000000000000000 OR p_received_on IS NULL
   OR p_received_on NOT BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'
   OR char_length(coalesce(note,''))>500 THEN
  RETURN jsonb_build_object('status','invalid');
 END IF;
 -- Idempotency: one key per org. A retry with the same payload replays; a different payload conflicts.
 PERFORM pg_advisory_xact_lock(hashtextextended('mf3/topup/request/'||p_org::text||'/'||p_request::text,0));
 SELECT * INTO prior FROM app.deposit_settlement_topups t WHERE t.org_id=p_org AND t.request_id=p_request;
 IF FOUND THEN
  IF prior.lease_id IS DISTINCT FROM p_lease OR prior.settlement_id IS DISTINCT FROM p_settlement
    OR prior.amount_minor IS DISTINCT FROM p_amount_minor OR prior.received_on IS DISTINCT FROM p_received_on
    OR prior.note IS DISTINCT FROM note OR prior.recorded_by IS DISTINCT FROM actor THEN
   RETURN jsonb_build_object('status','conflict');
  END IF;
  topup_id:=prior.id; replayed:=true;
 END IF;
 SELECT r.id,r.currency,r.deposit_held_minor,r.confirmed_total_deduction_minor INTO s
 FROM app.deposit_settlement_records r
 WHERE r.org_id=p_org AND r.lease_id=p_lease AND r.id=p_settlement AND r.basis='move_out' AND r.status='confirmed'
 FOR UPDATE;
 IF NOT FOUND OR s.confirmed_total_deduction_minor IS NULL
   OR s.confirmed_total_deduction_minor<=s.deposit_held_minor THEN
  RETURN jsonb_build_object('status','unavailable');
 END IF;
 SELECT c.minor_unit INTO unit FROM public.currencies c WHERE c.code=btrim(s.currency);
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
 owed:=s.confirmed_total_deduction_minor-s.deposit_held_minor;
 IF topup_id IS NULL THEN
  INSERT INTO app.deposit_settlement_topups(org_id,lease_id,settlement_id,amount_minor,currency,minor_unit,
   received_on,note,request_id,recorded_by)
  VALUES (p_org,p_lease,p_settlement,p_amount_minor,btrim(s.currency),unit,p_received_on,note,p_request,actor)
  RETURNING id INTO topup_id;
  INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,new_row,reason,request_id,occurred_at)
  VALUES (p_org,actor,member_role,'deposit_settlement_topups',topup_id::text,'insert',
   jsonb_build_object('lease_id',p_lease,'settlement_id',p_settlement,'amount_minor',p_amount_minor::text,
    'currency',btrim(s.currency),'minor_unit',unit,'received_on',p_received_on::text,'note',note),
   'deposit_topup_recorded',p_request::text,clock_timestamp());
 END IF;
 SELECT coalesce(sum(t.amount_minor),0) INTO paid FROM app.deposit_settlement_topups t
 WHERE t.org_id=p_org AND t.lease_id=p_lease AND t.settlement_id=p_settlement;
 result:=jsonb_build_object('status','recorded','topupId',topup_id,'replayed',replayed,
  'currency',btrim(s.currency),'minorUnit',unit,'owedMinor',owed::text,'paidMinor',paid::text,
  'overMinor',greatest(paid-owed,0)::text);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.mf3_topup_record(uuid,uuid,text,uuid,uuid,uuid,uuid,bigint,date,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.mf3_topup_record(uuid,uuid,text,uuid,uuid,uuid,uuid,bigint,date,text) TO service_role;

-- MGT-151-AC1/AC2 reader: ONE version for staff, the tenant and the owner (p_kind is the app the session is in).
-- NULL when the flag is off or no sent settlement owes a top-up. Not admitted to this lease: 42501.
-- Entries carry date and amount only; the note stays in the audit log (看紀錄), never in this view.
CREATE FUNCTION app.mf3_topup_view(p_org uuid,p_live uuid,p_env text,p_session uuid,p_kind text,p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; member_role text; s record; unit smallint; owed bigint; paid bigint; entries jsonb; tenant text;
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
 SELECT x.user_id INTO actor FROM public.auth_sessions x
 WHERE x.id=p_session AND x.revoked_at IS NULL AND x.expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('staff','tenant','owner') OR p_lease IS NULL THEN
  RAISE EXCEPTION 'Invalid top-up view' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organizations o
  WHERE o.id=p_org AND o.environment::text=p_env AND coalesce(o.live_org_id,o.id)=p_live
   AND o.feature_flags->'deposit_settlement'='true'::jsonb
   AND EXISTS (SELECT 1 FROM public.platform_settings p
    WHERE p.key='deposit_settlement' AND p.value->'enabled'='true'::jsonb
     AND jsonb_typeof(p.value->'allowed_org_ids')='array'
     AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text))) THEN
  RETURN NULL;
 END IF;
 IF p_kind='staff' THEN
  SELECT m.role::text INTO member_role FROM public.org_members m
  WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text='active' FOR SHARE;
  IF member_role IS NULL OR member_role NOT IN ('admin','manager','accountant') THEN
   RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 ELSIF p_kind='tenant' THEN
  IF NOT EXISTS (SELECT 1 FROM public.lease_parties lp
   JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
   JOIN public.leases l ON l.org_id=lp.org_id AND l.id=lp.lease_id
   WHERE lp.org_id=p_org AND lp.lease_id=p_lease AND c.user_id=actor AND c.archived_at IS NULL
    AND l.status::text<>'draft') THEN
   RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 ELSE
  IF NOT EXISTS (SELECT 1 FROM public.leases l
   JOIN public.property_owners po ON po.org_id=l.org_id AND po.property_id=l.property_id
   JOIN public.contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
   JOIN public.organizations o ON o.id=po.org_id
   WHERE l.org_id=p_org AND l.id=p_lease
    AND c.user_id=actor AND c.is_owner AND c.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)) THEN
   RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 SELECT r.id,r.currency,r.deposit_held_minor,r.confirmed_total_deduction_minor INTO s
 FROM app.deposit_settlement_records r
 WHERE r.org_id=p_org AND r.lease_id=p_lease AND r.basis='move_out' AND r.status='confirmed';
 IF NOT FOUND OR s.confirmed_total_deduction_minor IS NULL
   OR s.confirmed_total_deduction_minor<=s.deposit_held_minor THEN RETURN NULL; END IF;
 SELECT c.minor_unit INTO unit FROM public.currencies c WHERE c.code=btrim(s.currency);
 IF NOT FOUND THEN RETURN NULL; END IF;
 owed:=s.confirmed_total_deduction_minor-s.deposit_held_minor;
 SELECT coalesce(sum(t.amount_minor),0),
  coalesce(jsonb_agg(jsonb_build_object('id',t.id,'amountMinor',t.amount_minor::text,'receivedOn',t.received_on::text)
   ORDER BY t.received_on,t.created_at,t.id),'[]'::jsonb)
 INTO paid,entries FROM app.deposit_settlement_topups t
 WHERE t.org_id=p_org AND t.lease_id=p_lease AND t.settlement_id=s.id;
 IF p_kind='staff' THEN
  SELECT c.display_name INTO tenant FROM public.lease_parties lp
  JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
  WHERE lp.org_id=p_org AND lp.lease_id=p_lease
  ORDER BY (lp.role::text='primary') DESC,lp.created_at,lp.id LIMIT 1;
 END IF;
 RETURN jsonb_build_object('settlementId',s.id,'leaseId',p_lease,'tenant',tenant,
  'currency',btrim(s.currency),'minorUnit',unit,'depositMinor',s.deposit_held_minor::text,
  'deductionMinor',s.confirmed_total_deduction_minor::text,'owedMinor',owed::text,'paidMinor',paid::text,
  'entries',entries,'canRecord',p_kind='staff');
END $$;
REVOKE ALL ON FUNCTION app.mf3_topup_view(uuid,uuid,text,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.mf3_topup_view(uuid,uuid,text,uuid,text,uuid) TO service_role;
COMMIT;
