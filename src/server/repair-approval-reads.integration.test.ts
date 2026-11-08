import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let db: Client;
let ticket: string, otherTicket: string, org2Ticket: string, property: string, otherProperty: string;
let currency: string, scale: number;
let sessions: Record<string, string>;
// B-028 package 4: session id -> principal, and one real owner-visible photo per fixture ticket.
let users: Record<string, string>;
let photoOf: Record<string, string>;
const readers = ["b013_owner_pending", "b013_owner_history", "b013_manager_view"] as const;
const tables = ["b013_estimate_heads", "b013_estimate_versions", "b013_estimate_decisions",
  "b013_repair_emergencies", "b013_repair_appointments", "b013_repair_commands", "b013_repair_event_outbox"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest();

async function asRole(sql: string, values: unknown[] = [], role = "service_role", sub?: string | null) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.query("SAVEPOINT b021_call");
  try {
    if (sub !== undefined) await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [sub ?? ""]);
    await db.query("SET LOCAL ROLE " + role);
    const result = await db.query(sql, values);
    await db.query("RESET ROLE");
    if (sub !== undefined) await db.query("SELECT set_config('request.jwt.claim.sub','',true)");
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    await db.query("RELEASE SAVEPOINT b021_call");
    return result;
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT b021_call");
    await db.query("RELEASE SAVEPOINT b021_call");
    throw error;
  }
}
async function controls(flag: "repair_approvals" | "vendor_dispatch", on: boolean) {
  if (flag === "vendor_dispatch") {
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('vendor_dispatch',$2::boolean),"
      + "plan_tier=CASE WHEN $2::boolean THEN 'beta' ELSE plan_tier END WHERE id=$1", [ORG_ID, on]);
    return;
  }
  assert.equal((await db.query("UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$2::boolean,"
    + "'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'", [ORG_ID, on])).rowCount, 1);
  await db.query("UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('repair_approvals',$2::boolean) WHERE id=$1",
    [ORG_ID, on]);
}
async function makeTicket(org: string, propertyId: string) {
  const id = randomUUID();
  const result = await db.query("INSERT INTO public.maintenance_tickets"
    + "(id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)"
    + " SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),"
    + "$3,category,priority,status,'B-021 fixture',cost_bearer,owner_approval"
    + " FROM public.maintenance_tickets WHERE org_id=$4 ORDER BY id LIMIT 1", [id, org, propertyId, ORG_ID]);
  assert.equal(result.rowCount, 1);
  return id;
}
// Copy seed-required fields without assuming their enums or inserting generated columns.
async function copyFixture(table: "properties" | "contacts" | "property_owners", id: string, patch: Record<string, unknown>) {
  const columns = (await db.query("SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass"
    + " AND attnum>0 AND NOT attisdropped AND attgenerated='' AND attidentity='' ORDER BY attnum",
    ["public." + table])).rows.map(row => '"' + row.attname.replaceAll('"', '""') + '"');
  const result = await db.query("INSERT INTO public." + table + "(" + columns.join(",") + ") SELECT "
    + columns.map(column => "r." + column).join(",")
    + " FROM public." + table + " s CROSS JOIN LATERAL jsonb_populate_record(NULL::public." + table
    + ",to_jsonb(s)||$2::jsonb) r WHERE s.id=$1", [id, JSON.stringify(patch)]);
  assert.equal(result.rowCount, 1);
}
async function photo(ticketId: string) {
  const file = randomUUID(), attachment = randomUUID();
  await db.query("INSERT INTO public.files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)"
    + " VALUES($1::uuid,$2::uuid,'ticket-photos-private','org/'||$2::uuid::text||'/tickets/'||$3::uuid::text||'/'||$1::uuid::text||'.jpg','fixture.jpg','image/jpeg',1024,$4)",
  [file, ORG_ID, ticketId, USERS.admin]);
  await db.query("INSERT INTO public.ticket_attachments(id,org_id,ticket_id,file_id) VALUES($1,$2,$3,$4)",
    [attachment, ORG_ID, ticketId, file]);
  return attachment;
}
async function submit(ticketId = ticket, expected: string | null = null, amount = "500001") {
  const result = (await asRole("SELECT app.b013_submit_estimate("
    + "$1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,$8::smallint,$9::text,$10::jsonb,$11::bytea) r",
    [ORG_ID, sessions.manager, randomUUID(), ticketId, expected, amount, currency, scale, "Repair pipe",
      JSON.stringify([{ id: photoOf[ticketId], private: "strip-me" }]), hash([ticketId, expected, amount])],
    "service_role", users[sessions.manager])).rows[0].r;
  assert.equal(result.status, "recorded");
  assert.ok(result.version_id);
  return result.version_id as string;
}
// Call the SQL decision gateway on the fixture transaction connection.
async function decideEstimate(version: string, session = sessions.owner, request = randomUUID(), reason: string | null = null) {
  return (await asRole("SELECT app.b013_decide_estimate($1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,'approved',$5::text,$6::bytea) r",
    [ORG_ID, session, request, version, reason, hash([version, "approved", reason])], "service_role", users[session])).rows[0].r;
}
async function read(name: (typeof readers)[number], session = sessions.owner, ticketId = ticket,
  org = ORG_ID, live = ORG_ID, env = "live") {
  const args: unknown[] = [org, live, env, session];
  let placeholders = "$1::uuid,$2::uuid,$3::text,$4::uuid";
  if (name !== "b013_owner_pending") { args.push(ticketId); placeholders += ",$5::uuid"; }
  return (await asRole("SELECT * FROM app." + name + "(" + placeholders + ")", args)).rows;
}
async function job(ticketId: string) {
  const id = randomUUID();
  const expression = (await db.query("SELECT pg_get_expr(d.adbin,d.adrelid) expression FROM pg_attribute a"
    + " JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum"
    + " WHERE a.attrelid='public.repair_vendor_jobs'::regclass AND a.attname='scope'")).rows[0]?.expression;
  await db.query("INSERT INTO public.repair_vendor_jobs"
    + "(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,active,created_by,created_at,scope)"
    + " VALUES($1,$2,$3,'Fixture vendor','+886900000000','Weekdays',$4,clock_timestamp()+interval '1 day',true,$5,clock_timestamp(),"
    + (expression ?? "'repair'") + ")", [id, ORG_ID, ticketId, randomBytes(32).toString("hex"), USERS.admin]);
  return id;
}
test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  assert.equal((await db.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, true);
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
});
test.beforeEach(async () => {
  await db.query("BEGIN");
  const own = (await db.query("SELECT po.id,po.owner_contact_id,po.property_id,p.currency::text currency,r.minor_unit"
    + " FROM public.property_owners po JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id"
    + " JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id"
    + " JOIN public.organizations o ON o.id=po.org_id"
    + " JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency"
    + " WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND c.archived_at IS NULL AND p.archived_at IS NULL"
    + " ORDER BY po.id LIMIT 1", [ORG_ID, USERS.owner])).rows[0];
  assert.ok(own);
  property = own.property_id; currency = own.currency.trim(); scale = own.minor_unit;
  await db.query("UPDATE public.property_owners SET effective_from=least(effective_from,CURRENT_DATE-1),effective_to=CURRENT_DATE"
    + " WHERE org_id=$1 AND property_id=$2 AND id<>$3", [ORG_ID, property, own.id]);
  await db.query("UPDATE public.property_owners SET repair_approval_threshold_minor=500000,"
    + "effective_from=CURRENT_DATE-1,effective_to=NULL WHERE id=$1", [own.id]);
  otherProperty = randomUUID();
  const contact = randomUUID();
  await copyFixture("properties", property, { id: otherProperty, name: "B-021 other property" });
  await copyFixture("contacts", own.owner_contact_id, { id: contact, user_id: USERS.coastAdmin,
    email: contact + "@example.invalid", phone: "+886900000021" });
  await copyFixture("property_owners", own.id, { id: randomUUID(), property_id: otherProperty, owner_contact_id: contact });
  ticket = await makeTicket(ORG_ID, property);
  otherTicket = await makeTicket(ORG_ID, otherProperty);
  const p2 = (await db.query("SELECT id FROM public.properties WHERE org_id=$1 ORDER BY id LIMIT 1", [ORG2_ID])).rows[0];
  assert.ok(p2);
  org2Ticket = await makeTicket(ORG2_ID, p2.id);
  photoOf = { [ticket]: await photo(ticket), [otherTicket]: await photo(otherTicket) };
  sessions = {};
  users = {};
  for (const name of ["admin", "manager", "owner", "coastAdmin"] as const) {
    sessions[name] = randomUUID();
    users[sessions[name]] = USERS[name];
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at)"
      + " VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
      [sessions[name], USERS[name], randomBytes(32).toString("hex")]);
  }
  await controls("repair_approvals", true);
  await controls("vendor_dispatch", false);
});
test.afterEach(async () => { await db.query("ROLLBACK"); });
test.after(async () => { try { await db?.end(); } finally { await clone?.cleanup(); } });

