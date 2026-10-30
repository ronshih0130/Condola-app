-- Owner-only clone research. No complete seal, trusted wrapper, or successful COMMIT.
BEGIN;
CREATE TABLE app.b019_retained_join_seal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), xid xid8 NOT NULL UNIQUE,
 org uuid NOT NULL,live_org uuid NOT NULL,env text NOT NULL CHECK(env IN ('live','sandbox')),
 lease uuid NOT NULL,property uuid NOT NULL,currency text NOT NULL,payment uuid NOT NULL,
 actor uuid NOT NULL,session_id uuid NOT NULL,role text NOT NULL CHECK(role IN ('admin','manager','accountant')),
 mode text NOT NULL DEFAULT 'manager_record_confirmed' CHECK(mode='manager_record_confirmed'),prior_status text NOT NULL DEFAULT 'absent' CHECK(prior_status='absent'),source_kind text NOT NULL DEFAULT 'payment_confirmed' CHECK(source_kind='payment_confirmed'),source_key text NOT NULL DEFAULT 'payment_confirmed' CHECK(source_key='payment_confirmed'),source_birth xid8 NOT NULL,
 request uuid NOT NULL,digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 amount bigint NOT NULL CHECK(amount>0),paid_on date NOT NULL,method text NOT NULL CHECK(method IN ('zelle','bank_transfer')),last5_digest text NOT NULL CHECK(last5_digest ~ '^[0-9a-f]{64}$'),reference_digest text NOT NULL CHECK(reference_digest ~ '^[0-9a-f]{64}$'),raw_lease_digest text NOT NULL CHECK(raw_lease_digest ~ '^[0-9a-f]{64}$'),
 payer uuid NOT NULL,principal uuid,is_tenant boolean NOT NULL,archived boolean NOT NULL,eligible boolean NOT NULL,party uuid,party_role text,
 timezone text NOT NULL,observed_at timestamptz NOT NULL,local_date date NOT NULL,
 source uuid NOT NULL,outcome text NOT NULL CHECK(outcome IN ('issued','recipient_unavailable')),event uuid,recipient uuid,
 ledger_date date NOT NULL,
 CHECK ((party IS NULL)=(party_role IS NULL)), CHECK (NOT eligible OR (principal IS NOT NULL AND party IS NOT NULL AND party_role IN ('primary','co_tenant'))),
 CHECK ((outcome='issued' AND eligible AND principal IS NOT NULL AND event IS NOT NULL AND recipient IS NOT NULL) OR (outcome='recipient_unavailable' AND NOT eligible AND event IS NULL AND recipient IS NULL))
);
CREATE TABLE app.b019_retained_join_invoice (
 seal_id uuid NOT NULL REFERENCES app.b019_retained_join_seal(id) ON DELETE RESTRICT,
 invoice uuid NOT NULL,property uuid NOT NULL,currency text NOT NULL,prior_status text NOT NULL,total bigint NOT NULL,paid bigint NOT NULL,balance bigint NOT NULL,due date NOT NULL,created timestamptz NOT NULL,expected bigint NOT NULL,PRIMARY KEY(seal_id,invoice)
);
CREATE TABLE app.b019_retained_join_old_alloc (
 seal_id uuid NOT NULL REFERENCES app.b019_retained_join_seal(id) ON DELETE RESTRICT,
 id uuid NOT NULL,invoice uuid NOT NULL,payment uuid NOT NULL,amount bigint NOT NULL,payment_status text NOT NULL,PRIMARY KEY(seal_id,id)
);
CREATE TABLE app.b019_retained_join_line (
 seal_id uuid NOT NULL REFERENCES app.b019_retained_join_seal(id) ON DELETE RESTRICT,
 id uuid NOT NULL,invoice uuid NOT NULL,charge text NOT NULL,amount bigint NOT NULL,PRIMARY KEY(seal_id,id)
);
CREATE TABLE app.b019_retained_join_resource (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),seal_id uuid NOT NULL REFERENCES app.b019_retained_join_seal(id) ON DELETE RESTRICT,
 kind text NOT NULL,org uuid,id1 uuid,id2 uuid,text_key text,
 UNIQUE NULLS NOT DISTINCT(seal_id,kind,org,id1,id2,text_key),
 CHECK (((kind IN ('payment','invoice','lease','property','contact','organization','source','event','recipient','allocation','invoice_line','related_payment','ledger_header') AND org IS NOT NULL AND id1 IS NOT NULL AND id2 IS NULL AND text_key IS NULL)
  OR (kind IN ('auth_user','session') AND org IS NULL AND id1 IS NOT NULL AND id2 IS NULL AND text_key IS NULL)
  OR (kind IN ('lease_party_scope','invoice_candidate_scope','command_payment','member') AND org IS NOT NULL AND id1 IS NOT NULL AND id2 IS NULL AND text_key IS NULL)
  OR (kind='command' AND org IS NOT NULL AND id1 IS NOT NULL AND id2 IS NOT NULL AND text_key IS NULL)
  OR (kind='ledger_entry' AND org IS NOT NULL AND id1 IS NOT NULL AND id2 IS NULL AND text_key ~ '^[0-9]+$')
  OR (kind='control' AND org IS NOT NULL AND id1 IS NULL AND id2 IS NULL AND text_key IN ('payment_results_v2','notification_center_v2'))
  OR (kind='currency' AND org IS NULL AND id1 IS NULL AND id2 IS NULL AND text_key ~ '^[A-Z]{3}$')) IS TRUE)
);
CREATE TABLE app.b019_retained_join_permit (xid xid8 PRIMARY KEY,purpose text NOT NULL CHECK(purpose='install'));
REVOKE ALL ON app.b019_retained_join_seal,app.b019_retained_join_invoice,app.b019_retained_join_old_alloc,app.b019_retained_join_line,app.b019_retained_join_resource,app.b019_retained_join_permit FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b019_retained_join_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 LOCK TABLE app.b019_retained_join_permit IN ACCESS SHARE MODE NOWAIT;
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM app.b019_retained_join_permit p WHERE p.xid=pg_current_xact_id() AND p.purpose='install') THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'retained diagnostic sealed' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION app.b019_retained_join_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b019_retained_join_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_retained_join_seal FOR EACH ROW EXECUTE FUNCTION app.b019_retained_join_guard();
CREATE TRIGGER b019_retained_join_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_retained_join_invoice FOR EACH ROW EXECUTE FUNCTION app.b019_retained_join_guard();
CREATE TRIGGER b019_retained_join_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_retained_join_old_alloc FOR EACH ROW EXECUTE FUNCTION app.b019_retained_join_guard();
CREATE TRIGGER b019_retained_join_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_retained_join_line FOR EACH ROW EXECUTE FUNCTION app.b019_retained_join_guard();
CREATE TRIGGER b019_retained_join_guard BEFORE INSERT OR UPDATE OR DELETE ON app.b019_retained_join_resource FOR EACH ROW EXECUTE FUNCTION app.b019_retained_join_guard();
CREATE FUNCTION app.b019_retained_join_auth(p_org uuid,p_live uuid,p_env text,p_actor uuid,p_session uuid,p_role text,p_timezone text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT auth.uid()=p_actor AND EXISTS(SELECT 1 FROM auth.users u JOIN public.auth_sessions s ON s.user_id=u.id JOIN public.org_members m ON m.user_id=u.id JOIN public.organizations org ON org.id=p_org JOIN public.organizations live ON live.id=p_live JOIN public.platform_settings f ON f.key='notification_center_v2'
 WHERE u.id=p_actor AND s.id=p_session AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND m.org_id=p_live AND m.status='active' AND m.role::text=p_role AND m.role IN ('admin','manager','accountant') AND live.environment='live' AND live.live_org_id IS NULL AND org.environment::text=p_env AND ((p_env='live' AND org.id=live.id AND org.live_org_id IS NULL) OR (p_env='sandbox' AND org.live_org_id=live.id)) AND org.timezone=p_timezone AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=org.timezone) AND org.feature_flags->'notification_center_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(org.id::text) AND NOT EXISTS(SELECT 1 FROM public.platform_settings ef WHERE ef.key='payment_results_v2' AND ef.value->'enabled'='true'::jsonb AND jsonb_typeof(ef.value->'allowed_org_ids')='array' AND ef.value->'allowed_org_ids' @> jsonb_build_array(org.id::text) AND org.feature_flags->'payment_results_v2'='true'::jsonb))
$$;
REVOKE ALL ON FUNCTION app.b019_retained_join_auth(uuid,uuid,text,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
-- Fixed no-argument owner-only copy of the existing immutable *pre-mutation* facts.
CREATE FUNCTION app.b019_retained_join_install() RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET TimeZone='UTC' AS $$
DECLARE o record;s record;t record;prep record;r record;post record;old record;v_id uuid;v_n integer;v_invoices jsonb;v_lines jsonb;v_alloc jsonb;v_resource jsonb;v_method text;
BEGIN
 LOCK TABLE app.b019_retained_join_seal,app.b019_retained_join_invoice,app.b019_retained_join_line,app.b019_retained_join_old_alloc,app.b019_retained_join_resource,app.b019_retained_join_permit IN ROW EXCLUSIVE MODE NOWAIT;
 LOCK TABLE app.b019_byte_probe_op,app.b019_principal_probe_snapshot,app.b019_principal_probe_transition,app.b019_issuer_probe_preparation,app.b019_issuer_probe_result,app.b019_post_probe_op,app.b019_post_probe_invoice,app.b019_post_probe_line,app.b019_post_probe_old_alloc,app.b019_payment_requirements,app.b010_payment_commands,app.b017_occurrences,app.b028_center_events,app.b028_center_recipients,app.b019_channel_outcomes,public.payments,public.invoices,public.invoice_lines,public.payment_allocations,public.ledger_transactions,public.ledger_entries,public.organizations,public.org_members,public.auth_sessions,public.platform_settings,public.leases,public.properties,public.contacts,public.lease_parties,auth.users IN ACCESS SHARE MODE NOWAIT;
 SELECT * INTO o FROM app.b019_byte_probe_op WHERE xid=pg_current_xact_id();IF NOT FOUND OR o.actor IS DISTINCT FROM auth.uid() OR o.phase<>'stored' THEN RAISE EXCEPTION 'retained unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM app.b019_principal_probe_snapshot WHERE xid=o.xid;SELECT * INTO t FROM app.b019_principal_probe_transition WHERE xid=o.xid;SELECT * INTO prep FROM app.b019_issuer_probe_preparation WHERE xid=o.xid;SELECT * INTO r FROM app.b019_issuer_probe_result WHERE xid=o.xid;SELECT * INTO post FROM app.b019_post_probe_op WHERE xid=o.xid;
 IF s.xid IS NULL OR t.xid IS NULL OR prep.xid IS NULL OR r.xid IS NULL OR post.xid IS NULL OR app.b019_retained_join_auth(o.org,o.live_org,o.env,o.actor,o.session_id,o.role,prep.timezone) IS NOT TRUE OR app.b019_issuer_command_probe_join() IS DISTINCT FROM 'diagnostic_consistent' THEN RAISE EXCEPTION 'retained unavailable' USING ERRCODE='42501';END IF;
 SELECT count(*),coalesce(jsonb_agg(to_jsonb(q)-'xid' ORDER BY q.invoice),'[]'::jsonb) INTO v_n,v_invoices FROM (SELECT * FROM app.b019_post_probe_invoice WHERE xid=o.xid ORDER BY invoice LIMIT 1025) q;IF v_n=0 OR v_n>1024 THEN RAISE EXCEPTION 'retained bound exceeded' USING ERRCODE='54000';END IF;
 SELECT count(*),coalesce(jsonb_agg(to_jsonb(q)-'xid' ORDER BY q.id),'[]'::jsonb) INTO v_n,v_lines FROM (SELECT * FROM app.b019_post_probe_line WHERE xid=o.xid ORDER BY id LIMIT 8193) q;IF v_n>8192 THEN RAISE EXCEPTION 'retained bound exceeded' USING ERRCODE='54000';END IF;
 SELECT count(*),coalesce(jsonb_agg(to_jsonb(q)-'xid' ORDER BY q.id),'[]'::jsonb) INTO v_n,v_alloc FROM (SELECT * FROM app.b019_post_probe_old_alloc WHERE xid=o.xid ORDER BY id LIMIT 4097) q;IF v_n>4096 THEN RAISE EXCEPTION 'retained bound exceeded' USING ERRCODE='54000';END IF;
 v_method:=CASE WHEN o.currency='USD' THEN 'zelle' ELSE 'bank_transfer' END;
 -- Exact fixed resource list plus identities copied from the saved prestate; this
 -- first research slice is not a complete guard inventory.
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.kind,q.org,q.id1,q.id2,q.text_key),'[]'::jsonb) INTO v_resource FROM (
  SELECT DISTINCT kind,org,id1,id2,text_key FROM (
   VALUES ('organization',o.org,o.org,NULL::uuid,NULL::text),('organization',o.live_org,o.live_org,NULL::uuid,NULL::text),('lease',o.org,o.lease,NULL::uuid,NULL::text),('property',o.org,o.property,NULL::uuid,NULL::text),('payment',o.org,o.payment,NULL::uuid,NULL::text),('contact',o.org,o.payer,NULL::uuid,NULL::text),('auth_user',NULL::uuid,o.actor,NULL::uuid,NULL::text),('auth_user',NULL::uuid,s.principal,NULL::uuid,NULL::text),('session',NULL::uuid,o.session_id,NULL::uuid,NULL::text),('member',o.live_org,o.actor,NULL::uuid,NULL::text),('command',o.org,o.actor,o.request,NULL::text),('command_payment',o.org,o.payment,NULL::uuid,NULL::text),('lease_party_scope',o.org,o.lease,NULL::uuid,NULL::text),('invoice_candidate_scope',o.org,o.lease,NULL::uuid,NULL::text),('source',o.org,r.source,NULL::uuid,NULL::text),('event',o.org,r.event,NULL::uuid,NULL::text),('recipient',o.org,r.recipient,NULL::uuid,NULL::text),('control',o.org,NULL::uuid,NULL::uuid,'payment_results_v2'),('control',o.org,NULL::uuid,NULL::uuid,'notification_center_v2'),('currency',NULL::uuid,NULL::uuid,NULL::uuid,o.currency)
   UNION ALL SELECT 'invoice',o.org,x.invoice,NULL::uuid,NULL::text FROM jsonb_to_recordset(v_invoices) AS x(invoice uuid)
   UNION ALL SELECT 'invoice_line',o.org,x.id,NULL::uuid,NULL::text FROM jsonb_to_recordset(v_lines) AS x(id uuid)
   UNION ALL SELECT 'allocation',o.org,x.id,NULL::uuid,NULL::text FROM jsonb_to_recordset(v_alloc) AS x(id uuid)
   UNION ALL SELECT 'related_payment',o.org,x.payment,NULL::uuid,NULL::text FROM jsonb_to_recordset(v_alloc) AS x(payment uuid)
   UNION ALL SELECT 'ledger_header',o.org,p.ledger_transaction_id,NULL::uuid,NULL::text FROM public.payments p WHERE p.org_id=o.org AND p.id=o.payment
   UNION ALL SELECT 'ledger_entry',o.org,e.transaction_id,NULL::uuid,e.id::text FROM public.ledger_entries e JOIN public.payments p ON p.org_id=e.org_id AND p.ledger_transaction_id=e.transaction_id WHERE p.org_id=o.org AND p.id=o.payment
  ) z(kind,org,id1,id2,text_key) WHERE NOT (kind IN ('auth_user','event','recipient') AND id1 IS NULL)
  ORDER BY kind,org,id1,id2,text_key LIMIT 16385
 ) q;
 IF jsonb_array_length(v_resource)>16384 THEN RAISE EXCEPTION 'retained bound exceeded' USING ERRCODE='54000';END IF;
 SELECT * INTO old FROM app.b019_retained_join_seal WHERE xid=o.xid;
 IF FOUND THEN
  IF ROW(old.org,old.live_org,old.env,old.lease,old.property,old.currency,old.payment,old.actor,old.session_id,old.role,old.request,old.digest,old.amount,old.paid_on,old.method,old.last5_digest,old.reference_digest,old.raw_lease_digest,old.payer,old.principal,old.is_tenant,old.archived,old.eligible,old.party,old.party_role,old.timezone,old.observed_at,old.local_date,old.source,old.outcome,old.event,old.recipient,old.ledger_date) IS DISTINCT FROM ROW(o.org,o.live_org,o.env,o.lease,o.property,o.currency,o.payment,o.actor,o.session_id,o.role,o.request,o.digest,o.amount,o.paid_on,v_method,o.last5_digest,o.reference_digest,o.raw_lease_digest,o.payer,s.principal,s.is_tenant,s.archived,s.eligible,s.party,s.party_role,prep.timezone,t.observed_at,r.local_date,r.source,r.outcome,r.event,r.recipient,post.ledger_date)
  OR old.source_birth IS DISTINCT FROM o.xid OR old.mode<>'manager_record_confirmed' OR old.prior_status<>'absent' OR old.source_kind<>'payment_confirmed' OR old.source_key<>'payment_confirmed'
  OR v_invoices IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x)-'seal_id' ORDER BY x.invoice),'[]'::jsonb) FROM (SELECT * FROM app.b019_retained_join_invoice WHERE seal_id=old.id ORDER BY invoice LIMIT 1025) x)
  OR v_lines IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x)-'seal_id' ORDER BY x.id),'[]'::jsonb) FROM (SELECT * FROM app.b019_retained_join_line WHERE seal_id=old.id ORDER BY id LIMIT 8193) x)
  OR v_alloc IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x)-'seal_id' ORDER BY x.id),'[]'::jsonb) FROM (SELECT * FROM app.b019_retained_join_old_alloc WHERE seal_id=old.id ORDER BY id LIMIT 4097) x)
  OR v_resource IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x)-'id'-'seal_id' ORDER BY x.kind,x.org,x.id1,x.id2,x.text_key),'[]'::jsonb) FROM (SELECT * FROM app.b019_retained_join_resource WHERE seal_id=old.id ORDER BY kind,org,id1,id2,text_key LIMIT 16385) x)
  OR app.b019_retained_join_auth(o.org,o.live_org,o.env,o.actor,o.session_id,o.role,prep.timezone) IS NOT TRUE THEN RAISE EXCEPTION 'retained mismatch' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=o.session_id AND user_id=o.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'retained unavailable' USING ERRCODE='42501';END IF;
  RETURN 'synthetic_same';
 END IF;
 INSERT INTO app.b019_retained_join_permit VALUES(o.xid,'install');
 INSERT INTO app.b019_retained_join_seal(xid,org,live_org,env,lease,property,currency,payment,actor,session_id,role,source_birth,request,digest,amount,paid_on,method,last5_digest,reference_digest,raw_lease_digest,payer,principal,is_tenant,archived,eligible,party,party_role,timezone,observed_at,local_date,source,outcome,event,recipient,ledger_date) VALUES(o.xid,o.org,o.live_org,o.env,o.lease,o.property,o.currency,o.payment,o.actor,o.session_id,o.role,o.xid,o.request,o.digest,o.amount,o.paid_on,v_method,o.last5_digest,o.reference_digest,o.raw_lease_digest,o.payer,s.principal,s.is_tenant,s.archived,s.eligible,s.party,s.party_role,prep.timezone,t.observed_at,r.local_date,r.source,r.outcome,r.event,r.recipient,post.ledger_date) RETURNING id INTO v_id;
 INSERT INTO app.b019_retained_join_invoice SELECT v_id,x.* FROM jsonb_to_recordset(v_invoices) AS x(invoice uuid,property uuid,currency text,prior_status text,total bigint,paid bigint,balance bigint,due date,created timestamptz,expected bigint);
 INSERT INTO app.b019_retained_join_line SELECT v_id,x.* FROM jsonb_to_recordset(v_lines) AS x(id uuid,invoice uuid,charge text,amount bigint);
 INSERT INTO app.b019_retained_join_old_alloc SELECT v_id,x.* FROM jsonb_to_recordset(v_alloc) AS x(id uuid,invoice uuid,payment uuid,amount bigint,payment_status text);
 INSERT INTO app.b019_retained_join_resource(seal_id,kind,org,id1,id2,text_key) SELECT v_id,x.* FROM jsonb_to_recordset(v_resource) AS x(kind text,org uuid,id1 uuid,id2 uuid,text_key text);
 DELETE FROM app.b019_retained_join_permit WHERE xid=o.xid AND purpose='install';
 IF v_invoices IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x)-'seal_id' ORDER BY x.invoice),'[]'::jsonb) FROM (SELECT * FROM app.b019_retained_join_invoice WHERE seal_id=v_id ORDER BY invoice LIMIT 1025) x)
  OR v_lines IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x)-'seal_id' ORDER BY x.id),'[]'::jsonb) FROM (SELECT * FROM app.b019_retained_join_line WHERE seal_id=v_id ORDER BY id LIMIT 8193) x)
  OR v_alloc IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x)-'seal_id' ORDER BY x.id),'[]'::jsonb) FROM (SELECT * FROM app.b019_retained_join_old_alloc WHERE seal_id=v_id ORDER BY id LIMIT 4097) x)
  OR v_resource IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(x)-'id'-'seal_id' ORDER BY x.kind,x.org,x.id1,x.id2,x.text_key),'[]'::jsonb) FROM (SELECT * FROM app.b019_retained_join_resource WHERE seal_id=v_id ORDER BY kind,org,id1,id2,text_key LIMIT 16385) x)
  OR app.b019_retained_join_check() IS DISTINCT FROM 'synthetic_consistent' THEN RAISE EXCEPTION 'retained copy incomplete' USING ERRCODE='23514';END IF;
 IF app.b019_retained_join_auth(o.org,o.live_org,o.env,o.actor,o.session_id,o.role,prep.timezone) IS NOT TRUE THEN RAISE EXCEPTION 'retained unavailable' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=o.session_id AND user_id=o.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'retained unavailable' USING ERRCODE='42501';END IF;
 RETURN 'synthetic_installed';
