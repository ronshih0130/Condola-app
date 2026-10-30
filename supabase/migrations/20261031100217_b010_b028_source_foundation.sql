BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- DRAFT: isolated, owner-only typed source foundation. No producer or application
-- gateway is granted here. Center extension and cross-authority replay fencing are
-- required before this migration can be reviewed as a complete candidate.
CREATE TABLE app.b017_occurrences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.organizations(id),
 lease_id uuid NOT NULL,
 invoice_id uuid,
 payment_id uuid,
 kind text NOT NULL CHECK (kind IN ('rent_due','rent_overdue','rent_manual','payment_confirmed','payment_rejected','payment_reversed')),
 occurrence_key text NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 128),
 actor_id uuid REFERENCES auth.users(id),
 payer_contact_id uuid,
 payer_principal_user_id uuid REFERENCES auth.users(id),
 local_date date,
 occurred_at timestamptz NOT NULL,
 created_tx_id bigint NOT NULL DEFAULT txid_current(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (org_id,id),
 FOREIGN KEY (org_id,lease_id) REFERENCES public.leases(org_id,id),
 FOREIGN KEY (org_id,invoice_id) REFERENCES public.invoices(org_id,id),
 FOREIGN KEY (org_id,payment_id) REFERENCES public.payments(org_id,id),
 FOREIGN KEY (org_id,payer_contact_id) REFERENCES public.contacts(org_id,id),
 CHECK ((kind IN ('rent_due','rent_overdue','rent_manual') AND invoice_id IS NOT NULL AND payment_id IS NULL AND payer_contact_id IS NULL AND payer_principal_user_id IS NULL)
     OR (kind IN ('payment_confirmed','payment_rejected','payment_reversed') AND payment_id IS NOT NULL AND invoice_id IS NULL)),
 CHECK (payer_contact_id IS NOT NULL OR payer_principal_user_id IS NULL),
 CHECK ((kind IN ('rent_due','rent_overdue') AND local_date IS NOT NULL AND actor_id IS NULL)
     OR (kind='rent_manual' AND local_date IS NOT NULL AND actor_id IS NOT NULL)
     OR (kind LIKE 'payment_%' AND actor_id IS NOT NULL))
);
CREATE UNIQUE INDEX b017_rent_occurrence ON app.b017_occurrences(org_id,kind,invoice_id,occurrence_key) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX b017_manual_request ON app.b017_occurrences(org_id,actor_id,occurrence_key) WHERE kind='rent_manual';
CREATE UNIQUE INDEX b017_payment_transition ON app.b017_occurrences(org_id,kind,payment_id) WHERE payment_id IS NOT NULL;
REVOKE ALL ON app.b017_occurrences FROM PUBLIC,anon,authenticated,service_role;

