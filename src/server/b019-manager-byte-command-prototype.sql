-- Clone-only diagnostic: byte authority is trusted fixed test wrapper, not public API.
BEGIN;
CREATE TABLE app.b019_byte_probe_op(
 xid xid8 PRIMARY KEY,org uuid NOT NULL,live_org uuid NOT NULL,env text NOT NULL,session_id uuid NOT NULL,actor uuid NOT NULL,role text NOT NULL,
 lease uuid NOT NULL,request uuid NOT NULL,digest text NOT NULL,payment uuid NOT NULL,property uuid NOT NULL,currency text NOT NULL,payer uuid NOT NULL,
 amount bigint NOT NULL,paid_on date NOT NULL,last5_digest text NOT NULL,reference_digest text NOT NULL,raw_lease_digest text NOT NULL,stored boolean NOT NULL DEFAULT false
);
REVOKE ALL ON app.b019_byte_probe_op FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_byte_probe_never_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'byte command prototype cannot commit' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_never_commit() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b019_byte_probe_never_commit AFTER INSERT ON app.b019_byte_probe_op DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_never_commit();
CREATE FUNCTION app.b019_byte_probe_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op x WHERE x.xid=pg_current_xact_id() AND x.stored AND x.org=OLD.org_id AND ((x.actor=OLD.actor_id AND x.request=OLD.request_id) OR x.payment=OLD.payment_id)))
 OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op x WHERE x.xid=pg_current_xact_id() AND x.stored AND x.org=NEW.org_id AND ((x.actor=NEW.actor_id AND x.request=NEW.request_id) OR x.payment=NEW.payment_id))) THEN RAISE EXCEPTION 'byte command sealed' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b010_payment_commands FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_guard();