END $$;
REVOKE ALL ON FUNCTION app.b019_retained_join_install() FROM PUBLIC,anon,authenticated,service_role;
-- Internal owner-only derivation from retained identities; no caller controls authority.
CREATE FUNCTION app.b019_retained_join_resource_set(p_seal uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET TimeZone='UTC' AS $$
DECLARE x record;v jsonb;
BEGIN
 LOCK TABLE app.b019_retained_join_seal,app.b019_retained_join_invoice,app.b019_retained_join_line,app.b019_retained_join_old_alloc,public.payments,public.ledger_entries IN ACCESS SHARE MODE NOWAIT;
 SELECT * INTO x FROM app.b019_retained_join_seal WHERE id=p_seal AND xid=pg_current_xact_id();IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.kind,q.org,q.id1,q.id2,q.text_key),'[]'::jsonb) INTO v FROM (
  SELECT DISTINCT kind,org,id1,id2,text_key FROM (
   VALUES ('organization',x.org,x.org,NULL::uuid,NULL::text),('organization',x.live_org,x.live_org,NULL::uuid,NULL::text),('lease',x.org,x.lease,NULL::uuid,NULL::text),('property',x.org,x.property,NULL::uuid,NULL::text),('payment',x.org,x.payment,NULL::uuid,NULL::text),('contact',x.org,x.payer,NULL::uuid,NULL::text),('auth_user',NULL::uuid,x.actor,NULL::uuid,NULL::text),('auth_user',NULL::uuid,x.principal,NULL::uuid,NULL::text),('session',NULL::uuid,x.session_id,NULL::uuid,NULL::text),('member',x.live_org,x.actor,NULL::uuid,NULL::text),('command',x.org,x.actor,x.request,NULL::text),('command_payment',x.org,x.payment,NULL::uuid,NULL::text),('lease_party_scope',x.org,x.lease,NULL::uuid,NULL::text),('invoice_candidate_scope',x.org,x.lease,NULL::uuid,NULL::text),('source',x.org,x.source,NULL::uuid,NULL::text),('event',x.org,x.event,NULL::uuid,NULL::text),('recipient',x.org,x.recipient,NULL::uuid,NULL::text),('control',x.org,NULL::uuid,NULL::uuid,'payment_results_v2'),('control',x.org,NULL::uuid,NULL::uuid,'notification_center_v2'),('currency',NULL::uuid,NULL::uuid,NULL::uuid,x.currency)
   UNION ALL SELECT 'invoice',x.org,i.invoice,NULL::uuid,NULL::text FROM app.b019_retained_join_invoice i WHERE i.seal_id=x.id
   UNION ALL SELECT 'invoice_line',x.org,i.id,NULL::uuid,NULL::text FROM app.b019_retained_join_line i WHERE i.seal_id=x.id
   UNION ALL SELECT 'allocation',x.org,a.id,NULL::uuid,NULL::text FROM app.b019_retained_join_old_alloc a WHERE a.seal_id=x.id
   UNION ALL SELECT 'related_payment',x.org,a.payment,NULL::uuid,NULL::text FROM app.b019_retained_join_old_alloc a WHERE a.seal_id=x.id
   UNION ALL SELECT 'ledger_header',x.org,p.ledger_transaction_id,NULL::uuid,NULL::text FROM public.payments p WHERE p.org_id=x.org AND p.id=x.payment
   UNION ALL SELECT 'ledger_entry',x.org,e.transaction_id,NULL::uuid,e.id::text FROM public.ledger_entries e JOIN public.payments p ON p.org_id=e.org_id AND p.ledger_transaction_id=e.transaction_id WHERE p.org_id=x.org AND p.id=x.payment
  ) z(kind,org,id1,id2,text_key) WHERE NOT (kind IN ('auth_user','event','recipient') AND id1 IS NULL)
  ORDER BY kind,org,id1,id2,text_key LIMIT 16385
 ) q;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION app.b019_retained_join_resource_set(uuid) FROM PUBLIC,anon,authenticated,service_role;
