-- Clone-only diagnostic: byte authority is trusted fixed test wrapper, not public API.
BEGIN;
CREATE TABLE app.b019_byte_probe_op(
 xid xid8 PRIMARY KEY,org uuid NOT NULL,live_org uuid NOT NULL,env text NOT NULL,session_id uuid NOT NULL,actor uuid NOT NULL,role text NOT NULL,
 lease uuid NOT NULL,request uuid NOT NULL,digest text NOT NULL,payment uuid NOT NULL,property uuid NOT NULL,currency text NOT NULL,payer uuid NOT NULL,
 amount bigint NOT NULL,paid_on date NOT NULL,last5_digest text NOT NULL,reference_digest text NOT NULL,raw_lease_digest text NOT NULL,phase text NOT NULL CHECK(phase IN ('begun','ready','stored'))
);
REVOKE ALL ON app.b019_byte_probe_op FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE app.b019_byte_probe_permit(xid xid8 PRIMARY KEY,purpose text NOT NULL CHECK(purpose IN ('begin','capture','store')));
REVOKE ALL ON app.b019_byte_probe_permit FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_byte_probe_private_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE p text;
BEGIN
 LOCK TABLE app.b019_byte_probe_op,app.b019_byte_probe_permit IN ACCESS SHARE MODE NOWAIT;
 SELECT purpose INTO p FROM app.b019_byte_probe_permit WHERE xid=pg_current_xact_id();
 IF TG_TABLE_NAME='b019_byte_probe_op' THEN
  IF TG_OP='INSERT' AND p='begin' AND NEW.xid=pg_current_xact_id() AND NEW.phase='begun' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.xid=pg_current_xact_id() AND (to_jsonb(OLD)-'phase')=(to_jsonb(NEW)-'phase') AND ((p='capture' AND OLD.phase='begun' AND NEW.phase='ready') OR (p='store' AND OLD.phase='ready' AND NEW.phase='stored')) THEN RETURN NEW;END IF;
 ELSE
  IF TG_OP='INSERT' AND p='capture' AND NEW.xid=pg_current_xact_id() AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=NEW.xid AND o.phase='begun') THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'byte private proof sealed' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_private_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_private_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_byte_probe_op FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_private_guard();
CREATE TRIGGER b019_byte_probe_private_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_post_probe_op FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_private_guard();
CREATE TRIGGER b019_byte_probe_private_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_post_probe_invoice FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_private_guard();
CREATE TRIGGER b019_byte_probe_private_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_post_probe_line FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_private_guard();
CREATE TRIGGER b019_byte_probe_private_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_post_probe_old_alloc FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_private_guard();
CREATE FUNCTION app.b019_byte_probe_never_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'byte command prototype cannot commit' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_never_commit() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b019_byte_probe_never_commit AFTER INSERT ON app.b019_byte_probe_op DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_never_commit();
CREATE FUNCTION app.b019_byte_probe_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op x WHERE x.xid=pg_current_xact_id() AND x.phase='stored' AND x.org=OLD.org_id AND ((x.actor=OLD.actor_id AND x.request=OLD.request_id) OR x.payment=OLD.payment_id)))
 OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op x WHERE x.xid=pg_current_xact_id() AND x.phase='stored' AND x.org=NEW.org_id AND ((x.actor=NEW.actor_id AND x.request=NEW.request_id) OR x.payment=NEW.payment_id))) THEN RAISE EXCEPTION 'byte command sealed' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b010_payment_commands FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_guard();
-- Clone-only partial guard: current-XID stored operation and its captured invoice cohort.
CREATE FUNCTION app.b019_byte_probe_allocation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op,app.b019_post_probe_invoice IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND (o.payment=OLD.payment_id OR EXISTS(SELECT 1 FROM app.b019_post_probe_invoice i WHERE i.xid=o.xid AND i.invoice=OLD.invoice_id))))
 OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND (o.payment=NEW.payment_id OR EXISTS(SELECT 1 FROM app.b019_post_probe_invoice i WHERE i.xid=o.xid AND i.invoice=NEW.invoice_id)))) THEN RAISE EXCEPTION 'byte allocation sealed' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_allocation_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_allocation_guard();
