import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const filename = "20261106020000_b010_payment_result_events.sql";
const sql = readFileSync(
  new URL("../../supabase/migrations/" + filename, import.meta.url),
  "utf8",
);

// Function bodies define runtime behavior; they do not execute during migration.
const migrationSql = sql.replace(/\$\$[\s\S]*?\$\$/g, () => "$$ $$");

function tableDefinition(name: string): string {
  const match = sql.match(
    new RegExp(
      `CREATE TABLE IF NOT EXISTS app\\.${name}\\s*\\(([\\s\\S]*?)\\n\\);`,
      "i",
    ),
  );
  assert.ok(match, `Missing idempotent table definition: ${name}`);
  return match[1];
}

function functionDefinition(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(
    new RegExp(
      `\\bCREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+app\\.${escapedName}\\s*` +
        `\\([^;]*?\\)\\s*RETURNS\\b[^;]*?\\bAS\\s*\\$\\$` +
        `[\\s\\S]*?\\$\\$\\s*;`,
      "i",
    ),
  );
  assert.ok(match, `Missing replaceable function definition: ${name}`);
  return match[0];
}

function assertBefore(
  definition: string,
  first: string,
  second: string,
): void {
  const firstIndex = definition.indexOf(first);
  const secondIndex = definition.indexOf(second);
  assert.ok(firstIndex >= 0, `Missing ${first}`);
  assert.ok(secondIndex >= 0, `Missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must precede ${second}`);
}

// These tests retain the requested security requirements even when the supplied
// migration omits them: ALTER SET NOT NULL, session-pinned audit scope, and the
// replacement event emitter must be implemented rather than silently skipped.

