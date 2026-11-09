-- Sanitized fingerprint of one disposable database.
-- Emits catalog metadata, row counts, and content hashes. No row payloads.
\pset pager off
\pset tuples_only on
\pset format unaligned
SET client_min_messages TO warning;
SET timezone TO 'UTC';
SET bytea_output TO hex;
SET DateStyle TO ISO, YMD;
SET extra_float_digits TO 3;

CREATE OR REPLACE FUNCTION pg_temp.condola_pg17_fingerprint()
RETURNS SETOF text
LANGUAGE plpgsql
AS $fn$
DECLARE
  rec record;
  cnt bigint;
  digest text;
  lv text;
  called text;
  seq_start text;
  seq_inc text;
  seq_min text;
  seq_max text;
  seq_cache text;
  seq_cycle text;
BEGIN
  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2
  LOOP
    EXECUTE format(
      'SELECT count(*)::bigint, md5(coalesce(string_agg(md5(to_jsonb(x)::text), '''' ORDER BY md5(to_jsonb(x)::text)), '''')) FROM %I.%I AS x',
      rec.sch, rec.rel
    ) INTO cnt, digest;
    RETURN NEXT format('COUNT %s %s %s', rec.sch, rec.rel, cnt);
    RETURN NEXT format('CONTENT %s %s %s', rec.sch, rec.rel, digest);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS seq, c.oid AS seq_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT last_value::text, is_called::text FROM %I.%I', rec.sch, rec.seq)
      INTO lv, called;
    SELECT s.seqstart::text, s.seqincrement::text, s.seqmin::text, s.seqmax::text,
           s.seqcache::text, s.seqcycle::text
      INTO seq_start, seq_inc, seq_min, seq_max, seq_cache, seq_cycle
    FROM pg_sequence s
    WHERE s.seqrelid = rec.seq_oid;
    RETURN NEXT format(
      'SEQUENCE %s %s %s %s %s %s %s %s %s %s',
      rec.sch, rec.seq,
      coalesce(lv, 'NULL'), coalesce(called, 'NULL'),
      coalesce(seq_start, 'NULL'), coalesce(seq_inc, 'NULL'),
      coalesce(seq_min, 'NULL'), coalesce(seq_max, 'NULL'),
      coalesce(seq_cache, 'NULL'), coalesce(seq_cycle, 'NULL')
    );
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel, a.attname AS attname,
           row_number() OVER (PARTITION BY a.attrelid ORDER BY a.attnum) AS pos,
           md5(concat_ws('|',
             format_type(a.atttypid, a.atttypmod),
             a.attnotnull::text,
             a.attidentity,
             a.attgenerated,
             coalesce(pg_get_expr(ad.adbin, ad.adrelid), '')
           )) AS digest
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attnum > 0
      AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p', 'm', 'v')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2, 4
  LOOP
    RETURN NEXT format('COLUMN %s %s %s %s %s', rec.sch, rec.rel, rec.pos, rec.attname, rec.digest);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel, con.conname AS conname, con.contype AS contype,
           regexp_replace(pg_get_constraintdef(con.oid), E'\\s+', ' ', 'g') AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2, 3
  LOOP
    RETURN NEXT format(E'CONSTRAINT\t%s\t%s\t%s\t%s\t%s', rec.sch, rec.rel, rec.conname, rec.contype, rec.def);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel, md5(pg_get_indexdef(c.oid)) AS digest
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'i'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2
  LOOP
    RETURN NEXT format('INDEX %s %s %s', rec.sch, rec.rel, rec.digest);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel, md5(pg_get_viewdef(c.oid, true)) AS digest
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2
  LOOP
    RETURN NEXT format('VIEW %s %s %s', rec.sch, rec.rel, rec.digest);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, p.proname AS proname,
           coalesce(pg_get_function_identity_arguments(p.oid), '') AS args,
           md5(concat_ws('|',
             CASE WHEN p.prokind = 'a' THEN p.prosrc ELSE pg_get_functiondef(p.oid) END,
             CASE
               WHEN p.proacl IS NULL OR p.proacl = acldefault('f'::"char", p.proowner) THEN '<default>'
               ELSE (
                 SELECT string_agg(item, ',' ORDER BY item)
                 FROM regexp_split_to_table(trim(both '{}' FROM p.proacl::text), ',') AS item
               )
             END,
             p.prosecdef::text,
             p.provolatile
           )) AS digest
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2, 3
  LOOP
    RETURN NEXT format('FUNCTION %s %s %s %s', rec.sch, rec.proname, md5(rec.args), rec.digest);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel, t.tgname AS tgname,
           md5(pg_get_triggerdef(t.oid)) AS digest
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2, 3
  LOOP
    RETURN NEXT format('TRIGGER %s %s %s %s', rec.sch, rec.rel, rec.tgname, rec.digest);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel, c.relkind AS relkind,
           CASE
             WHEN c.relacl IS NULL
               OR c.relacl = acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner)
             THEN '<default>'
             ELSE (
               SELECT string_agg(item, ',' ORDER BY item)
               FROM regexp_split_to_table(trim(both '{}' FROM c.relacl::text), ',') AS item
             )
           END AS acl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2, 3
  LOOP
    RETURN NEXT format('ACL %s %s %s %s', rec.sch, rec.rel, rec.relkind, rec.acl);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch,
           CASE
             WHEN n.nspacl IS NULL OR n.nspacl = acldefault('n'::"char", n.nspowner) THEN '<default>'
             ELSE (
               SELECT string_agg(item, ',' ORDER BY item)
               FROM regexp_split_to_table(trim(both '{}' FROM n.nspacl::text), ',') AS item
             )
           END AS acl
    FROM pg_namespace n
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1
  LOOP
    RETURN NEXT format('ACL_SCHEMA %s %s', rec.sch, rec.acl);
  END LOOP;

  FOR rec IN
    SELECT pg_get_userbyid(d.defaclrole) AS owner, coalesce(n.nspname, '-') AS sch,
           d.defaclobjtype AS objtype,
           coalesce((
             SELECT string_agg(item, ',' ORDER BY item)
             FROM regexp_split_to_table(trim(both '{}' FROM d.defaclacl::text), ',') AS item
           ), '<default>') AS acl
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    ORDER BY 1, 2, 3
  LOOP
    RETURN NEXT format('DEFAULT_ACL %s %s %s %s', rec.owner, rec.sch, rec.objtype, rec.acl);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel,
           c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2
  LOOP
    RETURN NEXT format('RLS %s %s %s %s', rec.sch, rec.rel, rec.rls, rec.forced);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel, pol.polname AS polname,
           md5(concat_ws('|',
             pol.polcmd,
             pol.polpermissive::text,
             pol.polroles::text,
             coalesce(pg_get_expr(pol.polqual, pol.polrelid), ''),
             coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
           )) AS digest
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    ORDER BY 1, 2, 3
  LOOP
    RETURN NEXT format('POLICY %s %s %s %s', rec.sch, rec.rel, rec.polname, rec.digest);
  END LOOP;

  FOR rec IN
    SELECT extname, extversion
    FROM pg_extension
    ORDER BY 1
  LOOP
    RETURN NEXT format('EXTENSION %s %s', rec.extname, rec.extversion);
  END LOOP;

  FOR rec IN
    SELECT n.nspname AS sch, c.relname AS rel,
           CASE WHEN d.objsubid = 0 THEN '-' ELSE a.attname END AS col,
           md5(d.description) AS digest
    FROM pg_description d
    JOIN pg_class c ON c.oid = d.objoid AND d.classoid = 'pg_class'::regclass
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
      AND (d.objsubid = 0 OR NOT a.attisdropped)
    ORDER BY 1, 2, 3
  LOOP
    RETURN NEXT format('COMMENT %s %s %s %s', rec.sch, rec.rel, rec.col, rec.digest);
  END LOOP;
END
$fn$;

SELECT pg_temp.condola_pg17_fingerprint();