-- Clone-only partial OLD/NEW guards for captured lines and payment identities.
CREATE FUNCTION app.b019_byte_probe_line_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op,app.b019_post_probe_invoice IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o JOIN app.b019_post_probe_invoice i ON i.xid=o.xid WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND i.invoice=OLD.invoice_id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o JOIN app.b019_post_probe_invoice i ON i.xid=o.xid WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND i.invoice=NEW.invoice_id)) THEN RAISE EXCEPTION 'byte invoice line sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_line_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_line_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_lines FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_line_guard();
CREATE FUNCTION app.b019_byte_probe_payment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op,app.b019_post_probe_old_alloc IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND (o.payment=OLD.id OR EXISTS(SELECT 1 FROM app.b019_post_probe_old_alloc a WHERE a.xid=o.xid AND a.payment=OLD.id)))) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND (o.payment=NEW.id OR EXISTS(SELECT 1 FROM app.b019_post_probe_old_alloc a WHERE a.xid=o.xid AND a.payment=NEW.id)))) THEN RAISE EXCEPTION 'byte payment sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_payment_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_payment_guard();
-- Clone-only post-store candidate scope; capture-to-store revalidation remains separate.
CREATE FUNCTION app.b019_byte_probe_invoice_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND o.lease=OLD.lease_id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND o.lease=NEW.lease_id)) THEN RAISE EXCEPTION 'byte invoice scope sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_invoice_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoices FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_invoice_guard();
-- Clone-only helper-ledger guards. Operation payment is already protected after stored.
CREATE FUNCTION app.b019_byte_probe_ledger_tx_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op,public.payments IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o JOIN public.payments p ON p.org_id=o.org AND p.id=o.payment WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND (OLD.id=p.ledger_transaction_id OR (OLD.source_table='payments' AND OLD.source_id=o.payment) OR OLD.reverses_transaction_id=p.ledger_transaction_id))) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o JOIN public.payments p ON p.org_id=o.org AND p.id=o.payment WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND (NEW.id=p.ledger_transaction_id OR (NEW.source_table='payments' AND NEW.source_id=o.payment) OR NEW.reverses_transaction_id=p.ledger_transaction_id))) THEN RAISE EXCEPTION 'byte ledger header sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_ledger_tx_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_ledger_tx_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_ledger_tx_guard();
CREATE FUNCTION app.b019_byte_probe_ledger_entry_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op,public.payments IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o JOIN public.payments p ON p.org_id=o.org AND p.id=o.payment WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND p.ledger_transaction_id=OLD.transaction_id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o JOIN public.payments p ON p.org_id=o.org AND p.id=o.payment WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND p.ledger_transaction_id=NEW.transaction_id)) THEN RAISE EXCEPTION 'byte ledger entry sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_ledger_entry_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_ledger_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_ledger_entry_guard();
-- Clone-only session/member scope guards; every firing writer uses NOWAIT private admission.
CREATE FUNCTION app.b019_byte_probe_session_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.session_id=OLD.id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.session_id=NEW.id)) THEN RAISE EXCEPTION 'byte session sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_session_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_session_guard BEFORE INSERT OR UPDATE OR DELETE ON public.auth_sessions FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_session_guard();
CREATE FUNCTION app.b019_byte_probe_member_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.live_org=OLD.org_id AND o.actor=OLD.user_id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.live_org=NEW.org_id AND o.actor=NEW.user_id)) THEN RAISE EXCEPTION 'byte member sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_member_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_member_guard BEFORE INSERT OR UPDATE OR DELETE ON public.org_members FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_member_guard();
-- Clone-only lease/contact identity guards; payer principal issuance remains separate.
CREATE FUNCTION app.b019_byte_probe_lease_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND o.lease=OLD.id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND o.lease=NEW.id)) THEN RAISE EXCEPTION 'byte lease sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_lease_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_lease_guard BEFORE INSERT OR UPDATE OR DELETE ON public.leases FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_lease_guard();
CREATE FUNCTION app.b019_byte_probe_contact_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND o.payer=OLD.id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND o.payer=NEW.id)) THEN RAISE EXCEPTION 'byte payer contact sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_contact_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_contact_guard BEFORE INSERT OR UPDATE OR DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_contact_guard();
-- Clone-only whole-lease party absence guard.
CREATE FUNCTION app.b019_byte_probe_party_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND o.lease=OLD.lease_id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND o.lease=NEW.lease_id)) THEN RAISE EXCEPTION 'byte lease party scope sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_party_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_party_guard BEFORE INSERT OR UPDATE OR DELETE ON public.lease_parties FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_party_guard();
-- Clone-only selected/live organization and exact rollout-control guards.
CREATE FUNCTION app.b019_byte_probe_org_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND OLD.id IN(o.org,o.live_org))) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND NEW.id IN(o.org,o.live_org))) THEN RAISE EXCEPTION 'byte organization sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_org_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_org_guard BEFORE INSERT OR UPDATE OR DELETE ON public.organizations FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_org_guard();
CREATE FUNCTION app.b019_byte_probe_settings_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored') AND ((TG_OP<>'INSERT' AND OLD.key IN('notification_center_v2','payment_results_v2')) OR (TG_OP<>'DELETE' AND NEW.key IN('notification_center_v2','payment_results_v2'))) THEN RAISE EXCEPTION 'byte rollout control sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_settings_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON public.platform_settings FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_settings_guard();
-- Clone-only exact property scope; historical receipt lookup remains separate.
CREATE FUNCTION app.b019_byte_probe_property_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_byte_probe_op IN ACCESS SHARE MODE NOWAIT;
 IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=OLD.org_id AND o.property=OLD.id)) OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_byte_probe_op o WHERE o.xid=pg_current_xact_id() AND o.phase='stored' AND o.org=NEW.org_id AND o.property=NEW.id)) THEN RAISE EXCEPTION 'byte property sealed' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_property_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_byte_probe_property_guard BEFORE INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION app.b019_byte_probe_property_guard();