test("B-010 migration is atomic, bounded, and contains no migration-time data writes or table grants", () => {
  assert.match(
    sql,
    /^\s*BEGIN;\s*SET LOCAL lock_timeout = '5s';\s*SET LOCAL statement_timeout = '60s';/i,
  );
  assert.match(sql, /COMMIT;\s*$/i);
  assert.equal((migrationSql.match(/^\s*BEGIN;/gim) ?? []).length, 1);
  assert.equal((migrationSql.match(/^\s*COMMIT;/gim) ?? []).length, 1);
  assert.doesNotMatch(sql, /\bROLLBACK\b/i);
  assert.doesNotMatch(
    sql,
    /\bGRANT\b[^;]*\bON\s+(?:TABLE\s+)?app\s*\./i,
  );
  assert.doesNotMatch(
    sql,
    /\bGRANT\b[^;]*\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\b/i,
  );
  assert.doesNotMatch(migrationSql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(
    migrationSql,
    /\bUPDATE\s+(?:ONLY\s+)?(?:app|public)\s*\./i,
  );
  assert.doesNotMatch(
    migrationSql,
    /\bUPDATE\s+(?:"?public"?\s*\.\s*)?"?platform_settings"?\b/i,
  );
  assert.doesNotMatch(
    migrationSql,
    /\b(?:INSERT\s+INTO|MERGE\s+INTO|COPY|TRUNCATE\s+(?:TABLE\s+)?(?:app|public)\s*\.)\b/i,
  );
  // Runtime feature checks are allowed; migration-time flag changes are not.
  assert.doesNotMatch(
    migrationSql,
    /\bplatform_settings\b|\bfeature_flags\b/i,
  );
  assert.doesNotMatch(sql, /\bCREATE TABLE\s+(?!IF NOT EXISTS\b)/i);
  assert.doesNotMatch(sql, /\bCREATE UNIQUE INDEX\s+(?!IF NOT EXISTS\b)/i);
  assert.doesNotMatch(sql, /\bADD COLUMN\s+(?!IF NOT EXISTS\b)/i);
});

test("B-010 lease collectors enforce organization scope and owner selection", () => {
  const definition = tableDefinition("b010_lease_collectors");

  assert.match(definition, /\borg_id uuid NOT NULL\b/i);
  assert.match(definition, /\blease_id uuid NOT NULL\b/i);
  assert.match(
    definition,
    /collector text NOT NULL DEFAULT 'management' CHECK \(collector IN \('management','owner'\)\)/i,
  );
  assert.match(definition, /\bowner_contact_id uuid\s*,/i);
  assert.match(definition, /\bcreated_at timestamptz DEFAULT now\(\)/i);
  assert.match(definition, /\bupdated_at timestamptz DEFAULT now\(\)/i);
  assert.match(definition, /PRIMARY KEY\(org_id,lease_id\)/i);
  assert.match(
    definition,
    /FOREIGN KEY\(org_id,lease_id\) REFERENCES public\.leases\(org_id,id\)/i,
  );
  assert.match(
    definition,
    /FOREIGN KEY\(org_id,owner_contact_id\) REFERENCES public\.contacts\(org_id,id\)/i,
  );
  assert.match(
    definition,
    /CHECK \(collector <> 'owner' OR owner_contact_id IS NOT NULL\)/i,
  );
});

test("B-010 confirmations enforce payment uniqueness and non-null confirmation provenance", () => {
  const definition = tableDefinition("b010_payment_confirmations");

  assert.match(definition, /\bid uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  for (const column of ["org_id", "payment_id", "actor_user_id"]) {
    assert.match(definition, new RegExp(`\\b${column} uuid NOT NULL\\b`, "i"));
  }
  assert.match(definition, /\bon_behalf_of_owner_contact_id uuid\s*,/i);
  assert.match(
    definition,
    /confirmed_via text NOT NULL CHECK \(confirmed_via IN \('owner_direct','staff_proxy','management'\)\)/i,
  );
  assert.match(
    sql,
    /\bALTER\s+TABLE\s+app\.b010_payment_confirmations\s+ALTER\s+COLUMN\s+confirmed_via\s+SET\s+NOT\s+NULL\s*;/i,
  );
  assert.match(
    definition,
    /source text NOT NULL CHECK \(length\(source\) BETWEEN 1 AND 64\)/i,
  );
  assert.match(definition, /\bfrom_status text NOT NULL\b/i);
  assert.match(definition, /\bto_status text NOT NULL\b/i);
  assert.match(definition, /\bcreated_at timestamptz NOT NULL DEFAULT now\(\)/i);
  assert.match(
    definition,
    /CONSTRAINT b010_payment_confirmations_one_per_payment UNIQUE\(org_id,payment_id\)/i,
  );
  assert.match(
    definition,
    /FOREIGN KEY\(org_id,payment_id\) REFERENCES public\.payments\(org_id,id\)/i,
  );
  assert.match(
    definition,
    /CHECK \(\(confirmed_via = 'staff_proxy' AND on_behalf_of_owner_contact_id IS NOT NULL\) OR\s*\(confirmed_via IN \('owner_direct','management'\) AND on_behalf_of_owner_contact_id IS NULL\)\)/i,
  );
});

test("B-010 source events gain nullable metadata and organization-scoped deduplication", () => {
  assert.match(
    sql,
    /ALTER TABLE app\.b010_source_events\s+ADD COLUMN IF NOT EXISTS dedupe_key text,\s+ADD COLUMN IF NOT EXISTS source text,\s+ADD COLUMN IF NOT EXISTS triggered_by_user_id uuid;/i,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS b010_source_events_dedupe_uq\s+ON app\.b010_source_events\(org_id,dedupe_key\) WHERE dedupe_key IS NOT NULL;/i,
  );
});

test("B-010 new tables enable RLS and revoke access from every application role", () => {
  for (const table of ["b010_lease_collectors", "b010_payment_confirmations"]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE app\\.${table} ENABLE ROW LEVEL SECURITY;`, "i"),
    );
    assert.match(
      sql,
      new RegExp(
        `REVOKE ALL ON app\\.${table} FROM PUBLIC,anon,authenticated,service_role;`,
        "i",
      ),
    );
  }
});

test("B-010 confirmations reject mutations except explicit sandbox deletes and reject statement-level truncation", () => {
  const definition = functionDefinition("b010_confirmations_immutable");

  assert.match(
    definition,
    /b010_confirmations_immutable\(\) RETURNS trigger\s+LANGUAGE plpgsql SET search_path=pg_catalog,app AS \$\$/i,
  );
  assert.match(
    definition,
    /IF TG_OP='DELETE' THEN\s+IF current_setting\('app\.b010_sandbox_reset',\s*true\)='on'\s+AND EXISTS\s*\(\s*SELECT 1 FROM public\.organizations o\s+WHERE o\.id=OLD\.org_id AND o\.environment='sandbox'\s*\)\s+THEN\s+RETURN OLD;\s+END IF;\s+END IF;\s+RAISE EXCEPTION 'Payment confirmations are immutable' USING ERRCODE='55000';\s+END \$\$;/i,
  );
  assert.equal((definition.match(/\bRETURN\b/gi) ?? []).length, 1);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION app\.b010_confirmations_immutable\(\) FROM PUBLIC,anon,authenticated,service_role;/i,
  );
  assert.match(
    sql,
    /DROP TRIGGER IF EXISTS b010_payment_confirmations_no_change ON app\.b010_payment_confirmations;\s*CREATE TRIGGER b010_payment_confirmations_no_change BEFORE UPDATE OR DELETE ON app\.b010_payment_confirmations\s+FOR EACH ROW EXECUTE FUNCTION app\.b010_confirmations_immutable\(\);/i,
  );
  assert.match(
    sql,
    /DROP TRIGGER IF EXISTS b010_payment_confirmations_no_truncate ON app\.b010_payment_confirmations;\s*CREATE TRIGGER b010_payment_confirmations_no_truncate BEFORE TRUNCATE ON app\.b010_payment_confirmations\s+FOR EACH STATEMENT EXECUTE FUNCTION app\.b010_confirmations_immutable\(\);/i,
  );
});

test("B-010 result functions use SECURITY DEFINER with a fixed search path and explicit execution grants", () => {
  const signatures = [
    ["b010_lock_owner_payment_context", "uuid,text,uuid,uuid"],
    ["b010_payment_collector", "uuid"],
    ["b010_record_confirmation", "uuid,boolean,text"],
    ["b010_confirmation_audit", "uuid,uuid,text"],
  ] as const;

  for (const [name, argumentsSql] of signatures) {
    const definition = functionDefinition(name);

    assert.match(
      definition,
      /\bSECURITY DEFINER SET search_path=pg_catalog,public,app\s+AS \$\$/i,
    );
    assertBefore(sql, definition, "COMMIT;");
    assert.match(
      sql,
      new RegExp(
        `REVOKE ALL ON FUNCTION app\\.${name}\\(${argumentsSql}\\) FROM PUBLIC,anon,authenticated,service_role;\\s*` +
          `GRANT EXECUTE ON FUNCTION app\\.${name}\\(${argumentsSql}\\) TO authenticated,service_role;`,
        "i",
      ),
    );
  }
});

test("B-010 owner contexts validate organization, environment, session, lease, and authenticated owner", () => {
  const definition = functionDefinition("b010_lock_owner_payment_context");

  assert.match(
    definition,
    /b010_lock_owner_payment_context\(\s*p_org uuid,\s*p_environment text,\s*p_session uuid,\s*p_lease uuid\s*\)\s+RETURNS boolean/i,
  );
  assert.match(definition, /\bv_actor uuid\s*:=\s*auth\.uid\(\);/i);
  assert.match(
    definition,
    /IF NOT EXISTS\s*\(\s*SELECT 1 FROM public\.organizations o\s+WHERE o\.id=p_org AND o\.environment::text=p_environment\s*\) OR NOT EXISTS\s*\(\s*SELECT 1 FROM public\.auth_sessions s\s+WHERE s\.id=p_session\s+AND s\.user_id=v_actor\s+AND s\.revoked_at IS NULL\s+AND s\.expires_at>clock_timestamp\(\)\s*\) THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assert.match(
    definition,
    /PERFORM 1 FROM public\.leases l\s+WHERE l\.id=p_lease AND l\.org_id=p_org\s+FOR SHARE;\s+IF NOT FOUND THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assert.match(
    definition,
    /IF NOT EXISTS\s*\(\s*SELECT 1\s+FROM app\.b010_lease_collectors lc\s+JOIN public\.contacts c ON c\.org_id=p_org AND c\.id=lc\.owner_contact_id\s+WHERE lc\.org_id=p_org\s+AND lc\.lease_id=p_lease\s+AND lc\.collector='owner'\s+AND c\.user_id=v_actor\s+AND c\.archived_at IS NULL\s*\) THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assert.match(
    definition,
    /SELECT EXISTS\s*\(SELECT 1 FROM public\.organizations o JOIN public\.platform_settings f ON f\.key='payment_results_v2' WHERE o\.id=p_org AND o\.feature_flags->'payment_results_v2'='true'::jsonb AND f\.value->'enabled'='true'::jsonb AND jsonb_typeof\(f\.value->'allowed_org_ids'\)='array' AND f\.value->'allowed_org_ids' @> jsonb_build_array\(o\.id::text\)\)\s+INTO v_enabled;\s+IF NOT v_enabled THEN\s+RETURN false;\s+END IF;/i,
  );
  assert.match(
    definition,
    /INSERT INTO app\.b010_payment_contexts\(tx_id,org_id,lease_id,actor_id,session_id,role\)\s+VALUES\(txid_current\(\),p_org,p_lease,v_actor,p_session,'owner'\)\s+ON CONFLICT\(tx_id,org_id,lease_id,actor_id\) DO UPDATE\s+SET session_id=EXCLUDED\.session_id,role=EXCLUDED\.role;\s+RETURN true;/i,
  );
  assertBefore(definition, "FOR SHARE;", "FROM app.b010_lease_collectors");
  assertBefore(definition, "c.archived_at IS NULL", "INTO v_enabled;");
  assertBefore(
    definition,
    "IF NOT v_enabled THEN",
    "INSERT INTO app.b010_payment_contexts",
  );
});

test("B-010 collector requires the current actor's transaction context for the payment scope", () => {
  const definition = functionDefinition("b010_payment_collector");

  assert.match(definition, /\bv_actor uuid\s*:=\s*auth\.uid\(\);/i);
  assert.match(
    definition,
    /SELECT p\.org_id,\s*p\.lease_id INTO v_org,\s*v_lease\s+FROM public\.payments p\s+WHERE p\.id=p_payment\s+AND EXISTS\s*\(\s*SELECT 1 FROM app\.b010_payment_contexts ctx\s+WHERE ctx\.tx_id=txid_current\(\)\s+AND ctx\.actor_id=v_actor\s+AND ctx\.org_id=p\.org_id\s+AND ctx\.lease_id=p\.lease_id\s*\);/i,
  );
  assert.match(
    definition,
    /IF NOT FOUND THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assertBefore(
    definition,
    "IF NOT FOUND THEN",
    "FROM app.b010_lease_collectors",
  );
});

test("B-010 collector returns the scoped collector or the management default", () => {
  const definition = functionDefinition("b010_payment_collector");

  assert.match(
    definition,
    /b010_payment_collector\(p_payment uuid\)\s+RETURNS TABLE\(collector text,\s*owner_contact_id uuid\)/i,
  );
  assert.match(
    definition,
    /RETURN QUERY\s+SELECT lc\.collector,\s*lc\.owner_contact_id\s+FROM app\.b010_lease_collectors lc\s+WHERE lc\.org_id=v_org AND lc\.lease_id=v_lease;\s+IF NOT FOUND THEN\s+RETURN QUERY SELECT 'management'::text,\s*NULL::uuid;\s+END IF;/i,
  );
});

test("B-010 recording removes caller-controlled provenance and locks the confirmed payment", () => {
  const definition = functionDefinition("b010_record_confirmation");
  const drop =
    "DROP FUNCTION IF EXISTS app.b010_record_confirmation(uuid,text,uuid,text,text,text);";

  assert.match(
    sql,
    /DROP FUNCTION IF EXISTS app\.b010_record_confirmation\(uuid,text,uuid,text,text,text\);/i,
  );
  assertBefore(sql, drop, definition);
  assert.match(
    definition,
    /b010_record_confirmation\(\s*p_payment uuid,\s*p_proxy_owner_confirmed boolean,\s*p_source text\s*\)\s+RETURNS uuid/i,
  );
  assert.doesNotMatch(
    definition,
    /\bp_(?:via|on_behalf|from|to)\b/i,
  );
  assert.match(definition, /\bv_actor uuid\s*:=\s*auth\.uid\(\);/i);
  assert.match(
    definition,
    /IF v_actor IS NULL THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assert.match(
    definition,
    /SELECT p\.\* INTO v_payment\s+FROM public\.payments p\s+WHERE p\.id=p_payment\s+FOR UPDATE;\s+IF NOT FOUND THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assert.match(
    definition,
    /SELECT o\.environment::text,\s*o\.live_org_id\s+INTO v_environment,\s*v_live_org\s+FROM public\.organizations o\s+WHERE o\.id=v_payment\.org_id;\s+IF NOT FOUND THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assert.match(
    definition,
    /IF v_payment\.status IS DISTINCT FROM 'confirmed' THEN\s+RAISE EXCEPTION 'Payment transition unavailable' USING ERRCODE='23514';\s+END IF;/i,
  );
  assert.match(
    definition,
    /IF NOT EXISTS\s*\(\s*SELECT 1 FROM app\.b010_payment_requirements r\s+WHERE r\.tx_id=txid_current\(\)\s+AND r\.payment_id=p_payment\s+AND r\.kind='payment_confirmed'\s+AND r\.actor_id=v_actor\s*\) THEN\s+RAISE EXCEPTION 'Payment transition unavailable' USING ERRCODE='23514';\s+END IF;/i,
  );
  assert.match(
    definition,
    /IF p_source IS NULL OR p_source !~ '\^\[a-z_\]\{1,64\}\$' THEN\s+RAISE EXCEPTION 'Invalid payment confirmation source' USING ERRCODE='22023';\s+END IF;/i,
  );
  assertBefore(definition, "IF v_actor IS NULL", "FOR UPDATE;");
  assertBefore(definition, "FOR UPDATE;", "FROM app.b010_payment_requirements");
  assertBefore(
    definition,
    "FROM app.b010_payment_requirements",
    "INSERT INTO app.b010_payment_confirmations",
  );
  assertBefore(
    definition,
    "Invalid payment confirmation source",
    "INSERT INTO app.b010_payment_confirmations",
  );
});

test("B-010 recording derives management, direct-owner, and consenting staff-proxy provenance on the server", () => {
  const definition = functionDefinition("b010_record_confirmation");

  assert.match(
    definition,
    /SELECT lc\.collector,\s*lc\.owner_contact_id\s+INTO v_collector,\s*v_owner_contact\s+FROM app\.b010_lease_collectors lc\s+WHERE lc\.org_id=v_payment\.org_id AND lc\.lease_id=v_payment\.lease_id;\s+IF NOT FOUND THEN\s+v_collector := 'management';\s+v_owner_contact := NULL;\s+END IF;/i,
  );
  assert.match(
    definition,
    /SELECT EXISTS\s*\(\s*SELECT 1 FROM app\.b010_payment_contexts ctx\s+WHERE ctx\.tx_id=txid_current\(\)\s+AND ctx\.actor_id=v_actor\s+AND ctx\.org_id=v_payment\.org_id\s+AND ctx\.lease_id=v_payment\.lease_id\s+AND ctx\.role IN \('admin','manager','accountant'\)\s*\) INTO v_staff;/i,
  );
  assert.match(
    definition,
    /SELECT EXISTS\s*\(\s*SELECT 1 FROM public\.contacts c\s+WHERE c\.org_id=v_payment\.org_id\s+AND c\.id=v_owner_contact\s+AND c\.user_id=v_actor\s+AND c\.archived_at IS NULL\s*\) INTO v_owner;/i,
  );
  assert.match(
    definition,
    /IF v_collector='management' AND v_staff THEN\s+v_via := 'management';\s+v_on_behalf := NULL;\s+ELSIF v_collector='owner' AND v_owner THEN\s+v_via := 'owner_direct';\s+v_on_behalf := NULL;\s+ELSIF v_collector='owner' AND v_staff AND p_proxy_owner_confirmed IS TRUE THEN\s+v_via := 'staff_proxy';\s+v_on_behalf := v_owner_contact;\s+ELSE\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assert.match(
    definition,
    /PERFORM pg_advisory_xact_lock\(hashtextextended\('b010_confirm:'\|\|p_payment::text,0\)\);/i,
  );
  assertBefore(
    definition,
    "IF v_collector='management'",
    "PERFORM pg_advisory_xact_lock",
  );
  assertBefore(
    definition,
    "PERFORM pg_advisory_xact_lock",
    "INSERT INTO app.b010_payment_confirmations",
  );
  assert.match(
    definition,
    /INSERT INTO app\.b010_payment_confirmations\s*\(\s*org_id,\s*payment_id,\s*actor_user_id,\s*on_behalf_of_owner_contact_id,\s*confirmed_via,\s*source,\s*from_status,\s*to_status\s*\)\s*VALUES\s*\(\s*v_payment\.org_id,\s*p_payment,\s*v_actor,\s*v_on_behalf,\s*v_via,\s*p_source,\s*'submitted',\s*'confirmed'\s*\)\s*RETURNING id INTO v_id;/i,
  );
  assert.match(
    definition,
    /EXCEPTION WHEN unique_violation THEN\s+RAISE EXCEPTION 'Payment already confirmed' USING ERRCODE='23505';/i,
  );
  assert.match(definition, /RETURN v_id;/i);
});

test("B-010 confirmation audit is stable and scopes both authorization paths to organization and environment", () => {
  const definition = functionDefinition("b010_confirmation_audit");

  assert.match(
    sql,
    /DROP FUNCTION IF EXISTS app\.b010_confirmation_audit\(uuid\);/i,
  );
  assert.match(
    definition,
    /b010_confirmation_audit\(\s*p_payment uuid,\s*p_org uuid,\s*p_environment text\s*\)\s+RETURNS TABLE\(\s*actor_user_id uuid,\s*on_behalf_of_owner_contact_id uuid,\s*confirmed_via text,\s*source text,\s*from_status text,\s*to_status text,\s*created_at timestamptz\s*\)/i,
  );
  assert.match(
    definition,
    /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app/i,
  );
  assert.match(
    definition,
    /RETURN QUERY\s+SELECT c\.actor_user_id,\s*c\.on_behalf_of_owner_contact_id,\s*c\.confirmed_via,\s*c\.source,\s*c\.from_status,\s*c\.to_status,\s*c\.created_at\s+FROM app\.b010_payment_confirmations c\s+JOIN public\.payments p ON p\.org_id=c\.org_id AND p\.id=c\.payment_id\s+JOIN public\.organizations o ON o\.id=p\.org_id\s+WHERE p\.id=p_payment\s+AND p\.org_id=p_org\s+AND o\.id=p_org\s+AND o\.environment::text=p_environment/i,
  );
  assert.match(
    definition,
    /EXISTS\s*\(\s*SELECT 1\s+FROM public\.org_members m\s+WHERE m\.org_id=CASE WHEN o\.environment='sandbox' THEN o\.live_org_id ELSE o\.id END\s+AND m\.user_id=auth\.uid\(\)\s+AND m\.status='active'\s+AND m\.role IN \('admin','manager','accountant'\)\s*\)/i,
  );
  assert.match(
    definition,
    /OR EXISTS\s*\(\s*SELECT 1 FROM public\.contacts owner_contact\s+WHERE owner_contact\.org_id=p_org\s+AND owner_contact\.user_id=auth\.uid\(\)\s+AND\s*\(\s*owner_contact\.id=c\.on_behalf_of_owner_contact_id\s+OR EXISTS\s*\(\s*SELECT 1 FROM app\.b010_lease_collectors lc\s+WHERE lc\.org_id=p\.org_id\s+AND lc\.lease_id=p\.lease_id\s+AND lc\.collector='owner'\s+AND lc\.owner_contact_id=owner_contact\.id\s*\)\s*\)\s*\)\s*\);/i,
  );
});

test("B-010 confirmation audit pins caller-supplied scope to transaction settings", () => {
  const definition = functionDefinition("b010_confirmation_audit");
  const returnQuery = /\bRETURN\s+QUERY\b/i.exec(definition);
  assert.ok(returnQuery, "Audit must return a scoped query");

  const beforeQuery = definition.slice(0, returnQuery.index);
  const query = definition.slice(returnQuery.index);
  const scope = query.match(
    /\bWHERE\b([\s\S]*?)\bAND\s*\(\s*EXISTS\s*\(/i,
  );
  assert.ok(scope, "Audit must apply scope before both authorization paths");
  assert.doesNotMatch(
    scope[1],
    /\bOR\b/i,
    "Audit scope predicates must remain conjunctive",
  );

  // The requested scope must be tied to the columns used by the query.
  assert.match(scope[1], /\bAND\s+p\.org_id\s*=\s*p_org\b/i);
  assert.match(
    scope[1],
    /\bAND\s+o\.environment\s*::\s*text\s*=\s*p_environment\b/i,
  );

  // Accept direct guards or outer AND predicates, including text comparisons
  // such as p.org_id::text=v_active_org. Reading a setting alone is insufficient.
  for (const [parameter, setting, cast, scopedColumn] of [
    ["p_org", "app.active_org_id", "uuid", "p\\.org_id"],
    ["p_environment", "app.env", "text", "o\\.environment"],
  ] as const) {
    const escapedSetting = setting.replace(/\./g, "\\.");
    const optionalCast = `(?:\\s*::\\s*(?:${cast}|text)\\b)?`;
    const settingRead =
      `current_setting\\(\\s*'${escapedSetting}'\\s*,\\s*true\\s*\\)`;
    const expression =
      `(?:NULLIF\\(\\s*${settingRead}\\s*,\\s*''\\s*\\)|${settingRead})` +
      optionalCast;

    const references = [expression];
    const assignments = new RegExp(
      `\\b([a-z_][a-z0-9_]*)\\s+(?:(?:uuid|text)\\s+)?` +
        `(?::=|DEFAULT)\\s*${expression}\\s*;`,
      "gi",
    );

    for (const match of beforeQuery.matchAll(assignments)) {
      references.push(`\\b${match[1]}\\b${optionalCast}`);
    }

    const reference = `(?:${references.join("|")})`;
    const parameterOperand = `\\b${parameter}\\b${optionalCast}`;
    const scopedOperand =
      `(?:\\b${parameter}\\b|\\b${scopedColumn}\\b)${optionalCast}`;
    const comparison =
      `(?:${parameterOperand}\\s+IS\\s+DISTINCT\\s+FROM\\s+${reference}|` +
      `${reference}\\s+IS\\s+DISTINCT\\s+FROM\\s+${parameterOperand})`;

    const guard = beforeQuery.match(
      new RegExp(
        `\\bIF\\s+${comparison}\\s+THEN\\s+` +
          `RAISE\\s+EXCEPTION\\s+'[^']+'\\s+USING\\s+ERRCODE\\s*=\\s*'42501';\\s+END\\s+IF;`,
        "i",
      ),
    );

    const predicate = scope[1].match(
      new RegExp(
        `\\bAND\\s+(?:${scopedOperand}\\s*=\\s*${reference}|` +
          `${reference}\\s*=\\s*${scopedOperand})(?=\\s|$)`,
        "i",
      ),
    );

    assert.ok(
      guard || predicate,
      `Audit must bind ${parameter} to ${setting} with a fail-closed guard or outer AND predicate`,
    );
  }
});

