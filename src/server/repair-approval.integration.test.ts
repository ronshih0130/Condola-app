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
let property: string, ticket: string, otherTicket: string, org2Ticket: string;
let currency: string, minorUnit: number;
let sessions: Record<string, string>;
const tables = [
  "b013_estimate_heads", "b013_estimate_versions", "b013_estimate_decisions",
  "b013_repair_emergencies", "b013_repair_appointments",
  "b013_repair_commands", "b013_repair_event_outbox",
];
const gateways = [
  "b013_submit_estimate", "b013_decide_estimate", "b013_authorize_emergency",
  "b013_record_appointment", "b013_emit_reminder", "b013_dispatch_allowed",
];
type Result = {
  status: string;
  version_id?: string;
  decision_id?: string;
  emergency_id?: string;
  event_id?: string;
  appointment_id?: string;
  requires_owner_decision?: boolean;
  state?: string;
};
function hash(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}
async function seed() {
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
}
// Each test rolls back its history. Never disable triggers or purge immutable rows.
async function asRole(sql: string, values: unknown[] = [], role = "service_role") {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.query("SAVEPOINT b013_call");
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    const result = await db.query(sql, values);
    await db.query("RESET ROLE");
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    await db.query("RELEASE SAVEPOINT b013_call");
    return result;
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT b013_call");
    await db.query("RELEASE SAVEPOINT b013_call");
    throw error;
  }
}
async function rejected(sql: string, values: unknown[], code: string) {
  await db.query("SAVEPOINT b013_rejected");
  try {
    await assert.rejects(db.query(sql, values), (error: unknown) => {
      assert.equal((error as { code?: string }).code, code);
      return true;
    });
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT b013_rejected");
    await db.query("RELEASE SAVEPOINT b013_rejected");
  }
}
async function controls(flag: "repair_approvals" | "vendor_dispatch", on: boolean) {
  if (flag === "vendor_dispatch") {
    // app.vendor_dispatch_enabled: org flag not 'false' AND (sandbox OR beta plan).
    await db.query(`UPDATE public.organizations
      SET feature_flags=feature_flags||jsonb_build_object('vendor_dispatch',$2::boolean),
          plan_tier=CASE WHEN $2::boolean THEN 'beta' ELSE plan_tier END
      WHERE id=$1`, [ORG_ID, on]);
    return;
  }
  const updated = await db.query(`UPDATE public.platform_settings
    SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text))
    WHERE key=$3`, [ORG_ID, on, flag]);
  assert.equal(updated.rowCount, 1, `missing registered flag ${flag}`);
  await db.query(`UPDATE public.organizations
    SET feature_flags=feature_flags||jsonb_build_object($2::text,$3::boolean) WHERE id=$1`,
  [ORG_ID, flag, on]);
}
async function makeTicket(org: string, propertyId: string) {
  const id = randomUUID();
  // Reuse enum values from the seed rather than inventing maintenance enums.
  const inserted = await db.query(`INSERT INTO public.maintenance_tickets
    (id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)
    SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),
      $3,category,priority,status,'B-013 fixture',cost_bearer,owner_approval
    FROM public.maintenance_tickets WHERE org_id=$4 ORDER BY id LIMIT 1 RETURNING id`,
  [id, org, propertyId, ORG_ID]);
  assert.equal(inserted.rowCount, 1, "seed must contain a maintenance ticket");
  return id;
}
async function submit(options: {
  amount?: string; request?: string; expected?: string | null; ticketId?: string;
  session?: string; org?: string; digest?: Buffer; currency?: string; scale?: number;
} = {}): Promise<Result> {
  const args = [
    options.ticketId ?? ticket, options.expected ?? null, options.amount ?? "500001",
    options.currency ?? currency, options.scale ?? minorUnit, "Replace damaged pipe", [],
  ];
  const result = await asRole(`SELECT app.b013_submit_estimate(
    $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,$8::smallint,$9::text,$10::jsonb,$11::bytea) result`,
  [options.org ?? ORG_ID, options.session ?? sessions.manager, options.request ?? randomUUID(),
    ...args.slice(0, 6), JSON.stringify(args[6]), options.digest ?? hash(args)]);
  return result.rows[0].result;
}
async function decide(version: string, session = sessions.owner, request = randomUUID()): Promise<Result> {
  const result = await asRole(`SELECT app.b013_decide_estimate(
    $1::uuid,$2::uuid,$3::uuid,$4::uuid,'approved',NULL,$5::bytea) result`,
  [ORG_ID, session, request, version, hash([version, "approved", null])]);
  return result.rows[0].result;
}
async function pending() {
  const result = await submit();
  assert.equal(result.status, "recorded");
  assert.equal(result.state, "pending_approval");
  assert.ok(result.version_id);
  return result.version_id;
}
async function emergency(version: string, session: string, photos: unknown[] = [{ id: "fixture-photo" }]): Promise<Result> {
  const args = [version, "water", "Synthetic emergency reason", photos];
  const result = await asRole(`SELECT app.b013_authorize_emergency(
    $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::jsonb,$8::bytea) result`,
  [ORG_ID, session, randomUUID(), ...args.slice(0, 3), JSON.stringify(photos), hash(args)]);
  return result.rows[0].result;
}
async function dispatch(version: string, org = ORG_ID): Promise<boolean> {
  return (await asRole("SELECT app.b013_dispatch_allowed($1::uuid,$2::uuid) allowed", [org, version])).rows[0].allowed;
}
async function counts() {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM app.b013_estimate_versions) versions,
    (SELECT count(*)::int FROM app.b013_estimate_heads) heads,
    (SELECT count(*)::int FROM app.b013_estimate_decisions) decisions,
    (SELECT count(*)::int FROM app.b013_repair_event_outbox) outbox,
    (SELECT count(*)::int FROM app.b013_repair_commands) commands`)).rows[0];
}

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  assert.equal((await db.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper, true);
  await seed();
  assert.deepEqual(await counts(), { versions: 0, heads: 0, decisions: 0, outbox: 0, commands: 0 });
});
test.beforeEach(async () => {
  await db.query("BEGIN");
  const row = (await db.query(`SELECT po.id,po.property_id,p.currency::text currency,r.minor_unit
    FROM public.property_owners po
    JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
    JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id
    JOIN public.organizations o ON o.id=po.org_id
    JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
    WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND c.archived_at IS NULL
      AND p.archived_at IS NULL ORDER BY po.id LIMIT 1`, [ORG_ID, USERS.owner])).rows[0];
  assert.ok(row, "seed must contain an owner property with a regional currency scale");
  property = row.property_id; currency = row.currency.trim(); minorUnit = row.minor_unit;
  await db.query(`UPDATE public.property_owners SET effective_from=least(effective_from,CURRENT_DATE-1),effective_to=CURRENT_DATE
    WHERE org_id=$1 AND property_id=$2 AND id<>$3`, [ORG_ID, property, row.id]);
  await db.query(`UPDATE public.property_owners SET repair_approval_threshold_minor=500000,
    effective_from=CURRENT_DATE-1,effective_to=NULL WHERE id=$1`, [row.id]);
  ticket = await makeTicket(ORG_ID, property);
  otherTicket = await makeTicket(ORG_ID, property);
  const otherProperty = (await db.query(
    "SELECT id FROM public.properties WHERE org_id=$1 ORDER BY id LIMIT 1", [ORG2_ID],
  )).rows[0];
  assert.ok(otherProperty, "seed must contain an ORG2 property");
  org2Ticket = await makeTicket(ORG2_ID, otherProperty.id);
  sessions = {};
  for (const name of ["admin", "manager", "owner", "coastAdmin"] as const) {
    sessions[name] = randomUUID();
    await db.query(`INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,
    [sessions[name], USERS[name], randomBytes(32).toString("hex")]);
  }
  await controls("repair_approvals", true);
  await controls("vendor_dispatch", false);
});
test.afterEach(async () => { await db.query("ROLLBACK"); });
test.after(async () => {
  try { await db?.end(); } finally { await clone?.cleanup(); }
});

