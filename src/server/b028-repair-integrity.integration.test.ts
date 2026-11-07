// B-028 package 4: inherited B-013 repair authorization/integrity gaps.
// (1) Mutators bind the selected environment/live-org tuple and the request principal.
// (2) Estimate evidence and emergency photo refs must be real, owner-visible photos of
//     the same org and ticket. (3) Appointment/vendor-job org and ticket stay consistent
//     under parent-job UPDATE. Every denial proves zero domain/outbox writes.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { submitEstimate } from "./repair-approval";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let db: Client;
let property: string, ticket: string, otherTicket: string, org2Ticket: string;
let currency: string, scale: number;
let sandbox: string, sandboxTicket: string, sandboxScale: number;
let sessions: Record<string, string>;
let users: Record<string, string>;

const tables = [
  "b013_estimate_heads", "b013_estimate_versions", "b013_estimate_decisions",
  "b013_repair_emergencies", "b013_repair_appointments", "b013_repair_commands", "b013_repair_event_outbox",
];
const domain = tables.filter(name => name !== "b013_repair_commands");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest();
type Result = { status: string; version_id?: string; emergency_id?: string; event_id?: string; appointment_id?: string; decision_id?: string };
type Ctx = { org: string; live: string; env: string; session: string | null; sub: string | null };

async function asRole(sql: string, values: unknown[], sub: string | null) {
  await db.query("SAVEPOINT b028p4_call");
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [sub ?? ""]);
    await db.query("SET LOCAL ROLE service_role");
    const result = await db.query(sql, values);
    await db.query("RESET ROLE");
    await db.query("SELECT set_config('request.jwt.claim.sub','',true)");
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("SET CONSTRAINTS ALL DEFERRED");
    await db.query("RELEASE SAVEPOINT b028p4_call");
    return result;
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT b028p4_call");
    await db.query("RELEASE SAVEPOINT b028p4_call");
    throw error;
  }
}
async function rejectedSql(sql: string, values: unknown[], code: string) {
  await db.query("SAVEPOINT b028p4_rejected");
  try {
    await assert.rejects(db.query(sql, values), (error: unknown) => {
      assert.equal((error as { code?: string }).code, code);
      return true;
    });
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT b028p4_rejected");
    await db.query("RELEASE SAVEPOINT b028p4_rejected");
  }
}
/** Every persisted row of the seven B-013 tables plus the repair audit trail. */
async function snapshot(names: string[] = tables) {
  const rows: Record<string, unknown> = {};
  for (const name of names) {
    rows[name] = (await db.query("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE \"C\"),'[]'::jsonb) s FROM app."
      + name + " t")).rows[0].s;
  }
  rows.audit = (await db.query("SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) s FROM public.audit_log a"
    + " WHERE a.table_name LIKE 'b013%'")).rows[0].s;
  return rows;
}
async function controls(on: boolean, orgs: string[] = [ORG_ID, sandbox]) {
  assert.equal((await db.query("UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$1::boolean,"
    + "'allowed_org_ids',$2::jsonb) WHERE key='repair_approvals'", [on, JSON.stringify(orgs)])).rowCount, 1);
  await db.query("UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('repair_approvals',$2::boolean,"
    + "'vendor_dispatch',true),plan_tier=CASE WHEN environment='live' THEN 'beta' ELSE plan_tier END WHERE id=ANY($1::uuid[])", [orgs, on]);
}
async function makeTicket(org: string, propertyId: string) {
  const id = randomUUID();
  const result = await db.query("INSERT INTO public.maintenance_tickets"
    + "(id,org_id,ticket_number,property_id,category,priority,status,title,cost_bearer,owner_approval)"
    + " SELECT $1,$2,(SELECT coalesce(max(ticket_number),0)+1 FROM public.maintenance_tickets WHERE org_id=$2),"
    + "$3,category,priority,status,'B-028 package 4 fixture',cost_bearer,owner_approval"
    + " FROM public.maintenance_tickets WHERE org_id=$4 ORDER BY id LIMIT 1", [id, org, propertyId, ORG_ID]);
  assert.equal(result.rowCount, 1);
  return id;
}
/** A real owner-visible ticket photo: private-bucket file + ticket attachment. */
async function photo(ticketId: string, org = ORG_ID) {
  const file = randomUUID(), attachment = randomUUID();
  await db.query("INSERT INTO public.files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)"
    + " VALUES($1::uuid,$2::uuid,'ticket-photos-private','org/'||$2::uuid::text||'/tickets/'||$3::uuid::text||'/'||$1::uuid::text||'.jpg',"
    + "'fixture.jpg','image/jpeg',1024,$4)", [file, org, ticketId, USERS.admin]);
  await db.query("INSERT INTO public.ticket_attachments(id,org_id,ticket_id,file_id) VALUES($1,$2,$3,$4)",
    [attachment, org, ticketId, file]);
  return attachment;
}
async function job(ticketId: string, org = ORG_ID) {
  const id = randomUUID();
  const expression = (await db.query("SELECT pg_get_expr(d.adbin,d.adrelid) expression FROM pg_attribute a"
    + " JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum"
    + " WHERE a.attrelid='public.repair_vendor_jobs'::regclass AND a.attname='scope'")).rows[0]?.expression;
  await db.query("INSERT INTO public.repair_vendor_jobs"
    + "(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,active,created_by,created_at,scope)"
    + " VALUES($1,$2,$3,'Fixture vendor','+886900000000','Weekdays',$4,clock_timestamp()+interval '1 day',true,$5,clock_timestamp(),"
    + (expression ?? "'repair'") + ")", [id, org, ticketId, randomBytes(32).toString("hex"), USERS.admin]);
  return id;
}