CREATE FUNCTION app.b019_byte_probe_begin(p_org uuid,p_live uuid,p_env text,p_session uuid,p_lease_text text,p_role text,p_request uuid,p_bytes bytea)
RETURNS TABLE(disposition text,payment_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE actor uuid:=auth.uid(); j jsonb; lease uuid; amount bigint; paid date; dg text; rawdg text; l5dg text; refdg text; old app.b019_byte_probe_op%ROWTYPE; p uuid; v_lease uuid; st text; email boolean; center boolean; property uuid; currency text; payer uuid; aliases integer;
BEGIN
 IF actor IS NULL OR p_request IS NULL OR p_bytes IS NULL OR octet_length(p_bytes)>65536 OR NOT EXISTS(SELECT 1 FROM public.organizations o JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL JOIN public.org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=actor WHERE o.id=p_org AND o.environment::text=p_env AND ((o.environment='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live)) AND m.user_id=actor AND m.status='active' AND m.role::text=p_role AND m.role IN ('admin','manager','accountant') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 BEGIN j:=convert_from(p_bytes,'UTF8')::jsonb;lease:=p_lease_text::uuid; paid:=(j->>'paidOn')::date;amount:=(j->>'amount')::bigint; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END;
 IF jsonb_typeof(j)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(j))<>5 OR NOT j ?& ARRAY['leaseId','amount','paidOn','last5','reference'] OR jsonb_typeof(j->'amount')<>'number' OR jsonb_typeof(j->'leaseId')<>'string' OR jsonb_typeof(j->'paidOn')<>'string' OR jsonb_typeof(j->'last5')<>'string' OR jsonb_typeof(j->'reference')<>'string' OR j->>'leaseId' IS DISTINCT FROM p_lease_text OR amount<=0 OR amount>9007199254740991 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 dg:=encode(public.digest(p_bytes,'sha256'),'hex');rawdg:=encode(public.digest(convert_to(p_lease_text,'UTF8'),'sha256'),'hex');
 l5dg:=encode(public.digest(convert_to(CASE WHEN j->>'last5'='' THEN 'N' ELSE 'V'||(j->>'last5') END,'UTF8'),'sha256'),'hex');refdg:=encode(public.digest(convert_to(CASE WHEN j->>'reference'='' THEN 'N' ELSE 'V'||(j->>'reference') END,'UTF8'),'sha256'),'hex');
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations WHERE id IN(p_org,p_live) ORDER BY id FOR SHARE NOWAIT;
 LOCK TABLE app.b010_source_events,app.b017_occurrences IN ACCESS SHARE MODE NOWAIT;
 LOCK TABLE app.b010_payment_commands IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 LOCK TABLE app.b019_byte_probe_op,app.b019_payment_contexts,app.b019_payment_requirements,public.audit_log IN ROW EXCLUSIVE MODE NOWAIT;
 SELECT a.email_on,a.center_on INTO email,center FROM app.b019_payment_admit(p_org,p_live,p_env,p_session,lease,p_role) a;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('b010:payment:'||p_org::text||':'||actor::text||':'||p_request::text,0)) THEN RAISE EXCEPTION 'prototype busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO old FROM app.b019_byte_probe_op WHERE xid=pg_current_xact_id();
 IF FOUND THEN
  SELECT l.property_id,l.currency,lp.contact_id INTO property,currency,payer FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id AND c.is_tenant AND c.archived_at IS NULL WHERE l.org_id=p_org AND l.id=lease FOR SHARE OF c NOWAIT;
  IF NOT FOUND OR email OR NOT center OR (SELECT count(*) FROM public.lease_parties WHERE org_id=p_org AND lease_id=lease AND role='primary')<>1 OR ROW(old.org,old.live_org,old.env,old.session_id,old.actor,old.role,old.lease,old.request,old.digest,old.raw_lease_digest,old.property,old.currency,old.payer,old.amount,old.paid_on,old.last5_digest,old.reference_digest) IS DISTINCT FROM ROW(p_org,p_live,p_env,p_session,actor,p_role,lease,p_request,dg,rawdg,property,currency,payer,amount,paid,l5dg,refdg) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=p_session AND user_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT 'same_operation'::text,old.payment;RETURN;
 END IF;
 SELECT cmd.payment_id,pay.lease_id,pay.status::text INTO p,v_lease,st FROM app.b010_payment_commands cmd JOIN public.payments pay ON pay.org_id=cmd.org_id AND pay.id=cmd.payment_id WHERE cmd.org_id=p_org AND cmd.actor_id=actor AND cmd.request_id=p_request AND cmd.payload_digest=dg FOR SHARE OF cmd,pay NOWAIT;
 IF p IS NOT NULL THEN
  SELECT count(*) INTO aliases FROM (SELECT 1 FROM app.b010_payment_commands cmd2 WHERE cmd2.org_id=p_org AND cmd2.payment_id=p LIMIT 2) q;
  IF aliases<>1 OR v_lease<>lease OR st NOT IN ('confirmed','reversed') OR NOT (EXISTS(SELECT 1 FROM app.b010_source_events e WHERE e.org_id=p_org AND e.lease_id=lease AND e.payment_id=p AND e.actor_id=actor AND e.kind='payment_confirmed') OR EXISTS(SELECT 1 FROM app.b017_occurrences n WHERE n.org_id=p_org AND n.lease_id=lease AND n.payment_id=p AND n.actor_id=actor AND n.kind='payment_confirmed')) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.b019_payment_admit(p_org,p_live,p_env,p_session,lease,p_role);IF NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=p_session AND user_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT 'recorded'::text,p;RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM app.b010_payment_commands WHERE org_id=p_org AND actor_id=actor AND request_id=p_request) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF NOT center AND NOT email THEN PERFORM 1 FROM app.b019_payment_admit(p_org,p_live,p_env,p_session,lease,p_role);IF NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=p_session AND user_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;RETURN QUERY SELECT 'unknown'::text,NULL::uuid;RETURN;END IF;
 IF NOT center OR email THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 LOCK TABLE public.invoice_lines,public.invoices,public.lease_parties,public.ledger_entries,public.ledger_transactions,public.payment_allocations,public.payments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT l.property_id,l.currency,lp.contact_id INTO property,currency,payer FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id AND c.is_tenant AND c.archived_at IS NULL WHERE l.org_id=p_org AND l.id=lease FOR SHARE OF c NOWAIT;
 IF NOT FOUND OR (SELECT count(*) FROM public.lease_parties WHERE org_id=p_org AND lease_id=lease AND role='primary')<>1 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 p:=gen_random_uuid();IF EXISTS(SELECT 1 FROM public.payments WHERE id=p) THEN RAISE EXCEPTION 'prototype busy' USING ERRCODE='55P03';END IF;
 INSERT INTO app.b019_byte_probe_op VALUES(pg_current_xact_id(),p_org,p_live,p_env,p_session,actor,p_role,lease,p_request,dg,p,property,currency,payer,amount,paid,l5dg,refdg,rawdg,false);
 SELECT a.email_on,a.center_on INTO email,center FROM app.b019_payment_admit(p_org,p_live,p_env,p_session,lease,p_role) a;
 IF email OR NOT center OR NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=p_session AND user_id=actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT 'new'::text,p;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_begin(uuid,uuid,text,uuid,text,text,uuid,bytea) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_byte_probe_store() RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE x app.b019_byte_probe_op%ROWTYPE; p public.payments%ROWTYPE; v_email boolean;v_center boolean;v_property uuid;v_currency text;v_payer uuid;
BEGIN
 SELECT * INTO x FROM app.b019_byte_probe_op WHERE xid=pg_current_xact_id();IF NOT FOUND OR auth.uid() IS DISTINCT FROM x.actor OR NOT EXISTS(SELECT 1 FROM public.auth_sessions s JOIN public.org_members m ON m.user_id=s.user_id AND m.org_id=x.live_org WHERE s.id=x.session_id AND s.user_id=x.actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.status='active' AND m.role::text=x.role) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(x.org,x.live_org,x.env,x.session_id,x.lease,x.role) a;IF v_email OR NOT v_center THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT l.property_id,l.currency,lp.contact_id INTO v_property,v_currency,v_payer FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id AND c.is_tenant AND c.archived_at IS NULL WHERE l.org_id=x.org AND l.id=x.lease FOR SHARE OF c NOWAIT;
 IF NOT FOUND OR (SELECT count(*) FROM public.lease_parties WHERE org_id=x.org AND lease_id=x.lease AND role='primary')<>1 OR ROW(v_property,v_currency,v_payer) IS DISTINCT FROM ROW(x.property,x.currency,x.payer) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM public.payments WHERE org_id=x.org AND id=x.payment FOR UPDATE NOWAIT;
 IF NOT FOUND OR p.lease_id<>x.lease OR p.property_id<>x.property OR p.currency<>x.currency OR p.payer_contact_id IS DISTINCT FROM x.payer OR p.amount_minor<>x.amount OR p.paid_on<>x.paid_on OR p.method::text<>(CASE WHEN x.currency='USD' THEN 'zelle' ELSE 'bank_transfer' END) OR p.status<>'confirmed' OR p.source<>'manager_entry' OR p.submitted_by IS DISTINCT FROM x.actor OR p.confirmed_by IS DISTINCT FROM x.actor OR p.confirmed_at IS NULL OR encode(public.digest(convert_to(CASE WHEN p.payer_account_last5 IS NULL THEN 'N' ELSE 'V'||p.payer_account_last5 END,'UTF8'),'sha256'),'hex')<>x.last5_digest OR encode(public.digest(convert_to(CASE WHEN p.reference IS NULL THEN 'N' ELSE 'V'||p.reference END,'UTF8'),'sha256'),'hex')<>x.reference_digest OR NOT EXISTS(SELECT 1 FROM app.b019_payment_requirements r WHERE r.tx_id=txid_current() AND r.org_id=x.org AND r.lease_id=x.lease AND r.payment_id=x.payment AND r.kind='payment_confirmed' AND r.actor_id=x.actor) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF x.stored THEN IF NOT EXISTS(SELECT 1 FROM app.b010_payment_commands WHERE org_id=x.org AND actor_id=x.actor AND request_id=x.request AND payload_digest=x.digest AND payment_id=x.payment) OR (SELECT count(*) FROM app.b010_payment_commands WHERE org_id=x.org AND payment_id=x.payment)<>1 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(x.org,x.live_org,x.env,x.session_id,x.lease,x.role) a;IF v_email OR NOT v_center OR NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=x.session_id AND user_id=x.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;RETURN 'same_mapping'; END IF;
 IF EXISTS(SELECT 1 FROM app.b010_payment_commands WHERE org_id=x.org AND ((actor_id=x.actor AND request_id=x.request) OR payment_id=x.payment)) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES(x.org,x.actor,x.request,x.digest,x.payment);
 UPDATE app.b019_byte_probe_op SET stored=true WHERE xid=x.xid;SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(x.org,x.live_org,x.env,x.session_id,x.lease,x.role) a;IF v_email OR NOT v_center OR NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=x.session_id AND user_id=x.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;RETURN 'stored_rollback_only';
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_store() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
