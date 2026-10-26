-- Version 20261024100000.
-- TRUNCATE skips row triggers, so it would bypass the append-only access-log
-- guard and every other BEFORE DELETE trigger. anon and authenticated keep
-- their row DML grants and lose TRUNCATE on current public tables and on
-- tables the migration role creates later.

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