const live = (name: keyof typeof USERS): Ctx => ({ org: ORG_ID, live: ORG_ID, env: "live", session: sessions[name], sub: USERS[name] });
const inSandbox = (name: keyof typeof USERS): Ctx => ({ org: sandbox, live: ORG_ID, env: "sandbox", session: sessions[name], sub: USERS[name] });

async function submit(ctx: Ctx, options: { ticketId?: string; evidence?: unknown[]; expected?: string | null; request?: string } = {}): Promise<Result> {
  const ticketId = options.ticketId ?? (ctx.org === sandbox ? sandboxTicket : ticket);
  const args = [ticketId, options.expected ?? null, "500001", currency, ctx.org === sandbox ? sandboxScale : scale,
    "Replace damaged pipe", options.evidence ?? []];
  return (await asRole("SELECT app.b013_submit_estimate($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,"
    + "$8::bigint,$9::text,$10::smallint,$11::text,$12::jsonb,$13::bytea) r",
  [ctx.org, ctx.live, ctx.env, ctx.session, options.request ?? randomUUID(), ...args.slice(0, 6),
    JSON.stringify(args[6]), hash(args)], ctx.sub)).rows[0].r;
}
async function decide(ctx: Ctx, version: string, request = randomUUID()): Promise<Result> {
  return (await asRole("SELECT app.b013_decide_estimate($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,'approved',NULL,$7::bytea) r",
    [ctx.org, ctx.live, ctx.env, ctx.session, request, version, hash([version, "approved"])], ctx.sub)).rows[0].r;
}
async function emergency(ctx: Ctx, version: string, photos: unknown[], request = randomUUID()): Promise<Result> {
  return (await asRole("SELECT app.b013_authorize_emergency($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,'water',"
    + "'Synthetic emergency reason',$7::jsonb,$8::bytea) r",
  [ctx.org, ctx.live, ctx.env, ctx.session, request, version, JSON.stringify(photos), hash([version, photos])], ctx.sub)).rows[0].r;
}
async function appointment(ctx: Ctx, version: string, jobId: string, request = randomUUID()): Promise<Result> {
  return (await asRole("SELECT app.b013_record_appointment($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,"
    + "'vendor_proposed','2026-11-10T10:00:00Z','2026-11-10T11:00:00Z',NULL,NULL,$8::bytea) r",
  [ctx.org, ctx.live, ctx.env, ctx.session, request, version, jobId, hash([version, jobId])], ctx.sub)).rows[0].r;
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
  const own = (await db.query("SELECT po.id,po.property_id,p.currency::text currency,r.minor_unit"
    + " FROM public.property_owners po JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id"
    + " JOIN public.properties p ON p.org_id=po.org_id AND p.id=po.property_id"
    + " JOIN public.organizations o ON o.id=po.org_id"
    + " JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency"
    + " WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND c.archived_at IS NULL AND p.archived_at IS NULL"
    + " ORDER BY po.id LIMIT 1", [ORG_ID, USERS.owner])).rows[0];
  assert.ok(own, "seed must contain an owner property with a regional currency scale");
  property = own.property_id; currency = own.currency.trim(); scale = own.minor_unit;
  await db.query("UPDATE public.property_owners SET effective_from=least(effective_from,CURRENT_DATE-1),effective_to=CURRENT_DATE"
    + " WHERE org_id=$1 AND property_id=$2 AND id<>$3", [ORG_ID, property, own.id]);
  await db.query("UPDATE public.property_owners SET repair_approval_threshold_minor=500000,"
    + "effective_from=CURRENT_DATE-1,effective_to=NULL WHERE id=$1", [own.id]);
  ticket = await makeTicket(ORG_ID, property);
  otherTicket = await makeTicket(ORG_ID, property);
  const p2 = (await db.query("SELECT id FROM public.properties WHERE org_id=$1 ORDER BY id LIMIT 1", [ORG2_ID])).rows[0];
  assert.ok(p2);
  org2Ticket = await makeTicket(ORG2_ID, p2.id);
  // A sandbox of ORG_ID with its own staff members, owner, property and ticket.
  sandbox = randomUUID();
  const sandboxProperty = randomUUID(), sandboxContact = randomUUID();
  await db.query("INSERT INTO public.organizations(id,name,country_code,default_currency,timezone,environment,live_org_id,feature_flags)"
    + " SELECT $1,'B-028 package 4 sandbox',country_code,default_currency,timezone,'sandbox',id,'{}' FROM public.organizations WHERE id=$2",
  [sandbox, ORG_ID]);
  await db.query("INSERT INTO public.properties(id,org_id,name,country_code,currency,timezone)"
    + " SELECT $1,$2,'Sandbox repair property',country_code,currency,timezone FROM public.properties WHERE id=$3",
  [sandboxProperty, sandbox, property]);
  await db.query("INSERT INTO public.contacts(id,org_id,is_owner,user_id,display_name) VALUES($1,$2,true,$3,'Synthetic sandbox owner')",
    [sandboxContact, sandbox, USERS.owner]);
  await db.query("INSERT INTO public.property_owners(org_id,property_id,owner_contact_id,effective_from,repair_approval_threshold_minor)"
    + " VALUES($1,$2,$3,CURRENT_DATE-1,500000)", [sandbox, sandboxProperty, sandboxContact]);
  await db.query("INSERT INTO public.org_members(org_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'manager')",
    [sandbox, USERS.admin, USERS.manager]);
  sandboxTicket = await makeTicket(sandbox, sandboxProperty);
  sandboxScale = (await db.query("SELECT r.minor_unit FROM public.properties p JOIN public.organizations o ON o.id=p.org_id"
    + " JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency WHERE p.id=$1",
  [sandboxProperty])).rows[0].minor_unit;
  sessions = {};
  users = {};
  for (const name of ["admin", "manager", "owner", "coastAdmin"] as const) {
    sessions[name] = randomUUID();
    users[sessions[name]] = USERS[name];
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
      [sessions[name], USERS[name], randomBytes(32).toString("hex")]);
  }
  await controls(true);
});
test.afterEach(async () => { await db.query("ROLLBACK"); });
test.after(async () => { try { await db?.end(); } finally { await clone?.cleanup(); } });

