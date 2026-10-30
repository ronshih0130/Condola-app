-- Owned-clone prototype only. Do not apply to an integrated or production schema.
-- Provenance rows below are owner-synthetic; there is no trusted success path.
BEGIN;
CREATE TABLE app.b019_proto_operation (
 tx_id xid8 PRIMARY KEY DEFAULT pg_current_xact_id(),org_id uuid NOT NULL,live_org_id uuid NOT NULL,environment text NOT NULL CHECK(environment IN ('live','sandbox')),
 lease_id uuid NOT NULL,payment_id uuid NOT NULL,actor_id uuid NOT NULL,session_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('admin','manager','accountant')),
 mode text NOT NULL CHECK(mode IN ('manager_record_confirmed','confirm_submitted','reject_submitted','reverse_confirmed')),
 prior_status text NOT NULL CHECK(prior_status IN ('absent','submitted','confirmed')),
 request_id uuid,command_digest text CHECK(command_digest IS NULL OR command_digest ~ '^[0-9a-f]{64}$'),
 prestate_digest bytea NOT NULL CHECK(octet_length(prestate_digest)=32),
 CHECK ((mode='manager_record_confirmed')=(request_id IS NOT NULL AND command_digest IS NOT NULL)),
 CHECK ((request_id IS NULL)=(command_digest IS NULL)),
 CHECK ((mode='manager_record_confirmed' AND prior_status='absent') OR (mode IN ('confirm_submitted','reject_submitted') AND prior_status='submitted') OR (mode='reverse_confirmed' AND prior_status='confirmed'))
);
CREATE TABLE app.b019_proto_seals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tx_id xid8 NOT NULL DEFAULT pg_current_xact_id() UNIQUE,
 org_id uuid NOT NULL,live_org_id uuid NOT NULL,environment text NOT NULL CHECK(environment IN ('live','sandbox')),
 lease_id uuid NOT NULL,payment_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('payment_confirmed','payment_rejected','payment_reversed')),
 actor_id uuid NOT NULL,session_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('admin','manager','accountant')),
 mode text NOT NULL CHECK(mode IN ('manager_record_confirmed','confirm_submitted','reject_submitted','reverse_confirmed')),prior_status text NOT NULL CHECK(prior_status IN ('absent','submitted','confirmed')),request_id uuid,command_digest text CHECK(command_digest IS NULL OR command_digest ~ '^[0-9a-f]{64}$'),prestate_digest bytea NOT NULL CHECK(octet_length(prestate_digest)=32),
 neutral_source_id uuid NOT NULL,center_event_id uuid,in_app_outcome text NOT NULL CHECK(in_app_outcome IN ('issued','recipient_unavailable')),
 financial_digest bytea NOT NULL CHECK(octet_length(financial_digest)=32),recipient_digest bytea NOT NULL CHECK(octet_length(recipient_digest)=32),scope_digest bytea NOT NULL CHECK(octet_length(scope_digest)=32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((request_id IS NULL)=(command_digest IS NULL)),CHECK((mode='manager_record_confirmed')=(request_id IS NOT NULL AND command_digest IS NOT NULL)),
 CHECK((mode='manager_record_confirmed' AND prior_status='absent' AND kind='payment_confirmed') OR (mode='confirm_submitted' AND prior_status='submitted' AND kind='payment_confirmed') OR (mode='reject_submitted' AND prior_status='submitted' AND kind='payment_rejected') OR (mode='reverse_confirmed' AND prior_status='confirmed' AND kind='payment_reversed')),
 CHECK((in_app_outcome='issued')=(center_event_id IS NOT NULL))
);
CREATE TABLE app.b019_proto_resources (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,seal_id uuid NOT NULL REFERENCES app.b019_proto_seals(id) ON DELETE RESTRICT,
 kind text NOT NULL,org_id uuid,id1 uuid,id2 uuid,text_key text,
 UNIQUE NULLS NOT DISTINCT(seal_id,kind,org_id,id1,id2,text_key),
 CHECK ((
  (kind IN ('payment','invoice','lease','property','contact','member','original_ledger','reversal_ledger','bank_transaction','bank_account','bank_suggestion','source','center_event','center_recipient','organization','allocation','invoice_line') AND org_id IS NOT NULL AND id1 IS NOT NULL AND id2 IS NULL AND text_key IS NULL)
  OR (kind IN ('auth_user','session') AND org_id IS NULL AND id1 IS NOT NULL AND id2 IS NULL AND text_key IS NULL)
  OR (kind IN ('lease_party_scope','command') AND org_id IS NOT NULL AND id1 IS NOT NULL AND id2 IS NOT NULL AND text_key IS NULL)
  OR (kind='ledger_entry' AND org_id IS NOT NULL AND id1 IS NOT NULL AND id2 IS NULL AND text_key ~ '^[0-9]+$')
  OR (kind='org_control' AND org_id IS NOT NULL AND id1 IS NULL AND id2 IS NULL AND text_key IN ('payment_results_v2','notification_center_v2'))
  OR (kind='currency' AND org_id IS NULL AND id1 IS NULL AND id2 IS NULL AND text_key ~ '^[A-Z]{3}$')
 ) IS TRUE)
);