test("rls_enabled_all", async () => {
  const result = await db.query(`SELECT c.relname,c.relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname=ANY($1::text[])`, [tables]);
  assert.equal(result.rowCount, 7);
  assert.ok(result.rows.every(row => row.relrowsecurity));
  assert.equal((await db.query(`SELECT count(*)::int n FROM pg_policies
    WHERE schemaname='app' AND tablename=ANY($1::text[])`, [tables])).rows[0].n, 0);
});
test("no_direct_table_grants", async () => {
  for (const role of ["service_role", "anon", "authenticated"]) {
    for (const table of tables) {
      await assert.rejects(asRole(`SELECT * FROM app.${table} LIMIT 1`, [], role), { code: "42501" });
      const privileges = (await db.query(`SELECT
        has_table_privilege($1,$2,'SELECT') OR has_table_privilege($1,$2,'INSERT')
        OR has_table_privilege($1,$2,'UPDATE') OR has_table_privilege($1,$2,'DELETE')
        OR has_table_privilege($1,$2,'TRUNCATE') allowed`, [role, `app.${table}`])).rows[0];
      assert.equal(privileges.allowed, false);
    }
  }
});
test("role_definer_only", async () => {
  const rows = (await db.query(`SELECT p.oid,p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('service_role',p.oid,'EXECUTE') service,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app' AND p.proname=ANY($1::text[])`, [gateways])).rows;
  assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.equal(row.prosecdef, true);
    assert.equal(row.service, true);
    assert.equal(row.anon, false);
    assert.equal(row.authenticated, false);
    assert.ok(row.proconfig.some((value: string) => value.replaceAll(" ", "") === "search_path=pg_catalog,public,app,pg_temp"));
  }
});
test("off_fail_closed", async () => {
  await controls("repair_approvals", false);
  const request = randomUUID();
  assert.deepEqual(await submit({ request }), { status: "rejected_disabled" });
  assert.deepEqual(await counts(), { versions: 0, heads: 0, decisions: 0, outbox: 0, commands: 1 });
  await controls("repair_approvals", true);
  assert.deepEqual(await submit({ request }), { status: "rejected_disabled" });
  assert.deepEqual(await counts(), { versions: 0, heads: 0, decisions: 0, outbox: 0, commands: 1 });
});
test("strict_gt_boundary", async () => {
  const equal = await submit({ amount: "500000" });
  assert.equal(equal.status, "recorded");
  assert.equal(equal.requires_owner_decision, false);
  assert.equal(equal.state, "policy_qualified");
  const over = await submit({ expected: equal.version_id, amount: "500001" });
  assert.equal(over.requires_owner_decision, true);
  assert.equal(over.state, "pending_approval");
  assert.equal((await counts()).decisions, 0);
  const rows = (await db.query(`SELECT amount_minor::text,captured_threshold_minor::text,
    requires_owner_decision,version_no::int FROM app.b013_estimate_versions ORDER BY version_no`)).rows;
  assert.deepEqual(rows, [
    { amount_minor: "500000", captured_threshold_minor: "500000", requires_owner_decision: false, version_no: 1 },
    { amount_minor: "500001", captured_threshold_minor: "500000", requires_owner_decision: true, version_no: 2 },
  ]);
});
test("designated_owner_decides_approved", async () => {
  const version = await pending(), result = await decide(version);
  assert.equal(result.status, "recorded");
  assert.deepEqual((await db.query(`SELECT decision,decided_by::text FROM app.b013_estimate_decisions
    WHERE version_id=$1`, [version])).rows, [{ decision: "approved", decided_by: USERS.owner }]);
  assert.equal((await decide(version)).status, "rejected_conflict");
});
test("non_designated_actor_forbidden", async () => {
  const version = await pending();
  await assert.rejects(decide(version, sessions.manager), { code: "42501" });
  assert.equal((await counts()).decisions, 0);
});
test("wrong_ticket_and_cross_org_rejected", async () => {
  const version = await pending();
  await assert.rejects(submit({ ticketId: org2Ticket }), { code: "42501" });
  await assert.rejects(submit({ session: sessions.coastAdmin }), { code: "42501" });
  await assert.rejects(submit({ org: ORG2_ID, session: sessions.coastAdmin }), { code: "42501" });
  await rejected(`INSERT INTO app.b013_estimate_decisions(org_id,ticket_id,version_id,decision,decided_by)
    VALUES($1,$2,$3,'approved',$4)`, [ORG_ID, otherTicket, version, USERS.owner], "23503");
  await rejected(`INSERT INTO app.b013_estimate_decisions(org_id,ticket_id,version_id,decision,decided_by)
    VALUES($1,$2,$3,'approved',$4)`, [ORG2_ID, org2Ticket, version, USERS.owner], "23503");
  assert.equal(await dispatch(version, ORG2_ID), false);
  assert.equal((await counts()).decisions, 0);
});
test("immutable_history", async () => {
  const version = await pending();
  await rejected("UPDATE app.b013_estimate_versions SET work_scope='changed' WHERE id=$1", [version], "23514");
  await rejected("DELETE FROM app.b013_estimate_versions WHERE id=$1", [version], "23514");
  // CASCADE includes all FK dependants, so PostgreSQL reaches the truncate trigger.
  await rejected("TRUNCATE app.b013_estimate_versions CASCADE", [], "23514");
  assert.equal((await counts()).versions, 1);
});
test("reminder_single_intent", async () => {
  const version = await pending();
  async function remind(hours: number): Promise<Result> {
    const at = (await db.query(`SELECT (submitted_at+$2::int*interval '1 hour')::text at
      FROM app.b013_estimate_versions WHERE id=$1`, [version, hours])).rows[0].at;
    return (await asRole("SELECT app.b013_emit_reminder($1::uuid,$2::uuid,$3::timestamptz) result",
      [ORG_ID, version, at])).rows[0].result;
  }
  assert.equal((await remind(23)).status, "not_due");
  assert.equal((await counts()).outbox, 0);
  assert.equal((await remind(25)).status, "recorded");
  assert.equal((await remind(25)).status, "duplicate");
  assert.equal((await counts()).outbox, 1);
  assert.equal((await counts()).decisions, 0);
  await controls("vendor_dispatch", true);
  assert.equal(await dispatch(version), false);
});
test("reminder_exact_24h_boundary", async () => {
  const version = await pending();
  const at = (await db.query("SELECT (submitted_at+interval '24 hours')::text at FROM app.b013_estimate_versions WHERE id=$1", [version])).rows[0].at;
  assert.equal((await asRole("SELECT app.b013_emit_reminder($1::uuid,$2::uuid,$3::timestamptz) result",
    [ORG_ID, version, at])).rows[0].result.status, "recorded");
});
test("command_replay_returns_original", async () => {
  const request = randomUUID(), first = await submit({ request });
  assert.ok(first.version_id);
  await decide(first.version_id);
  assert.deepEqual(await submit({ request }), first);
  assert.equal((await submit({ request, amount: "500002" })).status, "rejected_conflict");
  const originalHash = hash([ticket, null, "500001", currency, minorUnit, "Replace damaged pipe", []]);
  assert.equal((await submit({ request, amount: "500002", digest: originalHash })).status, "rejected_conflict");
  assert.equal((await counts()).versions, 1);
  assert.equal((await counts()).commands, 2);
});
test("emergency_requires_admin_and_writes_outbox_and_sanitized_audit", async () => {
  const version = await pending();
  await assert.rejects(emergency(version, sessions.manager), { code: "42501" });
  assert.equal((await emergency(version, sessions.admin, [])).status, "rejected_invalid");
  const result = await emergency(version, sessions.admin);
  assert.equal(result.status, "recorded");
  assert.ok(result.emergency_id);
  assert.ok(result.event_id);
  assert.equal((await counts()).decisions, 0);
  assert.equal((await counts()).outbox, 1);
  const event = (await db.query("SELECT kind,emergency_id::text FROM app.b013_repair_event_outbox WHERE id=$1", [result.event_id])).rows[0];
  assert.deepEqual(event, { kind: "emergency_owner_notice", emergency_id: result.emergency_id });
  const audits = (await db.query(`SELECT actor_user_id::text,actor_role,new_row,reason
    FROM public.audit_log WHERE table_name='b013_repair_emergencies' AND row_id=$1`, [result.emergency_id])).rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_user_id, USERS.admin);
  assert.equal(audits[0].actor_role, "admin");
  assert.deepEqual(audits[0].new_row, {
    version_id: version, emergency_id: result.emergency_id, event_id: result.event_id, category: "water",
  });
  assert.equal(audits[0].reason, "repair_emergency_authorized");
  await controls("vendor_dispatch", true);
  assert.equal(await dispatch(version), true);
});
test("dispatch_allowed_false_before_approval_true_after", async () => {
  await controls("vendor_dispatch", true);
  const version = await pending();
  assert.equal(await dispatch(version), false);
  await decide(version);
  assert.equal(await dispatch(version), true);
  const next = await submit({ expected: version });
  assert.ok(next.version_id);
  assert.equal(await dispatch(version), false);
  assert.equal(await dispatch(next.version_id), false);
  await controls("repair_approvals", false);
  assert.equal(await dispatch(version), false);
});
test("currency_drift_rejected", async () => {
  assert.equal((await submit({ currency: currency === "USD" ? "TWD" : "USD" })).status, "rejected_invalid");
  assert.equal((await submit({ scale: (minorUnit + 1) % 5 })).status, "rejected_invalid");
  assert.equal((await counts()).versions, 0);
});
test("vendor_rejected_appointment_keeps_ticket_status_and_checks_job_ticket", async () => {
  const version = await pending();
  const before = (await db.query("SELECT status::text FROM public.maintenance_tickets WHERE id=$1", [ticket])).rows[0].status;
  // Honor the existing scope default, whose vocabulary belongs to vendor dispatch.
  const scopeDefault = (await db.query(`SELECT pg_get_expr(d.adbin,d.adrelid) expression
    FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.repair_vendor_jobs'::regclass AND a.attname='scope'`)).rows[0]?.expression;
  async function job(ticketId: string) {
    const id = randomUUID();
    await db.query(`INSERT INTO public.repair_vendor_jobs
      (id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,active,created_by,created_at,scope)
      VALUES($1,$2,$3,'Fixture vendor','+886900000000','Weekdays',$4,clock_timestamp()+interval '1 day',
        true,$5,clock_timestamp(),${scopeDefault ?? "'repair'"})`,
    [id, ORG_ID, ticketId, randomBytes(32).toString("hex"), USERS.admin]);
    return id;
  }
  const good = await job(ticket), wrong = await job(otherTicket);
  async function appointment(jobId: string): Promise<Result> {
    return (await asRole(`SELECT app.b013_record_appointment(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'vendor_rejected',NULL,NULL,NULL,NULL,$6::bytea) result`,
    [ORG_ID, sessions.manager, randomUUID(), version, jobId, hash([version, jobId, "vendor_rejected"])]))
      .rows[0].result;
  }
  assert.equal((await appointment(good)).status, "rejected_disabled");
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b013_repair_appointments")).rows[0].n, 0);
  await controls("vendor_dispatch", true);
  await assert.rejects(appointment(wrong), { code: "42501" });
  const result = await appointment(good);
  assert.equal(result.status, "recorded");
  assert.equal((await db.query("SELECT event_kind FROM app.b013_repair_appointments WHERE id=$1", [result.appointment_id])).rows[0].event_kind, "vendor_rejected");
  assert.equal((await db.query("SELECT status::text FROM public.maintenance_tickets WHERE id=$1", [ticket])).rows[0].status, before);
});