test("valid live and sandbox contexts record every session mutator", async () => {
  for (const [ctx, ticketId, org] of [[live, ticket, ORG_ID], [inSandbox, sandboxTicket, sandbox]] as const) {
    const version = (await submit(ctx("manager"))).version_id;
    assert.ok(version, org);
    assert.equal((await emergency(ctx("admin"), version, [{ id: await photo(ticketId, org) }])).status, "recorded", org);
    assert.equal((await decide(ctx("owner"), version)).status, "recorded", org);
    assert.equal((await appointment(ctx("manager"), version, await job(ticketId, org))).status, "recorded", org);
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b013_repair_appointments WHERE org_id=$1", [org])).rows[0].n, 1);
  }
  // Sandbox work stays in the sandbox org.
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b013_estimate_versions WHERE org_id=$1", [sandbox])).rows[0].n, 1);
});

test("swapped environment, live-org mismatch, wrong principal and revoked or expired sessions deny every mutator with zero writes", async () => {
  // Fixtures recorded through valid contexts; denials below must leave every row unchanged.
  const fixtures: Record<string, { version: string; photo: string; job: string; ticketId: string }> = {};
  for (const [ctx, ticketId, org] of [[live, ticket, ORG_ID], [inSandbox, sandboxTicket, sandbox]] as const) {
    const version = (await submit(ctx("manager"))).version_id;
    assert.ok(version);
    fixtures[org] = { version, photo: await photo(ticketId, org), job: await job(ticketId, org), ticketId };
  }
  const calls = {
    submit: (ctx: Ctx) => submit(ctx, { expected: fixtures[ctx.org === sandbox ? sandbox : ORG_ID]?.version }),
    decide: (ctx: Ctx) => decide(ctx, fixtures[ctx.org === sandbox ? sandbox : ORG_ID].version),
    emergency: (ctx: Ctx) => { const f = fixtures[ctx.org === sandbox ? sandbox : ORG_ID]; return emergency(ctx, f.version, [{ id: f.photo }]); },
    appointment: (ctx: Ctx) => { const f = fixtures[ctx.org === sandbox ? sandbox : ORG_ID]; return appointment(ctx, f.version, f.job); },
  } as const;
  const actor = { submit: "manager", decide: "owner", emergency: "admin", appointment: "manager" } as const;
  const revoked = randomUUID(), expired = randomUUID();
  const before = await snapshot();
  let denials = 0;
  for (const [name, call] of Object.entries(calls) as [keyof typeof calls, (ctx: Ctx) => Promise<Result>][]) {
    const who = actor[name];
    for (const base of [live(who), inSandbox(who)]) {
      const flipped = base.env === "live" ? "sandbox" : "live";
      const bad: [string, Ctx][] = [
        ["swapped environment", { ...base, env: flipped }],
        ["unknown environment", { ...base, env: "staging" }],
        ["live-org mismatch", { ...base, live: ORG2_ID }],
        ["live org is the sandbox", { ...base, live: sandbox }],
        ["wrong principal", { ...base, sub: who === "admin" ? USERS.manager : USERS.admin }],
        ["missing principal", { ...base, sub: null }],
        ["another user's session", { ...base, session: sessions.coastAdmin }],
        ["no session", { ...base, session: null }],
      ];
      for (const [label, ctx] of bad) {
        await assert.rejects(call(ctx), { code: "42501" }, `${name} ${base.env}: ${label}`);
        denials++;
      }
      for (const [label, id, change] of [["revoked session", revoked, "revoked_at=clock_timestamp()"],
        ["expired session", expired, "expires_at=clock_timestamp()-interval '1 second'"]] as const) {
        await db.query("SAVEPOINT session_state");
        await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",
          [id, USERS[who], randomBytes(32).toString("hex")]);
        await db.query(`UPDATE public.auth_sessions SET ${change} WHERE id=$1`, [id]);
        await assert.rejects(call({ ...base, session: id }), { code: "42501" }, `${name} ${base.env}: ${label}`);
        await db.query("ROLLBACK TO SAVEPOINT session_state");
        await db.query("RELEASE SAVEPOINT session_state");
        denials++;
      }
      assert.deepEqual(await snapshot(), before, `${name} ${base.env}: zero writes in all seven tables and audit`);
    }
  }
  assert.equal(denials, 4 * 2 * 10);
  // Positive controls: the same calls with the valid tuple are recorded.
  assert.equal((await calls.decide(live("owner"))).status, "recorded");
  assert.equal((await calls.decide(inSandbox("owner"))).status, "recorded");
});