REVOKE ALL ON app.b019_proto_operation,app.b019_proto_seals,app.b019_proto_resources FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE app.b019_proto_resources_id_seq FROM PUBLIC,anon,authenticated,service_role;

-- Owner-only GC permits are DB-derived and transaction-bound. No caller GUC.
CREATE TABLE app.b019_proto_gc_permits(tx_id xid8 NOT NULL,seal_id uuid NOT NULL,PRIMARY KEY(tx_id,seal_id));
CREATE TABLE app.b019_proto_install_permits(tx_id xid8 NOT NULL,seal_id uuid NOT NULL,PRIMARY KEY(tx_id,seal_id));
REVOKE ALL ON app.b019_proto_gc_permits,app.b019_proto_install_permits FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_proto_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v_seal uuid;v_birth xid8;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM app.b019_proto_install_permits p JOIN app.b019_proto_seals s ON s.id=p.seal_id WHERE p.tx_id=pg_current_xact_id() AND p.seal_id=NEW.seal_id AND s.tx_id=pg_current_xact_id()) THEN RAISE EXCEPTION 'prototype immutable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'prototype immutable' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='b019_proto_seals' THEN v_seal:=OLD.id;v_birth:=OLD.tx_id;
 ELSE v_seal:=OLD.seal_id;SELECT tx_id INTO v_birth FROM app.b019_proto_seals WHERE id=v_seal; END IF;
 IF v_birth IS NULL OR v_birth=pg_current_xact_id() OR pg_xact_status(v_birth) IS DISTINCT FROM 'committed'
  OR NOT EXISTS(SELECT 1 FROM app.b019_proto_gc_permits WHERE tx_id=pg_current_xact_id() AND seal_id=v_seal) THEN
  RAISE EXCEPTION 'prototype immutable' USING ERRCODE='42501'; END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.b019_proto_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_proto_seals_immutable BEFORE UPDATE OR DELETE ON app.b019_proto_seals FOR EACH ROW EXECUTE FUNCTION app.b019_proto_immutable();
