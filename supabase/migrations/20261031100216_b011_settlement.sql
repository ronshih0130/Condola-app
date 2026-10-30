-- B011 settlement is a statement, not a payment or accounting operation.
INSERT INTO public.platform_settings(key,value,description)
VALUES ('deposit_settlements','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'Settlement statement rollout')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE app.settlement_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL,
  currency char(3) NOT NULL REFERENCES public.currencies(code), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,lease_id,currency), UNIQUE(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id) REFERENCES public.leases(org_id,id)
);
CREATE TABLE app.settlement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, record_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0), published boolean NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'), source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL, request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(record_id,revision), UNIQUE(created_by,request_id), UNIQUE(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,record_id) REFERENCES app.settlement_records(org_id,lease_id,id)
);
CREATE TABLE app.settlement_upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, version_id uuid NOT NULL,
  actor_id uuid NOT NULL, session_id uuid NOT NULL, request_id uuid NOT NULL, file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 180),
  mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880), expected_sha256 text NOT NULL CHECK(expected_sha256 ~ '^[0-9a-f]{64}$'), storage_path text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','attached','discarded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 hour',
  UNIQUE(org_id,lease_id,id), UNIQUE(actor_id,request_id), FOREIGN KEY(org_id,lease_id,version_id) REFERENCES app.settlement_versions(org_id,lease_id,id)
);
CREATE TABLE app.settlement_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL,
  intent_id uuid UNIQUE, handover_attachment_id uuid, file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 180),
  mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880), sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text NOT NULL, uploaded_by uuid NOT NULL, upload_session uuid, uploaded_at timestamptz NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,intent_id) REFERENCES app.settlement_upload_intents(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,handover_attachment_id) REFERENCES app.handover_attachments(org_id,lease_id,id),
  CHECK(num_nonnulls(intent_id,handover_attachment_id)=1)
);
CREATE UNIQUE INDEX settlement_handover_evidence_unique ON app.settlement_evidence(org_id,lease_id,handover_attachment_id) WHERE handover_attachment_id IS NOT NULL;
CREATE TABLE app.settlement_evidence_links (
  org_id uuid NOT NULL, lease_id uuid NOT NULL, version_id uuid NOT NULL, evidence_id uuid NOT NULL,
  linked_by uuid NOT NULL, linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,lease_id,version_id,evidence_id),
  FOREIGN KEY(org_id,lease_id,version_id) REFERENCES app.settlement_versions(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,evidence_id) REFERENCES app.settlement_evidence(org_id,lease_id,id)
);
CREATE TABLE app.settlement_gc_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), storage_path text NOT NULL UNIQUE
    CHECK(storage_path ~ '^org/[0-9a-f-]{36}/settlement/[0-9a-f-]{36}/[0-9a-f-]{36}(/sealed)?$'),
  reason text NOT NULL CHECK(reason='demo_reset'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.settlement_gc_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tombstone_id uuid NOT NULL REFERENCES app.settlement_gc_tombstones(id),
  outcome text NOT NULL CHECK(outcome IN ('delete_accepted','storage_unavailable')), attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app.settlement_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL,
  currency char(3) NOT NULL REFERENCES public.currencies(code),
  kind text NOT NULL CHECK (kind IN ('payment','external')),
  payment_id uuid, external_identity text, declared_minor bigint,
  evidence_id uuid NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,lease_id,id),
  FOREIGN KEY (org_id,lease_id) REFERENCES public.leases(org_id,id),
  FOREIGN KEY (org_id,payment_id) REFERENCES public.payments(org_id,id),
  FOREIGN KEY (org_id,lease_id,evidence_id) REFERENCES app.settlement_evidence(org_id,lease_id,id),
  CHECK ((kind='payment' AND payment_id IS NOT NULL AND external_identity IS NULL AND declared_minor IS NULL)
      OR (kind='external' AND payment_id IS NULL AND external_identity IS NOT NULL AND length(btrim(external_identity)) BETWEEN 1 AND 200 AND declared_minor IS NOT NULL AND declared_minor > 0))
);
CREATE UNIQUE INDEX settlement_external_identity ON app.settlement_sources(org_id,lower(btrim(external_identity))) WHERE kind='external';
CREATE UNIQUE INDEX settlement_payment_lease_source ON app.settlement_sources(org_id,lease_id,payment_id) WHERE kind='payment';
-- An agreed cycle is an evidenced human assertion, not a charge or payment.
CREATE TABLE app.settlement_rent_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL,
  currency char(3) NOT NULL REFERENCES public.currencies(code), period_start date NOT NULL, period_end date NOT NULL,
  agreed_monthly_minor bigint NOT NULL CHECK(agreed_monthly_minor>=0), evidence_id uuid NOT NULL,
  asserted_by uuid NOT NULL, asserted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,lease_id,id), FOREIGN KEY(org_id,lease_id) REFERENCES public.leases(org_id,id),
  FOREIGN KEY(org_id,lease_id,evidence_id) REFERENCES app.settlement_evidence(org_id,lease_id,id),
  CHECK(period_end>=period_start),
  EXCLUDE USING gist(org_id WITH =,lease_id WITH =,daterange(period_start,period_end,'[]') WITH &&)
);
CREATE TABLE app.settlement_allocation_roots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, source_id uuid NOT NULL,
  category text NOT NULL CHECK(category IN ('deposit','rent')), cycle_id uuid,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,lease_id,id,source_id),
  FOREIGN KEY(org_id,lease_id,source_id) REFERENCES app.settlement_sources(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,cycle_id) REFERENCES app.settlement_rent_cycles(org_id,lease_id,id),
  CHECK((category='deposit' AND cycle_id IS NULL) OR (category='rent' AND cycle_id IS NOT NULL))
);
CREATE UNIQUE INDEX settlement_deposit_root ON app.settlement_allocation_roots(source_id) WHERE category='deposit';
CREATE UNIQUE INDEX settlement_rent_root ON app.settlement_allocation_roots(source_id,cycle_id) WHERE category='rent';
CREATE TABLE app.settlement_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, source_id uuid NOT NULL, root_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>0), amount_minor bigint NOT NULL CHECK (amount_minor>=0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000), evidence_id uuid NOT NULL, expected_prior_id uuid REFERENCES app.settlement_attributions(id), request_external_identity text, request_id uuid NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(root_id,revision), UNIQUE(created_by,request_id), UNIQUE(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,source_id) REFERENCES app.settlement_sources(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,root_id,source_id) REFERENCES app.settlement_allocation_roots(org_id,lease_id,id,source_id),
  FOREIGN KEY(org_id,lease_id,evidence_id) REFERENCES app.settlement_evidence(org_id,lease_id,id)
);
CREATE TABLE app.settlement_version_attributions (
  org_id uuid NOT NULL, lease_id uuid NOT NULL, version_id uuid NOT NULL, attribution_id uuid NOT NULL,
  PRIMARY KEY(version_id,attribution_id),
  FOREIGN KEY(org_id,lease_id,version_id) REFERENCES app.settlement_versions(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,attribution_id) REFERENCES app.settlement_attributions(org_id,lease_id,id)
);
CREATE TABLE app.settlement_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, version_id uuid NOT NULL,
  item_key uuid NOT NULL, label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 200),
  original_minor bigint NOT NULL CHECK(original_minor>=0), amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000), evidence_id uuid NOT NULL,
  prior_item_id uuid, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(version_id,item_key), UNIQUE(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,prior_item_id) REFERENCES app.settlement_items(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,version_id) REFERENCES app.settlement_versions(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,evidence_id) REFERENCES app.settlement_evidence(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,version_id,evidence_id) REFERENCES app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id)
);
CREATE TABLE app.settlement_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, version_id uuid NOT NULL,
  actor_id uuid NOT NULL, actor_kind text NOT NULL CHECK(actor_kind IN ('staff','tenant','owner')),
  response text NOT NULL CHECK(response IN ('confirm','disagree')), note text NOT NULL CHECK(length(note)<=2000),
  request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(actor_id,request_id),
  FOREIGN KEY(org_id,lease_id,version_id) REFERENCES app.settlement_versions(org_id,lease_id,id)
);
CREATE TABLE app.settlement_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, version_id uuid NOT NULL,
  direction text NOT NULL CHECK(direction IN ('refund','top_up')), amount_minor bigint NOT NULL CHECK(amount_minor>0),
  currency char(3) NOT NULL REFERENCES public.currencies(code), occurred_on date NOT NULL,
  payer_id uuid NOT NULL, payer_kind text NOT NULL CHECK(payer_kind IN ('staff','tenant','owner')),
  payee_id uuid NOT NULL CHECK(payee_id<>payer_id), payee_kind text NOT NULL CHECK(payee_kind IN ('staff','tenant','owner')),
  reporter_id uuid NOT NULL CHECK(reporter_id=payer_id),
  evidence_id uuid NOT NULL, request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reporter_id,request_id), UNIQUE(org_id,lease_id,id), UNIQUE(org_id,lease_id,version_id,id),
  FOREIGN KEY(org_id,lease_id,version_id) REFERENCES app.settlement_versions(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,evidence_id) REFERENCES app.settlement_evidence(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,version_id,evidence_id) REFERENCES app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id)
);
CREATE TABLE app.settlement_external_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, version_id uuid NOT NULL,
  direction text NOT NULL CHECK(direction IN ('refund','top_up')), amount_minor bigint NOT NULL CHECK(amount_minor>0),
  currency char(3) NOT NULL REFERENCES public.currencies(code), occurred_on date NOT NULL,
  payer_id uuid NOT NULL, payer_kind text NOT NULL CHECK(payer_kind IN ('staff','tenant','owner')),
  payee_id uuid NOT NULL CHECK(payee_id<>payer_id), payee_kind text NOT NULL CHECK(payee_kind IN ('staff','tenant','owner')),
  reporter_id uuid NOT NULL, evidence_id uuid NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reporter_id,request_id), UNIQUE(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,version_id) REFERENCES app.settlement_versions(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,version_id,evidence_id) REFERENCES app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id)
);
CREATE TABLE app.settlement_outcome_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, version_id uuid NOT NULL,
  report_id uuid NOT NULL, prior_outcome_id uuid, prior_observation_id uuid, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  evidence_id uuid NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(org_id,lease_id,version_id,report_id) REFERENCES app.settlement_outcomes(org_id,lease_id,version_id,id),
  FOREIGN KEY(org_id,lease_id,prior_outcome_id) REFERENCES app.settlement_outcomes(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,prior_observation_id) REFERENCES app.settlement_external_observations(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,version_id,evidence_id) REFERENCES app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id),
  CHECK(num_nonnulls(prior_outcome_id,prior_observation_id)=1 AND prior_outcome_id IS DISTINCT FROM report_id)
);
CREATE UNIQUE INDEX settlement_reconcile_outcome ON app.settlement_outcome_reconciliations(report_id,prior_outcome_id) WHERE prior_outcome_id IS NOT NULL;
CREATE UNIQUE INDEX settlement_reconcile_observation ON app.settlement_outcome_reconciliations(report_id,prior_observation_id) WHERE prior_observation_id IS NOT NULL;
CREATE TABLE app.settlement_outcome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, lease_id uuid NOT NULL, outcome_id uuid NOT NULL,
  actor_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), event text NOT NULL CHECK(event IN ('acknowledged','disputed','withdrawn','external_reviewed')),
  note text NOT NULL CHECK(length(note)<=2000), evidence_id uuid, expected_last_event_id uuid REFERENCES app.settlement_outcome_events(id), request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,request_id), UNIQUE(outcome_id,revision), FOREIGN KEY(org_id,lease_id,outcome_id) REFERENCES app.settlement_outcomes(org_id,lease_id,id),
  FOREIGN KEY(org_id,lease_id,evidence_id) REFERENCES app.settlement_evidence(org_id,lease_id,id),
  CHECK(event <> 'external_reviewed' OR evidence_id IS NOT NULL)
);
DO $$ DECLARE n text; BEGIN
  FOREACH n IN ARRAY ARRAY['settlement_sources','settlement_rent_cycles','settlement_allocation_roots','settlement_attributions','settlement_records','settlement_versions','settlement_upload_intents','settlement_evidence','settlement_evidence_links','settlement_gc_tombstones','settlement_gc_attempts','settlement_version_attributions','settlement_items','settlement_replies','settlement_outcomes','settlement_external_observations','settlement_outcome_reconciliations','settlement_outcome_events'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',n);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,anon,authenticated',n);
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO service_role',n);
  END LOOP;
END $$;
GRANT UPDATE(created_at) ON app.settlement_sources,app.settlement_records TO service_role;
GRANT UPDATE(status) ON app.settlement_upload_intents TO service_role;
CREATE FUNCTION app.settlement_parent_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'settlement parent is immutable' USING ERRCODE='42501'; END $$;
CREATE TRIGGER settlement_source_immutable BEFORE UPDATE ON app.settlement_sources FOR EACH ROW EXECUTE FUNCTION app.settlement_parent_immutable();
CREATE TRIGGER settlement_record_immutable BEFORE UPDATE ON app.settlement_records FOR EACH ROW EXECUTE FUNCTION app.settlement_parent_immutable();
REVOKE ALL ON FUNCTION app.settlement_parent_immutable() FROM PUBLIC,anon,authenticated;