test("a recorded request cannot be replayed under a swapped or foreign context", async () => {
  const request = randomUUID();
  const first = await submit(live("manager"), { request });
  assert.equal(first.status, "recorded");
  const before = await snapshot();
  for (const ctx of [{ ...live("manager"), env: "sandbox" }, { ...live("manager"), live: ORG2_ID }, { ...live("manager"), sub: USERS.admin }]) {
    await assert.rejects(submit(ctx, { request }), { code: "42501" });
  }
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await submit(live("manager"), { request }), first);
});

test("OFF: a valid context keeps the single disabled-command record; an invalid context writes nothing", async () => {
  await controls(false);
  const before = await snapshot();
  await assert.rejects(submit({ ...live("manager"), env: "sandbox" }), { code: "42501" });
  await assert.rejects(submit({ ...live("manager"), sub: USERS.admin }), { code: "42501" });
  assert.deepEqual(await snapshot(), before, "invalid context while OFF: zero writes");
  const request = randomUUID();
  assert.deepEqual(await submit(live("manager"), { request }), { status: "rejected_disabled" });
  const after = await snapshot();
  for (const name of domain) assert.deepEqual(after[name], before[name], name + " unchanged while OFF");
  assert.deepEqual(after.audit, before.audit);
  const added = (after.b013_repair_commands as { request_id: string; outcome: string }[])
    .filter(row => !(before.b013_repair_commands as { request_id: string }[]).some(old => old.request_id === row.request_id));
  assert.deepEqual(added.map(row => [row.request_id, row.outcome]), [[request, "rejected_disabled"]]);
});