-- A shared nonblocking key is taken before either authority reaches a unique
-- index. This first draft changes direct-writer contention to retryable failure;
-- compatibility and all gate races require independent review before acceptance.
CREATE TABLE app.b017_old_source_transactions (
 tx_id bigint NOT NULL, org_id uuid NOT NULL, source_id uuid NOT NULL,
 PRIMARY KEY(org_id,source_id),
 FOREIGN KEY(org_id,source_id) REFERENCES app.b010_source_events(org_id,id)
);
REVOKE ALL ON app.b017_old_source_transactions FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b017_occurrence_key_lock(p_org uuid,p_kind text,p_invoice uuid,p_payment uuid,p_actor uuid,p_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_key text; v_invoice_key text;
BEGIN
 IF p_kind='rent_manual' THEN
  v_key:='manual:'||p_org::text||':'||p_actor::text||':'||p_key;
  v_invoice_key:='manual-invoice:'||p_org::text||':'||p_invoice::text||':'||p_key;
 ELSIF p_kind IN ('rent_due','rent_overdue') THEN
  v_key:='rent:'||p_org::text||':'||p_kind||':'||p_invoice::text||':'||p_key;
 ELSIF p_kind IN ('payment_confirmed','payment_rejected','payment_reversed') THEN
  v_key:='payment:'||p_org::text||':'||p_kind||':'||p_payment::text;
 ELSE RAISE EXCEPTION 'Invalid occurrence key' USING ERRCODE='23514'; END IF;
 IF v_key IS NULL OR NOT pg_try_advisory_xact_lock(hashtextextended('b017:'||v_key,0)) THEN
  RAISE EXCEPTION 'Occurrence busy' USING ERRCODE='55P03';
 END IF;
 IF p_kind='rent_manual' AND (v_invoice_key IS NULL OR NOT pg_try_advisory_xact_lock(hashtextextended('b017:'||v_invoice_key,0))) THEN
  RAISE EXCEPTION 'Occurrence busy' USING ERRCODE='55P03';
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.b017_occurrence_key_lock(uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

-- Serialize even private resolution writes with the guarded demo reset. This
-- runs before source/key locks and never waits on a late admission edge.
CREATE FUNCTION app.b017_resolution_admit(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Occurrence unavailable' USING ERRCODE='23514'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b017_resolution_admit(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b017_old_source_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_new app.b017_occurrences;
BEGIN
 -- Serializes even an OFF writer with an OFF-to-ON control update. Supported
 -- 100212 gateways already acquire these admission locks; direct writers fail
 -- retryably if acquisition is unsafe instead of waiting behind a late edge.
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations o WHERE o.id=NEW.org_id FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Occurrence unavailable' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.leases l WHERE l.org_id=NEW.org_id AND l.id=NEW.lease_id FOR KEY SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing occurrence parent' USING ERRCODE='23503'; END IF;
 IF NEW.invoice_id IS NOT NULL THEN
  PERFORM 1 FROM public.invoices i WHERE i.org_id=NEW.org_id AND i.id=NEW.invoice_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing occurrence parent' USING ERRCODE='23503'; END IF;
 END IF;
 IF NEW.payment_id IS NOT NULL THEN
  PERFORM 1 FROM public.payments p WHERE p.org_id=NEW.org_id AND p.id=NEW.payment_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing occurrence parent' USING ERRCODE='23503'; END IF;
 END IF;
 IF NEW.actor_id IS NOT NULL THEN
  PERFORM 1 FROM auth.users u WHERE u.id=NEW.actor_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing occurrence parent' USING ERRCODE='23503'; END IF;
 END IF;
 PERFORM app.b017_occurrence_key_lock(NEW.org_id,NEW.kind,NEW.invoice_id,NEW.payment_id,NEW.actor_id,NEW.occurrence_key);
 SELECT n.* INTO v_new FROM app.b017_occurrences n WHERE n.org_id=NEW.org_id AND n.kind=NEW.kind AND (
  (NEW.kind='rent_manual' AND (n.actor_id=NEW.actor_id OR n.invoice_id=NEW.invoice_id) AND n.occurrence_key=NEW.occurrence_key)
  OR (NEW.kind IN ('rent_due','rent_overdue') AND n.invoice_id=NEW.invoice_id AND n.occurrence_key=NEW.occurrence_key)
  OR (NEW.kind LIKE 'payment_%' AND n.payment_id=NEW.payment_id)) FOR SHARE NOWAIT;
 IF FOUND AND ((v_new.lease_id IS DISTINCT FROM NEW.lease_id OR v_new.invoice_id IS DISTINCT FROM NEW.invoice_id
   OR v_new.payment_id IS DISTINCT FROM NEW.payment_id OR v_new.actor_id IS DISTINCT FROM NEW.actor_id)
   OR (v_new.created_tx_id=txid_current() AND (v_new.local_date IS DISTINCT FROM NEW.local_date
   OR v_new.occurred_at IS DISTINCT FROM NEW.created_at))) THEN
  RAISE EXCEPTION 'Occurrence source mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b017_old_source_insert BEFORE INSERT ON app.b010_source_events
 FOR EACH ROW EXECUTE FUNCTION app.b017_old_source_insert();
REVOKE ALL ON FUNCTION app.b017_old_source_insert() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b017_old_source_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 INSERT INTO app.b017_old_source_transactions(tx_id,org_id,source_id) VALUES(txid_current(),NEW.org_id,NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER b017_old_source_record AFTER INSERT ON app.b010_source_events
 FOR EACH ROW EXECUTE FUNCTION app.b017_old_source_record();
REVOKE ALL ON FUNCTION app.b017_old_source_record() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b017_old_source_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 DELETE FROM app.b017_old_source_transactions WHERE org_id=OLD.org_id AND source_id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER b017_old_source_delete BEFORE DELETE ON app.b010_source_events
 FOR EACH ROW EXECUTE FUNCTION app.b017_old_source_delete();
REVOKE ALL ON FUNCTION app.b017_old_source_delete() FROM PUBLIC,anon,authenticated,service_role;
-- Provenance stays bound to the source lifecycle: early SET CONSTRAINTS must
-- not turn a source created in this transaction into historical data. The
-- existing source DELETE trigger removes it, including zero-recipient rollback.

-- One private resolution authority covers both typed source families.
CREATE TABLE app.b017_center_resolutions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('rent_due','rent_overdue','rent_manual','payment_confirmed','payment_rejected','payment_reversed')),
 lease_id uuid NOT NULL, invoice_id uuid, payment_id uuid, actor_id uuid, occurrence_key text NOT NULL,
 local_date date, occurred_at timestamptz NOT NULL,
 old_source_id uuid, neutral_source_id uuid, center_event_id uuid,
 outcome text NOT NULL CHECK (outcome IN ('existing_center','no_backfill')),
 FOREIGN KEY(org_id,old_source_id) REFERENCES app.b010_source_events(org_id,id),
 FOREIGN KEY(org_id,neutral_source_id) REFERENCES app.b017_occurrences(org_id,id),
 FOREIGN KEY(org_id,center_event_id) REFERENCES app.b028_center_events(org_id,id),
 UNIQUE(org_id,old_source_id), UNIQUE(org_id,neutral_source_id), UNIQUE(org_id,center_event_id),
 CHECK (old_source_id IS NOT NULL OR neutral_source_id IS NOT NULL),
 CHECK ((kind IN ('rent_due','rent_overdue','rent_manual') AND invoice_id IS NOT NULL AND payment_id IS NULL)
     OR (kind LIKE 'payment_%' AND invoice_id IS NULL AND payment_id IS NOT NULL)),
 CHECK ((outcome='existing_center' AND center_event_id IS NOT NULL) OR (outcome='no_backfill' AND center_event_id IS NULL))
);
CREATE UNIQUE INDEX b017_resolution_rent ON app.b017_center_resolutions(org_id,kind,invoice_id,occurrence_key) WHERE kind IN ('rent_due','rent_overdue');
CREATE UNIQUE INDEX b017_resolution_manual ON app.b017_center_resolutions(org_id,actor_id,occurrence_key) WHERE kind='rent_manual';
CREATE UNIQUE INDEX b017_resolution_manual_invoice ON app.b017_center_resolutions(org_id,invoice_id,occurrence_key) WHERE kind='rent_manual';
CREATE UNIQUE INDEX b017_resolution_payment ON app.b017_center_resolutions(org_id,kind,payment_id) WHERE payment_id IS NOT NULL;
REVOKE ALL ON app.b017_center_resolutions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b017_center_resolutions_immutable BEFORE UPDATE OR DELETE ON app.b017_center_resolutions
 FOR EACH ROW EXECUTE FUNCTION app.b028_center_immutable();

CREATE FUNCTION app.b017_occurrence_valid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_lease uuid; v_payer uuid; v_user uuid; v_status text; v_old app.b010_source_events; v_users integer; v_expected integer;
BEGIN
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations o WHERE o.id=NEW.org_id FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Occurrence unavailable' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.leases l WHERE l.org_id=NEW.org_id AND l.id=NEW.lease_id FOR KEY SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing occurrence parent' USING ERRCODE='23503'; END IF;
 PERFORM 1 FROM auth.users u WHERE u.id IN (NEW.actor_id,NEW.payer_principal_user_id) ORDER BY u.id FOR KEY SHARE NOWAIT;
 GET DIAGNOSTICS v_users=ROW_COUNT;
 SELECT count(DISTINCT x.id)::integer INTO v_expected FROM unnest(ARRAY[NEW.actor_id,NEW.payer_principal_user_id]) AS x(id) WHERE x.id IS NOT NULL;
 IF v_users<>v_expected THEN RAISE EXCEPTION 'Missing occurrence parent' USING ERRCODE='23503'; END IF;
 PERFORM app.b017_occurrence_key_lock(NEW.org_id,NEW.kind,NEW.invoice_id,NEW.payment_id,NEW.actor_id,NEW.occurrence_key);
 NEW.created_tx_id:=txid_current();
 SELECT b.* INTO v_old FROM app.b010_source_events b WHERE b.org_id=NEW.org_id AND (
  (NEW.kind='rent_manual' AND b.kind=NEW.kind AND (b.actor_id=NEW.actor_id OR b.invoice_id=NEW.invoice_id) AND b.occurrence_key=NEW.occurrence_key)
  OR (NEW.kind IN ('rent_due','rent_overdue') AND b.kind=NEW.kind AND b.invoice_id=NEW.invoice_id AND b.occurrence_key=NEW.occurrence_key)
  OR (NEW.kind LIKE 'payment_%' AND b.kind=NEW.kind AND b.payment_id=NEW.payment_id)) FOR SHARE NOWAIT;
 IF FOUND AND (v_old.lease_id IS DISTINCT FROM NEW.lease_id OR v_old.invoice_id IS DISTINCT FROM NEW.invoice_id
   OR v_old.payment_id IS DISTINCT FROM NEW.payment_id OR v_old.actor_id IS DISTINCT FROM NEW.actor_id
   OR v_old.local_date IS DISTINCT FROM NEW.local_date OR v_old.created_at IS DISTINCT FROM NEW.occurred_at
   OR NOT EXISTS (SELECT 1 FROM app.b017_old_source_transactions t
      WHERE t.org_id=NEW.org_id AND t.source_id=v_old.id AND t.tx_id=txid_current())) THEN
  RAISE EXCEPTION 'Historical occurrence must be resolved' USING ERRCODE='23505';
 END IF;
 IF NEW.invoice_id IS NOT NULL THEN
  SELECT i.lease_id INTO v_lease FROM public.invoices i
   WHERE i.org_id=NEW.org_id AND i.id=NEW.invoice_id FOR SHARE NOWAIT;
  IF NOT FOUND OR v_lease IS DISTINCT FROM NEW.lease_id THEN
   RAISE EXCEPTION 'Invalid occurrence source' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT p.lease_id,p.payer_contact_id,p.status::text INTO v_lease,v_payer,v_status FROM public.payments p
   WHERE p.org_id=NEW.org_id AND p.id=NEW.payment_id FOR SHARE NOWAIT;
  IF NOT FOUND OR v_lease IS DISTINCT FROM NEW.lease_id OR v_payer IS DISTINCT FROM NEW.payer_contact_id
     OR v_status IS DISTINCT FROM substring(NEW.kind FROM 9) THEN
   RAISE EXCEPTION 'Invalid occurrence source' USING ERRCODE='23514';
  END IF;
  IF v_payer IS NOT NULL THEN
   SELECT c.user_id INTO v_user FROM public.contacts c
    WHERE c.org_id=NEW.org_id AND c.id=v_payer FOR SHARE NOWAIT;
   IF NOT FOUND OR v_user IS DISTINCT FROM NEW.payer_principal_user_id THEN
    RAISE EXCEPTION 'Invalid occurrence payer' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b017_occurrence_valid BEFORE INSERT ON app.b017_occurrences
 FOR EACH ROW EXECUTE FUNCTION app.b017_occurrence_valid();
REVOKE ALL ON FUNCTION app.b017_occurrence_valid() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b017_occurrence_commit_valid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.payment_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.payments p LEFT JOIN public.contacts c ON c.org_id=p.org_id AND c.id=p.payer_contact_id
   WHERE p.id=NEW.payment_id AND p.org_id=NEW.org_id AND p.lease_id=NEW.lease_id
    AND p.status::text=substring(NEW.kind FROM 9)
    AND p.payer_contact_id IS NOT DISTINCT FROM NEW.payer_contact_id
    AND c.user_id IS NOT DISTINCT FROM NEW.payer_principal_user_id
 ) THEN RAISE EXCEPTION 'Invalid final occurrence source' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER b017_occurrence_commit_valid AFTER INSERT ON app.b017_occurrences
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b017_occurrence_commit_valid();
REVOKE ALL ON FUNCTION app.b017_occurrence_commit_valid() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b017_occurrence_immutable BEFORE UPDATE OR DELETE ON app.b017_occurrences
 FOR EACH ROW EXECUTE FUNCTION app.b028_center_immutable();

-- DRAFT additive center source extension; no producer grants are added.
ALTER TABLE app.b028_center_events ADD COLUMN neutral_source_id uuid;
ALTER TABLE app.b028_center_events ADD CONSTRAINT b017_center_neutral_scope FOREIGN KEY(org_id,neutral_source_id) REFERENCES app.b017_occurrences(org_id,id);
ALTER TABLE app.b028_center_events ADD CONSTRAINT b017_center_neutral_unique UNIQUE(org_id,neutral_source_id);
ALTER TABLE app.b028_center_events ADD CONSTRAINT b017_center_exact_source CHECK (
 (kind<>'vendor_job_assigned' AND b010_event_id IS NOT NULL AND neutral_source_id IS NULL AND ticket_id IS NULL AND job_id IS NULL)
 OR (kind='vendor_job_assigned' AND b010_event_id IS NULL AND neutral_source_id IS NULL AND ticket_id IS NOT NULL AND job_id IS NOT NULL)
 OR (kind<>'vendor_job_assigned' AND b010_event_id IS NULL AND neutral_source_id IS NOT NULL AND ticket_id IS NULL AND job_id IS NULL)
) NOT VALID;
ALTER TABLE app.b028_center_events VALIDATE CONSTRAINT b017_center_exact_source;
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='app.b028_center_events'::regclass
  AND c.conname='b028_center_events_check' AND c.contype='c'
  AND pg_get_constraintdef(c.oid) = $check$CHECK ((((kind = 'vendor_job_assigned'::text) AND (b010_event_id IS NULL) AND (ticket_id IS NOT NULL) AND (job_id IS NOT NULL)) OR ((kind <> 'vendor_job_assigned'::text) AND (b010_event_id IS NOT NULL) AND (ticket_id IS NULL) AND (job_id IS NULL))))$check$) THEN
  RAISE EXCEPTION 'Unexpected existing center source constraint' USING ERRCODE='23514';
 END IF;
