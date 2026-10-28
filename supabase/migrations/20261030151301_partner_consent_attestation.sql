-- Version 20261030151301: immutable authority and consenter snapshots.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.partner_agreement_consents
  ADD COLUMN IF NOT EXISTS authority_attested boolean,
  ADD COLUMN IF NOT EXISTS actor_role text,
  ADD COLUMN IF NOT EXISTS consenter_name text;

-- NOT VALID avoids rejecting legacy rows during deployment. PostgreSQL still
-- enforces each CHECK on every new INSERT. Explicit null checks are deliberate.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.partner_agreement_consents'::regclass
      AND conname = 'partner_consents_authority_attested_check'
  ) THEN
    ALTER TABLE public.partner_agreement_consents
      ADD CONSTRAINT partner_consents_authority_attested_check
      CHECK (authority_attested IS TRUE) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.partner_agreement_consents'::regclass
      AND conname = 'partner_consents_actor_role_check'
  ) THEN
    ALTER TABLE public.partner_agreement_consents
      ADD CONSTRAINT partner_consents_actor_role_check
      CHECK (actor_role IS NOT NULL AND actor_role IN ('owner', 'admin')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.partner_agreement_consents'::regclass
      AND conname = 'partner_consents_consenter_name_check'
  ) THEN
    ALTER TABLE public.partner_agreement_consents
      ADD CONSTRAINT partner_consents_consenter_name_check
      CHECK (consenter_name IS NOT NULL
             AND pg_catalog.btrim(consenter_name) <> ''
             AND pg_catalog.char_length(consenter_name) <= 200) NOT VALID;
  END IF;
END
$migration$;

-- Existing table-level privileges, RLS and append-only triggers cover these columns.
RESET lock_timeout;
RESET statement_timeout;
