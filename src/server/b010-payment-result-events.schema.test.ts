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
  const match = sql.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION app\\.${name}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$;`,
      "i",
    ),
  );
  assert.ok(match, `Missing replaceable function definition: ${name}`);
  return match[0];
}

test("B-010 migration is atomic, bounded, and contains no migration-time data writes or table grants", () => {
  assert.match(
    sql,
    /^\s*BEGIN;\s*SET LOCAL lock_timeout = '5s';\s*SET LOCAL statement_timeout = '60s';/i,
  );
  assert.match(sql, /COMMIT;\s*$/i);
  assert.equal((sql.match(/^\s*COMMIT;/gim) ?? []).length, 1);
  assert.doesNotMatch(sql, /\bROLLBACK\b/i);
  assert.doesNotMatch(
    sql,
    /\bGRANT\b[^;]*\bON\s+(?:TABLE\s+)?app\s*\./i,
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
    /\b(?:INSERT\s+INTO|MERGE\s+INTO|COPY)\b/i,
  );
  assert.doesNotMatch(sql, /\bplatform_settings\b|\bfeature_flags\b/i);
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

test("B-010 confirmations enforce payment uniqueness and confirmation provenance", () => {
  const definition = tableDefinition("b010_payment_confirmations");

  assert.match(definition, /\bid uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  for (const column of ["org_id", "payment_id", "actor_user_id"]) {
    assert.match(definition, new RegExp(`\\b${column} uuid NOT NULL\\b`, "i"));
  }
  assert.match(definition, /\bon_behalf_of_owner_contact_id uuid\s*,/i);
  assert.match(
    definition,
    /confirmed_via text CHECK \(confirmed_via IN \('owner_direct','staff_proxy','management'\)\)/i,
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

test("B-010 confirmations reject row mutations and statement-level truncation", () => {
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION app\.b010_confirmations_immutable\(\) RETURNS trigger\s+LANGUAGE plpgsql SET search_path=pg_catalog,app AS \$\$\s*BEGIN\s+RAISE EXCEPTION 'Payment confirmations are immutable' USING ERRCODE='55000';\s*END \$\$;/i,
  );
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
    ["b010_payment_collector", "uuid"],
    ["b010_record_confirmation", "uuid,text,uuid,text,text,text"],
    ["b010_confirmation_audit", "uuid"],
  ] as const;

  for (const [name, argumentsSql] of signatures) {
    const definition = functionDefinition(name);

    assert.match(
      definition,
      /\bSECURITY DEFINER SET search_path=pg_catalog,public,app\b/i,
    );
    assert.ok(
      sql.indexOf(definition) < sql.lastIndexOf("COMMIT;"),
      `${name} must be defined before COMMIT`,
    );
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

test("B-010 collector and recording functions require the current actor's transaction context for the payment scope", () => {
  for (const name of [
    "b010_payment_collector",
    "b010_record_confirmation",
  ]) {
    const definition = functionDefinition(name);

    assert.match(definition, /\bv_actor uuid\s*:=\s*auth\.uid\(\);/i);
    assert.match(
      definition,
      /SELECT p\.org_id,\s*p\.lease_id INTO v_org,\s*v_lease\s+FROM public\.payments p\s+WHERE p\.id=p_payment\s+AND EXISTS\s*\(\s*SELECT 1 FROM app\.b010_payment_contexts ctx\s+WHERE ctx\.tx_id=txid_current\(\)\s+AND ctx\.actor_id=v_actor\s+AND ctx\.org_id=p\.org_id\s+AND ctx\.lease_id=p\.lease_id\s*\);/i,
    );
    assert.match(
      definition,
      /IF NOT FOUND THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
    );
    assert.ok(
      definition.indexOf("IF NOT FOUND THEN") <
        definition.indexOf("FROM app.b010_lease_collectors"),
      `${name} must validate context before reading collectors`,
    );
  }
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

test("B-010 recording validates owner proxies, serializes confirmations, and preserves provenance", () => {
  const definition = functionDefinition("b010_record_confirmation");

  assert.match(
    definition,
    /b010_record_confirmation\(\s*p_payment uuid,\s*p_via text,\s*p_on_behalf uuid,\s*p_source text,\s*p_from text,\s*p_to text\s*\)\s+RETURNS uuid/i,
  );
  assert.match(
    definition,
    /IF p_via='staff_proxy' AND NOT EXISTS\s*\(\s*SELECT 1 FROM app\.b010_lease_collectors lc\s+WHERE lc\.org_id=v_org AND lc\.lease_id=v_lease\s+AND lc\.collector='owner'\s+AND lc\.owner_contact_id=p_on_behalf\s*\) THEN\s+RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';\s+END IF;/i,
  );
  assert.match(
    definition,
    /PERFORM pg_advisory_xact_lock\(hashtextextended\('b010_confirm:'\|\|p_payment::text,0\)\);/i,
  );
  assert.ok(
    definition.indexOf("IF p_via='staff_proxy'") <
      definition.indexOf("PERFORM pg_advisory_xact_lock"),
  );
  assert.ok(
    definition.indexOf("PERFORM pg_advisory_xact_lock") <
      definition.indexOf("INSERT INTO app.b010_payment_confirmations"),
  );
  assert.match(
    definition,
    /INSERT INTO app\.b010_payment_confirmations\s*\(\s*org_id,\s*payment_id,\s*actor_user_id,\s*on_behalf_of_owner_contact_id,\s*confirmed_via,\s*source,\s*from_status,\s*to_status\s*\)\s*VALUES\s*\(\s*v_org,\s*p_payment,\s*v_actor,\s*p_on_behalf,\s*p_via,\s*p_source,\s*p_from,\s*p_to\s*\)\s*RETURNING id INTO v_id;/i,
  );
  assert.match(
    definition,
    /EXCEPTION WHEN unique_violation THEN\s+RAISE EXCEPTION 'Payment already confirmed' USING ERRCODE='23505';/i,
  );
  assert.match(definition, /RETURN v_id;/i);
});

test("B-010 confirmation audit is stable and restricts rows to active members or the represented owner", () => {
  const definition = functionDefinition("b010_confirmation_audit");

  assert.match(
    definition,
    /b010_confirmation_audit\(p_payment uuid\)\s+RETURNS TABLE\(\s*actor_user_id uuid,\s*on_behalf_of_owner_contact_id uuid,\s*confirmed_via text,\s*source text,\s*from_status text,\s*to_status text,\s*created_at timestamptz\s*\)/i,
  );
  assert.match(
    definition,
    /LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app/i,
  );
  assert.match(
    definition,
    /SELECT c\.actor_user_id,\s*c\.on_behalf_of_owner_contact_id,\s*c\.confirmed_via,\s*c\.source,\s*c\.from_status,\s*c\.to_status,\s*c\.created_at\s+FROM app\.b010_payment_confirmations c\s+JOIN public\.payments p ON p\.org_id=c\.org_id AND p\.id=c\.payment_id\s+WHERE p\.id=p_payment\s+AND\s*\(/i,
  );
  assert.match(
    definition,
    /EXISTS\s*\(\s*SELECT 1\s+FROM public\.organizations o\s+JOIN public\.org_members m\s+ON m\.org_id=CASE WHEN o\.environment='sandbox' THEN o\.live_org_id ELSE o\.id END\s+WHERE o\.id=p\.org_id\s+AND m\.user_id=auth\.uid\(\)\s+AND m\.status='active'\s*\)/i,
  );
  assert.match(
    definition,
    /OR EXISTS\s*\(\s*SELECT 1 FROM public\.contacts owner_contact\s+WHERE owner_contact\.org_id=c\.org_id\s+AND owner_contact\.id=c\.on_behalf_of_owner_contact_id\s+AND owner_contact\.user_id=auth\.uid\(\)\s*\)\s*\);/i,
  );
});