CREATE TRIGGER b019_proto_resources_immutable BEFORE INSERT OR UPDATE OR DELETE ON app.b019_proto_resources FOR EACH ROW EXECUTE FUNCTION app.b019_proto_immutable();
CREATE FUNCTION app.b019_proto_gc(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE ids uuid[];v_count integer;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>10 THEN RAISE EXCEPTION 'invalid limit' USING ERRCODE='22023'; END IF;
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO ids FROM (SELECT id FROM app.b019_proto_seals WHERE tx_id<>pg_current_xact_id() AND pg_xact_status(tx_id)='committed' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT p_limit) q;
 -- Child rows must never cause a late blocking wait while reset admission is held.
 PERFORM 1 FROM app.b019_proto_resources WHERE seal_id=ANY(ids) ORDER BY seal_id,id FOR UPDATE NOWAIT;
 INSERT INTO app.b019_proto_gc_permits(tx_id,seal_id) SELECT pg_current_xact_id(),id FROM unnest(ids) id;
 DELETE FROM app.b019_proto_resources WHERE seal_id=ANY(ids);
 DELETE FROM app.b019_proto_seals WHERE id=ANY(ids);
 GET DIAGNOSTICS v_count=ROW_COUNT;
 DELETE FROM app.b019_proto_gc_permits WHERE tx_id=pg_current_xact_id();
 RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION app.b019_proto_gc(integer) FROM PUBLIC,anon,authenticated,service_role;

-- Test fixture only; cannot create genuine provenance. Every field must be
-- replaced by a fixed trusted entrypoint before any real operation is accepted.
CREATE FUNCTION app.b019_proto_snapshot(p_org uuid,p_payment uuid) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_payment_count integer;v_alloc integer;v_invoices integer;v_invoice_rows integer;v_base_headers integer;v_headers integer;v_entries integer;v_lines integer;v_related_allocations integer;v_pointer_valid boolean;v_data jsonb;
BEGIN
 -- One statement/snapshot, materialized cap+1 rowsets; aggregation consumes
 -- only these bounded sets. Completeness under concurrent writers needs pins.
 WITH p AS MATERIALIZED (
  SELECT id,org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method::text,status::text,source,submitted_by,confirmed_by,
   extract(epoch FROM confirmed_at) confirmed_at_epoch,rejected_reason,bank_transaction_id,ledger_transaction_id,proof_file_id,is_deposit,extract(epoch FROM submitted_at) submitted_at_epoch,reference,payer_account_last5
  FROM public.payments WHERE org_id=p_org AND id=p_payment
 ), a AS MATERIALIZED (
  SELECT id,org_id,payment_id,invoice_id,amount_minor,created_by FROM public.payment_allocations WHERE org_id=p_org AND payment_id=p_payment ORDER BY id LIMIT 4097
 ), bh AS MATERIALIZED (
  SELECT t.id FROM public.ledger_transactions t CROSS JOIN p WHERE t.org_id=p_org AND (t.id=p.ledger_transaction_id OR (t.source_table='payments' AND t.source_id=p_payment)) ORDER BY t.id LIMIT 1025
 ), h AS MATERIALIZED (
  SELECT t.id,t.org_id,t.property_id,t.lease_id,t.kind::text,t.currency,t.effective_date,t.source_table,t.source_id,t.reverses_transaction_id,t.reason,t.created_by
  FROM public.ledger_transactions t WHERE t.org_id=p_org AND (t.id IN (SELECT id FROM bh) OR t.reverses_transaction_id IN (SELECT id FROM bh)) ORDER BY t.id LIMIT 1025
 ), e AS MATERIALIZED (
  SELECT e.id,e.org_id,e.transaction_id,e.account::text,e.amount_minor,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id
  FROM public.ledger_entries e JOIN h ON h.id=e.transaction_id AND h.org_id=e.org_id ORDER BY e.id LIMIT 8193
 ), ik AS MATERIALIZED (
  SELECT id FROM (SELECT invoice_id id FROM a UNION SELECT invoice_id id FROM e WHERE invoice_id IS NOT NULL) k ORDER BY id LIMIT 1025
 ), i AS MATERIALIZED (
  SELECT i.id,i.org_id,i.property_id,i.lease_id,i.currency,i.status::text,i.total_minor,i.paid_minor,i.balance_minor,i.due_date
  FROM public.invoices i JOIN ik ON ik.id=i.id WHERE i.org_id=p_org ORDER BY i.id
 ), ia AS MATERIALIZED (
  SELECT pa.id,pa.org_id,pa.payment_id,pa.invoice_id,pa.amount_minor,pp.status::text payment_status,pp.lease_id payment_lease,pp.currency payment_currency,pp.amount_minor payment_amount,pp.ledger_transaction_id payment_ledger,pp.confirmed_by payment_confirmed_by,ot.kind::text ledger_kind,ot.source_table ledger_source_table,ot.source_id ledger_source_id,ot.currency ledger_currency FROM public.payment_allocations pa JOIN ik ON ik.id=pa.invoice_id LEFT JOIN public.payments pp ON pp.id=pa.payment_id AND pp.org_id=pa.org_id LEFT JOIN public.ledger_transactions ot ON ot.id=pp.ledger_transaction_id AND ot.org_id=pp.org_id WHERE pa.org_id=p_org ORDER BY pa.id LIMIT 8193
 ), il AS MATERIALIZED (
  SELECT il.id,il.org_id,il.invoice_id,il.charge_type::text,il.amount_minor FROM public.invoice_lines il JOIN ik ON ik.id=il.invoice_id WHERE il.org_id=p_org ORDER BY il.id LIMIT 8193
 )
 SELECT (SELECT count(*) FROM p),(SELECT count(*) FROM a),(SELECT count(*) FROM ik),(SELECT count(*) FROM i),(SELECT count(*) FROM bh),(SELECT count(*) FROM h),(SELECT count(*) FROM e),(SELECT count(*) FROM il),(SELECT count(*) FROM ia),
  coalesce((SELECT p.ledger_transaction_id IS NULL OR EXISTS(SELECT 1 FROM h WHERE h.id=p.ledger_transaction_id AND h.kind='payment' AND h.source_table='payments' AND h.source_id=p.id) FROM p),false),
  jsonb_build_object('payment',(SELECT to_jsonb(p) FROM p),'allocations',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM a),'[]'::jsonb),
   'invoice_keys',coalesce((SELECT jsonb_agg(ik.id ORDER BY ik.id) FROM ik),'[]'::jsonb),'invoices',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM i),'[]'::jsonb),
   'invoice_lines',coalesce((SELECT jsonb_agg(to_jsonb(il) ORDER BY il.id) FROM il),'[]'::jsonb),'related_allocations',coalesce((SELECT jsonb_agg(to_jsonb(ia) ORDER BY ia.id) FROM ia),'[]'::jsonb),'headers',coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id) FROM h),'[]'::jsonb),
   'entries',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM e),'[]'::jsonb))
 INTO v_payment_count,v_alloc,v_invoices,v_invoice_rows,v_base_headers,v_headers,v_entries,v_lines,v_related_allocations,v_pointer_valid,v_data;
 IF v_alloc>4096 OR v_invoices>1024 OR v_base_headers>1024 OR v_headers>1024 OR v_entries>8192 OR v_lines>8192 OR v_related_allocations>8192 THEN RAISE EXCEPTION 'prototype bound exceeded' USING ERRCODE='54000'; END IF;
 IF v_payment_count<>1 OR NOT v_pointer_valid OR v_invoices<>v_invoice_rows THEN RAISE EXCEPTION 'prototype snapshot unavailable' USING ERRCODE='23514'; END IF;
 RETURN public.digest(convert_to(v_data::text,'UTF8'),'sha256');