test("B-010 payment event emission is redefined with metadata and organization-scoped conflict reuse", () => {
  const definition = functionDefinition("b010_emit_payment_event");

  assertBefore(sql, definition, "COMMIT;");
  assert.match(
    definition,
    /\bSECURITY DEFINER SET search_path=pg_catalog,public,app\s+AS \$\$/i,
  );

  const insert = definition.match(
    /INSERT INTO app\.b010_source_events\s*\(([^)]+)\)([\s\S]*?);/i,
  );
  assert.ok(insert, "Emitter must insert into b010_source_events");

  const columns = insert[1]
    .split(",")
    .map((column) => column.trim().toLowerCase());

  for (const column of [
    "org_id",
    "dedupe_key",
    "source",
    "triggered_by_user_id",
  ]) {
    assert.ok(columns.includes(column), `Event insert must include ${column}`);
  }

  assert.match(
    insert[0],
    /ON CONFLICT\s*\(\s*org_id\s*,\s*dedupe_key\s*\)\s+WHERE dedupe_key IS NOT NULL\s+DO\s+(?:NOTHING|UPDATE\s+SET)\b/i,
  );

  if (/\bDO NOTHING\b/i.test(insert[0])) {
    const reuse = definition.slice(
      definition.indexOf(insert[0]) + insert[0].length,
    );

    assert.match(
      reuse,
      /SELECT\s+(?:[a-z_][a-z0-9_]*\.)?id\s+INTO\s+[a-z_][a-z0-9_]*\s+FROM app\.b010_source_events\b[\s\S]*?\bWHERE\s+(?:[a-z_][a-z0-9_]*\.)?org_id\s*=\s*[^;]+?\s+AND\s+(?:[a-z_][a-z0-9_]*\.)?dedupe_key\s*=\s*[^;]+;/i,
      "DO NOTHING must retrieve the existing event using both organization and dedupe key",
    );
  } else {
    // An upsert must return the existing row without replacing its provenance.
    assert.match(
      insert[0],
      /\bRETURNING\s+(?:[a-z_][a-z0-9_]*\.)?id\s+INTO\s+[a-z_][a-z0-9_]*\s*;/i,
    );
    const conflictUpdate = insert[0].split(/\bDO UPDATE SET\b/i)[1];
    assert.ok(conflictUpdate);
    assert.doesNotMatch(
      conflictUpdate,
      /(?:\bSET\b|^|,)\s*(?:id|org_id|source|triggered_by_user_id)\s*=/i,
      "Conflict reuse must preserve the existing event identity and attribution",
    );
  }

  assert.match(definition, /\bRETURN\s+[a-z_][a-z0-9_]*\s*;/i);
});