test("photo refs: only real owner-visible photos of the same org and ticket are accepted; others are rejected, never stripped", async () => {
  const good = await photo(ticket), second = await photo(ticket);
  const foreignTicket = await photo(otherTicket);
  const foreignOrg = await photo(org2Ticket, ORG2_ID);
  const sandboxPhoto = await photo(sandboxTicket, sandbox);
  const internal = await photo(ticket);
  await db.query("UPDATE public.ticket_attachments SET is_internal=true WHERE id=$1", [internal]);
  const deleted = await photo(ticket);
  await db.query("DELETE FROM public.ticket_attachments WHERE id=$1", [deleted]);
  const moved = await photo(ticket);
  await db.query("UPDATE public.files SET storage_bucket='ticket-files-other' WHERE id=(SELECT file_id FROM public.ticket_attachments WHERE id=$1)", [moved]);
  const version = (await submit(live("manager"))).version_id;
  assert.ok(version);
  const bad: [string, unknown[]][] = [
    ["foreign ticket", [{ id: foreignTicket }]],
    ["foreign org", [{ id: foreignOrg }]],
    ["sandbox of the same live org", [{ id: sandboxPhoto }]],
    ["missing", [{ id: randomUUID() }]],
    ["deleted", [{ id: deleted }]],
    ["revoked (internal, hidden from the owner)", [{ id: internal }]],
    ["storage object outside the private ticket-photo bucket", [{ id: moved }]],
    ["synthetic non-UUID id", [{ id: "photo" }]],
    ["one authorized plus one foreign", [{ id: good }, { id: foreignOrg }]],
  ];
  for (const [label, refs] of bad) {
    const before = await snapshot();
    assert.deepEqual(await submit(live("manager"), { expected: version, evidence: refs }), { status: "rejected_invalid" }, "evidence: " + label);
    assert.deepEqual(await emergency(live("admin"), version, refs), { status: "rejected_invalid" }, "emergency: " + label);
    const after = await snapshot();
    for (const name of domain) assert.deepEqual(after[name], before[name], label + ": " + name + " unchanged");
    assert.deepEqual(after.audit, before.audit, label + ": no emergency audit");
    assert.equal((after.b013_repair_commands as unknown[]).length, (before.b013_repair_commands as unknown[]).length + 2,
      label + ": only the two rejected_invalid command results");
  }
  // Authorized refs are accepted (extra fields stay in the private snapshot only).
  const evidence = [{ id: good, storage_key: "org/secret.jpg", url: "https://private.invalid/x" }, { id: second }];
  const next = await submit(live("manager"), { expected: version, evidence });
  assert.equal(next.status, "recorded");
  assert.ok(next.version_id);
  const authorized = await emergency(live("admin"), next.version_id, [{ id: good, storage_path: "org/secret.jpg" }]);
  assert.equal(authorized.status, "recorded");
  const readers = [
    ["b013_owner_pending", sessions.owner, USERS.owner, "evidence_snapshot", [{ id: good }, { id: second }]],
    ["b013_owner_history", sessions.owner, USERS.owner, "emergency_photo_refs", [{ id: good }]],
    ["b013_manager_view", sessions.manager, USERS.manager, "emergency_photo_refs", [{ id: good }]],
  ] as const;
  for (const [name, session, sub, column, expected] of readers) {
    const args = name === "b013_owner_pending" ? "$1::uuid,$1::uuid,'live',$2::uuid" : "$1::uuid,$1::uuid,'live',$2::uuid,$3::uuid";
    const values = name === "b013_owner_pending" ? [ORG_ID, session] : [ORG_ID, session, ticket];
    const rows = (await asRole("SELECT * FROM app." + name + "(" + args + ")", values, sub)).rows;
    const current = rows.find(row => row.version_id === next.version_id);
    assert.ok(current, name);
    assert.deepEqual(current[column], expected, name);
    assert.doesNotMatch(JSON.stringify(rows), /storage_key|storage_path|ticket-photos|secret|https?:|\.jpg/, name + " never returns storage keys or URLs");
  }
});