END $$;
REVOKE ALL ON FUNCTION app.b019_proto_snapshot(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
-- Read-only recipient consistency; no delivery or authorization claim.
CREATE FUNCTION app.b019_proto_recipient_snapshot(p_org uuid,p_source uuid) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE n app.b017_occurrences;o app.b019_channel_outcomes;v_eligible boolean;v_data jsonb;v_recipient uuid;
BEGIN
 SELECT * INTO n FROM app.b017_occurrences WHERE org_id=p_org AND id=p_source;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.org_id=n.org_id AND p.id=n.payment_id AND p.lease_id=n.lease_id AND p.payer_contact_id IS NOT DISTINCT FROM n.payer_contact_id AND p.status::text=substring(n.kind FROM 9)) THEN RAISE EXCEPTION 'prototype recipient unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO o FROM app.b019_channel_outcomes WHERE org_id=n.org_id AND neutral_source_id=n.id AND channel='in_app';
 IF NOT FOUND THEN RAISE EXCEPTION 'prototype recipient unavailable' USING ERRCODE='23514'; END IF;
 IF n.payer_contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contacts c WHERE c.org_id=n.org_id AND c.id=n.payer_contact_id AND c.user_id IS NOT DISTINCT FROM n.payer_principal_user_id) THEN RAISE EXCEPTION 'prototype recipient unavailable' USING ERRCODE='23514'; END IF;
 SELECT EXISTS(SELECT 1 FROM public.contacts c JOIN public.lease_parties lp ON lp.org_id=c.org_id AND lp.contact_id=c.id WHERE c.org_id=n.org_id AND c.id=n.payer_contact_id AND c.user_id=n.payer_principal_user_id AND c.user_id IS NOT NULL AND c.is_tenant AND c.archived_at IS NULL AND lp.lease_id=n.lease_id AND lp.role IN ('primary','co_tenant')) INTO v_eligible;
 IF o.outcome='issued' THEN
  IF NOT v_eligible OR NOT EXISTS(SELECT 1 FROM app.b028_center_events e JOIN app.b028_center_recipients rec ON rec.org_id=e.org_id AND rec.event_id=e.id WHERE e.org_id=n.org_id AND e.id=o.center_event_id AND e.neutral_source_id=n.id AND e.kind=n.kind AND e.occurred_at=n.occurred_at AND rec.persona='tenant' AND rec.contact_id=n.payer_contact_id AND rec.principal_user_id=n.payer_principal_user_id)
   OR (SELECT count(*) FROM app.b028_center_recipients rec WHERE rec.org_id=n.org_id AND rec.event_id=o.center_event_id)<>1 THEN RAISE EXCEPTION 'prototype recipient unavailable' USING ERRCODE='23514'; END IF;
  SELECT rec.id INTO v_recipient FROM app.b028_center_recipients rec WHERE rec.org_id=n.org_id AND rec.event_id=o.center_event_id;
 ELSIF o.outcome='recipient_unavailable' THEN
  IF v_eligible OR o.center_event_id IS NOT NULL OR EXISTS(SELECT 1 FROM app.b028_center_events e WHERE e.org_id=n.org_id AND e.neutral_source_id=n.id) THEN RAISE EXCEPTION 'prototype recipient unavailable' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'prototype recipient unavailable' USING ERRCODE='23514'; END IF;
 v_data:=jsonb_build_object('source',n.id,'org',n.org_id,'lease',n.lease_id,'payment',n.payment_id,'kind',n.kind,'actor',n.actor_id,'occurred_epoch',extract(epoch FROM n.occurred_at),'payer',n.payer_contact_id,'principal',n.payer_principal_user_id,'outcome',o.outcome,'center',o.center_event_id,'recipient',v_recipient,'eligible',v_eligible);
 RETURN public.digest(convert_to(v_data::text,'UTF8'),'sha256');
END $$;
REVOKE ALL ON FUNCTION app.b019_proto_recipient_snapshot(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b019_proto_scope_snapshot(p_org uuid,p_lease uuid) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_data jsonb;
BEGIN
 SELECT jsonb_build_object('org',o.id,'environment',o.environment::text,'live_org',o.live_org_id,'lease',l.id,'status',l.status::text,'terminated',l.terminated_on,'lease_currency',l.currency,'property',p.id,'property_currency',p.currency,'property_archived_epoch',extract(epoch FROM p.archived_at)) INTO v_data
 FROM public.organizations o JOIN public.leases l ON l.org_id=o.id JOIN public.properties p ON p.org_id=l.org_id AND p.id=l.property_id
 JOIN public.platform_settings f ON f.key='notification_center_v2'
 WHERE o.id=p_org AND l.id=p_lease AND o.feature_flags->'notification_center_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
  AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text);
 IF NOT FOUND THEN RAISE EXCEPTION 'prototype scope unavailable' USING ERRCODE='42501'; END IF;
 RETURN public.digest(convert_to(v_data::text,'UTF8'),'sha256');
