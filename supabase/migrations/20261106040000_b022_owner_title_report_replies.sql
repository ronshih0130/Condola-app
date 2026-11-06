BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key,value) VALUES
  ('owner_receipt_title','{"enabled":false,"allowed_org_ids":[]}'::jsonb),
  ('owner_report_replies','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b022_receipt_title_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  owner_contact_id uuid NOT NULL,
  request_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100 AND title=btrim(title)
    AND title !~ '[[:cntrl:]]|^[[:space:]]|[[:space:]]$'),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,request_id),
  FOREIGN KEY(org_id,owner_contact_id) REFERENCES public.contacts(org_id,id)
);
CREATE TABLE app.b022_report_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  version_id uuid,
  owner_contact_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('confirm','dispute')),
  body text,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='confirm' AND body IS NULL) OR (kind='dispute' AND body IS NOT NULL
    AND length(body) BETWEEN 1 AND 1000 AND body=btrim(body) AND body !~ '^[[:space:]]|[[:space:]]$')),
  UNIQUE(org_id,request_id),
  FOREIGN KEY(org_id,statement_id) REFERENCES public.owner_statements(org_id,id),
  FOREIGN KEY(org_id,statement_id,version_id) REFERENCES app.b014_statement_versions(org_id,statement_id,id),
  FOREIGN KEY(org_id,owner_contact_id) REFERENCES public.contacts(org_id,id)
);
ALTER TABLE app.b022_receipt_title_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b022_report_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b022_receipt_title_revisions,app.b022_report_replies FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b022_history_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  RAISE EXCEPTION 'Owner finance history is immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION app.b022_history_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b022_titles_no_change BEFORE UPDATE OR DELETE ON app.b022_receipt_title_revisions
FOR EACH ROW EXECUTE FUNCTION app.b022_history_immutable();
CREATE TRIGGER b022_titles_no_truncate BEFORE TRUNCATE ON app.b022_receipt_title_revisions
FOR EACH STATEMENT EXECUTE FUNCTION app.b022_history_immutable();
CREATE TRIGGER b022_replies_no_change BEFORE UPDATE OR DELETE ON app.b022_report_replies
FOR EACH ROW EXECUTE FUNCTION app.b022_history_immutable();
CREATE TRIGGER b022_replies_no_truncate BEFORE TRUNCATE ON app.b022_report_replies
FOR EACH STATEMENT EXECUTE FUNCTION app.b022_history_immutable();

CREATE FUNCTION app.b022_flag_on(p_org uuid,p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id=p_org
    WHERE f.key=p_key AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array'
      AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
      AND o.feature_flags->p_key='true'::jsonb
  );