test("owner_pending_scoped", async () => {
  const first = await submit();
  const current = await submit(ticket, first);
  await submit(otherTicket);
  const rows = await read("b013_owner_pending");
  assert.deepEqual(rows.map(row => row.version_id), [current]);
  assert.equal(rows[0].property_id, property);
  assert.deepEqual(rows[0].evidence_snapshot, [{ id: photoOf[ticket] }]);
  assert.deepEqual(await read("b013_owner_pending", sessions.manager), []);
});
test("property_isolation", async () => {
  const a = await submit(), b = await submit(otherTicket);
  assert.deepEqual((await read("b013_owner_pending")).map(row => row.version_id), [a]);
  assert.deepEqual((await read("b013_owner_pending", sessions.coastAdmin)).map(row => row.version_id), [b]);
  assert.deepEqual(await read("b013_owner_history", sessions.owner, otherTicket), []);
  assert.deepEqual(await read("b013_owner_history", sessions.coastAdmin, ticket), []);
});
test("other_owner_empty", async () => {
  await submit();
  assert.deepEqual(await read("b013_owner_pending", sessions.coastAdmin), []);
  assert.deepEqual(await read("b013_owner_history", sessions.coastAdmin), []);
});
test("owner_history_same_ticket_org", async () => {
  const a = await submit(), b = await submit(ticket, a);
  const rows = await read("b013_owner_history");
  assert.deepEqual(rows.map(row => [row.version_id, row.is_current]), [[b, true], [a, false]]);
  assert.deepEqual(await read("b013_owner_history", sessions.owner, randomUUID()), []);
  assert.deepEqual(await read("b013_owner_history", sessions.owner, org2Ticket), []);
});
test("manager_staff_only", async () => {
  await submit();
  await assert.rejects(read("b013_manager_view", sessions.owner), { code: "42501" });
  assert.equal((await read("b013_manager_view", sessions.admin)).length, 1);
  assert.equal((await read("b013_manager_view", sessions.manager)).length, 1);
  await db.query("UPDATE public.org_members SET role='maintenance' WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.manager]);
  await assert.rejects(read("b013_manager_view", sessions.manager), { code: "42501" });
});
test("cross_org_empty_or_forbidden", async () => {
  await submit();
  assert.deepEqual(await read("b013_manager_view", sessions.manager, org2Ticket), []);
  await assert.rejects(read("b013_owner_pending", sessions.owner, ticket, ORG2_ID, ORG2_ID), { code: "42501" });
});
test("env_mismatch_forbidden", async () => {
  await submit();
  for (const name of readers) {
    const session = name === "b013_manager_view" ? sessions.manager : sessions.owner;
    await assert.rejects(read(name, session, ticket, ORG_ID, ORG_ID, "sandbox"), { code: "42501" });
    await assert.rejects(read(name, session, ticket, ORG_ID, ORG2_ID, "live"), { code: "42501" });
  }
});
test("threshold_equality_not_pending / above_pending", async () => {
  const equal = await submit(ticket, null, "500000");
  assert.deepEqual(await read("b013_owner_pending"), []);
  assert.equal((await read("b013_owner_history"))[0].requires_owner_decision, false);
  const above = await submit(ticket, equal, "500001");
  assert.deepEqual((await read("b013_owner_pending")).map(row => row.version_id), [above]);
});
test("stale_decision_rejected after resubmit", async () => {
  const first = await submit();
  assert.equal((await decideEstimate(first)).status, "recorded");
  const next = await submit(ticket, first);
  await assert.rejects(decideEstimate(first), { code: "40001" });
  assert.deepEqual((await read("b013_owner_pending")).map(row => row.version_id), [next]);
  assert.equal((await read("b013_manager_view", sessions.manager)).find(row => row.version_id === next).decision, null);
});
test("decision_visible_to_manager_with_decided_at", async () => {
  const version = await submit();
  await assert.rejects(decideEstimate(version, sessions.coastAdmin), { code: "42501" });
  assert.equal((await decideEstimate(version)).status, "recorded");
  const rows = await read("b013_manager_view", sessions.manager);
  assert.equal(rows[0].version_id, version);
  assert.equal(rows[0].decision, "approved");
  assert.equal(rows[0].decided_by, USERS.owner);
  assert.ok(rows[0].decided_at);
  assert.deepEqual(await read("b013_owner_pending"), []);
});
test("decide replay and payload conflict", async () => {
  const version = await submit(), request = randomUUID();
  const first = await decideEstimate(version, sessions.owner, request);
  assert.deepEqual(await decideEstimate(version, sessions.owner, request), first);
  assert.equal((await decideEstimate(version, sessions.owner, request, "changed")).status, "rejected_conflict");
});
test("SQL decision replay preserves one decision row", async () => {
  const version = await submit(), requestId = randomUUID();
  const decisionCount = async () => (await db.query(
    "SELECT count(*)::int n FROM app.b013_estimate_decisions WHERE org_id=$1 AND version_id=$2",
    [ORG_ID, version],
  )).rows[0].n;
  assert.equal(await decisionCount(), 0);
  const first = await decideEstimate(version, sessions.owner, requestId);
  assert.equal(first.status, "recorded");
  assert.equal(await decisionCount(), 1);
  // Complements the real POST regression in owner-repair-decision/request-id.test.ts.
  const retry = await decideEstimate(version, sessions.owner, requestId);
  assert.deepEqual(retry, first);
  assert.equal(await decisionCount(), 1);
});
test("emergency_visibility", async () => {
  const version = await submit();
  const result = (await asRole("SELECT app.b013_authorize_emergency("
    + "$1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,'water','Urgent pipe repair',$5::jsonb,$6::bytea) r",
    [ORG_ID, sessions.admin, randomUUID(), version,
      JSON.stringify([{ id: photoOf[ticket], storage_key: "secret", url: "private" }]), hash([version])],
    "service_role", users[sessions.admin])).rows[0].r;
  assert.equal(result.status, "recorded");
  for (const [name, session] of [["b013_owner_history", sessions.owner], ["b013_manager_view", sessions.manager]] as const) {
    const row = (await read(name, session))[0];
    assert.equal(row.emergency_category, "water");
    assert.equal(row.emergency_reason, "Urgent pipe repair");
    assert.deepEqual(row.emergency_photo_refs, [{ id: photoOf[ticket] }]);
    assert.ok(row.emergency_notice_intent_at);
    assert.equal(row.decision, null);
    assert.doesNotMatch(JSON.stringify(row), /storage_key|storage_path|ticket-photos|secret|private|delivered|sent_at|\.jpg/);
  }
  assert.equal((await read("b013_owner_pending"))[0].has_emergency, true);
});
test("reader_off_empty", async () => {
  const version = await submit();
  type SnapshotRow = Record<string, unknown>;
  async function stateRows() {
    const rows: Record<string, SnapshotRow[]> = {};
    for (const table of tables) {
      // Preserve every column, including timestamps and bytea hashes. Ordering
      // by the canonical JSON text is deterministic for every table's key shape.
      rows[table] = (await db.query("SELECT coalesce(jsonb_agg(to_jsonb(t)"
        + " ORDER BY to_jsonb(t)::text COLLATE \"C\"),'[]'::jsonb) AS snapshot"
        + " FROM app." + table + " t")).rows[0].snapshot;
    }
    return rows;
  }
  for (const control of ["platform_enabled", "allowed_org_ids", "org_flag"] as const) {
    await controls("repair_approvals", true);
    if (control === "org_flag") {
      await db.query("UPDATE public.organizations SET feature_flags=feature_flags"
        + "||jsonb_build_object('repair_approvals',false) WHERE id=$1", [ORG_ID]);
    } else {
      await db.query("UPDATE public.platform_settings SET value=value||$1::jsonb WHERE key='repair_approvals'",
        [JSON.stringify(control === "platform_enabled" ? { enabled: false } : { allowed_org_ids: [] })]);
    }
    const before = await stateRows();
    for (const name of readers) {
      assert.deepEqual(await read(name, name === "b013_manager_view" ? sessions.manager : sessions.owner), [], control);
      assert.deepEqual(await stateRows(), before, control + ": " + name + " must not write");
    }
    const requestId = randomUUID();
    assert.deepEqual(await decideEstimate(version, sessions.owner, requestId),
      { status: "rejected_disabled" }, control);
    const after = await stateRows();
    const ledger = "b013_repair_commands";
    const added = after[ledger].filter(row => row.request_id === requestId);
    assert.equal(added.length, 1, control + ": exactly one disabled command");
    const row = added[0];
    const inputHash = (await db.query(
      "SELECT encode(sha256(convert_to(jsonb_build_array($1::uuid,'approved'::text,NULL::text)::text,"
        + " 'UTF8')),'hex') AS hash", [version],
    )).rows[0].hash;
    // Contract: b013_decide_estimate's OFF branch calls b013_store_result,
    // persisting the rejected result and its request/payload binding.
    assert.equal(typeof row.recorded_at, "string", control);
    assert.ok(Number.isFinite(Date.parse(row.recorded_at as string)), control);
    assert.deepEqual(row, {
      actor_id: USERS.owner,
      request_id: requestId,
      org_id: ORG_ID,
      ticket_id: ticket,
      operation_kind: "decision",
      outcome: "rejected_disabled",
      expected_head_id: null,
      requested_version_id: version,
      payload_sha256: "\\x" + hash([version, "approved", null]).toString("hex"),
      input_sha256: "\\x" + inputHash,
      result_version_id: null,
      result_decision_id: null,
      result_emergency_id: null,
      result_appointment_id: null,
      result_event_id: null,
      result_json: { status: "rejected_disabled" },
      recorded_at: row.recorded_at,
    }, control + ": exact disabled command fields");
    assert.deepEqual({
      ...after,
      [ledger]: after[ledger].filter(candidate => candidate.request_id !== requestId),
    }, before, control + ": all preexisting rows in all seven tables must remain unchanged");
  }
});
test("appointment_job_guard", async () => {
  const version = await submit(), good = await job(ticket), wrong = await job(otherTicket);
  const insert = "INSERT INTO app.b013_repair_appointments(org_id,ticket_id,version_id,repair_vendor_job_id,event_kind,actor_id)"
    + " VALUES($1,$2,$3,$4,'vendor_proposed',$5)";
  await db.query("SAVEPOINT wrong_job");
  await assert.rejects(db.query(insert, [ORG_ID, ticket, version, wrong, USERS.manager]), { code: "23503" });
  await db.query("ROLLBACK TO SAVEPOINT wrong_job");
  await db.query("RELEASE SAVEPOINT wrong_job");
  await db.query(insert, [ORG_ID, ticket, version, good, USERS.manager]);
  // Read visibility does not depend on vendor_dispatch.
  assert.equal((await read("b013_manager_view", sessions.manager))[0].appointment_event_kind, "vendor_proposed");
});
test("reader_role_definer_only and no_direct_table_grants", async () => {
  const rows = (await db.query("SELECT p.oid,p.proname,p.prosecdef,p.proconfig FROM pg_proc p"
    + " JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname=ANY($1::text[])", [readers])).rows;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.prosecdef, true);
    assert.ok(row.proconfig.some((value: string) => value.replaceAll(" ", "") === "search_path=pg_catalog,public,app,pg_temp"));
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, row.oid])).rows[0].ok, role === "service_role");
    }
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal((await db.query("SELECT has_function_privilege($1,'app.b013_appointment_job_guard()','EXECUTE') ok", [role])).rows[0].ok, false);
    for (const table of tables) for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      assert.equal((await db.query("SELECT has_table_privilege($1,$2,$3) ok", [role, "app." + table, privilege])).rows[0].ok, false);
    }
  }
});