test("appointment/job invariant: wrong-org insertion and parent-job reassignment are rejected; references preserved", async () => {
  const version = (await submit(live("manager"))).version_id;
  assert.ok(version);
  const good = await job(ticket);
  const foreignOrgJob = await job(org2Ticket, ORG2_ID);
  const insert = "INSERT INTO app.b013_repair_appointments(org_id,ticket_id,version_id,repair_vendor_job_id,event_kind,actor_id)"
    + " VALUES($1,$2,$3,$4,'vendor_proposed',$5)";
  const before = await snapshot();
  await rejectedSql(insert, [ORG_ID, ticket, version, foreignOrgJob, USERS.manager], "23503");
  await assert.rejects(appointment(live("manager"), version, foreignOrgJob), { code: "42501" });
  assert.deepEqual(await snapshot(), before, "wrong-org job: zero writes");
  const recorded = await appointment(live("manager"), version, good);
  assert.equal(recorded.status, "recorded");
  const jobRow = async () => (await db.query("SELECT org_id::text,ticket_id::text FROM public.repair_vendor_jobs WHERE id=$1", [good])).rows[0];
  const appointmentRow = async () => (await db.query("SELECT org_id::text,ticket_id::text,repair_vendor_job_id::text FROM app.b013_repair_appointments WHERE id=$1",
    [recorded.appointment_id])).rows[0];
  const jobBefore = await jobRow(), appointmentBefore = await appointmentRow();
  assert.deepEqual(jobBefore, { org_id: ORG_ID, ticket_id: ticket });
  await rejectedSql("UPDATE public.repair_vendor_jobs SET ticket_id=$2 WHERE id=$1", [good, otherTicket], "23503");
  const p2 = (await db.query("SELECT property_id FROM public.maintenance_tickets WHERE id=$1", [org2Ticket])).rows[0].property_id;
  const org2Target = await makeTicket(ORG2_ID, p2);
  await rejectedSql("UPDATE public.repair_vendor_jobs SET org_id=$2,ticket_id=$3 WHERE id=$1", [good, ORG2_ID, org2Target], "23503");
  assert.deepEqual(await jobRow(), jobBefore);
  assert.deepEqual(await appointmentRow(), appointmentBefore);
  // Non-scope updates of the referenced job still work (e.g. revocation).
  await db.query("SAVEPOINT revoke_job");
  await db.query("UPDATE public.repair_vendor_jobs SET active=false,revoked_at=clock_timestamp() WHERE id=$1", [good]);
  await db.query("ROLLBACK TO SAVEPOINT revoke_job");
  await db.query("RELEASE SAVEPOINT revoke_job");
  // Negative control: without the composite FK the parent reassignment silently succeeds.
  await db.query("SAVEPOINT without_fk");
  await db.query("ALTER TABLE app.b013_repair_appointments DROP CONSTRAINT b028_appointment_job_scope_fkey");
  assert.equal((await db.query("UPDATE public.repair_vendor_jobs SET ticket_id=$2 WHERE id=$1", [good, otherTicket])).rowCount, 1);
  await db.query("ROLLBACK TO SAVEPOINT without_fk");
  await db.query("RELEASE SAVEPOINT without_fk");
  assert.deepEqual(await jobRow(), jobBefore);
});