END $$;
REVOKE ALL ON FUNCTION app.b019_proto_scope_snapshot(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Research predicate only: supported manager-confirmation fixture, not a
-- universal historical/accounting proof or production policy.
CREATE FUNCTION app.b019_proto_confirmed_evidence(uuid,uuid,uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
SELECT EXISTS(SELECT 1 FROM payments p JOIN ledger_transactions t ON t.id=p.ledger_transaction_id AND t.org_id=p.org_id
 WHERE p.id=$1 AND p.org_id=$2 AND p.status='confirmed' AND p.confirmed_by=$3 AND p.confirmed_at IS NOT NULL AND p.amount_minor>0
 AND t.kind='payment' AND t.source_table='payments' AND t.source_id=p.id AND t.created_by=$3
 AND t.property_id=p.property_id AND t.lease_id=p.lease_id AND t.currency=p.currency
 AND (SELECT coalesce(sum(a.amount_minor),0) FROM payment_allocations a WHERE a.org_id=p.org_id AND a.payment_id=p.id)=p.amount_minor
 AND NOT EXISTS(SELECT 1 FROM payment_allocations a LEFT JOIN invoices i ON i.org_id=a.org_id AND i.id=a.invoice_id
   WHERE a.payment_id=p.id AND (a.org_id<>p.org_id OR a.amount_minor<=0 OR i.id IS NULL OR i.lease_id<>p.lease_id OR i.property_id<>p.property_id OR i.currency<>p.currency
    OR i.total_minor IS DISTINCT FROM (SELECT coalesce(sum(il.amount_minor),0) FROM invoice_lines il WHERE il.invoice_id=i.id)
    OR i.paid_minor IS DISTINCT FROM (SELECT coalesce(sum(pa.amount_minor),0) FROM payment_allocations pa JOIN payments pp ON pp.id=pa.payment_id WHERE pa.invoice_id=i.id AND pp.status='confirmed')
    OR i.status::text IS DISTINCT FROM CASE WHEN i.balance_minor<=0 AND i.total_minor>0 THEN 'paid' WHEN i.paid_minor>0 THEN 'partially_paid' ELSE 'open' END))
 AND NOT EXISTS(SELECT 1 FROM ledger_transactions rev WHERE rev.org_id=p.org_id AND rev.reverses_transaction_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=t.id AND
   (e.currency<>p.currency OR e.property_id IS DISTINCT FROM p.property_id OR e.lease_id IS DISTINCT FROM p.lease_id OR e.contact_id IS DISTINCT FROM p.payer_contact_id OR (e.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_allocations a WHERE a.org_id=p.org_id AND a.payment_id=p.id AND a.invoice_id=e.invoice_id)) OR e.account NOT IN ('cash_clearing','tenant_receivable')))
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=t.id AND e.account='cash_clearing')=p.amount_minor
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=t.id AND e.account='tenant_receivable')=-p.amount_minor
 ) AS valid