$$;
REVOKE ALL ON FUNCTION app.b022_flag_on(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b022_flag_locked(p_org uuid,p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  PERFORM 1 FROM public.platform_settings WHERE key=p_key FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  RETURN app.b022_flag_on(p_org,p_key);
END $$;
REVOKE ALL ON FUNCTION app.b022_flag_locked(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b022_scope_matches(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id=p_org
    AND (nullif(current_setting('app.active_org_id',true),'') IS NULL
      OR current_setting('app.active_org_id',true)=p_org::text)
    AND (nullif(current_setting('app.env',true),'') IS NULL
      OR current_setting('app.env',true)=o.environment::text));
$$;
REVOKE ALL ON FUNCTION app.b022_scope_matches(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b022_my_owner_contact(p_org uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_ids uuid[];
BEGIN
  IF NOT app.b022_scope_matches(p_org) OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Owner title unavailable' USING ERRCODE='42501';
  END IF;
  -- Defense in depth: a staff member of this organization (or of its live org) never
  -- acts through the owner-only path, even if a contact's user binding points at them.
  IF EXISTS (
    SELECT 1 FROM public.organizations o JOIN public.org_members m
      ON m.org_id IN (o.id, coalesce(o.live_org_id, o.id))
    WHERE o.id=p_org AND m.user_id=auth.uid() AND m.status='active'
  ) THEN
    RAISE EXCEPTION 'Owner title unavailable' USING ERRCODE='42501';
  END IF;
  SELECT array_agg(c.id) INTO v_ids FROM public.contacts c
    WHERE c.org_id=p_org AND c.user_id=auth.uid() AND c.is_owner AND c.archived_at IS NULL;
  IF coalesce(cardinality(v_ids),0)<>1 THEN
    RAISE EXCEPTION 'Owner title unavailable' USING ERRCODE='42501';
  END IF;
  RETURN v_ids[1];
END $$;
REVOKE ALL ON FUNCTION app.b022_my_owner_contact(uuid) FROM PUBLIC,anon,authenticated,service_role;


-- contacts.receipt_title is owner-entered only (CAP-O-04). API roles may change it
-- only inside app.b022_set_receipt_title, which writes a transaction-scoped token
-- to a private table first; direct staff UPDATE/INSERT through table grants fails.
-- Migrations/maintenance running as the table owner are unaffected. Tokens are
-- removed at commit.
CREATE TABLE app.b022_title_write_tokens (
  tx_id bigint NOT NULL,
  contact_id uuid NOT NULL,
  PRIMARY KEY (tx_id, contact_id)
);
ALTER TABLE app.b022_title_write_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b022_title_write_tokens FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b022_clean_title_token() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  DELETE FROM app.b022_title_write_tokens WHERE tx_id=NEW.tx_id AND contact_id=NEW.contact_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b022_clean_title_token() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b022_title_token_cleanup AFTER INSERT ON app.b022_title_write_tokens
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b022_clean_title_token();

CREATE FUNCTION app.b022_title_token_present(p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT EXISTS (SELECT 1 FROM app.b022_title_write_tokens t WHERE t.tx_id=txid_current() AND t.contact_id=p_contact);
$$;
REVOKE ALL ON FUNCTION app.b022_title_token_present(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b022_title_token_present(uuid) TO authenticated,service_role;

-- Runs as the invoker so current_user is the real API role (authenticated/service_role/anon).
CREATE FUNCTION app.b022_guard_receipt_title() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF (TG_OP='INSERT' AND NEW.receipt_title IS NULL)
     OR (TG_OP='UPDATE' AND NEW.receipt_title IS NOT DISTINCT FROM OLD.receipt_title) THEN
    RETURN NEW;
  END IF;
  IF current_user IN ('authenticated','anon','service_role') AND NOT app.b022_title_token_present(NEW.id) THEN
    RAISE EXCEPTION 'Receipt title is owner-entered only' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b022_guard_receipt_title() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b022_guard_receipt_title BEFORE INSERT OR UPDATE OF receipt_title ON public.contacts
FOR EACH ROW EXECUTE FUNCTION app.b022_guard_receipt_title();

CREATE FUNCTION app.b022_set_receipt_title(p_org uuid,p_request uuid,p_title text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_contact uuid; v_id uuid; prior app.b022_receipt_title_revisions%ROWTYPE;
BEGIN
  IF p_request IS NULL OR NOT app.b022_flag_on(p_org,'owner_receipt_title') THEN
    RAISE EXCEPTION 'Owner title unavailable' USING ERRCODE='42501';
  END IF;
  v_contact:=app.b022_my_owner_contact(p_org);
  IF p_title IS NULL OR length(p_title) NOT BETWEEN 1 AND 100 OR p_title<>btrim(p_title)
    OR p_title ~ '[[:cntrl:]]|^[[:space:]]|[[:space:]]$' THEN
    RAISE EXCEPTION 'Invalid receipt title' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b022_title_request:'||p_org||':'||p_request,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('b022_title:'||v_contact,0));
  IF NOT app.b022_flag_locked(p_org,'owner_receipt_title') THEN
    RAISE EXCEPTION 'Owner title unavailable' USING ERRCODE='42501';
  END IF;
  -- Lock and revalidate the actor after any wait, including archive/reassignment.
  PERFORM 1 FROM public.contacts WHERE id=v_contact FOR UPDATE;
  IF app.b022_my_owner_contact(p_org) IS DISTINCT FROM v_contact THEN
    RAISE EXCEPTION 'Owner title unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO prior FROM app.b022_receipt_title_revisions WHERE org_id=p_org AND request_id=p_request;
  IF FOUND THEN
    IF prior.owner_contact_id=v_contact AND prior.title=p_title AND prior.actor_user_id=auth.uid() THEN RETURN prior.id; END IF;
    RAISE EXCEPTION 'Owner title request conflict' USING ERRCODE='42501';
  END IF;
  INSERT INTO app.b022_title_write_tokens(tx_id,contact_id) VALUES (txid_current(),v_contact) ON CONFLICT DO NOTHING;
  UPDATE public.contacts SET receipt_title=p_title WHERE id=v_contact AND org_id=p_org;
  INSERT INTO app.b022_receipt_title_revisions(org_id,owner_contact_id,request_id,title,actor_user_id)
  VALUES(p_org,v_contact,p_request,p_title,auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b022_set_receipt_title(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b022_set_receipt_title(uuid,uuid,text) TO authenticated;

CREATE FUNCTION app.b022_my_receipt_title(p_org uuid) RETURNS TABLE(title text,revisions jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_contact uuid;
BEGIN
  IF NOT app.b022_flag_on(p_org,'owner_receipt_title') THEN
    RAISE EXCEPTION 'Owner title unavailable' USING ERRCODE='42501';
  END IF;
  v_contact:=app.b022_my_owner_contact(p_org);
  RETURN QUERY SELECT c.receipt_title,coalesce((SELECT jsonb_agg(jsonb_build_object('title',r.title,'created_at',r.created_at)
    ORDER BY r.created_at DESC,r.id) FROM app.b022_receipt_title_revisions r WHERE r.org_id=p_org AND r.owner_contact_id=v_contact),'[]'::jsonb)
    FROM public.contacts c WHERE c.id=v_contact AND c.org_id=p_org;
END $$;
REVOKE ALL ON FUNCTION app.b022_my_receipt_title(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b022_my_receipt_title(uuid) TO authenticated;

-- Shared admission for the B-022 statement surface. No table privileges escape.
CREATE FUNCTION app.b022_reply_statement(p_statement uuid,p_owner_only boolean) RETURNS public.owner_statements
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE s public.owner_statements%ROWTYPE; v_owner boolean;
BEGIN
  SELECT * INTO s FROM public.owner_statements WHERE id=p_statement;
  IF NOT FOUND OR s.status<>'issued' OR NOT app.b022_scope_matches(s.org_id)
    OR NOT app.b022_flag_on(s.org_id,'owner_report_replies') THEN
    RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501';
  END IF;
  v_owner:=coalesce(app.is_my_contact(s.owner_contact_id),false);
  IF p_owner_only THEN
    v_owner:=v_owner AND EXISTS(SELECT 1 FROM public.contacts c WHERE c.org_id=s.org_id
      AND c.id=s.owner_contact_id AND c.user_id=auth.uid() AND c.is_owner AND c.archived_at IS NULL)
      -- Defense in depth: staff of this org never write through the owner-only path.
      AND NOT EXISTS(SELECT 1 FROM public.organizations o JOIN public.org_members m
        ON m.org_id IN (o.id, coalesce(o.live_org_id, o.id))
        WHERE o.id=s.org_id AND m.user_id=auth.uid() AND m.status='active');
    IF NOT v_owner THEN RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501'; END IF;
  ELSIF NOT (v_owner OR coalesce(app.is_member(s.org_id),false)) THEN
    RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501';
  END IF;
  RETURN s;
END $$;
REVOKE ALL ON FUNCTION app.b022_reply_statement(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b022_owner_transfers_for(p_statement uuid)
RETURNS TABLE(id uuid,kind text,effective_date date,amount_minor text,currency text,reverses_transaction_id uuid,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE s public.owner_statements%ROWTYPE;
BEGIN
  s:=app.b022_reply_statement(p_statement,false);
  RETURN QUERY SELECT t.id,t.kind::text,t.effective_date,abs(e.amount_minor::numeric)::text,t.currency::text,t.reverses_transaction_id,t.created_at
    FROM public.ledger_transactions t JOIN public.ledger_entries e ON e.org_id=t.org_id AND e.transaction_id=t.id
    WHERE t.org_id=s.org_id AND t.source_table='b014_owner_transfer_v1' AND t.kind IN ('owner_payout','reversal')
      AND e.account='owner_payable' AND e.contact_id=s.owner_contact_id AND t.currency=s.currency AND e.currency=t.currency
      AND t.effective_date BETWEEN s.period_start AND s.period_end
    ORDER BY t.effective_date DESC,t.created_at DESC,t.id;
END $$;
REVOKE ALL ON FUNCTION app.b022_owner_transfers_for(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b022_owner_transfers_for(uuid) TO authenticated;

CREATE FUNCTION app.b022_record_report_reply(p_statement uuid,p_version uuid,p_request uuid,p_kind text,p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE s public.owner_statements%ROWTYPE; prior app.b022_report_replies%ROWTYPE; v_latest uuid; v_id uuid;
BEGIN
  s:=app.b022_reply_statement(p_statement,true);
  IF p_request IS NULL THEN RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('confirm','dispute') OR (p_kind='confirm' AND p_body IS NOT NULL)
    OR (p_kind='dispute' AND (p_body IS NULL OR length(p_body) NOT BETWEEN 1 AND 1000 OR p_body<>btrim(p_body)
      OR p_body ~ '^[[:space:]]|[[:space:]]$')) THEN
    RAISE EXCEPTION 'Invalid report reply' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b022_reply_request:'||s.org_id||':'||p_request,0));
  -- Same lock as B-014 version creation: latest admission and append are atomic.
  PERFORM pg_advisory_xact_lock(hashtextextended('b014_version:'||p_statement,0));
  IF NOT app.b022_flag_locked(s.org_id,'owner_report_replies') THEN
    RAISE EXCEPTION 'Report unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.owner_statements WHERE id=p_statement FOR SHARE;
  PERFORM 1 FROM public.contacts WHERE id=s.owner_contact_id FOR SHARE;
  s:=app.b022_reply_statement(p_statement,true);
  SELECT * INTO prior FROM app.b022_report_replies WHERE org_id=s.org_id AND request_id=p_request;
  IF FOUND THEN
    IF prior.statement_id=p_statement AND prior.version_id IS NOT DISTINCT FROM p_version
      AND prior.owner_contact_id=s.owner_contact_id AND prior.kind=p_kind AND prior.body IS NOT DISTINCT FROM p_body
      AND prior.actor_user_id=auth.uid() THEN RETURN prior.id; END IF;
    RAISE EXCEPTION 'Report reply request conflict' USING ERRCODE='42501';
  END IF;
  SELECT v.id INTO v_latest FROM app.b014_statement_versions v WHERE v.org_id=s.org_id AND v.statement_id=p_statement ORDER BY v.version_no DESC LIMIT 1;
  IF p_version IS DISTINCT FROM v_latest THEN
    RAISE EXCEPTION 'Report version changed' USING ERRCODE='42501';
  END IF;
  INSERT INTO app.b022_report_replies(org_id,statement_id,version_id,owner_contact_id,request_id,kind,body,actor_user_id)
  VALUES(s.org_id,p_statement,p_version,s.owner_contact_id,p_request,p_kind,p_body,auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b022_record_report_reply(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b022_record_report_reply(uuid,uuid,uuid,text,text) TO authenticated;

CREATE FUNCTION app.b022_report_replies_for(p_statement uuid)
RETURNS TABLE(id uuid,version_id uuid,kind text,body text,created_at timestamptz,actor_is_owner boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE s public.owner_statements%ROWTYPE;
BEGIN
  s:=app.b022_reply_statement(p_statement,false);
  RETURN QUERY SELECT r.id,r.version_id,r.kind,r.body,r.created_at,r.owner_contact_id=s.owner_contact_id
    FROM app.b022_report_replies r WHERE r.org_id=s.org_id AND r.statement_id=p_statement ORDER BY r.created_at DESC,r.id;
END $$;
REVOKE ALL ON FUNCTION app.b022_report_replies_for(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b022_report_replies_for(uuid) TO authenticated;

-- Metadata must remain correct when owner_net_ledger is OFF. Its B-014 reader is
-- independently gated, so expose only the current version identity through B-022.
CREATE FUNCTION app.b022_report_reply_context(p_statement uuid)
RETURNS TABLE(latest_version_id uuid,latest_version_no int,can_reply boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE s public.owner_statements%ROWTYPE;
BEGIN
  s:=app.b022_reply_statement(p_statement,false);
  RETURN QUERY SELECT v.id,coalesce(v.version_no,1),coalesce(app.is_my_contact(s.owner_contact_id),false)
    AND EXISTS(SELECT 1 FROM public.contacts c WHERE c.org_id=s.org_id AND c.id=s.owner_contact_id
      AND c.user_id=auth.uid() AND c.is_owner AND c.archived_at IS NULL)
    FROM (SELECT 1) seed LEFT JOIN LATERAL (SELECT bv.id,bv.version_no FROM app.b014_statement_versions bv
      WHERE bv.org_id=s.org_id AND bv.statement_id=p_statement ORDER BY bv.version_no DESC LIMIT 1) v ON true;
END $$;
REVOKE ALL ON FUNCTION app.b022_report_reply_context(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b022_report_reply_context(uuid) TO authenticated;
COMMIT;