test("catalog: new mutator signatures replace the old ones; helpers and constraint stay private and validated", async () => {
  const rows = (await db.query("SELECT p.proname,p.oid::regprocedure::text signature,p.prosecdef,p.proconfig,"
    + " has_function_privilege('service_role',p.oid,'EXECUTE') service,has_function_privilege('anon',p.oid,'EXECUTE') anon,"
    + " has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated"
    + " FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app'"
    + " AND p.proname IN ('b013_submit_estimate','b013_decide_estimate','b013_authorize_emergency','b013_record_appointment',"
    + "'b028_repair_actor','b028_repair_photo_refs') ORDER BY p.proname")).rows;
  assert.deepEqual(rows.map(row => row.signature), [
    "app.b013_authorize_emergency(uuid,uuid,text,uuid,uuid,uuid,text,text,jsonb,bytea)",
    "app.b013_decide_estimate(uuid,uuid,text,uuid,uuid,uuid,text,text,bytea)",
    "app.b013_record_appointment(uuid,uuid,text,uuid,uuid,uuid,uuid,text,timestamp with time zone,timestamp with time zone,"
      + "timestamp with time zone,timestamp with time zone,bytea,text)",
    "app.b013_submit_estimate(uuid,uuid,text,uuid,uuid,uuid,uuid,bigint,text,smallint,text,jsonb,bytea)",
    "app.b028_repair_actor(uuid,uuid,text,uuid)",
    "app.b028_repair_photo_refs(uuid,uuid,jsonb,integer)",
  ]);
  for (const row of rows) {
    const gateway = row.proname.startsWith("b013_");
    assert.equal(row.prosecdef, true, row.proname);
    assert.equal(row.service, gateway, row.proname);
    assert.equal(row.anon, false, row.proname);
    assert.equal(row.authenticated, false, row.proname);
    assert.ok(row.proconfig.some((value: string) => value.replaceAll(" ", "") === (row.proname === "b013_record_appointment"
      ? "search_path=pg_catalog,app" : "search_path=pg_catalog,public,app,pg_temp")), row.proname);
  }
  const fk = (await db.query("SELECT convalidated,pg_get_constraintdef(oid) def FROM pg_constraint"
    + " WHERE conrelid='app.b013_repair_appointments'::regclass AND conname='b028_appointment_job_scope_fkey'")).rows[0];
  assert.deepEqual(fk, { convalidated: true,
    def: "FOREIGN KEY (org_id, ticket_id, repair_vendor_job_id) REFERENCES repair_vendor_jobs(org_id, ticket_id, id) ON DELETE RESTRICT" });
});

// Last: commits its fixtures so the real TS wrapper (svc, separate connection) sees them.
test("TS wrapper passes the session tuple and principal; mismatched sessions are denied before any write", async () => {
  await db.query("COMMIT");
  try {
    const session = (overrides: Partial<Session> = {}): Session => ({
      userId: USERS.manager, sessionId: sessions.manager, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live",
      kind: "staff", role: "manager", email: "synthetic@example.test", name: "Synthetic", locale: "en",
      calendar: "gregorian", leaseId: null, ...overrides,
    });
    const input = () => ({ requestId: randomUUID(), ticketId: ticket, expectedHeadId: null, amountMinor: 1000,
      currency, minorUnit: scale, workScope: "Synthetic", evidence: [] as { id: string }[] });
    const before = await snapshot();
    for (const overrides of [{ environment: "sandbox" as const }, { liveOrgId: ORG2_ID }, { userId: USERS.admin }]) {
      await assert.rejects(submitEstimate(session(overrides), input()), (error: unknown) => {
        assert.equal((error as { cause?: { code?: string } }).cause?.code, "42501");
        return true;
      });
    }
    assert.throws(() => submitEstimate(session({ environment: "staging" as Session["environment"] }), input()), { message: "errors.forbidden" });
    assert.deepEqual(await snapshot(), before, "TS denials: zero writes");
    assert.equal((await submitEstimate(session(), input())).status, "recorded");
  } finally {
    await db.query("BEGIN");
  }
});