END $$;
ALTER TABLE app.b028_center_events DROP CONSTRAINT b028_center_events_check;

CREATE FUNCTION app.b017_resolution_valid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE b app.b010_source_events; n app.b017_occurrences; v_count integer; v_center uuid;
BEGIN
 PERFORM app.b017_resolution_admit(NEW.org_id);
 PERFORM app.b017_occurrence_key_lock(NEW.org_id,NEW.kind,NEW.invoice_id,NEW.payment_id,NEW.actor_id,NEW.occurrence_key);
 IF NEW.old_source_id IS NOT NULL THEN
  SELECT * INTO b FROM app.b010_source_events WHERE org_id=NEW.org_id AND id=NEW.old_source_id FOR SHARE NOWAIT;
  IF NOT FOUND OR b.kind IS DISTINCT FROM NEW.kind OR b.lease_id IS DISTINCT FROM NEW.lease_id
    OR b.invoice_id IS DISTINCT FROM NEW.invoice_id OR b.payment_id IS DISTINCT FROM NEW.payment_id
    OR b.actor_id IS DISTINCT FROM NEW.actor_id OR b.local_date IS DISTINCT FROM NEW.local_date
    OR b.created_at IS DISTINCT FROM NEW.occurred_at OR (b.kind NOT LIKE 'payment_%' AND b.occurrence_key IS DISTINCT FROM NEW.occurrence_key)
    OR EXISTS (SELECT 1 FROM app.b017_old_source_transactions t WHERE t.org_id=NEW.org_id AND t.source_id=b.id AND t.tx_id=txid_current()) THEN
   RAISE EXCEPTION 'Historical occurrence unavailable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.neutral_source_id IS NOT NULL THEN
  SELECT * INTO n FROM app.b017_occurrences WHERE org_id=NEW.org_id AND id=NEW.neutral_source_id FOR SHARE NOWAIT;
  IF NOT FOUND OR n.kind IS DISTINCT FROM NEW.kind OR n.lease_id IS DISTINCT FROM NEW.lease_id
    OR n.invoice_id IS DISTINCT FROM NEW.invoice_id OR n.payment_id IS DISTINCT FROM NEW.payment_id
    OR n.actor_id IS DISTINCT FROM NEW.actor_id OR n.local_date IS DISTINCT FROM NEW.local_date
    OR n.occurred_at IS DISTINCT FROM NEW.occurred_at OR (n.kind NOT LIKE 'payment_%' AND n.occurrence_key IS DISTINCT FROM NEW.occurrence_key)
    OR n.created_tx_id=txid_current() THEN
   RAISE EXCEPTION 'Historical occurrence unavailable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM app.b010_source_events x WHERE x.org_id=NEW.org_id AND x.kind=NEW.kind
   AND x.id IS DISTINCT FROM NEW.old_source_id AND (
    (NEW.kind='rent_manual' AND (x.actor_id=NEW.actor_id OR x.invoice_id=NEW.invoice_id) AND x.occurrence_key=NEW.occurrence_key)
    OR (NEW.kind IN ('rent_due','rent_overdue') AND x.invoice_id=NEW.invoice_id AND x.occurrence_key=NEW.occurrence_key)
    OR (NEW.kind LIKE 'payment_%' AND x.payment_id=NEW.payment_id)))
  OR EXISTS (SELECT 1 FROM app.b017_occurrences x WHERE x.org_id=NEW.org_id AND x.kind=NEW.kind
   AND x.id IS DISTINCT FROM NEW.neutral_source_id AND (
    (NEW.kind='rent_manual' AND (x.actor_id=NEW.actor_id OR x.invoice_id=NEW.invoice_id) AND x.occurrence_key=NEW.occurrence_key)
    OR (NEW.kind IN ('rent_due','rent_overdue') AND x.invoice_id=NEW.invoice_id AND x.occurrence_key=NEW.occurrence_key)
    OR (NEW.kind LIKE 'payment_%' AND x.payment_id=NEW.payment_id))) THEN
  RAISE EXCEPTION 'Incomplete occurrence binding' USING ERRCODE='23514';
 END IF;
 IF NEW.center_event_id IS NOT NULL THEN
  PERFORM 1 FROM app.b028_center_events e WHERE e.org_id=NEW.org_id AND e.id=NEW.center_event_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Historical occurrence unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT count(*),min(e.id::text)::uuid INTO v_count,v_center FROM app.b028_center_events e
  LEFT JOIN app.b010_source_events bsrc ON bsrc.org_id=e.org_id AND bsrc.id=e.b010_event_id
  LEFT JOIN app.b017_occurrences neu ON neu.org_id=e.org_id AND neu.id=e.neutral_source_id
  WHERE e.org_id=NEW.org_id AND ((bsrc.kind=NEW.kind AND (
    (NEW.kind='rent_manual' AND (bsrc.actor_id=NEW.actor_id OR bsrc.invoice_id=NEW.invoice_id) AND bsrc.occurrence_key=NEW.occurrence_key)
    OR (NEW.kind IN ('rent_due','rent_overdue') AND bsrc.invoice_id=NEW.invoice_id AND bsrc.occurrence_key=NEW.occurrence_key)
    OR (NEW.kind LIKE 'payment_%' AND bsrc.payment_id=NEW.payment_id))) OR (neu.kind=NEW.kind AND (
    (NEW.kind='rent_manual' AND (neu.actor_id=NEW.actor_id OR neu.invoice_id=NEW.invoice_id) AND neu.occurrence_key=NEW.occurrence_key)
    OR (NEW.kind IN ('rent_due','rent_overdue') AND neu.invoice_id=NEW.invoice_id AND neu.occurrence_key=NEW.occurrence_key)
    OR (NEW.kind LIKE 'payment_%' AND neu.payment_id=NEW.payment_id))));
 IF v_count>1 OR (NEW.outcome='no_backfill' AND v_count<>0)
   OR (NEW.outcome='existing_center' AND (v_count<>1 OR NEW.center_event_id IS DISTINCT FROM v_center)) THEN
  RAISE EXCEPTION 'Historical occurrence unavailable' USING ERRCODE='23514';
 END IF;
 IF NEW.outcome='existing_center' AND NOT EXISTS (SELECT 1 FROM app.b028_center_events e
    WHERE e.org_id=NEW.org_id AND e.id=NEW.center_event_id AND
    ((NEW.old_source_id IS NOT NULL AND e.b010_event_id=NEW.old_source_id)
      OR (NEW.neutral_source_id IS NOT NULL AND e.neutral_source_id=NEW.neutral_source_id))) THEN
  RAISE EXCEPTION 'Historical occurrence unavailable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b017_resolution_valid BEFORE INSERT ON app.b017_center_resolutions FOR EACH ROW EXECUTE FUNCTION app.b017_resolution_valid();