-- Read-only research check intentionally does not read transient 19 or source
-- prestate tables; it is not the future complete/authorized finalizer.
CREATE FUNCTION app.b019_retained_join_check() RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET TimeZone='UTC' AS $$
DECLARE x record;v_ok boolean;v_expected jsonb;v_actual jsonb;
BEGIN
 LOCK TABLE app.b019_retained_join_seal,app.b019_retained_join_invoice,app.b019_retained_join_line,app.b019_retained_join_old_alloc,app.b019_retained_join_resource,app.b010_payment_commands,app.b017_occurrences,app.b028_center_events,app.b028_center_recipients,app.b019_channel_outcomes,public.payments,public.invoices,public.invoice_lines,public.payment_allocations,public.ledger_transactions,public.ledger_entries,public.organizations,public.org_members,public.auth_sessions,public.platform_settings,public.leases,public.properties,public.contacts,public.lease_parties,auth.users IN ACCESS SHARE MODE NOWAIT;
 SELECT * INTO x FROM app.b019_retained_join_seal WHERE xid=pg_current_xact_id();IF NOT FOUND OR x.actor IS DISTINCT FROM auth.uid() THEN RETURN 'incomplete';END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM app.b019_retained_join_invoice WHERE seal_id=x.id LIMIT 1025) q)>1024 OR (SELECT count(*) FROM (SELECT 1 FROM app.b019_retained_join_line WHERE seal_id=x.id LIMIT 8193) q)>8192 OR (SELECT count(*) FROM (SELECT 1 FROM app.b019_retained_join_old_alloc WHERE seal_id=x.id LIMIT 4097) q)>4096 THEN RETURN 'incomplete';END IF;
 v_expected:=app.b019_retained_join_resource_set(x.id);
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.kind,q.org,q.id1,q.id2,q.text_key),'[]'::jsonb) INTO v_actual FROM (SELECT kind,org,id1,id2,text_key FROM app.b019_retained_join_resource WHERE seal_id=x.id ORDER BY kind,org,id1,id2,text_key LIMIT 16385) q;
 IF v_expected IS NULL OR jsonb_array_length(v_expected)>16384 OR jsonb_array_length(v_actual)>16384 OR v_actual IS DISTINCT FROM v_expected THEN RETURN 'incomplete';END IF;
 SELECT EXISTS(SELECT 1 FROM public.payments p JOIN public.ledger_transactions h ON h.org_id=p.org_id AND h.id=p.ledger_transaction_id JOIN app.b010_payment_commands cmd ON cmd.org_id=x.org AND cmd.actor_id=x.actor AND cmd.request_id=x.request AND cmd.payload_digest=x.digest AND cmd.payment_id=x.payment JOIN app.b017_occurrences n ON n.org_id=x.org AND n.id=x.source AND n.payment_id=x.payment AND n.lease_id=x.lease AND n.kind=x.source_kind AND n.occurrence_key=x.source_key AND n.created_tx_id=txid_current() AND x.source_birth=pg_current_xact_id() AND n.actor_id=x.actor AND n.payer_contact_id=x.payer AND n.payer_principal_user_id IS NOT DISTINCT FROM x.principal AND n.occurred_at=x.observed_at AND n.local_date=x.local_date JOIN app.b019_channel_outcomes co ON co.org_id=x.org AND co.neutral_source_id=n.id AND co.channel='in_app' AND co.outcome=x.outcome AND co.center_event_id IS NOT DISTINCT FROM x.event
 WHERE EXISTS(SELECT 1 FROM public.leases l JOIN public.properties prop ON prop.org_id=l.org_id AND prop.id=l.property_id JOIN public.contacts ct ON ct.org_id=l.org_id AND ct.id=x.payer WHERE l.org_id=x.org AND l.id=x.lease AND l.property_id=x.property AND l.currency=x.currency AND prop.currency=x.currency AND ct.user_id IS NOT DISTINCT FROM x.principal AND ct.is_tenant=x.is_tenant AND (ct.archived_at IS NOT NULL)=x.archived AND ((x.party IS NULL AND NOT EXISTS(SELECT 1 FROM public.lease_parties lp WHERE lp.org_id=x.org AND lp.lease_id=x.lease AND lp.contact_id=x.payer AND lp.role IN ('primary','co_tenant'))) OR (x.party IS NOT NULL AND EXISTS(SELECT 1 FROM public.lease_parties lp WHERE lp.org_id=x.org AND lp.lease_id=x.lease AND lp.contact_id=x.payer AND lp.id=x.party AND lp.role::text=x.party_role)))) AND x.local_date=(x.observed_at AT TIME ZONE x.timezone)::date
 AND p.org_id=x.org AND p.id=x.payment AND p.lease_id=x.lease AND p.property_id=x.property AND p.currency=x.currency AND p.amount_minor=x.amount AND p.paid_on=x.paid_on AND p.method::text=x.method AND p.payer_contact_id=x.payer AND p.status='confirmed' AND p.source='manager_entry' AND p.submitted_by=x.actor AND p.confirmed_by=x.actor AND p.confirmed_at IS NOT NULL
 AND encode(public.digest(convert_to(CASE WHEN p.payer_account_last5 IS NULL THEN 'N' ELSE 'V'||p.payer_account_last5 END,'UTF8'),'sha256'),'hex')=x.last5_digest AND encode(public.digest(convert_to(CASE WHEN p.reference IS NULL THEN 'N' ELSE 'V'||p.reference END,'UTF8'),'sha256'),'hex')=x.reference_digest
 AND (SELECT count(*) FROM app.b010_payment_commands c WHERE c.org_id=x.org AND c.payment_id=x.payment)=1
 AND h.kind='payment' AND h.reverses_transaction_id IS NULL AND h.effective_date=x.ledger_date AND h.source_table='payments' AND h.source_id=x.payment AND h.property_id=x.property AND h.lease_id=x.lease AND h.currency=x.currency AND h.created_by=x.actor
 AND (SELECT count(*) FROM public.ledger_transactions lh WHERE lh.org_id=x.org AND lh.source_table='payments' AND lh.source_id=x.payment)=1 AND NOT EXISTS(SELECT 1 FROM public.ledger_transactions rev WHERE rev.org_id=x.org AND rev.reverses_transaction_id=h.id)
 AND (SELECT count(*) FROM public.ledger_entries e WHERE e.org_id=x.org AND e.transaction_id=h.id)=2
 AND NOT EXISTS(SELECT 1 FROM public.ledger_entries e WHERE e.org_id=x.org AND e.transaction_id=h.id AND (e.currency<>x.currency OR e.contact_id IS DISTINCT FROM x.payer OR e.property_id IS DISTINCT FROM x.property OR e.lease_id IS DISTINCT FROM x.lease OR e.invoice_id IS NOT NULL OR e.account NOT IN ('cash_clearing','tenant_receivable')))
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM public.ledger_entries e WHERE e.org_id=x.org AND e.transaction_id=h.id AND e.account='cash_clearing')=x.amount AND (SELECT coalesce(sum(e.amount_minor),0) FROM public.ledger_entries e WHERE e.org_id=x.org AND e.transaction_id=h.id AND e.account='tenant_receivable')=-x.amount
 AND NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.org_id=x.org AND i.lease_id=x.lease AND i.status IN ('open','partially_paid') AND NOT EXISTS(SELECT 1 FROM app.b019_retained_join_invoice k WHERE k.seal_id=x.id AND k.invoice=i.id))
 AND NOT EXISTS((SELECT k.invoice,k.expected FROM app.b019_retained_join_invoice k WHERE k.seal_id=x.id AND k.expected>0) EXCEPT (SELECT a.invoice_id,a.amount_minor FROM public.payment_allocations a WHERE a.org_id=x.org AND a.payment_id=x.payment))
 AND NOT EXISTS((SELECT a.invoice_id,a.amount_minor FROM public.payment_allocations a WHERE a.org_id=x.org AND a.payment_id=x.payment) EXCEPT (SELECT k.invoice,k.expected FROM app.b019_retained_join_invoice k WHERE k.seal_id=x.id AND k.expected>0))
 AND NOT EXISTS(SELECT 1 FROM app.b019_retained_join_invoice k LEFT JOIN public.invoices i ON i.org_id=x.org AND i.id=k.invoice WHERE k.seal_id=x.id AND (i.id IS NULL OR i.lease_id<>x.lease OR i.property_id<>k.property OR i.currency<>k.currency OR i.due_date<>k.due OR i.created_at<>k.created OR i.total_minor<>k.total OR i.paid_minor<>k.paid+k.expected OR i.balance_minor<>k.balance-k.expected OR i.status::text<>CASE WHEN k.expected=0 THEN k.prior_status WHEN k.balance-k.expected<=0 AND k.total>0 THEN 'paid' WHEN k.paid+k.expected>0 THEN 'partially_paid' ELSE 'open' END))
 AND NOT EXISTS((SELECT k.id,k.invoice,k.charge,k.amount FROM app.b019_retained_join_line k WHERE k.seal_id=x.id) EXCEPT (SELECT il.id,il.invoice_id,il.charge_type::text,il.amount_minor FROM public.invoice_lines il WHERE il.org_id=x.org AND il.invoice_id IN (SELECT invoice FROM app.b019_retained_join_invoice WHERE seal_id=x.id)))
 AND NOT EXISTS((SELECT il.id,il.invoice_id,il.charge_type::text,il.amount_minor FROM public.invoice_lines il WHERE il.org_id=x.org AND il.invoice_id IN (SELECT invoice FROM app.b019_retained_join_invoice WHERE seal_id=x.id)) EXCEPT (SELECT k.id,k.invoice,k.charge,k.amount FROM app.b019_retained_join_line k WHERE k.seal_id=x.id))
 AND NOT EXISTS((SELECT k.id,k.invoice,k.payment,k.amount,k.payment_status FROM app.b019_retained_join_old_alloc k WHERE k.seal_id=x.id) EXCEPT (SELECT a.id,a.invoice_id,a.payment_id,a.amount_minor,p2.status::text FROM public.payment_allocations a JOIN public.payments p2 ON p2.org_id=a.org_id AND p2.id=a.payment_id WHERE a.org_id=x.org AND a.invoice_id IN (SELECT invoice FROM app.b019_retained_join_invoice WHERE seal_id=x.id) AND a.payment_id<>x.payment))
 AND NOT EXISTS((SELECT a.id,a.invoice_id,a.payment_id,a.amount_minor,p2.status::text FROM public.payment_allocations a JOIN public.payments p2 ON p2.org_id=a.org_id AND p2.id=a.payment_id WHERE a.org_id=x.org AND a.invoice_id IN (SELECT invoice FROM app.b019_retained_join_invoice WHERE seal_id=x.id) AND a.payment_id<>x.payment) EXCEPT (SELECT k.id,k.invoice,k.payment,k.amount,k.payment_status FROM app.b019_retained_join_old_alloc k WHERE k.seal_id=x.id))
 AND ((x.eligible AND x.outcome='issued' AND EXISTS(SELECT 1 FROM app.b028_center_events e JOIN app.b028_center_recipients ent ON ent.org_id=e.org_id AND ent.event_id=e.id WHERE e.org_id=x.org AND e.id=x.event AND e.neutral_source_id=x.source AND e.kind='payment_confirmed' AND e.occurred_at=x.observed_at AND ent.id=x.recipient AND ent.persona='tenant' AND ent.contact_id=x.payer AND ent.principal_user_id=x.principal) AND (SELECT count(*) FROM app.b028_center_recipients ent WHERE ent.org_id=x.org AND ent.event_id=x.event)=1) OR (NOT x.eligible AND x.outcome='recipient_unavailable' AND x.event IS NULL AND x.recipient IS NULL AND NOT EXISTS(SELECT 1 FROM app.b028_center_events e WHERE e.org_id=x.org AND e.neutral_source_id=x.source)))
 ) INTO v_ok;
 IF v_ok IS NOT TRUE THEN RETURN 'incomplete';END IF;
 IF app.b019_retained_join_auth(x.org,x.live_org,x.env,x.actor,x.session_id,x.role,x.timezone) IS NOT TRUE THEN RETURN 'incomplete';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id=x.session_id AND user_id=x.actor AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN RETURN 'incomplete';END IF;
 RETURN 'synthetic_consistent';
END $$;
REVOKE ALL ON FUNCTION app.b019_retained_join_check() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