$$;
REVOKE ALL ON FUNCTION app.b019_proto_confirmed_evidence(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Bounded typed resource derivation; no client supplies resource identities.
CREATE FUNCTION app.b019_proto_derive_resources(p_org uuid,p_payment uuid,p_source uuid,p_actor uuid,p_session uuid,p_request uuid)
RETURNS TABLE(kind text,org_id uuid,id1 uuid,id2 uuid,text_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH p AS MATERIALIZED (SELECT * FROM public.payments WHERE org_id=p_org AND id=p_payment),
 n AS MATERIALIZED (SELECT * FROM app.b017_occurrences WHERE org_id=p_org AND id=p_source AND payment_id=p_payment),
 org AS MATERIALIZED (SELECT o.id,o.live_org_id FROM public.organizations o JOIN p ON p.org_id=o.id),
 bh AS MATERIALIZED (SELECT t.id FROM public.ledger_transactions t CROSS JOIN p WHERE t.org_id=p_org AND (t.id=p.ledger_transaction_id OR (t.source_table='payments' AND t.source_id=p_payment)) ORDER BY t.id LIMIT 1025),
 h AS MATERIALIZED (SELECT t.id,t.reverses_transaction_id FROM public.ledger_transactions t WHERE t.org_id=p_org AND (t.id IN (SELECT id FROM bh) OR t.reverses_transaction_id IN (SELECT id FROM bh)) ORDER BY t.id LIMIT 1025),
 e AS MATERIALIZED (SELECT e.id,e.transaction_id,e.invoice_id FROM public.ledger_entries e JOIN h ON h.id=e.transaction_id WHERE e.org_id=p_org ORDER BY e.id LIMIT 8193),
 ik AS MATERIALIZED (SELECT id FROM (SELECT invoice_id id FROM public.payment_allocations WHERE org_id=p_org AND payment_id=p_payment UNION SELECT invoice_id FROM e WHERE invoice_id IS NOT NULL) q ORDER BY id LIMIT 1025),
 ia AS MATERIALIZED (SELECT a.id,a.payment_id FROM public.payment_allocations a JOIN ik ON ik.id=a.invoice_id WHERE a.org_id=p_org ORDER BY a.id LIMIT 8193),
 il AS MATERIALIZED (SELECT l.id FROM public.invoice_lines l JOIN ik ON ik.id=l.invoice_id WHERE l.org_id=p_org ORDER BY l.id LIMIT 8193),
 recipient AS MATERIALIZED (SELECT rec.id FROM app.b019_channel_outcomes o JOIN app.b028_center_recipients rec ON rec.org_id=o.org_id AND rec.event_id=o.center_event_id WHERE o.org_id=p_org AND o.neutral_source_id=p_source)
 SELECT * FROM (
  SELECT 'payment'::text,p_org,p_payment,NULL::uuid,NULL::text FROM p
  UNION SELECT 'lease',p_org,p.lease_id,NULL,NULL FROM p
  UNION SELECT 'property',p_org,p.property_id,NULL,NULL FROM p
  UNION SELECT 'contact',p_org,p.payer_contact_id,NULL,NULL FROM p WHERE p.payer_contact_id IS NOT NULL
  UNION SELECT 'lease_party_scope',p_org,p.lease_id,p.payer_contact_id,NULL FROM p WHERE p.payer_contact_id IS NOT NULL
  UNION SELECT 'currency',NULL,NULL,NULL,p.currency::text FROM p
  UNION SELECT 'auth_user',NULL,p_actor,NULL,NULL
  UNION SELECT 'auth_user',NULL,n.payer_principal_user_id,NULL,NULL FROM n WHERE n.payer_principal_user_id IS NOT NULL
  UNION SELECT 'session',NULL,p_session,NULL,NULL
  UNION SELECT 'organization',p_org,p_org,NULL,NULL FROM org
  UNION SELECT 'organization',coalesce(org.live_org_id,org.id),coalesce(org.live_org_id,org.id),NULL,NULL FROM org
  UNION SELECT 'member',m.org_id,m.id,NULL,NULL FROM public.org_members m JOIN org ON m.org_id=coalesce(org.live_org_id,org.id) WHERE m.user_id=p_actor AND m.status='active'
  UNION SELECT 'org_control',p_org,NULL,NULL,'payment_results_v2'
  UNION SELECT 'org_control',p_org,NULL,NULL,'notification_center_v2'
  UNION SELECT 'command',p_org,p_actor,p_request,NULL WHERE p_request IS NOT NULL
  UNION SELECT 'source',p_org,p_source,NULL,NULL FROM n
  UNION SELECT 'center_event',p_org,o.center_event_id,NULL,NULL FROM app.b019_channel_outcomes o WHERE o.org_id=p_org AND o.neutral_source_id=p_source AND o.center_event_id IS NOT NULL
  UNION SELECT 'center_recipient',p_org,recipient.id,NULL,NULL FROM recipient
  UNION SELECT 'invoice',p_org,ik.id,NULL,NULL FROM ik
  UNION SELECT 'allocation',p_org,ia.id,NULL,NULL FROM ia
  UNION SELECT 'payment',p_org,ia.payment_id,NULL,NULL FROM ia
  UNION SELECT 'invoice_line',p_org,il.id,NULL,NULL FROM il
  UNION SELECT CASE WHEN h.reverses_transaction_id IS NULL THEN 'original_ledger' ELSE 'reversal_ledger' END,p_org,h.id,NULL,NULL FROM h
  UNION SELECT 'ledger_entry',p_org,e.transaction_id,NULL,e.id::text FROM e
  UNION SELECT 'original_ledger',p_org,pp.ledger_transaction_id,NULL,NULL FROM public.payments pp JOIN ia ON ia.payment_id=pp.id WHERE pp.org_id=p_org AND pp.ledger_transaction_id IS NOT NULL
 ) resources(kind,org_id,id1,id2,text_key)
 ORDER BY kind,org_id,id1,id2,text_key LIMIT 16385
$$;
REVOKE ALL ON FUNCTION app.b019_proto_derive_resources(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Owner-only synthetic prototype. It returns a diagnostic consistency result;
-- operation provenance is not trusted and this is not financial acceptance.
CREATE FUNCTION app.b019_proto_install(p_payment uuid,p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE op app.b019_proto_operation;r app.b019_payment_requirements;ctx app.b019_payment_contexts;
 n app.b017_occurrences;o app.b019_channel_outcomes;v_seal uuid;v_financial bytea;v_recipient bytea;v_scope bytea;v_old app.b019_proto_seals;v_resources integer;v_resource_set jsonb;
BEGIN
 SELECT * INTO op FROM app.b019_proto_operation WHERE tx_id=pg_current_xact_id() AND payment_id=p_payment AND actor_id=auth.uid();
 IF NOT FOUND OR op.mode<>'manager_record_confirmed' OR op.prior_status<>'absent' OR p_kind<>'payment_confirmed' THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM app.b019_payment_requirements WHERE tx_id=txid_current() AND org_id=op.org_id AND lease_id=op.lease_id AND payment_id=op.payment_id AND kind=p_kind AND actor_id=op.actor_id;
 IF NOT FOUND OR r.occurrence_id IS NULL THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO ctx FROM app.b019_payment_contexts WHERE tx_id=r.tx_id AND org_id=r.org_id AND lease_id=r.lease_id AND actor_id=r.actor_id AND session_id=op.session_id AND role=op.role AND center_on;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app.b019_payment_preparations prep WHERE prep.tx_id=r.tx_id AND prep.org_id=r.org_id AND prep.lease_id=r.lease_id AND prep.payment_id=r.payment_id AND prep.kind=r.kind AND prep.actor_id=r.actor_id AND prep.session_id=ctx.session_id) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO n FROM app.b017_occurrences WHERE id=r.occurrence_id AND org_id=r.org_id AND lease_id=r.lease_id AND payment_id=r.payment_id AND kind=r.kind AND actor_id=r.actor_id AND created_tx_id=r.tx_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM app.b019_channel_outcomes WHERE org_id=n.org_id AND neutral_source_id=n.id AND channel='in_app';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app.b010_payment_commands c WHERE c.org_id=op.org_id AND c.actor_id=op.actor_id AND c.request_id=op.request_id AND c.payload_digest=op.command_digest AND c.payment_id=op.payment_id) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organizations org JOIN public.organizations live ON live.id=op.live_org_id AND live.environment='live' AND live.live_org_id IS NULL
   JOIN public.org_members m ON m.org_id=CASE WHEN org.environment='sandbox' THEN org.live_org_id ELSE org.id END
   JOIN public.auth_sessions s ON s.id=op.session_id AND s.user_id=op.actor_id
   WHERE org.id=op.org_id AND org.environment::text=op.environment AND ((org.environment='live' AND org.id=op.live_org_id AND org.live_org_id IS NULL) OR (org.environment='sandbox' AND org.live_org_id=op.live_org_id))
    AND m.user_id=op.actor_id AND m.role::text=op.role AND m.status='active' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF NOT app.b019_proto_confirmed_evidence(op.payment_id,op.org_id,op.actor_id) THEN RAISE EXCEPTION 'prototype financial unavailable' USING ERRCODE='23514'; END IF;
 v_financial:=app.b019_proto_snapshot(op.org_id,op.payment_id);
 v_scope:=app.b019_proto_scope_snapshot(op.org_id,op.lease_id);
 v_recipient:=app.b019_proto_recipient_snapshot(n.org_id,n.id);
 SELECT count(*),coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.kind,q.org_id,q.id1,q.id2,q.text_key),'[]'::jsonb) INTO v_resources,v_resource_set FROM app.b019_proto_derive_resources(op.org_id,op.payment_id,n.id,op.actor_id,op.session_id,op.request_id) q;
 IF v_resources>16384 THEN RAISE EXCEPTION 'prototype bound exceeded' USING ERRCODE='54000'; END IF;
 SELECT * INTO v_old FROM app.b019_proto_seals WHERE tx_id=pg_current_xact_id();
 IF FOUND THEN
  IF ROW(v_old.org_id,v_old.live_org_id,v_old.environment,v_old.lease_id,v_old.payment_id,v_old.kind,v_old.actor_id,v_old.session_id,v_old.role,v_old.mode,v_old.prior_status,v_old.request_id,v_old.command_digest,v_old.prestate_digest,v_old.neutral_source_id,v_old.center_event_id,v_old.in_app_outcome,v_old.financial_digest,v_old.recipient_digest,v_old.scope_digest)
    IS DISTINCT FROM ROW(op.org_id,op.live_org_id,op.environment,op.lease_id,op.payment_id,p_kind,op.actor_id,op.session_id,op.role,op.mode,op.prior_status,op.request_id,op.command_digest,op.prestate_digest,n.id,o.center_event_id,o.outcome,v_financial,v_recipient,v_scope)
   OR EXISTS((SELECT kind,org_id,id1,id2,text_key FROM app.b019_proto_resources WHERE seal_id=v_old.id) EXCEPT (SELECT * FROM jsonb_to_recordset(v_resource_set) AS q(kind text,org_id uuid,id1 uuid,id2 uuid,text_key text)))
   OR EXISTS((SELECT * FROM jsonb_to_recordset(v_resource_set) AS q(kind text,org_id uuid,id1 uuid,id2 uuid,text_key text)) EXCEPT (SELECT kind,org_id,id1,id2,text_key FROM app.b019_proto_resources WHERE seal_id=v_old.id))
  THEN RAISE EXCEPTION 'prototype changed' USING ERRCODE='23514'; END IF;
  RETURN v_old.id;
 END IF;
 INSERT INTO app.b019_proto_seals(tx_id,org_id,live_org_id,environment,lease_id,payment_id,kind,actor_id,session_id,role,mode,prior_status,request_id,command_digest,prestate_digest,neutral_source_id,center_event_id,in_app_outcome,financial_digest,recipient_digest,scope_digest)
  VALUES(pg_current_xact_id(),op.org_id,op.live_org_id,op.environment,op.lease_id,op.payment_id,p_kind,op.actor_id,op.session_id,op.role,op.mode,op.prior_status,op.request_id,op.command_digest,op.prestate_digest,n.id,o.center_event_id,o.outcome,v_financial,v_recipient,v_scope) RETURNING id INTO v_seal;
 INSERT INTO app.b019_proto_install_permits(tx_id,seal_id) VALUES(pg_current_xact_id(),v_seal);
 INSERT INTO app.b019_proto_resources(seal_id,kind,org_id,id1,id2,text_key) SELECT v_seal,kind,org_id,id1,id2,text_key FROM jsonb_to_recordset(v_resource_set) AS q(kind text,org_id uuid,id1 uuid,id2 uuid,text_key text);
 DELETE FROM app.b019_proto_install_permits WHERE tx_id=pg_current_xact_id() AND seal_id=v_seal;
 RETURN v_seal;
