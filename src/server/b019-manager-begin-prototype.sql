-- Disposable local prototype only. No production grants or application wiring.
BEGIN;
CREATE TABLE app.b019_begin_probe_ops (
 tx_id xid8 PRIMARY KEY DEFAULT pg_current_xact_id(),org_id uuid NOT NULL,live_org_id uuid NOT NULL,environment text NOT NULL,
 lease_id uuid NOT NULL,actor_id uuid NOT NULL,session_id uuid NOT NULL,role text NOT NULL,
 request_id uuid NOT NULL,payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),payment_id uuid NOT NULL,
 payer_contact_id uuid NOT NULL,invoice_ids uuid[] NOT NULL,prestate_digest text NOT NULL CHECK(prestate_digest ~ '^[0-9a-f]{64}$')
);
REVOKE ALL ON app.b019_begin_probe_ops FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_begin_probe_never_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'prototype operation incomplete' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION app.b019_begin_probe_never_commit() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b019_begin_probe_never_commit AFTER INSERT ON app.b019_begin_probe_ops DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b019_begin_probe_never_commit();
CREATE FUNCTION app.b019_begin_probe(p_org uuid,p_live uuid,p_env text,p_session uuid,p_lease_input text,p_role text,p_request uuid,p_amount bigint,p_paid_on text,p_last5 text,p_reference text)
RETURNS TABLE(disposition text,payment_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE actor uuid:=auth.uid();lease uuid;v_email boolean;v_center boolean;v_digest text;v_existing uuid;v_lease uuid;v_status text;v_fresh uuid;v_key_result text;v_aliases integer;v_primary integer;v_payer uuid;v_user uuid;v_invoice_ids uuid[];v_payment_ids uuid[];v_locked uuid[];v_lines integer;v_related integer;v_prestate text;
BEGIN
 IF actor IS NULL OR p_request IS NULL OR p_lease_input IS NULL OR p_amount IS NULL OR p_amount<=0 OR p_amount>9007199254740991 OR p_paid_on IS NULL OR p_paid_on !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR p_last5 IS NULL OR p_reference IS NULL THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 BEGIN lease:=p_lease_input::uuid; PERFORM p_paid_on::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END;
 IF NOT EXISTS(SELECT 1 FROM public.organizations o JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  JOIN public.org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=actor
  WHERE o.id=p_org AND o.environment::text=p_env AND ((o.environment='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live))
   AND m.user_id=actor AND m.status='active' AND m.role::text=p_role AND m.role IN ('admin','manager','accountant') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations WHERE id IN (p_org,p_live) ORDER BY id FOR SHARE NOWAIT;
 -- Relation admission before any context/operation/resolution insert. These
 -- names exist in the owned 19+17 clone; not a complete production inventory.
 LOCK TABLE app.b010_source_events IN ACCESS SHARE MODE NOWAIT;
 LOCK TABLE app.b010_payment_commands,app.b017_center_resolutions,app.b017_occurrences,app.b017_old_source_transactions,app.b019_begin_probe_ops,app.b019_channel_outcomes,app.b019_payment_contexts,app.b019_payment_preparations,app.b019_payment_requirements,app.b028_center_events,app.b028_center_recipients,public.audit_log IN ROW EXCLUSIVE MODE NOWAIT;
 SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(p_org,p_live,p_env,p_session,lease,p_role) a;
 v_digest:=encode(public.digest(convert_to('{"amount":'||p_amount::text||',"last5":'||to_json(p_last5)::text||',"leaseId":'||to_json(p_lease_input)::text||',"paidOn":'||to_json(p_paid_on)::text||',"reference":'||to_json(p_reference)::text||'}','UTF8'),'sha256'),'hex');
 IF NOT pg_try_advisory_xact_lock(hashtextextended('b010:payment:'||p_org::text||':'||actor::text||':'||p_request::text,0)) THEN RAISE EXCEPTION 'prototype busy' USING ERRCODE='55P03'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT c.payment_id,p.lease_id,p.status::text INTO v_existing,v_lease,v_status FROM app.b010_payment_commands c JOIN public.payments p ON p.org_id=c.org_id AND p.id=c.payment_id
  WHERE c.org_id=p_org AND c.actor_id=actor AND c.request_id=p_request AND c.payload_digest=v_digest FOR SHARE OF p NOWAIT;
 IF v_existing IS NOT NULL THEN
  IF v_lease IS DISTINCT FROM lease OR v_status NOT IN ('confirmed','reversed') OR NOT (
    EXISTS(SELECT 1 FROM app.b010_source_events e WHERE e.org_id=p_org AND e.lease_id=lease AND e.payment_id=v_existing AND e.kind='payment_confirmed' AND e.actor_id=actor)
    OR EXISTS(SELECT 1 FROM app.b017_occurrences n WHERE n.org_id=p_org AND n.lease_id=lease AND n.payment_id=v_existing AND n.kind='payment_confirmed' AND n.actor_id=actor)
   ) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO v_aliases FROM (SELECT 1 FROM app.b010_payment_commands c WHERE c.org_id=p_org AND c.payment_id=v_existing LIMIT 2) q;
  IF v_aliases<>1 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.b019_payment_admit(p_org,p_live,p_env,p_session,lease,p_role);
  IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT 'recorded'::text,v_existing;RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM app.b010_payment_commands c WHERE c.org_id=p_org AND c.actor_id=actor AND c.request_id=p_request) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF NOT v_center AND NOT v_email THEN PERFORM 1 FROM app.b019_payment_admit(p_org,p_live,p_env,p_session,lease,p_role);IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;RETURN QUERY SELECT 'unknown'::text,NULL::uuid;RETURN; END IF;
 IF NOT v_center OR v_email THEN RAISE EXCEPTION 'prototype channel unsupported' USING ERRCODE='42501'; END IF;
 LOCK TABLE public.invoice_lines,public.invoices,public.lease_parties,public.ledger_entries,public.ledger_transactions,public.payment_allocations,public.payments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT count(*) INTO v_primary FROM (SELECT 1 FROM public.lease_parties lp WHERE lp.org_id=p_org AND lp.lease_id=lease AND lp.role='primary' LIMIT 2) q;
 IF v_primary<>1 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT c.id,c.user_id INTO v_payer,v_user FROM public.lease_parties lp JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id WHERE lp.org_id=p_org AND lp.lease_id=lease AND lp.role='primary' AND c.is_tenant AND c.archived_at IS NULL FOR SHARE OF lp,c NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF v_user IS NOT NULL THEN PERFORM 1 FROM auth.users u WHERE u.id=v_user FOR KEY SHARE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF; END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_invoice_ids FROM (SELECT i.id FROM public.invoices i WHERE i.org_id=p_org AND i.lease_id=lease AND i.status IN ('open','partially_paid') ORDER BY i.id LIMIT 1025) q;
 IF cardinality(v_invoice_ids)=0 OR cardinality(v_invoice_ids)>1024 THEN RAISE EXCEPTION 'prototype cohort unavailable' USING ERRCODE='54000'; END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_payment_ids FROM (SELECT p.id FROM public.payments p WHERE p.org_id=p_org AND EXISTS(SELECT 1 FROM public.payment_allocations a WHERE a.org_id=p_org AND a.payment_id=p.id AND a.invoice_id=ANY(v_invoice_ids)) ORDER BY p.id LIMIT 8193 FOR UPDATE NOWAIT) q;
 IF cardinality(v_payment_ids)>8192 THEN RAISE EXCEPTION 'prototype cohort unavailable' USING ERRCODE='54000'; END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_locked FROM (SELECT i.id FROM public.invoices i WHERE i.org_id=p_org AND i.lease_id=lease AND i.id=ANY(v_invoice_ids) AND i.status IN ('open','partially_paid') ORDER BY i.id LIMIT 1025 FOR UPDATE NOWAIT) q;
 IF v_locked IS DISTINCT FROM v_invoice_ids THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.invoices i JOIN public.leases l ON l.org_id=i.org_id AND l.id=i.lease_id WHERE i.org_id=p_org AND i.id=ANY(v_invoice_ids) AND (i.property_id IS DISTINCT FROM l.property_id OR i.currency IS DISTINCT FROM l.currency)) THEN RAISE EXCEPTION 'prototype invoice scope unavailable' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO v_lines FROM (SELECT 1 FROM public.invoice_lines WHERE org_id=p_org AND invoice_id=ANY(v_invoice_ids) LIMIT 8193) q;
 SELECT count(*) INTO v_related FROM (SELECT 1 FROM public.payment_allocations WHERE org_id=p_org AND invoice_id=ANY(v_invoice_ids) LIMIT 8193) q;
 IF v_lines>8192 OR v_related>8192 THEN RAISE EXCEPTION 'prototype cohort unavailable' USING ERRCODE='54000'; END IF;
 SELECT encode(public.digest(convert_to(jsonb_build_object(
  'invoices',(SELECT coalesce(jsonb_agg(jsonb_build_array(i.id,i.lease_id,i.property_id,i.currency,i.status::text,i.total_minor,i.paid_minor,i.balance_minor,i.due_date) ORDER BY i.id),'[]'::jsonb) FROM public.invoices i WHERE i.org_id=p_org AND i.id=ANY(v_invoice_ids)),
  'lines',(SELECT coalesce(jsonb_agg(jsonb_build_array(il.id,il.invoice_id,il.charge_type::text,il.amount_minor) ORDER BY il.id),'[]'::jsonb) FROM public.invoice_lines il WHERE il.org_id=p_org AND il.invoice_id=ANY(v_invoice_ids)),
  'allocations',(SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,a.payment_id,a.invoice_id,a.amount_minor,p.status::text) ORDER BY a.id),'[]'::jsonb) FROM public.payment_allocations a JOIN public.payments p ON p.org_id=a.org_id AND p.id=a.payment_id WHERE a.org_id=p_org AND a.invoice_id=ANY(v_invoice_ids))
 )::text,'UTF8'),'sha256'),'hex') INTO v_prestate;
 v_fresh:=gen_random_uuid();IF EXISTS(SELECT 1 FROM public.payments WHERE id=v_fresh) THEN RAISE EXCEPTION 'prototype busy' USING ERRCODE='55P03'; END IF;
 SELECT x.outcome INTO v_key_result FROM app.b017_resolve_key(p_org,lease,'payment_confirmed',NULL,v_fresh,actor,'payment_confirmed') x;
 IF v_key_result IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO app.b019_begin_probe_ops(tx_id,org_id,live_org_id,environment,lease_id,actor_id,session_id,role,request_id,payload_digest,payment_id,payer_contact_id,invoice_ids,prestate_digest)
  VALUES(pg_current_xact_id(),p_org,p_live,p_env,lease,actor,p_session,p_role,p_request,v_digest,v_fresh,v_payer,v_invoice_ids,v_prestate);
 RETURN QUERY SELECT 'new'::text,v_fresh;
END $$;
REVOKE ALL ON FUNCTION app.b019_begin_probe(uuid,uuid,text,uuid,text,text,uuid,bigint,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b019_begin_probe(uuid,uuid,text,uuid,text,text,uuid,bigint,text,text,text) TO service_role;
COMMIT;
