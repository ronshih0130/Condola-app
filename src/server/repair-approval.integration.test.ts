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
// B-028 package 4: each session id maps to its principal (svc() sets request.jwt.claim.sub).
let users: Record<string, string>;
const tables = [
  "b013_estimate_heads", "b013_estimate_versions", "b013_estimate_decisions",
  "b013_repair_emergencies", "b013_repair_appointments",
  "b013_repair_commands", "b013_repair_event_outbox",
];
const gateways = [
  "b013_submit_estimate", "b013_decide_estimate", "b013_authorize_emergency",
  "b013_record_appointment", "b013_emit_reminder", "b013_dispatch_allowed",
  "b013_record_vendor_appointment",
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
async function asRole(sql: string, values: unknown[] = [], role = "service_role", sub?: string | null) {
  assert.ok(["service_role", "anon", "authenticated"].includes(role));
  await db.query("SAVEPOINT b013_call");
  try {
    if (sub !== undefined) await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [sub ?? ""]);
    await db.query(`SET LOCAL ROLE ${role}`);
    const result = await db.query(sql, values);
    await db.query("RESET ROLE");
    if (sub !== undefined) await db.query("SELECT set_config('request.jwt.claim.sub','',true)");
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
// B-028 package 4: a real owner-visible ticket photo (attachment + private-bucket file).
async function photo(ticketId = ticket, org = ORG_ID) {
  const file = randomUUID(), attachment = randomUUID();
  await db.query(`INSERT INTO public.files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)
    VALUES($1::uuid,$2::uuid,'ticket-photos-private','org/'||$2::uuid::text||'/tickets/'||$3::uuid::text||'/'||$1::uuid::text||'.jpg','fixture.jpg','image/jpeg',1024,$4)`,
  [file, org, ticketId, USERS.admin]);
  await db.query(`INSERT INTO public.ticket_attachments(id,org_id,ticket_id,file_id) VALUES($1,$2,$3,$4)`,
    [attachment, org, ticketId, file]);
  return attachment;
}
async function submit(options: {
  amount?: string; request?: string; expected?: string | null; ticketId?: string;
  session?: string; org?: string; live?: string; digest?: Buffer; currency?: string; scale?: number;
} = {}): Promise<Result> {
  const args = [
    options.ticketId ?? ticket, options.expected ?? null, options.amount ?? "500001",
    options.currency ?? currency, options.scale ?? minorUnit, "Replace damaged pipe", [],
  ];
  const session = options.session ?? sessions.manager;
  const result = await asRole(`SELECT app.b013_submit_estimate(
    $1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::bigint,$9::text,$10::smallint,$11::text,$12::jsonb,$13::bytea) result`,
  [options.org ?? ORG_ID, options.live ?? options.org ?? ORG_ID, "live", session, options.request ?? randomUUID(),
    ...args.slice(0, 6), JSON.stringify(args[6]), options.digest ?? hash(args)], "service_role", users[session]);
  return result.rows[0].result;
}
async function decide(version: string, session = sessions.owner, request = randomUUID()): Promise<Result> {
  const result = await asRole(`SELECT app.b013_decide_estimate(
    $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,'approved',NULL,$5::bytea) result`,
  [ORG_ID, session, request, version, hash([version, "approved", null])], "service_role", users[session]);
  return result.rows[0].result;
}
async function pending() {
  const result = await submit();
  assert.equal(result.status, "recorded");
  assert.equal(result.state, "pending_approval");
  assert.ok(result.version_id);
  return result.version_id;
}
async function emergency(version: string, session: string, refs?: unknown[]): Promise<Result> {
  const photos = refs ?? [{ id: await photo() }];
  const args = [version, "water", "Synthetic emergency reason", photos];
  const result = await asRole(`SELECT app.b013_authorize_emergency(
    $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::jsonb,$8::bytea) result`,
  [ORG_ID, session, randomUUID(), ...args.slice(0, 3), JSON.stringify(photos), hash(args)], "service_role", users[session]);
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
  users = {};
  for (const name of ["admin", "manager", "owner", "coastAdmin"] as const) {
    sessions[name] = randomUUID();
    users[sessions[name]] = USERS[name];
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
  assert.equal(rows.length, 7);
  for (const row of rows) {
    assert.equal(row.prosecdef, true);
    assert.equal(row.service, true);
    assert.equal(row.anon, false);
    assert.equal(row.authenticated, false);
    assert.ok(row.proconfig.some((value: string) => value.replaceAll(" ", "") ===
      (["b013_record_appointment", "b013_record_vendor_appointment"].includes(row.proname)
        ? "search_path=pg_catalog,app" : "search_path=pg_catalog,public,app,pg_temp")));
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
      $1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::uuid,'vendor_rejected',NULL,NULL,NULL,NULL,$6::bytea,'Unavailable') result`,
    [ORG_ID, sessions.manager, randomUUID(), version, jobId, hash([version, jobId, "vendor_rejected"])],
    "service_role", users[sessions.manager])).rows[0].result;
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

async function vendorAppointmentFixture(createdBy: string | null = USERS.admin) {
  const version = await pending(), jobId = randomUUID(), tokenHash = randomBytes(32).toString("hex");
  const scope = (await db.query(`SELECT pg_get_expr(d.adbin,d.adrelid) expression
    FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.repair_vendor_jobs'::regclass AND a.attname='scope'`)).rows[0]?.expression;
  await db.query(`INSERT INTO public.repair_vendor_jobs
    (id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,active,created_by,scope)
    VALUES($1,$2,$3,'Fixture vendor','+886900000000','Weekdays',$4,
      clock_timestamp()+interval '1 day',true,$5,${scope ?? "'repair'"})`,
  [jobId, ORG_ID, ticket, tokenHash, createdBy]);
  return { version, jobId, tokenHash };
}
type VendorFixture = Awaited<ReturnType<typeof vendorAppointmentFixture>>;
async function vendorAppointment(f: VendorFixture, options: {
  org?: string; request?: string; event?: string; reason?: string | null; digest?: Buffer;
} = {}): Promise<Result> {
  const event = options.event ?? "vendor_rejected";
  const reason = options.reason === undefined ? "Cannot attend" : options.reason;
  return (await asRole(`SELECT app.b013_record_vendor_appointment(
    $1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::text,
    NULL,NULL,'2026-11-06T10:00:00Z','2026-11-06T11:00:00Z',$7::text,$8::bytea) result`,
  [options.org ?? ORG_ID, f.jobId, f.tokenHash, options.request ?? randomUUID(), f.version,
    event, reason, options.digest ?? hash([f.version, f.jobId, event, reason])])).rows[0].result;
}

test("vendor token rejection and completion replay without a session and never close the ticket", async () => {
  const f = await vendorAppointmentFixture();
  await controls("vendor_dispatch", true);
  const before = (await db.query("SELECT status::text FROM public.maintenance_tickets WHERE id=$1", [ticket])).rows[0];
  const request = randomUUID(), digest = hash("fixed hash tests independent argument binding");
  const first = await vendorAppointment(f, { request, digest });
  assert.equal(first.status, "recorded");
  assert.deepEqual(await vendorAppointment(f, { request, digest }), first);
  assert.equal((await vendorAppointment(f, { request, digest, reason: "Changed" })).status, "rejected_conflict");
  assert.equal((await vendorAppointment(f, { request, digest: hash("changed hash") })).status, "rejected_conflict");
  const row = (await db.query(`SELECT response_reason,actor_id::text FROM app.b013_repair_appointments
    WHERE id=$1`, [first.appointment_id])).rows[0];
  assert.deepEqual(row, { response_reason: "Cannot attend", actor_id: USERS.admin });
  assert.equal((await vendorAppointment(f, { event: "vendor_completion_submitted" })).status, "rejected_conflict");
  await decide(f.version);
  const complete = await vendorAppointment(f, { event: "vendor_completion_submitted", reason: null });
  assert.equal(complete.status, "recorded");
  assert.deepEqual((await db.query("SELECT status::text FROM public.maintenance_tickets WHERE id=$1", [ticket])).rows[0], before);
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b013_repair_appointments")).rows[0].n, 2);
  await rejected("UPDATE app.b013_repair_appointments SET response_reason='changed' WHERE id=$1", [first.appointment_id], "23514");
  await rejected("DELETE FROM app.b013_repair_appointments WHERE id=$1", [complete.appointment_id], "23514");
});

test("vendor token pins org, ticket and active capability even on replay", async () => {
  const f = await vendorAppointmentFixture(), request = randomUUID();
  await controls("vendor_dispatch", true);
  assert.equal((await vendorAppointment(f, { request })).status, "recorded");
  await assert.rejects(vendorAppointment({ ...f, tokenHash: randomBytes(32).toString("hex") }), { code: "42501" });
  await assert.rejects(vendorAppointment(f, { org: ORG2_ID }), { code: "42501" });
  const other = await submit({ ticketId: otherTicket });
  assert.ok(other.version_id);
  await assert.rejects(vendorAppointment({ ...f, version: other.version_id }), { code: "42501" });
  for (const change of ["active=false", "revoked_at=clock_timestamp()", "expires_at=clock_timestamp()-interval '1 second'"]) {
    await db.query("SAVEPOINT capability");
    await db.query(`UPDATE public.repair_vendor_jobs SET ${change} WHERE id=$1`, [f.jobId]);
    await assert.rejects(vendorAppointment(f, { request }), { code: "42501" });
    await db.query("ROLLBACK TO SAVEPOINT capability");
    await db.query("RELEASE SAVEPOINT capability");
  }
});

test("vendor OFF commands persist and replay; null dispatcher uses stable job actor", async () => {
  const f = await vendorAppointmentFixture(null);
  for (const flag of ["vendor_dispatch", "repair_approvals"] as const) {
    await controls("vendor_dispatch", true);
    await controls("repair_approvals", true);
    await controls(flag, false);
    const request = randomUUID();
    assert.deepEqual(await vendorAppointment(f, { request }), { status: "rejected_disabled" });
    await controls(flag, true);
    assert.deepEqual(await vendorAppointment(f, { request }), { status: "rejected_disabled" });
    assert.equal((await db.query("SELECT actor_id::text FROM app.b013_repair_commands WHERE request_id=$1", [request])).rows[0].actor_id, f.jobId);
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b013_repair_appointments")).rows[0].n, 0);
  assert.equal((await vendorAppointment(f)).status, "recorded");
});

test("company confirmation stays staff-only and rejection reasons are checked by gateway and table", async () => {
  const f = await vendorAppointmentFixture();
  await controls("vendor_dispatch", true);
  assert.equal((await vendorAppointment(f, { event: "company_confirmed" })).status, "rejected_invalid");
  for (const reason of [null, "", "   ", "x".repeat(4001)]) {
    assert.equal((await vendorAppointment(f, { reason })).status, "rejected_invalid");
    await rejected(`INSERT INTO app.b013_repair_appointments
      (org_id,ticket_id,version_id,repair_vendor_job_id,event_kind,actor_id,response_reason)
      VALUES($1,$2,$3,$4,'vendor_rejected',$5,$6)`,
    [ORG_ID, ticket, f.version, f.jobId, USERS.admin, reason], "23514");
  }
  for (const reason of ["x", "x".repeat(4000)]) {
    assert.equal((await vendorAppointment(f, { reason })).status, "recorded");
  }
  const sql = `SELECT app.b013_record_appointment($1::uuid,$1::uuid,'live',$2::uuid,$3::uuid,$4::uuid,$5::uuid,
    'company_confirmed',NULL,NULL,'2026-11-06T10:00:00Z','2026-11-06T11:00:00Z',$6::bytea) result`;
  const args = [ORG_ID, sessions.manager, randomUUID(), f.version, f.jobId, hash("confirmation")];
  assert.equal((await asRole(sql, args, "service_role", users[sessions.manager])).rows[0].result.status, "recorded");
  for (const session of [sessions.owner, null]) {
    await assert.rejects(asRole(sql, [ORG_ID, session, randomUUID(), f.version, f.jobId, hash("denied")],
      "service_role", session ? users[session] : null), { code: "42501" });
  }
});