END $$;
REVOKE ALL ON FUNCTION app.b019_proto_install(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_proto_validate(p_seal uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE x app.b019_proto_seals; n app.b017_occurrences;o app.b019_channel_outcomes;v_recipient bytea;v_resources integer;v_resource_set jsonb;
BEGIN
 SELECT * INTO x FROM app.b019_proto_seals WHERE id=p_seal AND tx_id=pg_current_xact_id() AND actor_id=auth.uid();
 IF NOT FOUND OR x.mode<>'manager_record_confirmed' OR x.kind<>'payment_confirmed' THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organizations org JOIN public.organizations live ON live.id=x.live_org_id AND live.environment='live' AND live.live_org_id IS NULL
   JOIN public.org_members m ON m.org_id=CASE WHEN org.environment='sandbox' THEN org.live_org_id ELSE org.id END
   JOIN public.auth_sessions s ON s.id=x.session_id AND s.user_id=x.actor_id
   WHERE org.id=x.org_id AND org.environment::text=x.environment AND ((org.environment='live' AND org.id=x.live_org_id AND org.live_org_id IS NULL) OR (org.environment='sandbox' AND org.live_org_id=x.live_org_id))
    AND m.user_id=x.actor_id AND m.role::text=x.role AND m.status='active' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO n FROM app.b017_occurrences WHERE id=x.neutral_source_id AND org_id=x.org_id AND lease_id=x.lease_id AND payment_id=x.payment_id AND kind=x.kind AND actor_id=x.actor_id AND created_tx_id=txid_current();
 IF NOT FOUND THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM app.b019_channel_outcomes WHERE org_id=x.org_id AND neutral_source_id=n.id AND channel='in_app' AND outcome=x.in_app_outcome AND center_event_id IS NOT DISTINCT FROM x.center_event_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app.b010_payment_commands c WHERE c.org_id=x.org_id AND c.actor_id=x.actor_id AND c.request_id=x.request_id AND c.payload_digest=x.command_digest AND c.payment_id=x.payment_id) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 v_recipient:=app.b019_proto_recipient_snapshot(n.org_id,n.id);
 SELECT count(*),coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.kind,q.org_id,q.id1,q.id2,q.text_key),'[]'::jsonb) INTO v_resources,v_resource_set FROM app.b019_proto_derive_resources(x.org_id,x.payment_id,n.id,x.actor_id,x.session_id,x.request_id) q;
 IF v_resources>16384 THEN RAISE EXCEPTION 'prototype bound exceeded' USING ERRCODE='54000'; END IF;
 IF NOT app.b019_proto_confirmed_evidence(x.payment_id,x.org_id,x.actor_id) OR v_recipient<>x.recipient_digest OR app.b019_proto_snapshot(x.org_id,x.payment_id)<>x.financial_digest OR app.b019_proto_scope_snapshot(x.org_id,x.lease_id)<>x.scope_digest
  OR EXISTS((SELECT kind,org_id,id1,id2,text_key FROM app.b019_proto_resources WHERE seal_id=x.id) EXCEPT (SELECT * FROM jsonb_to_recordset(v_resource_set) AS q(kind text,org_id uuid,id1 uuid,id2 uuid,text_key text)))
  OR EXISTS((SELECT * FROM jsonb_to_recordset(v_resource_set) AS q(kind text,org_id uuid,id1 uuid,id2 uuid,text_key text)) EXCEPT (SELECT kind,org_id,id1,id2,text_key FROM app.b019_proto_resources WHERE seal_id=x.id))
 THEN RAISE EXCEPTION 'prototype changed' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.organizations org JOIN public.organizations live ON live.id=x.live_org_id AND live.environment='live' AND live.live_org_id IS NULL
   JOIN public.org_members m ON m.org_id=CASE WHEN org.environment='sandbox' THEN org.live_org_id ELSE org.id END
   JOIN public.auth_sessions s ON s.id=x.session_id AND s.user_id=x.actor_id
   WHERE org.id=x.org_id AND org.environment::text=x.environment AND ((org.environment='live' AND org.id=x.live_org_id AND org.live_org_id IS NULL) OR (org.environment='sandbox' AND org.live_org_id=x.live_org_id))
    AND m.user_id=x.actor_id AND m.role::text=x.role AND m.status='active' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 -- Never equate this diagnostic with authorized financial success.
 RETURN 'synthetic_consistent';
END $$;
REVOKE ALL ON FUNCTION app.b019_proto_validate(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
