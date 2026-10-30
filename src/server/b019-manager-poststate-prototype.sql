-- Disposable-owner-only diagnostic. Synthetic operation arguments are NOT trusted provenance.
-- No production gateway or successful COMMIT is provided.
BEGIN;
CREATE TABLE app.b019_post_probe_op (xid xid8 PRIMARY KEY,org uuid NOT NULL,lease uuid NOT NULL,payment uuid NOT NULL,actor uuid NOT NULL,property uuid NOT NULL,currency text NOT NULL,payer uuid NOT NULL,ledger_date date NOT NULL,amount bigint NOT NULL CHECK(amount>0));
CREATE TABLE app.b019_post_probe_invoice (xid xid8 NOT NULL,invoice uuid NOT NULL,property uuid NOT NULL,currency text NOT NULL,prior_status text NOT NULL,total bigint NOT NULL,paid bigint NOT NULL,balance bigint NOT NULL,due date NOT NULL,created timestamptz NOT NULL,expected bigint NOT NULL,PRIMARY KEY(xid,invoice));
CREATE TABLE app.b019_post_probe_old_alloc (xid xid8 NOT NULL,id uuid NOT NULL,invoice uuid NOT NULL,payment uuid NOT NULL,amount bigint NOT NULL,payment_status text NOT NULL,PRIMARY KEY(xid,id));
CREATE TABLE app.b019_post_probe_line (xid xid8 NOT NULL,id uuid NOT NULL,invoice uuid NOT NULL,charge text NOT NULL,amount bigint NOT NULL,PRIMARY KEY(xid,id));
REVOKE ALL ON app.b019_post_probe_op,app.b019_post_probe_invoice,app.b019_post_probe_old_alloc,app.b019_post_probe_line FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_post_probe_never_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'poststate prototype cannot commit' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION app.b019_post_probe_never_commit() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b019_post_probe_never_commit AFTER INSERT ON app.b019_post_probe_op DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b019_post_probe_never_commit();
CREATE FUNCTION app.b019_post_probe_capture() RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE ids uuid[]; payment_ids uuid[]; n integer; total numeric; v_property uuid;v_currency text;v_payer uuid;op record;p_org uuid;p_lease uuid;p_payment uuid;p_actor uuid;p_amount bigint;v_email boolean;v_center boolean;
BEGIN
 SELECT * INTO op FROM app.b019_byte_probe_op WHERE xid=pg_current_xact_id();IF NOT FOUND OR auth.uid() IS DISTINCT FROM op.actor THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(op.org,op.live_org,op.env,op.session_id,op.lease,op.role) a;IF v_email OR NOT v_center OR NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=op.session_id AND user_id=op.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501';END IF;
 IF op.phase IN ('ready','stored') THEN IF NOT EXISTS(SELECT 1 FROM app.b019_post_probe_op q WHERE q.xid=op.xid AND ROW(q.org,q.lease,q.payment,q.actor,q.property,q.currency,q.payer,q.amount) IS NOT DISTINCT FROM ROW(op.org,op.lease,op.payment,op.actor,op.property,op.currency,op.payer,op.amount)) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501';END IF;SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(op.org,op.live_org,op.env,op.session_id,op.lease,op.role) a;IF v_email OR NOT v_center OR NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=op.session_id AND user_id=op.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501';END IF; RETURN 'same_proof';END IF;
 IF op.phase<>'begun' THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501'; END IF;
 p_org:=op.org;p_lease:=op.lease;p_payment:=op.payment;p_actor:=op.actor;p_amount:=op.amount;
 IF p_amount IS NULL OR p_amount<=0 OR EXISTS(SELECT 1 FROM public.payments WHERE id=p_payment) THEN RAISE EXCEPTION 'unsupported synthetic operation' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.leases WHERE org_id=p_org AND id=p_lease FOR SHARE NOWAIT; IF NOT FOUND THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='23514'; END IF;
 LOCK TABLE public.invoice_lines,public.invoices,public.lease_parties,public.ledger_entries,public.ledger_transactions,public.payment_allocations,public.payments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT l.property_id,l.currency,lp.contact_id INTO v_property,v_currency,v_payer FROM public.leases l JOIN public.lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' WHERE l.org_id=p_org AND l.id=p_lease;
 IF NOT FOUND OR ROW(v_property,v_currency,v_payer) IS DISTINCT FROM ROW(op.property,op.currency,op.payer) OR (SELECT count(*) FROM public.lease_parties WHERE org_id=p_org AND lease_id=p_lease AND role='primary')<>1 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='23514'; END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO ids FROM (SELECT id FROM public.invoices WHERE org_id=p_org AND lease_id=p_lease AND status IN ('open','partially_paid') ORDER BY id LIMIT 1025) q;
 IF cardinality(ids)=0 OR cardinality(ids)>1024 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='54000'; END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO payment_ids FROM (SELECT p.id FROM public.payments p WHERE p.org_id=p_org AND EXISTS(SELECT 1 FROM public.payment_allocations a WHERE a.org_id=p_org AND a.payment_id=p.id AND a.invoice_id=ANY(ids)) ORDER BY p.id LIMIT 8193 FOR UPDATE NOWAIT) q;
 IF cardinality(payment_ids)>8192 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='54000'; END IF;
 PERFORM 1 FROM public.invoices WHERE org_id=p_org AND id=ANY(ids) ORDER BY id FOR UPDATE NOWAIT;
 SELECT count(*) INTO n FROM (SELECT 1 FROM public.payment_allocations WHERE org_id=p_org AND invoice_id=ANY(ids) LIMIT 8193) q;
 IF n>8192 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='54000'; END IF;
 SELECT count(*) INTO n FROM (SELECT 1 FROM public.invoice_lines WHERE org_id=p_org AND invoice_id=ANY(ids) LIMIT 8193) q;
 IF n>8192 THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='54000'; END IF;
 IF EXISTS(SELECT 1 FROM public.invoices WHERE org_id=p_org AND id=ANY(ids) AND (property_id<>v_property OR currency<>v_currency)) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='23514'; END IF;
 INSERT INTO app.b019_byte_probe_permit VALUES(pg_current_xact_id(),'capture');
 INSERT INTO app.b019_post_probe_op VALUES(pg_current_xact_id(),p_org,p_lease,p_payment,p_actor,v_property,v_currency,v_payer,current_date,p_amount);
 INSERT INTO app.b019_post_probe_invoice(xid,invoice,property,currency,prior_status,total,paid,balance,due,created,expected)
 SELECT pg_current_xact_id(),q.id,q.property_id,q.currency,q.status::text,q.total_minor,q.paid_minor,q.balance_minor,q.due_date,q.created_at,
  greatest(0,least(q.balance_minor::numeric,p_amount::numeric-coalesce(sum(greatest(q.balance_minor,0)) OVER(ORDER BY q.due_date,q.created_at,q.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)))::bigint
 FROM public.invoices q WHERE q.org_id=p_org AND q.id=ANY(ids);
 SELECT coalesce(sum(expected),0) INTO total FROM app.b019_post_probe_invoice WHERE xid=pg_current_xact_id();
 IF total<>p_amount THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='23514'; END IF;
 INSERT INTO app.b019_post_probe_line SELECT pg_current_xact_id(),id,invoice_id,charge_type::text,amount_minor FROM public.invoice_lines WHERE org_id=p_org AND invoice_id=ANY(ids);
 INSERT INTO app.b019_post_probe_old_alloc SELECT pg_current_xact_id(),a.id,a.invoice_id,a.payment_id,a.amount_minor,p.status::text FROM public.payment_allocations a JOIN public.payments p ON p.org_id=a.org_id AND p.id=a.payment_id WHERE a.org_id=p_org AND a.invoice_id=ANY(ids);
 UPDATE app.b019_byte_probe_op SET phase='ready' WHERE xid=op.xid;DELETE FROM app.b019_byte_probe_permit WHERE xid=op.xid AND purpose='capture';
 SELECT a.email_on,a.center_on INTO v_email,v_center FROM app.b019_payment_admit(op.org,op.live_org,op.env,op.session_id,op.lease,op.role) a;IF v_email OR NOT v_center OR NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=op.session_id AND user_id=op.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'prototype unavailable' USING ERRCODE='42501';END IF;RETURN 'captured';
END $$;
REVOKE ALL ON FUNCTION app.b019_post_probe_capture() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_post_probe_compare() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.b019_post_probe_op o JOIN public.payments p ON p.org_id=o.org AND p.id=o.payment AND p.lease_id=o.lease AND p.status='confirmed' AND p.amount_minor=o.amount AND p.confirmed_by=o.actor AND p.submitted_by=o.actor AND p.confirmed_at IS NOT NULL AND p.property_id=o.property AND p.currency=o.currency AND p.payer_contact_id=o.payer AND p.method::text=CASE WHEN o.currency='USD' THEN 'zelle' ELSE 'bank_transfer' END AND p.source='manager_entry'
 WHERE o.xid=pg_current_xact_id()
 AND NOT EXISTS(SELECT 1 FROM public.invoices candidate WHERE candidate.org_id=o.org AND candidate.lease_id=o.lease AND candidate.status IN ('open','partially_paid') AND NOT EXISTS(SELECT 1 FROM app.b019_post_probe_invoice captured WHERE captured.xid=o.xid AND captured.invoice=candidate.id))
 AND NOT EXISTS ((SELECT i.invoice,i.expected FROM app.b019_post_probe_invoice i WHERE i.xid=o.xid AND i.expected>0) EXCEPT (SELECT a.invoice_id,a.amount_minor FROM public.payment_allocations a WHERE a.org_id=o.org AND a.payment_id=o.payment))
 AND NOT EXISTS ((SELECT a.invoice_id,a.amount_minor FROM public.payment_allocations a WHERE a.org_id=o.org AND a.payment_id=o.payment) EXCEPT (SELECT i.invoice,i.expected FROM app.b019_post_probe_invoice i WHERE i.xid=o.xid AND i.expected>0))
 AND NOT EXISTS(SELECT 1 FROM app.b019_post_probe_invoice x LEFT JOIN public.invoices i ON i.org_id=o.org AND i.id=x.invoice WHERE x.xid=o.xid AND (i.id IS NULL OR i.lease_id<>o.lease OR i.property_id<>x.property OR i.currency<>x.currency OR i.due_date<>x.due OR i.created_at<>x.created OR i.total_minor<>x.total OR i.paid_minor<>x.paid+x.expected OR i.balance_minor<>x.balance-x.expected OR i.status::text<>CASE WHEN x.expected=0 THEN x.prior_status WHEN x.balance-x.expected<=0 AND x.total>0 THEN 'paid' WHEN x.paid+x.expected>0 THEN 'partially_paid' ELSE 'open' END))
 AND NOT EXISTS ((SELECT x.id,x.invoice,x.charge,x.amount FROM app.b019_post_probe_line x WHERE x.xid=o.xid) EXCEPT (SELECT il.id,il.invoice_id,il.charge_type::text,il.amount_minor FROM public.invoice_lines il WHERE il.org_id=o.org AND il.invoice_id IN (SELECT invoice FROM app.b019_post_probe_invoice WHERE xid=o.xid)))
 AND NOT EXISTS ((SELECT il.id,il.invoice_id,il.charge_type::text,il.amount_minor FROM public.invoice_lines il WHERE il.org_id=o.org AND il.invoice_id IN (SELECT invoice FROM app.b019_post_probe_invoice WHERE xid=o.xid)) EXCEPT (SELECT x.id,x.invoice,x.charge,x.amount FROM app.b019_post_probe_line x WHERE x.xid=o.xid))
 AND NOT EXISTS ((SELECT x.id,x.invoice,x.payment,x.amount,x.payment_status FROM app.b019_post_probe_old_alloc x WHERE x.xid=o.xid) EXCEPT (SELECT a.id,a.invoice_id,a.payment_id,a.amount_minor,p2.status::text FROM public.payment_allocations a JOIN public.payments p2 ON p2.org_id=a.org_id AND p2.id=a.payment_id WHERE a.org_id=o.org AND a.invoice_id IN (SELECT invoice FROM app.b019_post_probe_invoice WHERE xid=o.xid) AND a.payment_id<>o.payment))
 AND NOT EXISTS ((SELECT a.id,a.invoice_id,a.payment_id,a.amount_minor,p2.status::text FROM public.payment_allocations a JOIN public.payments p2 ON p2.org_id=a.org_id AND p2.id=a.payment_id WHERE a.org_id=o.org AND a.invoice_id IN (SELECT invoice FROM app.b019_post_probe_invoice WHERE xid=o.xid) AND a.payment_id<>o.payment) EXCEPT (SELECT x.id,x.invoice,x.payment,x.amount,x.payment_status FROM app.b019_post_probe_old_alloc x WHERE x.xid=o.xid))
 );