REVOKE ALL ON FUNCTION app.b017_resolution_valid() FROM PUBLIC,anon,authenticated,service_role;

-- Both wrappers call this one owner-only authority; no application role can call it.
CREATE FUNCTION app.b017_resolve(p_org uuid,p_old uuid,p_neutral uuid)
RETURNS TABLE(outcome text,center_event_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE b app.b010_source_events; n app.b017_occurrences; r app.b017_center_resolutions;
 v_kind text; v_lease uuid; v_invoice uuid; v_payment uuid; v_actor uuid; v_key text; v_date date; v_at timestamptz;
 v_count integer; v_center uuid;
BEGIN
 PERFORM app.b017_resolution_admit(p_org);
 IF (p_old IS NULL)=(p_neutral IS NULL) THEN RAISE EXCEPTION 'Historical occurrence unavailable' USING ERRCODE='23514'; END IF;
 IF p_old IS NOT NULL THEN
  SELECT * INTO b FROM app.b010_source_events WHERE org_id=p_org AND id=p_old FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Historical occurrence unavailable' USING ERRCODE='23514'; END IF;
  v_kind:=b.kind; v_lease:=b.lease_id; v_invoice:=b.invoice_id; v_payment:=b.payment_id; v_actor:=b.actor_id; v_key:=b.occurrence_key; v_date:=b.local_date; v_at:=b.created_at;
 ELSE
  SELECT * INTO n FROM app.b017_occurrences WHERE org_id=p_org AND id=p_neutral FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Historical occurrence unavailable' USING ERRCODE='23514'; END IF;
  v_kind:=n.kind; v_lease:=n.lease_id; v_invoice:=n.invoice_id; v_payment:=n.payment_id; v_actor:=n.actor_id; v_key:=n.occurrence_key; v_date:=n.local_date; v_at:=n.occurred_at;
 END IF;
 PERFORM app.b017_occurrence_key_lock(p_org,v_kind,v_invoice,v_payment,v_actor,v_key);
 SELECT * INTO r FROM app.b017_center_resolutions x WHERE x.org_id=p_org AND x.kind=v_kind AND (
   (v_kind='rent_manual' AND (x.actor_id=v_actor OR x.invoice_id=v_invoice) AND x.occurrence_key=v_key)
   OR (v_kind IN ('rent_due','rent_overdue') AND x.invoice_id=v_invoice AND x.occurrence_key=v_key)
   OR (v_kind LIKE 'payment_%' AND x.payment_id=v_payment));
 IF FOUND THEN
  IF r.lease_id IS DISTINCT FROM v_lease OR r.invoice_id IS DISTINCT FROM v_invoice OR r.payment_id IS DISTINCT FROM v_payment
   OR r.actor_id IS DISTINCT FROM v_actor OR r.local_date IS DISTINCT FROM v_date OR r.occurred_at IS DISTINCT FROM v_at THEN
   RAISE EXCEPTION 'Historical occurrence mismatch' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT r.outcome,r.center_event_id; RETURN;
 END IF;
 -- Discover the other typed source only under the common key, without a late wait.
 IF p_old IS NULL THEN SELECT * INTO b FROM app.b010_source_events x WHERE x.org_id=p_org AND x.kind=v_kind AND (
   (v_kind='rent_manual' AND (x.actor_id=v_actor OR x.invoice_id=v_invoice) AND x.occurrence_key=v_key)
   OR (v_kind IN ('rent_due','rent_overdue') AND x.invoice_id=v_invoice AND x.occurrence_key=v_key)
   OR (v_kind LIKE 'payment_%' AND x.payment_id=v_payment)) FOR SHARE NOWAIT; END IF;
 IF p_neutral IS NULL THEN SELECT * INTO n FROM app.b017_occurrences x WHERE x.org_id=p_org AND x.kind=v_kind AND (
   (v_kind='rent_manual' AND (x.actor_id=v_actor OR x.invoice_id=v_invoice) AND x.occurrence_key=v_key)
   OR (v_kind IN ('rent_due','rent_overdue') AND x.invoice_id=v_invoice AND x.occurrence_key=v_key)
   OR (v_kind LIKE 'payment_%' AND x.payment_id=v_payment)) FOR SHARE NOWAIT; END IF;
 SELECT count(*),min(e.id::text)::uuid INTO v_count,v_center FROM app.b028_center_events e
  WHERE e.org_id=p_org AND ((b.id IS NOT NULL AND e.b010_event_id=b.id) OR (n.id IS NOT NULL AND e.neutral_source_id=n.id));
 IF v_count>1 THEN RAISE EXCEPTION 'Ambiguous historical occurrence' USING ERRCODE='23514'; END IF;
 INSERT INTO app.b017_center_resolutions(org_id,kind,lease_id,invoice_id,payment_id,actor_id,occurrence_key,local_date,occurred_at,old_source_id,neutral_source_id,center_event_id,outcome)
  VALUES(p_org,v_kind,v_lease,v_invoice,v_payment,v_actor,v_key,v_date,v_at,b.id,n.id,v_center,CASE WHEN v_count=1 THEN 'existing_center' ELSE 'no_backfill' END)
  RETURNING * INTO r;
 RETURN QUERY SELECT r.outcome,r.center_event_id;
END $$;
REVOKE ALL ON FUNCTION app.b017_resolve(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b017_resolve_history(p_org uuid,p_source uuid) RETURNS TABLE(outcome text,center_event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT * FROM app.b017_resolve(p_org,p_source,NULL) $$;
CREATE FUNCTION app.b017_resolve_neutral(p_org uuid,p_source uuid) RETURNS TABLE(outcome text,center_event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT * FROM app.b017_resolve(p_org,NULL,p_source) $$;
REVOKE ALL ON FUNCTION app.b017_resolve_history(uuid,uuid),app.b017_resolve_neutral(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Trusted producers must call this under their verified context before creating
-- either source. New means only that no existing typed source is visible under
-- the held nonblocking canonical key; this function grants no creation rights.
CREATE FUNCTION app.b017_resolve_key(p_org uuid,p_lease uuid,p_kind text,p_invoice uuid,p_payment uuid,p_actor uuid,p_key text)
RETURNS TABLE(outcome text,center_event_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE v_old app.b010_source_events; v_neutral app.b017_occurrences;
BEGIN
 IF p_org IS NULL OR p_lease IS NULL OR p_kind IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 128 OR NOT (
  (p_kind IN ('rent_due','rent_overdue') AND p_invoice IS NOT NULL AND p_payment IS NULL AND p_actor IS NULL)
  OR (p_kind='rent_manual' AND p_invoice IS NOT NULL AND p_payment IS NULL AND p_actor IS NOT NULL)
  OR (p_kind IN ('payment_confirmed','payment_rejected','payment_reversed') AND p_invoice IS NULL AND p_payment IS NOT NULL AND p_actor IS NOT NULL)
 ) THEN RAISE EXCEPTION 'Invalid occurrence key' USING ERRCODE='23514'; END IF;
 PERFORM app.b017_resolution_admit(p_org);
 PERFORM app.b017_occurrence_key_lock(p_org,p_kind,p_invoice,p_payment,p_actor,p_key);
 SELECT * INTO v_old FROM app.b010_source_events x WHERE x.org_id=p_org AND x.kind=p_kind AND (
  (p_kind='rent_manual' AND (x.actor_id=p_actor OR x.invoice_id=p_invoice) AND x.occurrence_key=p_key)
  OR (p_kind IN ('rent_due','rent_overdue') AND x.invoice_id=p_invoice AND x.occurrence_key=p_key)
  OR (p_kind LIKE 'payment_%' AND x.payment_id=p_payment)) FOR SHARE NOWAIT;
 SELECT * INTO v_neutral FROM app.b017_occurrences x WHERE x.org_id=p_org AND x.kind=p_kind AND (
  (p_kind='rent_manual' AND (x.actor_id=p_actor OR x.invoice_id=p_invoice) AND x.occurrence_key=p_key)
  OR (p_kind IN ('rent_due','rent_overdue') AND x.invoice_id=p_invoice AND x.occurrence_key=p_key)
  OR (p_kind LIKE 'payment_%' AND x.payment_id=p_payment)) FOR SHARE NOWAIT;
 IF v_old.id IS NOT NULL AND (v_old.lease_id IS DISTINCT FROM p_lease OR v_old.invoice_id IS DISTINCT FROM p_invoice
  OR v_old.payment_id IS DISTINCT FROM p_payment OR v_old.actor_id IS DISTINCT FROM p_actor) THEN
  RAISE EXCEPTION 'Occurrence source mismatch' USING ERRCODE='23514'; END IF;
 IF v_neutral.id IS NOT NULL AND (v_neutral.lease_id IS DISTINCT FROM p_lease OR v_neutral.invoice_id IS DISTINCT FROM p_invoice
  OR v_neutral.payment_id IS DISTINCT FROM p_payment OR v_neutral.actor_id IS DISTINCT FROM p_actor) THEN
  RAISE EXCEPTION 'Occurrence source mismatch' USING ERRCODE='23514'; END IF;
 IF v_old.id IS NOT NULL THEN RETURN QUERY SELECT * FROM app.b017_resolve(p_org,v_old.id,NULL); RETURN; END IF;
 IF v_neutral.id IS NOT NULL THEN RETURN QUERY SELECT * FROM app.b017_resolve(p_org,NULL,v_neutral.id); RETURN; END IF;
 RETURN QUERY SELECT 'new'::text,NULL::uuid;
END $$;
REVOKE ALL ON FUNCTION app.b017_resolve_key(uuid,uuid,text,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b017_center_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE b app.b010_source_events; n app.b017_occurrences; v_kind text; v_invoice uuid; v_payment uuid; v_actor uuid; v_key text; v_org uuid;
BEGIN
 IF NEW.b010_event_id IS NOT NULL THEN
  SELECT * INTO b FROM app.b010_source_events WHERE org_id=NEW.org_id AND id=NEW.b010_event_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Occurrence unavailable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.b017_old_source_transactions t WHERE t.org_id=b.org_id AND t.source_id=b.id AND t.tx_id=txid_current()) THEN
   RAISE EXCEPTION 'Historical occurrence must be resolved' USING ERRCODE='23505'; END IF;
  v_org:=b.org_id; v_kind:=b.kind; v_invoice:=b.invoice_id; v_payment:=b.payment_id; v_actor:=b.actor_id; v_key:=b.occurrence_key;
 ELSIF NEW.neutral_source_id IS NOT NULL THEN
  SELECT * INTO n FROM app.b017_occurrences WHERE org_id=NEW.org_id AND id=NEW.neutral_source_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Occurrence unavailable' USING ERRCODE='23514'; END IF;
  IF n.created_tx_id<>txid_current() THEN RAISE EXCEPTION 'Historical occurrence must be resolved' USING ERRCODE='23505'; END IF;
  v_org:=n.org_id; v_kind:=n.kind; v_invoice:=n.invoice_id; v_payment:=n.payment_id; v_actor:=n.actor_id; v_key:=n.occurrence_key;
 ELSE RETURN NEW; END IF;
 PERFORM app.b017_occurrence_key_lock(v_org,v_kind,v_invoice,v_payment,v_actor,v_key);
 IF EXISTS (SELECT 1 FROM app.b017_center_resolutions r WHERE r.org_id=v_org AND r.kind=v_kind AND r.outcome='no_backfill' AND (
   (v_kind='rent_manual' AND (r.actor_id=v_actor OR r.invoice_id=v_invoice) AND r.occurrence_key=v_key)
   OR (v_kind IN ('rent_due','rent_overdue') AND r.invoice_id=v_invoice AND r.occurrence_key=v_key)
   OR (v_kind LIKE 'payment_%' AND r.payment_id=v_payment))) THEN
  RAISE EXCEPTION 'Occurrence already resolved' USING ERRCODE='23505';
 END IF;
 IF NEW.b010_event_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.b017_occurrences x
   WHERE x.org_id=v_org AND x.kind=v_kind AND x.created_tx_id<>txid_current() AND (
   (v_kind='rent_manual' AND (x.actor_id=v_actor OR x.invoice_id=v_invoice) AND x.occurrence_key=v_key)
   OR (v_kind IN ('rent_due','rent_overdue') AND x.invoice_id=v_invoice AND x.occurrence_key=v_key)
   OR (v_kind LIKE 'payment_%' AND x.payment_id=v_payment))) THEN
  RAISE EXCEPTION 'Historical occurrence must be resolved' USING ERRCODE='23505';
 END IF;
 IF NEW.b010_event_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.b028_center_events e JOIN app.b017_occurrences x ON x.id=e.neutral_source_id AND x.org_id=e.org_id
   WHERE x.org_id=v_org AND x.kind=v_kind AND (
   (v_kind='rent_manual' AND (x.actor_id=v_actor OR x.invoice_id=v_invoice) AND x.occurrence_key=v_key)
   OR (v_kind IN ('rent_due','rent_overdue') AND x.invoice_id=v_invoice AND x.occurrence_key=v_key)
   OR (v_kind LIKE 'payment_%' AND x.payment_id=v_payment))) THEN
  RAISE EXCEPTION 'Occurrence already resolved' USING ERRCODE='23505';
 END IF;
 IF NEW.neutral_source_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.b010_source_events x WHERE x.org_id=v_org AND x.kind=v_kind AND (
   (v_kind='rent_manual' AND (x.actor_id=v_actor OR x.invoice_id=v_invoice) AND x.occurrence_key=v_key)
   OR (v_kind IN ('rent_due','rent_overdue') AND x.invoice_id=v_invoice AND x.occurrence_key=v_key)
   OR (v_kind LIKE 'payment_%' AND x.payment_id=v_payment)) AND
   (EXISTS (SELECT 1 FROM app.b028_center_events e WHERE e.org_id=x.org_id AND e.b010_event_id=x.id)
    OR NOT EXISTS (SELECT 1 FROM app.b017_old_source_transactions t WHERE t.org_id=x.org_id AND t.source_id=x.id AND t.tx_id=txid_current()))) THEN
  RAISE EXCEPTION 'Historical occurrence must be resolved' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b017_center_insert BEFORE INSERT ON app.b028_center_events FOR EACH ROW EXECUTE FUNCTION app.b017_center_insert();
REVOKE ALL ON FUNCTION app.b017_center_insert() FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION app.b028_center_source_valid() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.b010_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.b010_source_events b WHERE b.id=NEW.b010_event_id AND b.org_id=NEW.org_id AND b.kind=NEW.kind AND b.created_at=NEW.occurred_at) THEN
   RAISE EXCEPTION 'Invalid event source' USING ERRCODE='23514';
 END IF;
 IF NEW.neutral_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.b017_occurrences n WHERE n.id=NEW.neutral_source_id AND n.org_id=NEW.org_id AND n.kind=NEW.kind AND n.occurred_at=NEW.occurred_at) THEN
   RAISE EXCEPTION 'Invalid event source' USING ERRCODE='23514';
 END IF;
 IF NEW.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.repair_vendor_jobs j WHERE j.id=NEW.job_id AND j.org_id=NEW.org_id AND j.ticket_id=NEW.ticket_id AND j.created_at=NEW.occurred_at) THEN
   RAISE EXCEPTION 'Invalid event source' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION app.b028_center_recipient_valid() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE e app.b028_center_events; v_lease uuid; v_property uuid; v_ticket uuid;
