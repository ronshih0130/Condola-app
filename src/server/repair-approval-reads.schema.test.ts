import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const filename = "20261105180000_b021_repair_approval_reads.sql";
const sql = readFileSync(new URL("../../supabase/migrations/" + filename, import.meta.url), "utf8");
const readers = [
  ["b013_owner_pending", "uuid,uuid,text,uuid"],
  ["b013_owner_history", "uuid,uuid,text,uuid,uuid"],
  ["b013_manager_view", "uuid,uuid,text,uuid,uuid"],
] as const;

test("reader migration is atomic, ordered, bounded and makes no table or flag changes", () => {
  assert.ok(filename > "20261105170000_b013_repair_approval_state.sql");
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /SET LOCAL statement_timeout = '60s';/);
  assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP)\s+TABLE\b|\bDROP\b|\b(?:INSERT INTO|UPDATE|DELETE FROM)\b|\bdigest\s*\(/i);
  assert.equal((sql.match(/GRANT EXECUTE ON FUNCTION/g) ?? []).length, 3);
  assert.doesNotMatch(sql, /GRANT\s+(?!EXECUTE\b)/i);
});
test("every reader validates the environment, actor and flag before reading state", () => {
  for (const [name, signature] of readers) {
    const body = sql.split("CREATE FUNCTION app." + name + "(")[1]?.split("END $$;")[0];
    assert.ok(body);
    assert.match(body, /SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp/);
    assert.match(body, /o.environment::text=p_env/);
    assert.match(body, /live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL/);
    assert.match(body, /p_env='live' AND o.id=p_live AND o.live_org_id IS NULL/);
    assert.match(body, /p_env='sandbox' AND o.live_org_id=p_live/);
    assert.match(body, /ERRCODE='42501'/);
    assert.match(body, /app.b013_actor\(p_org,p_session\)/);
    assert.match(body, /IF NOT app.b013_approvals_enabled\(p_org\) THEN RETURN; END IF;/);
    assert.ok(body.indexOf("o.environment::text=p_env") < body.indexOf("app.b013_actor"));
    assert.ok(body.indexOf("app.b013_actor") < body.indexOf("RETURN QUERY"));
    assert.ok(body.indexOf("app.b013_approvals_enabled") < body.indexOf("RETURN QUERY"));
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION app." + name + "(" + signature + ") FROM PUBLIC,anon,authenticated,service_role;"));
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION app." + name + "(" + signature + ") TO service_role;"));
    assert.match(body, /v.org_id=p_org/);
    assert.match(body, /jsonb_agg\(jsonb_build_object\('id', x->>'id'\)\)/);
    if (name !== "b013_manager_view") assert.match(body, /v.designated_principal_id=a.actor/);
    if (name !== "b013_owner_pending") assert.match(body, /v.ticket_id=p_ticket/);
  }
  assert.match(sql, /h.current_version_id=v.id[\s\S]*v.requires_owner_decision[\s\S]*NOT EXISTS/);
  assert.match(sql, /a.member_role IS NULL OR a.member_role NOT IN \('admin','manager'\)/);
});
test("appointment guard closes the job org and ticket FK gap and stays private", () => {
  assert.match(sql, /CREATE TRIGGER b013_appointment_job_guard BEFORE INSERT ON app.b013_repair_appointments/);
  assert.match(sql, /j.id=NEW.repair_vendor_job_id AND j.org_id=NEW.org_id AND j.ticket_id=NEW.ticket_id/);
  assert.match(sql, /ERRCODE='23503'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app.b013_appointment_job_guard\(\) FROM PUBLIC,anon,authenticated,service_role;/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app.b013_appointment_job_guard/);
});
