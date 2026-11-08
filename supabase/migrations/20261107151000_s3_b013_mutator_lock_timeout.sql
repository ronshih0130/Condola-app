-- S3 BLK-MAC-24: bound every lock wait of the B-013 repair mutators.
-- The production call path (repair-approval.ts -> svc -> svcOn) sets no
-- lock_timeout/statement_timeout and there is no role or database default, so a
-- mutator queued behind a held maintenance_tickets / properties / property_owners
-- / contacts / repair_vendor_jobs row waited as long as the holder. A function
-- SET clause scopes lock_timeout to each call (nested helpers included) and
-- restores the caller's value on exit. A timeout is 55P03 (lock_not_available);
-- the TS layer already rolls back and rethrows it as FlowError with
-- cause.code='55P03' (isDbTimeout). Signatures are the current ones from
-- 20261107120000 (session mutators) and 20261105170000/20261105190000 (vendor
-- appointment, reminder). Bodies, owners, grants and search_path are unchanged.
-- No table, column, grant, flag or data change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER FUNCTION app.b013_submit_estimate(uuid, uuid, text, uuid, uuid, uuid, uuid, bigint, text, smallint, text, jsonb, bytea)
 SET lock_timeout = '3s';
ALTER FUNCTION app.b013_decide_estimate(uuid, uuid, text, uuid, uuid, uuid, text, text, bytea)
 SET lock_timeout = '3s';
ALTER FUNCTION app.b013_authorize_emergency(uuid, uuid, text, uuid, uuid, uuid, text, text, jsonb, bytea)
 SET lock_timeout = '3s';
ALTER FUNCTION app.b013_record_appointment(uuid, uuid, text, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, bytea, text)
 SET lock_timeout = '3s';
ALTER FUNCTION app.b013_record_vendor_appointment(uuid, uuid, text, uuid, uuid, text, timestamptz, timestamptz, timestamptz, timestamptz, text, bytea)
 SET lock_timeout = '3s';
ALTER FUNCTION app.b013_emit_reminder(uuid, uuid, timestamptz)
 SET lock_timeout = '3s';

DO $s3_b013_mutator_lock_timeout$
DECLARE v_missing text;
BEGIN
 SELECT string_agg(s.sig, ', ') INTO v_missing
 FROM unnest(ARRAY[
  'app.b013_submit_estimate(uuid,uuid,text,uuid,uuid,uuid,uuid,bigint,text,smallint,text,jsonb,bytea)',
  'app.b013_decide_estimate(uuid,uuid,text,uuid,uuid,uuid,text,text,bytea)',
  'app.b013_authorize_emergency(uuid,uuid,text,uuid,uuid,uuid,text,text,jsonb,bytea)',
  'app.b013_record_appointment(uuid,uuid,text,uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,bytea,text)',
  'app.b013_record_vendor_appointment(uuid,uuid,text,uuid,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,bytea)',
  'app.b013_emit_reminder(uuid,uuid,timestamptz)']) AS s(sig)
 JOIN pg_proc p ON p.oid = s.sig::regprocedure
 WHERE NOT ('lock_timeout=3s' = ANY (coalesce(p.proconfig, '{}'::text[])))
  OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%');
 IF v_missing IS NOT NULL THEN
  RAISE EXCEPTION 'S3 B-013 mutator lock_timeout missing on: %', v_missing;
 END IF;
END $s3_b013_mutator_lock_timeout$;
COMMIT;