BEGIN
 SELECT * INTO e FROM app.b028_center_events WHERE id=NEW.event_id AND org_id=NEW.org_id FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514'; END IF;
 IF (e.b010_event_id IS NOT NULL OR e.neutral_source_id IS NOT NULL) AND NEW.principal_user_id IS NOT NULL THEN
  PERFORM 1 FROM auth.users u WHERE u.id=NEW.principal_user_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514'; END IF;
 END IF;
 IF e.b010_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.b017_old_source_transactions t
   WHERE t.org_id=e.org_id AND t.source_id=e.b010_event_id AND t.tx_id=txid_current()) THEN
  RAISE EXCEPTION 'Historical recipient unavailable' USING ERRCODE='23514';
 END IF;
 IF e.neutral_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.b017_occurrences n
   WHERE n.org_id=e.org_id AND n.id=e.neutral_source_id AND n.created_tx_id=txid_current()) THEN
  RAISE EXCEPTION 'Historical recipient unavailable' USING ERRCODE='23514';
 END IF;
 IF e.b010_event_id IS NOT NULL THEN
  SELECT b.lease_id INTO v_lease FROM app.b010_source_events b WHERE b.id=e.b010_event_id AND b.org_id=e.org_id;
 ELSIF e.neutral_source_id IS NOT NULL THEN
  SELECT n.lease_id INTO v_lease FROM app.b017_occurrences n WHERE n.id=e.neutral_source_id AND n.org_id=e.org_id FOR SHARE NOWAIT;
  IF e.kind LIKE 'payment_%' AND NEW.persona<>'tenant' THEN
   RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514';
  END IF;
  IF e.kind LIKE 'payment_%' AND NEW.persona='tenant' AND NOT EXISTS (SELECT 1 FROM app.b017_occurrences n WHERE n.id=e.neutral_source_id AND n.org_id=e.org_id AND n.payer_contact_id=NEW.contact_id AND n.payer_principal_user_id=NEW.principal_user_id) THEN
   RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514';
  END IF;
 ELSE
  SELECT t.lease_id,t.property_id,t.id INTO v_lease,v_property,v_ticket FROM public.maintenance_tickets t
   JOIN public.repair_vendor_jobs j ON j.ticket_id=t.id AND j.org_id=t.org_id
   WHERE j.id=e.job_id AND j.org_id=e.org_id AND t.id=e.ticket_id FOR SHARE OF t,j NOWAIT;
 END IF;
 IF NEW.persona='staff' THEN
  PERFORM 1 FROM public.org_members m JOIN public.organizations o ON o.id=NEW.org_id
   WHERE m.id=NEW.member_id AND m.user_id=NEW.principal_user_id AND m.status='active'
    AND m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    AND ((e.kind LIKE 'payment_%' AND m.role IN ('admin','manager','accountant')) OR (e.kind IN ('rent_due','rent_overdue','rent_manual') AND m.role IN ('admin','manager')) OR (e.kind='vendor_job_assigned' AND m.role IN ('admin','manager','maintenance'))) FOR SHARE OF m NOWAIT;
 ELSIF NEW.persona='tenant' THEN
  IF v_ticket IS NOT NULL THEN LOCK TABLE public.contacts IN SHARE MODE NOWAIT; END IF;
  PERFORM 1 FROM public.contacts c JOIN public.lease_parties lp ON lp.contact_id=c.id AND lp.org_id=c.org_id
   WHERE c.id=NEW.contact_id AND c.org_id=NEW.org_id AND c.user_id=NEW.principal_user_id AND c.is_tenant AND c.archived_at IS NULL
    AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant') FOR SHARE OF c,lp NOWAIT;
  IF FOUND AND v_ticket IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.maintenance_tickets t WHERE t.id=v_ticket AND t.org_id=NEW.org_id AND (
   t.reported_by_user=NEW.principal_user_id OR t.reported_by_contact_id=NEW.contact_id OR
   (t.reported_by_contact_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.contacts other WHERE other.user_id=t.reported_by_user AND other.is_tenant AND other.archived_at IS NULL AND other.user_id IS DISTINCT FROM NEW.principal_user_id)))) THEN
   RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.persona='owner' THEN
  PERFORM 1 FROM public.contacts c JOIN public.property_owners po ON po.owner_contact_id=c.id AND po.org_id=c.org_id JOIN public.organizations o ON o.id=c.org_id
   WHERE e.kind='vendor_job_assigned' AND c.id=NEW.contact_id AND c.org_id=NEW.org_id AND c.user_id=NEW.principal_user_id AND c.is_owner AND c.archived_at IS NULL
    AND po.property_id=v_property AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=o.timezone) AND po.effective_from<=(clock_timestamp() AT TIME ZONE o.timezone)::date AND (po.effective_to IS NULL OR po.effective_to>(clock_timestamp() AT TIME ZONE o.timezone)::date) FOR SHARE OF c,po NOWAIT;
 ELSE
  PERFORM 1 FROM public.repair_vendor_jobs j JOIN public.maintenance_tickets t ON t.id=j.ticket_id AND t.org_id=j.org_id
   WHERE e.kind='vendor_job_assigned' AND j.id=e.job_id AND j.id=NEW.job_id AND j.ticket_id=NEW.ticket_id AND j.org_id=NEW.org_id
    AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp() AND j.vendor_contact_id IS NOT NULL AND j.vendor_contact_id=t.assigned_vendor_contact_id FOR SHARE OF j,t NOWAIT;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app.b028_center_session(p_org uuid,p_live uuid,p_env text,p_session uuid,p_persona text,p_role text,p_mark uuid DEFAULT NULL,p_cursor uuid DEFAULT NULL)
