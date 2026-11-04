-- Bank match decisions store a fixed reason code.
-- Existing free text is rewritten to other. The append-only trigger is
-- removed only for that rewrite, then restored.
-- Re-run keeps the same check and leaves codes unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP TRIGGER IF EXISTS b009_decisions_no_change ON app.b009_decisions;

UPDATE app.b009_decisions
   SET reason = 'other'
 WHERE reason IS NULL
    OR reason NOT IN ('confirmed_amount', 'wrong_payment', 'duplicate', 'other');

CREATE TRIGGER b009_decisions_no_change
  BEFORE UPDATE OR DELETE ON app.b009_decisions
  FOR EACH ROW EXECUTE FUNCTION app.b009_decisions_immutable();

DO $$
DECLARE
  old_name text;
BEGIN
  SELECT c.conname INTO old_name
    FROM pg_constraint c
   WHERE c.conrelid = 'app.b009_decisions'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%btrim(reason)%';
  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app.b009_decisions DROP CONSTRAINT %I', old_name);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'b009_decisions_reason_code'
  ) THEN
    ALTER TABLE app.b009_decisions
      ADD CONSTRAINT b009_decisions_reason_code
      CHECK (reason IN ('confirmed_amount', 'wrong_payment', 'duplicate', 'other'));
  END IF;
END $$;
COMMIT;