CREATE FUNCTION app.b019_byte_probe_begin(p_org uuid,p_live uuid,p_env text,p_session uuid,p_lease_text text,p_role text,p_request uuid,p_bytes bytea)
RETURNS TABLE(disposition text,payment_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE actor uuid:=auth.uid(); j jsonb; lease uuid; amount bigint; paid date; dg text; rawdg text; l5dg text; refdg text; old app.b019_byte_probe_op%ROWTYPE; p uuid; v_lease uuid; st text; email boolean; center boolean; property uuid; currency text; payer uuid; aliases integer;v_prop_id uuid;v_prop_currency text;v_last5 public.payments.payer_account_last5%TYPE;
BEGIN
 IF actor IS NULL OR p_request IS NULL OR p_bytes IS NULL OR octet_length(p_bytes)>65536 OR NOT EXISTS(SELECT 1 FROM public.organizations o JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL JOIN public.org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=actor WHERE o.id=p_org AND o.environment::text=p_env AND ((o.environment='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live)) AND m.user_id=actor AND m.status='active' AND m.role::text=p_role AND m.role IN ('admin','manager','accountant') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 BEGIN j:=convert_from(p_bytes,'UTF8')::jsonb;lease:=p_lease_text::uuid; paid:=(j->>'paidOn')::date;amount:=(j->>'amount')::bigint; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END;
 IF jsonb_typeof(j)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(j))<>5 OR NOT j ?& ARRAY['leaseId','amount','paidOn','last5','reference'] OR jsonb_typeof(j->'amount')<>'number' OR jsonb_typeof(j->'leaseId')<>'string' OR jsonb_typeof(j->'paidOn')<>'string' OR jsonb_typeof(j->'last5')<>'string' OR jsonb_typeof(j->'reference')<>'string' OR j->>'leaseId' IS DISTINCT FROM p_lease_text OR amount<=0 OR amount>9007199254740991 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 dg:=encode(public.digest(p_bytes,'sha256'),'hex');rawdg:=encode(public.digest(convert_to(p_lease_text,'UTF8'),'sha256'),'hex');
 BEGIN v_last5:=NULLIF(j->>'last5',''); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END;
 IF v_last5 IS NOT NULL AND v_last5 !~ '^[0-9]{5}$' THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 l5dg:=encode(public.digest(convert_to(CASE WHEN v_last5 IS NULL THEN 'N' ELSE 'V'||v_last5::text END,'UTF8'),'sha256'),'hex');refdg:=encode(public.digest(convert_to(CASE WHEN j->>'reference'='' THEN 'N' ELSE 'V'||(j->>'reference') END,'UTF8'),'sha256'),'hex');
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations WHERE id IN(p_org,p_live) ORDER BY id FOR SHARE NOWAIT;
 LOCK TABLE app.b010_source_events,app.b017_occurrences IN ACCESS SHARE MODE NOWAIT;
 LOCK TABLE app.b010_payment_commands IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 LOCK TABLE app.b019_byte_probe_op,app.b019_byte_probe_permit,app.b019_payment_contexts,app.b019_payment_requirements,app.b019_post_probe_op,app.b019_post_probe_invoice,app.b019_post_probe_line,app.b019_post_probe_old_alloc,public.audit_log IN ROW EXCLUSIVE MODE NOWAIT;
 SELECT a.email_on,a.center_on INTO email,center FROM app.b019_payment_admit(p_org,p_live,p_env,p_session,lease,p_role) a;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('b010:payment:'||p_org::text||':'||actor::text||':'||p_request::text,0)) THEN RAISE EXCEPTION 'prototype busy' USING ERRCODE='55P03'; END IF;
 SELECT * INTO old FROM app.b019_byte_probe_op WHERE xid=pg_current_xact_id();
 IF FOUND THEN
  SELECT l.property_id,l.currency,lp.contact_id INTO property,currency,payer FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id AND c.is_tenant AND c.archived_at IS NULL WHERE l.org_id=p_org AND l.id=lease FOR SHARE OF c NOWAIT;
  IF NOT FOUND OR email OR NOT center OR (currency='TWD' AND (j->>'last5') !~ '^[0-9]{5}$') OR (SELECT count(*) FROM public.lease_parties WHERE org_id=p_org AND lease_id=lease AND role='primary')<>1 OR ROW(old.org,old.live_org,old.env,old.session_id,old.actor,old.role,old.lease,old.request,old.digest,old.raw_lease_digest,old.property,old.currency,old.payer,old.amount,old.paid_on,old.last5_digest,old.reference_digest) IS DISTINCT FROM ROW(p_org,p_live,p_env,p_session,actor,p_role,lease,p_request,dg,rawdg,property,currency,payer,amount,paid,l5dg,refdg) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.properties prop WHERE prop.org_id=old.org AND prop.id=old.property AND prop.currency=old.currency FOR SHARE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501';END IF;
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
 SELECT prop.id,prop.currency INTO v_prop_id,v_prop_currency FROM public.leases l JOIN public.properties prop ON prop.org_id=l.org_id AND prop.id=l.property_id WHERE l.org_id=p_org AND l.id=lease AND prop.currency=l.currency FOR SHARE OF prop NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501';END IF;
 LOCK TABLE public.invoice_lines,public.invoices,public.lease_parties,public.ledger_entries,public.ledger_transactions,public.payment_allocations,public.payments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT l.property_id,l.currency,lp.contact_id INTO property,currency,payer FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id AND c.is_tenant AND c.archived_at IS NULL WHERE l.org_id=p_org AND l.id=lease FOR SHARE OF c NOWAIT;
 IF NOT FOUND OR property IS DISTINCT FROM v_prop_id OR currency IS DISTINCT FROM v_prop_currency OR (currency='TWD' AND (j->>'last5') !~ '^[0-9]{5}$') OR (SELECT count(*) FROM public.lease_parties WHERE org_id=p_org AND lease_id=lease AND role='primary')<>1 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 p:=gen_random_uuid();IF EXISTS(SELECT 1 FROM public.payments WHERE id=p) THEN RAISE EXCEPTION 'prototype busy' USING ERRCODE='55P03';END IF;
 INSERT INTO app.b019_byte_probe_permit VALUES(pg_current_xact_id(),'begin');
 INSERT INTO app.b019_byte_probe_op VALUES(pg_current_xact_id(),p_org,p_live,p_env,p_session,actor,p_role,lease,p_request,dg,p,property,currency,payer,amount,paid,l5dg,refdg,rawdg,'begun');
 DELETE FROM app.b019_byte_probe_permit WHERE xid=pg_current_xact_id() AND purpose='begin';
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
 PERFORM 1 FROM public.properties prop WHERE prop.org_id=x.org AND prop.id=x.property AND prop.currency=x.currency FOR SHARE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.b019_post_probe_op q WHERE q.xid=x.xid AND ROW(q.org,q.lease,q.payment,q.actor,q.property,q.currency,q.payer,q.amount) IS NOT DISTINCT FROM ROW(x.org,x.lease,x.payment,x.actor,x.property,x.currency,x.payer,x.amount)) THEN RAISE EXCEPTION 'prototype evidence scope mismatch' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM public.payments WHERE org_id=x.org AND id=x.payment FOR UPDATE NOWAIT;
 IF NOT FOUND OR p.lease_id<>x.lease OR p.property_id<>x.property OR p.currency<>x.currency OR p.payer_contact_id IS DISTINCT FROM x.payer OR p.amount_minor<>x.amount OR p.paid_on<>x.paid_on OR p.method::text<>(CASE WHEN x.currency='USD' THEN 'zelle' ELSE 'bank_transfer' END) OR p.status<>'confirmed' OR p.source<>'manager_entry' OR p.submitted_by IS DISTINCT FROM x.actor OR p.confirmed_by IS DISTINCT FROM x.actor OR p.confirmed_at IS NULL OR encode(public.digest(convert_to(CASE WHEN p.payer_account_last5 IS NULL THEN 'N' ELSE 'V'||p.payer_account_last5 END,'UTF8'),'sha256'),'hex')<>x.last5_digest OR encode(public.digest(convert_to(CASE WHEN p.reference IS NULL THEN 'N' ELSE 'V'||p.reference END,'UTF8'),'sha256'),'hex')<>x.reference_digest OR NOT EXISTS(SELECT 1 FROM app.b019_payment_requirements r WHERE r.tx_id=txid_current() AND r.org_id=x.org AND r.lease_id=x.lease AND r.payment_id=x.payment AND r.kind='payment_confirmed' AND r.actor_id=x.actor) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 -- Diagnostic conjunction only: mutable synthetic proof is not a trusted finalizer.
 IF NOT app.b019_post_probe_compare() OR NOT app.b019_post_probe_ledger_compare() THEN RAISE EXCEPTION 'prototype financial evidence unavailable' USING ERRCODE='23514'; END IF;
 IF x.phase='begun' THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501';END IF;
 IF x.phase='stored' THEN IF NOT EXISTS(SELECT 1 FROM app.b010_payment_commands WHERE org_id=x.org AND actor_id=x.actor AND request_id=x.request AND payload_digest=x.digest AND payment_id=x.payment) OR (SELECT count(*) FROM app.b010_payment_commands WHERE org_id=x.org AND payment_id=x.payment)<>1 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(x.org,x.live_org,x.env,x.session_id,x.lease,x.role) a;IF v_email OR NOT v_center OR NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=x.session_id AND user_id=x.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;RETURN 'same_mapping'; END IF;
 IF EXISTS(SELECT 1 FROM app.b010_payment_commands WHERE org_id=x.org AND ((actor_id=x.actor AND request_id=x.request) OR payment_id=x.payment)) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES(x.org,x.actor,x.request,x.digest,x.payment);
 INSERT INTO app.b019_byte_probe_permit VALUES(pg_current_xact_id(),'store');UPDATE app.b019_byte_probe_op SET phase='stored' WHERE xid=x.xid;DELETE FROM app.b019_byte_probe_permit WHERE xid=x.xid AND purpose='store';SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(x.org,x.live_org,x.env,x.session_id,x.lease,x.role) a;IF v_email OR NOT v_center OR NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=x.session_id AND user_id=x.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;RETURN 'stored_rollback_only';
END $$;
REVOKE ALL ON FUNCTION app.b019_byte_probe_store() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