RETURNS TABLE(recipient_id uuid,kind text,occurred_at timestamptz,read_at timestamptz,continuation uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid(); r record; v_lease uuid; v_property uuid; v_read timestamptz; v_count integer:=0; v_scanned integer:=0; v_after_time timestamptz; v_after_id uuid; v_last_time timestamptz; v_last_id uuid; v_owner_recipients uuid[]:=ARRAY[]::uuid[];
BEGIN
 IF NOT app.b028_center_context(p_org,p_live,p_env,p_session,p_persona,p_role) THEN RETURN; END IF;
 DELETE FROM app.b028_center_cursors WHERE id IN (SELECT cur.id FROM app.b028_center_cursors cur WHERE cur.expires_at<=clock_timestamp() ORDER BY cur.expires_at,cur.id LIMIT 100 FOR UPDATE SKIP LOCKED);
 IF p_cursor IS NOT NULL THEN
  SELECT cur.after_time,cur.after_id INTO v_after_time,v_after_id FROM app.b028_center_cursors cur
   WHERE cur.id=p_cursor AND cur.org_id=p_org AND cur.actor_id=v_actor AND cur.session_id=p_session AND cur.persona=p_persona AND cur.expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 FOR r IN SELECT ent.id AS rid,ent.contact_id,ent.member_id,e.id AS eid,e.kind AS ekind,e.occurred_at AS happened,e.b010_event_id,e.neutral_source_id,e.ticket_id,e.job_id
   FROM app.b028_center_recipients ent JOIN app.b028_center_events e ON e.id=ent.event_id AND e.org_id=ent.org_id
   WHERE ent.org_id=p_org AND ent.persona=p_persona AND ent.principal_user_id=v_actor AND (p_mark IS NULL OR ent.id=p_mark)
     AND (p_mark IS NOT NULL OR v_after_time IS NULL OR (e.occurred_at,ent.id)>(v_after_time,v_after_id))
   ORDER BY e.occurred_at,ent.id LIMIT 500
 LOOP
  v_scanned:=v_scanned+1; v_last_time:=r.happened; v_last_id:=r.rid;
  v_lease:=NULL; v_property:=NULL;
  IF r.b010_event_id IS NOT NULL THEN
   SELECT b.lease_id INTO v_lease FROM app.b010_source_events b WHERE b.org_id=p_org AND b.id=r.b010_event_id AND b.kind=r.ekind;
  ELSIF r.neutral_source_id IS NOT NULL THEN
   SELECT n.lease_id INTO v_lease FROM app.b017_occurrences n WHERE n.org_id=p_org AND n.id=r.neutral_source_id AND n.kind=r.ekind;
  ELSE
   SELECT t.lease_id,t.property_id INTO v_lease,v_property FROM public.maintenance_tickets t JOIN public.repair_vendor_jobs j ON j.ticket_id=t.id AND j.org_id=t.org_id
    WHERE t.org_id=p_org AND t.id=r.ticket_id AND j.id=r.job_id;
  END IF;
  IF p_persona='staff' THEN
   IF NOT EXISTS (SELECT 1 FROM public.org_members m JOIN public.organizations o ON o.id=p_org WHERE m.id=r.member_id AND m.user_id=v_actor AND m.status='active' AND m.role::text=p_role AND m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
     AND ((r.ekind LIKE 'payment_%' AND m.role IN ('admin','manager','accountant')) OR (r.ekind IN ('rent_due','rent_overdue','rent_manual') AND m.role IN ('admin','manager')) OR (r.ekind='vendor_job_assigned' AND m.role IN ('admin','manager','maintenance')))) THEN CONTINUE; END IF;
  ELSIF p_persona='tenant' THEN
   IF v_lease IS NULL THEN CONTINUE; END IF;
   IF r.ticket_id IS NOT NULL THEN LOCK TABLE public.contacts IN SHARE MODE NOWAIT; END IF;
   PERFORM 1 FROM public.contacts c JOIN public.lease_parties lp ON lp.contact_id=c.id AND lp.org_id=c.org_id
    WHERE c.id=r.contact_id AND c.org_id=p_org AND c.user_id=v_actor AND c.is_tenant AND c.archived_at IS NULL AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant') FOR SHARE OF c,lp NOWAIT;
   IF NOT FOUND THEN CONTINUE; END IF;
  ELSE
   IF r.ekind<>'vendor_job_assigned' OR v_property IS NULL THEN CONTINUE; END IF;
   PERFORM 1 FROM public.contacts c JOIN public.property_owners po ON po.owner_contact_id=c.id AND po.org_id=c.org_id JOIN public.organizations o ON o.id=c.org_id
    WHERE c.id=r.contact_id AND c.org_id=p_org AND c.user_id=v_actor AND c.is_owner AND c.archived_at IS NULL AND po.property_id=v_property
      AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=o.timezone) AND po.effective_from<=(clock_timestamp() AT TIME ZONE o.timezone)::date AND (po.effective_to IS NULL OR po.effective_to>(clock_timestamp() AT TIME ZONE o.timezone)::date) FOR SHARE OF c,po NOWAIT;
   IF NOT FOUND THEN CONTINUE; END IF;
  END IF;
  IF v_lease IS NOT NULL THEN PERFORM 1 FROM public.leases l WHERE l.id=v_lease AND l.org_id=p_org FOR SHARE NOWAIT; IF NOT FOUND THEN CONTINUE; END IF; END IF;
  IF r.ticket_id IS NOT NULL THEN
   PERFORM 1 FROM public.maintenance_tickets t WHERE t.id=r.ticket_id AND t.org_id=p_org AND t.lease_id IS NOT DISTINCT FROM v_lease AND t.property_id=v_property FOR SHARE NOWAIT;
   IF NOT FOUND THEN CONTINUE; END IF;
   IF p_persona='tenant' AND NOT app.tenant_owns_ticket(r.ticket_id) THEN CONTINUE; END IF;
   PERFORM 1 FROM public.repair_vendor_jobs j WHERE j.id=r.job_id AND j.ticket_id=r.ticket_id AND j.org_id=p_org FOR SHARE NOWAIT;
   IF NOT FOUND THEN CONTINUE; END IF;
  END IF;
  PERFORM 1 FROM app.b028_center_events e JOIN app.b028_center_recipients ent ON ent.event_id=e.id AND ent.org_id=e.org_id
   WHERE e.id=r.eid AND ent.id=r.rid AND ent.principal_user_id=v_actor AND ent.persona=p_persona FOR SHARE OF e,ent NOWAIT;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
  IF p_mark IS NOT NULL THEN
   INSERT INTO app.b028_center_reads(org_id,recipient_id) VALUES(p_org,r.rid) ON CONFLICT DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
   INSERT INTO app.b028_center_mark_contexts(tx_id,org_id,recipient_id,actor_id,session_id,persona,contact_id,property_id) VALUES(txid_current(),p_org,r.rid,v_actor,p_session,p_persona,r.contact_id,v_property) ON CONFLICT DO NOTHING;
  END IF;
  SELECT rd.read_at INTO v_read FROM app.b028_center_reads rd WHERE rd.org_id=p_org AND rd.recipient_id=r.rid;
  IF p_persona='owner' THEN v_owner_recipients:=array_append(v_owner_recipients,r.rid); END IF;
  recipient_id:=r.rid; kind:=r.ekind; occurred_at:=r.happened; read_at:=v_read; continuation:=NULL; RETURN NEXT;
  v_count:=v_count+1; IF v_count>=100 THEN EXIT; END IF;
 END LOOP;
 IF p_mark IS NULL AND (v_count>=100 OR v_scanned>=500) THEN
  IF NOT EXISTS(SELECT 1 FROM public.auth_sessions sess WHERE sess.id=p_session AND sess.user_id=v_actor AND sess.revoked_at IS NULL AND sess.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO app.b028_center_cursors(org_id,actor_id,session_id,persona,after_time,after_id) VALUES(p_org,v_actor,p_session,p_persona,v_last_time,v_last_id) RETURNING id INTO continuation;
  recipient_id:=NULL;kind:=NULL;occurred_at:=NULL;read_at:=NULL; RETURN NEXT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions sess WHERE sess.id=p_session AND sess.user_id=v_actor AND sess.revoked_at IS NULL AND sess.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 IF p_persona='owner' AND EXISTS(SELECT 1 FROM unnest(v_owner_recipients) AS requested(id) JOIN app.b028_center_recipients ent ON ent.id=requested.id JOIN app.b028_center_events e ON e.id=ent.event_id AND e.org_id=ent.org_id JOIN public.maintenance_tickets t ON t.id=e.ticket_id AND t.org_id=e.org_id
  WHERE NOT EXISTS(SELECT 1 FROM public.organizations o JOIN public.contacts c ON c.org_id=o.id JOIN public.property_owners po ON po.org_id=o.id AND po.owner_contact_id=c.id
   WHERE o.id=p_org AND c.id=ent.contact_id AND c.user_id=v_actor AND c.is_owner AND c.archived_at IS NULL AND po.property_id=t.property_id AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=o.timezone)
    AND po.effective_from<=(clock_timestamp() AT TIME ZONE o.timezone)::date AND (po.effective_to IS NULL OR po.effective_to>(clock_timestamp() AT TIME ZONE o.timezone)::date))) THEN
  RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
END $$;

COMMIT;