$$;
REVOKE ALL ON FUNCTION app.b019_post_probe_compare() FROM PUBLIC,anon,authenticated,service_role;
-- Separate helper-specific ledger diagnostic; not a historical ledger rule.
CREATE FUNCTION app.b019_post_probe_ledger_compare() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.b019_post_probe_op o JOIN public.payments p ON p.org_id=o.org AND p.id=o.payment JOIN public.ledger_transactions t ON t.org_id=p.org_id AND t.id=p.ledger_transaction_id
 WHERE o.xid=pg_current_xact_id() AND t.kind='payment' AND t.reverses_transaction_id IS NULL AND t.effective_date=o.ledger_date AND t.source_table='payments' AND t.source_id=p.id AND t.property_id=o.property AND t.lease_id=o.lease AND t.currency=o.currency AND t.created_by=o.actor
 AND (SELECT count(*) FROM public.ledger_transactions tx WHERE tx.org_id=o.org AND tx.source_table='payments' AND tx.source_id=o.payment)=1
 AND NOT EXISTS(SELECT 1 FROM public.ledger_transactions rev WHERE rev.org_id=o.org AND rev.reverses_transaction_id=t.id)
 AND (SELECT count(*) FROM public.ledger_entries e WHERE e.org_id=o.org AND e.transaction_id=t.id)=2
 AND NOT EXISTS(SELECT 1 FROM public.ledger_entries e WHERE e.org_id=o.org AND e.transaction_id=t.id AND (e.currency<>o.currency OR e.contact_id IS DISTINCT FROM o.payer OR e.property_id IS DISTINCT FROM o.property OR e.lease_id IS DISTINCT FROM o.lease OR e.invoice_id IS NOT NULL OR e.account NOT IN ('cash_clearing','tenant_receivable')))
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM public.ledger_entries e WHERE e.org_id=o.org AND e.transaction_id=t.id AND e.account='cash_clearing')=o.amount
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM public.ledger_entries e WHERE e.org_id=o.org AND e.transaction_id=t.id AND e.account='tenant_receivable')=-o.amount
 );
$$;
REVOKE ALL ON FUNCTION app.b019_post_probe_ledger_compare() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
