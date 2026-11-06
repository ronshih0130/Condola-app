BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS app.b009_row_identities (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  bank_account_id uuid NOT NULL,
  row_key text NOT NULL CHECK (row_key ~ '^[0-9a-f]{64}$'),
  bank_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,bank_account_id,row_key),
  UNIQUE(org_id,bank_transaction_id),
  FOREIGN KEY(org_id,bank_account_id) REFERENCES public.bank_accounts(org_id,id),
  FOREIGN KEY(org_id,bank_transaction_id) REFERENCES public.bank_transactions(org_id,id)
);

REVOKE ALL ON app.b009_row_identities FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS b009_row_identities_no_change ON app.b009_row_identities;
CREATE TRIGGER b009_row_identities_no_change BEFORE UPDATE OR DELETE ON app.b009_row_identities
FOR EACH ROW EXECUTE FUNCTION app.b009_decisions_immutable();
DROP TRIGGER IF EXISTS b009_row_identities_no_truncate ON app.b009_row_identities;
CREATE TRIGGER b009_row_identities_no_truncate BEFORE TRUNCATE ON app.b009_row_identities
FOR EACH STATEMENT EXECUTE FUNCTION app.b009_decisions_immutable();

ALTER TABLE app.b009_decisions
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS request_digest text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'b009_decisions_request_pair'
    AND conrelid = 'app.b009_decisions'::regclass) THEN
    ALTER TABLE app.b009_decisions ADD CONSTRAINT b009_decisions_request_pair
      CHECK ((request_id IS NULL AND request_digest IS NULL) OR
        (request_id IS NOT NULL AND request_digest ~ '^[0-9a-f]{64}$'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS b009_decisions_request_uq
  ON app.b009_decisions(org_id,request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS b009_decisions_one_match_bank
  ON app.b009_decisions(org_id,bank_transaction_id) WHERE decision='match';
CREATE UNIQUE INDEX IF NOT EXISTS b009_decisions_one_match_payment
  ON app.b009_decisions(org_id,payment_id) WHERE decision='match';
COMMIT;
