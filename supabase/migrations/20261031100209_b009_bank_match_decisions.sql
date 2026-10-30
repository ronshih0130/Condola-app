BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
INSERT INTO public.platform_settings(key,value,description)
VALUES ('bank_matching','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'Bank matching rollout control')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b009_file_imports (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  bank_account_id uuid NOT NULL,
  file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  encoding text NOT NULL CHECK (encoding IN ('utf-8','big5')),
  date_format text NOT NULL CHECK (date_format IN ('iso','roc')),
  import_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,bank_account_id,file_hash),
  FOREIGN KEY (org_id,bank_account_id) REFERENCES public.bank_accounts(org_id,id),
  FOREIGN KEY (org_id,import_id) REFERENCES public.bank_statement_imports(org_id,id)
);
CREATE TABLE app.b009_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  bank_transaction_id uuid NOT NULL,
  payment_id uuid,
  suggestion_id uuid,
  decision text NOT NULL CHECK (decision IN ('match','reject')),
  source text NOT NULL CHECK (source IN ('manual','suggestion')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id,bank_transaction_id) REFERENCES public.bank_transactions(org_id,id),
  FOREIGN KEY (org_id,payment_id) REFERENCES public.payments(org_id,id)
);
REVOKE ALL ON app.b009_file_imports, app.b009_decisions FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE app.b009_decisions_id_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b009_decisions_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Bank decisions are append-only' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION app.b009_decisions_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b009_decisions_no_change BEFORE UPDATE OR DELETE ON app.b009_decisions FOR EACH ROW EXECUTE FUNCTION app.b009_decisions_immutable();
CREATE TRIGGER b009_decisions_no_truncate BEFORE TRUNCATE ON app.b009_decisions FOR EACH STATEMENT EXECUTE FUNCTION app.b009_decisions_immutable();

-- Legacy writes remain unchanged while rollout is OFF. When ON, the audited
-- server path owns bank matching mutations. DB owners remain trusted.
CREATE FUNCTION app.b009_direct_write_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_role text := coalesce(nullif(current_setting('role',true),'none'),session_user::text); v_old_org uuid; v_new_org uuid; v_enabled boolean;
BEGIN
  IF v_role = current_user::text THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE;
  IF TG_OP <> 'INSERT' THEN v_old_org := OLD.org_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_org := NEW.org_id; END IF;
  PERFORM 1 FROM public.organizations WHERE id IN (v_old_org,v_new_org) ORDER BY id FOR SHARE;
  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings p ON p.key='bank_matching'
    WHERE o.id IN (v_old_org,v_new_org) AND o.feature_flags->'bank_matching'='true'::jsonb AND p.value->'enabled'='true'::jsonb
      AND jsonb_typeof(p.value->'allowed_org_ids')='array' AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF v_enabled THEN RAISE EXCEPTION 'Bank matching requires audited server path' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b009_direct_write_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b009_import_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bank_statement_imports FOR EACH ROW EXECUTE FUNCTION app.b009_direct_write_guard();
CREATE TRIGGER b009_transaction_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION app.b009_direct_write_guard();
CREATE TRIGGER b009_suggestion_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bank_match_suggestions FOR EACH ROW EXECUTE FUNCTION app.b009_direct_write_guard();
CREATE TRIGGER b009_payment_insert_guard BEFORE INSERT ON public.payments FOR EACH ROW WHEN (NEW.bank_transaction_id IS NOT NULL) EXECUTE FUNCTION app.b009_direct_write_guard();
CREATE TRIGGER b009_payment_guard BEFORE UPDATE OF bank_transaction_id ON public.payments FOR EACH ROW WHEN (OLD.bank_transaction_id IS DISTINCT FROM NEW.bank_transaction_id) EXECUTE FUNCTION app.b009_direct_write_guard();
COMMIT;
