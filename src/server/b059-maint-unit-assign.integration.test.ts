import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { assignEdit, assignList, saveAssign } from "./b059-maint-unit-assign";
import { svc } from "./db";
import { updateTicket } from "./domain";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { listTickets, ticketDetail } from "./queries";
import { readRepairPhoto } from "./repairs";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

// MGT-118 (B-059 / DO-3) on a cloned disposable database: the real gateways through service_role and the real
// ticket readers (tx as authenticated, so the RESTRICTIVE policy applies). Never a pg mock or a grant.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const VIEW = "app.b059_assign_view(uuid,uuid,text,uuid,uuid)";
const SAVE = "app.b059_assign_save(uuid,uuid,text,uuid,uuid,uuid,uuid[])";
const HELPERS = ["app.b059_scoped_orgs()", "app.b059_visible_units()", "app.b059_own_members()", "app.b059_ticket_visible(uuid)"];
const sid: Record<string, string> = {};
const member: Record<string, string> = {};
let unitA: string, unitB: string, unitC: string, archivedUnit: string, org2Unit: string, property: string;
let tA: string, tB: string, tC: string, tProperty: string, tAssigned: string, attachmentB: string, org2Ticket: string;
let invite: string, managerInvite: string;
type Result = Record<string, unknown> & { status: string };
const code = (c: string) => (e: unknown) => ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === c;

const session = (who: keyof typeof USERS, role: Session["role"], org = ORG_ID): Session => ({ kind: "staff", role, orgId: org, liveOrgId: org,
  userId: USERS[who], sessionId: sid[who], name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });
const admin = () => session("admin", "admin");
const manager = () => session("manager", "manager");
const accountant = () => session("accountant", "accountant");
const maint = () => session("maintenance", "maintenance");

async function flag(on: boolean, orgs: string[] = [ORG_ID, ORG2_ID]) {
  await db.query(`UPDATE public.platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',to_jsonb($2::text[])) WHERE key='maint_unit_assign'`, [on, orgs]);
  await db.query(`UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object('maint_unit_assign',$2::boolean) WHERE id = ANY($1::uuid[])`, [[ORG_ID, ORG2_ID], on]);
}
type Opts = { org?: string; live?: string; env?: string; pin?: string | null };
async function call<T>(fn: string, who: string, args: unknown[], opts: Opts = {}): Promise<T> {
  const org = opts.org ?? ORG_ID, env = opts.env ?? "live";
  return svc(null, async client => {
    if (opts.pin !== null) await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [opts.pin ?? org, env]);
    const params = args.map((_, i) => `$${i + 5}`).join(",");
    return (await client.query(`SELECT ${fn.split("(")[0]}($1,$2,$3,$4,${params}) r`, [org, opts.live ?? org, env, sid[who], ...args])).rows[0].r;
  });
}
const save = (who: string, target: string, units: string[], request = randomUUID(), opts: Opts = {}) => call<Result>(SAVE, who, [request, target, units], opts);
const view = (who: string, target: string | null = null, opts: Opts = {}) => call<Record<string, unknown> | null>(VIEW, who, [target], opts);
const snapshot = async () => (await db.query(`SELECT
  (SELECT md5(coalesce(string_agg(row_to_json(a)::text,'|' ORDER BY a.id),'')) FROM app.b059_unit_assignments a) rows,
  (SELECT md5(coalesce(string_agg(row_to_json(c)::text,'|' ORDER BY c.request_id),'')) FROM app.b059_assign_commands c) commands,
  (SELECT count(*)::int FROM public.audit_log a WHERE a.table_name='b059_unit_assignments') audit`)).rows[0] as Record<string, unknown>;
async function unchanged(label: string, fn: () => Promise<unknown>) { const before = await snapshot(); await fn(); assert.deepEqual(await snapshot(), before, label); }
const unitsOf = async (target: string) => (await db.query(`SELECT array_agg(unit_id::text ORDER BY unit_id) u FROM app.b059_unit_assignments WHERE member_id=$1 OR invitation_id=$1`, [target])).rows[0].u ?? [];
async function ticket(org: string, prop: string, unit: string | null, title: string, assigned: string | null = null) {
  return (await db.query(`INSERT INTO public.maintenance_tickets(org_id,ticket_number,property_id,unit_id,title,assigned_member_id)
    VALUES($1,(SELECT coalesce(max(ticket_number),1000)+1 FROM public.maintenance_tickets WHERE org_id=$1),$2,$3,$4,$5) RETURNING id`,
  [org, prop, unit, title, assigned])).rows[0].id as string;
}
const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort();
/** b059_ticket_visible's statements: [as written in the body, a parameterised copy, the index it must use].
 *  Parameters: $1 ticket, $2 org, $3 caller user, $4 caller member, $5 unit, $6 one of the caller's accepted
 *  invitations (a random id when it has none: the probe's shape is the same). */
const PROBES = [
  ["SELECT x.org_id, x.unit_id, x.assigned_member_id INTO t FROM public.maintenance_tickets x WHERE x.id=p_ticket",
    "SELECT x.org_id, x.unit_id, x.assigned_member_id FROM public.maintenance_tickets x WHERE x.id=$1", /maintenance_tickets_pkey/],
  ["SELECT m.id INTO me FROM public.org_members m WHERE m.org_id=t.org_id AND m.user_id=auth.uid() AND m.role='maintenance' AND m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id)",
    "SELECT m.id FROM public.org_members m WHERE m.org_id=$2 AND m.user_id=$3 AND m.role='maintenance' AND m.status='active' AND NOT app.b056_member_paused(m.org_id, m.user_id)",
    // Either user-keyed index is an exact caller lookup; the planner picks by version/stats (CI chose org_members_user_idx).
    /Index (Only )?Scan using (org_members_org_id_user_id_key|org_members_user_idx) on org_members/],
  ["EXISTS (SELECT 1 FROM app.b059_unit_assignments a WHERE a.org_id=t.org_id AND a.member_id=me AND a.unit_id=t.unit_id)",
    "SELECT EXISTS (SELECT 1 FROM app.b059_unit_assignments a WHERE a.org_id=$2 AND a.member_id=$4 AND a.unit_id=$5)", /b059_unit_assignments_member_unit_key/],
  ["FOR inv IN SELECT i.id FROM public.invitations i WHERE i.accepted_by=auth.uid() AND i.org_id=t.org_id AND i.status='accepted' LOOP",
    "SELECT i.id FROM public.invitations i WHERE i.accepted_by=$3 AND i.org_id=$2 AND i.status='accepted'", /b059_invitations_accepted_by_idx/],
  ["EXISTS (SELECT 1 FROM app.b059_unit_assignments a WHERE a.org_id=t.org_id AND a.invitation_id=inv AND a.unit_id=t.unit_id)",
    "SELECT EXISTS (SELECT 1 FROM app.b059_unit_assignments a WHERE a.org_id=$2 AND a.invitation_id=$6 AND a.unit_id=$5)",
    /b059_unit_assignments_invite_unit_key/],
] as const;
const norm = (text: string) => text.replace(/\s+/g, " ").trim();
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
/** Each probe uses its index, never a Seq Scan or hashed SubPlan. Caller-first: every assignment-table scan has the
 *  caller (member_id or the caller's invitation_id) in its index condition, so it can only touch the caller's own
 *  assignment entries, never the unit's other assignees; with ANALYZE it returns at most one row. Returns the plans
 *  and, per assignment node, [rows returned, rows removed by filter]. */
async function assertProbePlans(body: string, ticketId: string, memberId: string, unitId: string, invitationId: string = randomUUID()) {
  const fn = norm(body);
  const all = [ticketId, ORG_ID, USERS.maintenance, memberId, unitId, invitationId];
  const out: { text: string; assignmentRows: number[][] }[] = [];
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL enable_seqscan = off");
    for (const [inBody, sql, index] of PROBES) {
      assert.ok(fn.includes(inBody), `function body changed: ${inBody}`);
      const used = [...new Set([...sql.matchAll(/\$(\d)/g)].map(m => Number(m[1])))].sort();
      const bound = used.reduce((q: string, n, i) => q.replaceAll(`$${n}`, `$${i + 1}`), sql as string);
      const values = used.map(n => all[n - 1]);
      const text = (await db.query(`EXPLAIN (COSTS OFF) ${bound}`, values)).rows.map(r => r["QUERY PLAN"]).join("\n");
      assert.match(text, index, text);
      assert.doesNotMatch(text, /Seq Scan|hashed SubPlan/, text);
      const json = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${bound}`, values)).rows[0]["QUERY PLAN"][0].Plan as PlanNode;
      const assignments = planNodes(json).filter(n => n["Relation Name"] === "b059_unit_assignments");
      for (const n of assignments) {
        assert.ok(Number(n["Actual Rows"]) <= 1, `${sql}: ${JSON.stringify(n)}`);
        const cond = String(n["Index Cond"] ?? "");
        assert.ok(/member_id|invitation_id/.test(cond) && /org_id/.test(cond) && /unit_id/.test(cond), `${sql}: not an exact caller-first key ${JSON.stringify(n)}`);
        assert.equal(Number(n["Rows Removed by Filter"] ?? 0), 0, `${sql}: rows filtered away`);
      }
      out.push({ text, assignmentRows: assignments.map(n => [Number(n["Actual Rows"]), Number(n["Rows Removed by Filter"] ?? 0) + Number(n["Rows Removed by Index Recheck"] ?? 0)]) });
    }
  } finally { await db.query("ROLLBACK"); }
  return out;
}
/** Every SQL text the app sends while fn runs (the readers' own statements; parity is on these texts). */
async function sqlTexts(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const original = Client.prototype.query;
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    seen.push(typeof first === "string" ? first : first?.text ?? "");
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof Client.prototype.query;
  try { await fn(); } finally { Client.prototype.query = original; }
  return seen;
}

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
  for (const who of Object.keys(USERS)) {
    sid[who] = randomUUID();
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid[who], USERS[who as keyof typeof USERS], randomUUID()]);
  }
  sid.revoked = randomUUID();
  await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours',clock_timestamp())", [sid.revoked, USERS.admin, randomUUID()]);
  for (const row of (await db.query<{ id: string; user_id: string; org_id: string }>("SELECT id::text,user_id::text,org_id::text FROM public.org_members")).rows)
    member[`${row.org_id}:${row.user_id}`] = row.id;
  property = (await db.query(`INSERT INTO public.properties(org_id,name,country_code,currency,timezone) VALUES($1,'B059 民生東路','TW','TWD','Asia/Taipei') RETURNING id`, [ORG_ID])).rows[0].id;
  const unit = async (org: string, prop: string, label: string) => (await db.query(`INSERT INTO public.units(org_id,property_id,label,rental_mode) VALUES($1,$2,$3,'whole_unit') RETURNING id`, [org, prop, label])).rows[0].id as string;
  unitA = await unit(ORG_ID, property, "B059-1F"); unitB = await unit(ORG_ID, property, "B059-2F"); unitC = await unit(ORG_ID, property, "B059-3F");
  archivedUnit = await unit(ORG_ID, property, "B059-9F");
  await db.query("UPDATE public.units SET archived_at=clock_timestamp() WHERE id=$1", [archivedUnit]);
  const org2Property = (await db.query(`INSERT INTO public.properties(org_id,name,country_code,currency,timezone) VALUES($1,'B059 海岸','TW','TWD','Asia/Taipei') RETURNING id`, [ORG2_ID])).rows[0].id;
  org2Unit = await unit(ORG2_ID, org2Property, "B059-X");
  tA = await ticket(ORG_ID, property, unitA, "B059 A"); tB = await ticket(ORG_ID, property, unitB, "B059 B"); tC = await ticket(ORG_ID, property, unitC, "B059 C");
  tProperty = await ticket(ORG_ID, property, null, "B059 property-level");
  tAssigned = await ticket(ORG_ID, property, unitC, "B059 assigned to maintenance", member[`${ORG_ID}:${USERS.maintenance}`]);
  org2Ticket = await ticket(ORG2_ID, org2Property, org2Unit, "B059 org2");
  const file = randomUUID();
  await db.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,uploaded_by,size_bytes) VALUES($1,$2,'ticket-photos-private',$3,'b.png','image/png',$4,42)`,
    [file, ORG_ID, `org/${ORG_ID}/tickets/${tB}/${file}.png`, USERS.admin]);
  attachmentB = (await db.query(`INSERT INTO ticket_attachments(org_id,ticket_id,file_id) VALUES($1,$2,$3) RETURNING id`, [ORG_ID, tB, file])).rows[0].id;
  const invitation = async (role: string, email: string) => (await db.query(`INSERT INTO public.invitations(org_id,kind,role,email,code_hash,status,invited_by)
    VALUES($1,'team_member',$2::org_role,$3,$4,'pending',$5) RETURNING id`, [ORG_ID, role, email, randomUUID(), USERS.admin])).rows[0].id as string;
  invite = await invitation("maintenance", "b059-fixer@example.test");
  managerInvite = await invitation("manager", "b059-manager@example.test");
});

test.beforeEach(async () => { await flag(true); });
test.after(async () => {
  try { if (db) await db.end(); } finally { await clone?.cleanup(); }
});

test("MGT-118 privileges: gateways service_role only, RLS helpers authenticated only, tables have no application privilege", async () => {
  for (const fn of [VIEW, SAVE]) for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok, role === "service_role", `${role} ${fn}`);
  for (const fn of HELPERS) for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok, role === "authenticated", `${role} ${fn}`);
  for (const table of ["app.b059_unit_assignments", "app.b059_assign_commands"]) for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await db.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') ok", [role, table])).rows[0].ok, false, `${role} ${table}`);
});

test("MGT-118 Tier 2 anon denial: anon cannot run either gateway or read either table", async () => {
  for (const sql of [`SELECT ${VIEW.split("(")[0]}($1,$1,'live',$2,NULL)`, `SELECT ${SAVE.split("(")[0]}($1,$1,'live',$2,$3,$3,ARRAY[]::uuid[])`,
    "SELECT count(*) FROM app.b059_unit_assignments", "SELECT count(*) FROM app.b059_assign_commands"]) {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE anon");
      const args = sql.includes("$3") ? [ORG_ID, sid.admin, randomUUID()] : sql.includes("$2") ? [ORG_ID, sid.admin] : [];
      await assert.rejects(db.query(sql, args), code("42501"), sql);
    } finally { await db.query("ROLLBACK"); }
  }
});

test("MGT-118-AC1: admin and manager assign units; the list counts them; replay, unchanged and conflict are idempotent", async () => {
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  const request = randomUUID();
  const first = await save("admin", fixer, [unitA, unitB], request);
  assert.deepEqual(first, { status: "saved", units: 2, replayed: false });
  await unchanged("a replay writes nothing", async () =>
    assert.deepEqual(await save("admin", fixer, [unitA, unitB], request), { status: "saved", units: 2, replayed: true }));
  await unchanged("same id, other payload", async () =>
    assert.deepEqual(await save("admin", fixer, [unitA], request), { status: "conflict" }));
  await unchanged("same id, other actor", async () =>
    assert.deepEqual(await save("manager", fixer, [unitA, unitB], request), { status: "conflict" }));
  const audit = (await db.query("SELECT count(*)::int n FROM public.audit_log WHERE table_name='b059_unit_assignments' AND request_id=$1", [request])).rows[0].n;
  assert.equal(audit, 1);
  assert.deepEqual(await save("manager", fixer, [unitB, unitA]), { status: "unchanged", units: 2, replayed: false });
  assert.deepEqual(await save("manager", fixer, [unitA]), { status: "saved", units: 1, replayed: false });
  assert.deepEqual(await unitsOf(fixer), [unitA]);
  const list = await view("manager") as { people: { id: string; kind: string; units: number; name: string }[] };
  const row = list.people.find(p => p.id === fixer);
  assert.equal(row?.kind, "member"); assert.equal(row?.units, 1);
  // AC2: only maintenance people are listed (the pending maintenance invitation too; never a manager or accountant).
  assert.ok(list.people.some(p => p.id === invite && p.kind === "invite"));
  assert.ok(!list.people.some(p => p.id === managerInvite || p.id === member[`${ORG_ID}:${USERS.manager}`] || p.id === member[`${ORG_ID}:${USERS.accountant}`]));
  const edit = await view("admin", fixer) as { person: { id: string }; units: { id: string; checked: boolean }[] };
  assert.equal(edit.person.id, fixer);
  assert.deepEqual(edit.units.filter(u => [unitA, unitB, unitC].includes(u.id)).map(u => [u.id, u.checked]).sort(),
    [[unitA, true], [unitB, false], [unitC, false]].sort());
  assert.ok(!edit.units.some(u => u.id === archivedUnit || u.id === org2Unit), "no archived or foreign unit");
  // The app layer: same results through the TypeScript readers.
  const app = await assignList(manager());
  assert.equal(app.state, "ready");
  const saved = await saveAssign(admin(), { requestId: randomUUID(), target: fixer, units: [unitA, unitC] });
  assert.deepEqual(saved, { ok: true, status: "saved", units: 2, replayed: false });
  const appEdit = await assignEdit(admin(), fixer);
  assert.ok(appEdit.state === "ready" && appEdit.units.filter(u => u.checked).map(u => u.id).sort().join() === [unitA, unitC].sort().join());
});

test("MGT-118-AC7 + Tier 2 cross-org: accountant, maintenance, revoked session, other org and tuple tricks are 42501 with no write", async () => {
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  await unchanged("denials", async () => {
    for (const who of ["accountant", "maintenance", "revoked", "tenant", "owner"]) {
      await assert.rejects(save(who, fixer, [unitA]), code("42501"), who);
      await assert.rejects(view(who), code("42501"), who);
    }
    // ORG2's admin, with its own tuple, against ORG1's person and units.
    await assert.rejects(save("coastAdmin", fixer, [unitA], randomUUID(), { org: ORG2_ID }), code("42501"));
    await assert.rejects(view("coastAdmin", fixer, { org: ORG2_ID }), code("42501"));
    // ORG2's admin with ORG1's tuple (not a member there).
    await assert.rejects(save("coastAdmin", fixer, [unitA]), code("42501"));
    // A pinned org that differs from the tuple.
    await assert.rejects(save("admin", fixer, [unitA], randomUUID(), { pin: ORG2_ID }), code("42501"));
    await assert.rejects(save("admin", fixer, [unitA], randomUUID(), { pin: null }), code("42501"));
    // TS layer: 403 / forbidden, never a write.
    assert.deepEqual(await assignList(accountant()), { state: "forbidden" });
    assert.deepEqual(await assignList(maint()), { state: "forbidden" });
    assert.deepEqual(await assignEdit(accountant(), fixer), { state: "forbidden" });
    assert.deepEqual(await saveAssign(maint(), { requestId: randomUUID(), target: fixer, units: [unitA] }), { ok: false, status: 403 });
  });
});

test("MGT-118-AC2: the target must be a maintenance member or pending maintenance invitation of the same org; units must be this org's live units", async () => {
  await unchanged("bad targets", async () => {
    for (const target of [member[`${ORG_ID}:${USERS.manager}`], member[`${ORG_ID}:${USERS.accountant}`], member[`${ORG_ID}:${USERS.admin}`],
      member[`${ORG2_ID}:${USERS.coastAdmin}`], managerInvite, randomUUID()]) {
      await assert.rejects(save("admin", target, [unitA]), code("42501"), target);
      await assert.rejects(view("admin", target), code("42501"), target);
    }
  });
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  const before = await unitsOf(fixer);
  for (const units of [[archivedUnit], [org2Unit], [unitA, unitA], [unitA, randomUUID()]]) {
    const request = randomUUID();
    assert.deepEqual(await save("admin", fixer, units, request), { status: "invalid", replayed: false }, JSON.stringify(units));
    assert.deepEqual(await save("admin", fixer, units, request), { status: "invalid", replayed: true });
  }
  assert.deepEqual(await unitsOf(fixer), before);
  assert.deepEqual(await saveAssign(admin(), { requestId: randomUUID(), target: fixer, units: [org2Unit] }), { ok: false, status: 400 });
  // A pending maintenance invitation can be assigned ahead (GS-24).
  assert.deepEqual(await save("admin", invite, [unitB]), { status: "saved", units: 1, replayed: false });
  assert.deepEqual(await unitsOf(invite), [unitB]);
});

test("flag OFF: view NULL, save disabled, the TS layer says off / 404, nothing written", async () => {
  await flag(false);
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  await unchanged("OFF", async () => {
    assert.equal(await view("admin"), null);
    assert.deepEqual(await save("admin", fixer, [unitA]), { status: "disabled" });
    assert.deepEqual(await assignList(admin()), { state: "off" });
    assert.deepEqual(await saveAssign(admin(), { requestId: randomUUID(), target: fixer, units: [unitA] }), { ok: false, status: 404 });
  });
});

test("MGT-118-AC3/AC4/AC5: ON scopes maintenance to assigned units plus its own tickets; admin and manager unaffected; OFF is the unscoped baseline with the same SQL", async () => {
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  await save("admin", fixer, [unitA]);
  const ours = [tA, tB, tC, tProperty, tAssigned];
  const visible = async (s: Session) => ids(await listTickets(s)).filter(id => ours.includes(id));
  // Baseline: flag OFF, every role sees every ticket (as before this item).
  await flag(false);
  const offTexts = await sqlTexts(async () => { await listTickets(maint()); await ticketDetail(maint(), tA); });
  const offHidden = await sqlTexts(() => ticketDetail(maint(), tB));
  for (const s of [admin(), manager(), maint()]) assert.deepEqual(await visible(s), [...ours].sort(), `OFF ${s.role}`);
  assert.ok(await ticketDetail(maint(), tB), "OFF: detail of an unassigned unit's ticket");
  // ON: only unit A's ticket and the ticket explicitly assigned to the maintenance member (AC5); the property-level
  // ticket and units B/C are hidden. Admin, manager unchanged (AC4).
  await flag(true);
  assert.deepEqual(await visible(maint()), [tA, tAssigned].sort());
  for (const s of [admin(), manager()]) assert.deepEqual(await visible(s), [...ours].sort(), `ON ${s.role}`);
  assert.equal(await ticketDetail(maint(), tB), null);
  assert.ok(await ticketDetail(maint(), tA));
  assert.ok(await ticketDetail(maint(), tAssigned));
  // Same SQL text ON and OFF: the gate is the policy, not a reader change (flag-OFF data-read parity).
  const onTexts = await sqlTexts(async () => { await listTickets(maint()); await ticketDetail(maint(), tA); });
  assert.deepEqual(onTexts, offTexts);
  // A hidden ticket: the very same statements up to the ticket read, which now finds no row (then the reader stops).
  const onHidden = await sqlTexts(() => ticketDetail(maint(), tB));
  assert.deepEqual(onHidden.slice(0, -1), offHidden.slice(0, onHidden.length - 1));
  assert.equal(onHidden.at(-1), "COMMIT");
  // Writes follow visibility: a hidden ticket is not found for maintenance; the admin can still update it.
  await assert.rejects(updateTicket(maint(), tB, { status: "in_progress" }), (e: unknown) => (e as { key?: string }).key === "errors.notFound");
  await updateTicket(maint(), tA, { note: "B059 visible" });
  // The by-id photo reader: hidden ticket's photo row is gone for maintenance, present for the admin.
  assert.equal(await readRepairPhoto(maint(), attachmentB), null);
  assert.ok(await readRepairPhoto(admin(), attachmentB));
  // Another org's flag/assignments never touch ORG2 readers; ORG1's maintenance never sees ORG2 rows anyway.
  assert.ok(ids(await listTickets(session("coastAdmin", "admin", ORG2_ID))).includes(org2Ticket));
  // Flag ON but no assignment: only the explicitly assigned ticket.
  await save("admin", fixer, []);
  assert.deepEqual(await visible(maint()), [tAssigned]);
  // Back OFF: everything again, assignments kept.
  await flag(false);
  assert.deepEqual(await visible(maint()), [...ours].sort());
  assert.equal((await db.query("SELECT count(*)::int n FROM app.b059_unit_assignments WHERE member_id=$1", [fixer])).rows[0].n, 0);
});

test("MGT-118-AC4 accountant: the ticket list, detail and photo readers answer exactly the same with the flag ON as OFF (access or denial)", async () => {
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  await save("admin", fixer, [unitA]);
  const outcome = async (fn: () => Promise<unknown>) => {
    try { const value = await fn(); return { ok: Array.isArray(value) ? ids(value as { id: string }[]) : value === null ? null : "row" }; }
    catch (error) { return { error: (error as { key?: string }).key ?? (error as { code?: string }).code ?? "error" }; }
  };
  const read = async () => ({
    list: await outcome(() => listTickets(accountant())),
    detailB: await outcome(() => ticketDetail(accountant(), tB)),
    detailProperty: await outcome(() => ticketDetail(accountant(), tProperty)),
    photo: await outcome(() => readRepairPhoto(accountant(), attachmentB)),
  });
  await flag(false);
  const off = await read();
  await flag(true);
  assert.deepEqual(await read(), off);
});

test("MGT-118 policy cost: ticket policy = InitPlans once per statement; photo policy = O(1) indexed per-row checks, never a ticket array", async () => {
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  await save("admin", fixer, [unitA]);
  // 150 more tickets (half on the assigned unit) with two photo rows each.
  const many: string[] = [];
  for (let i = 0; i < 150; i++) many.push(await ticket(ORG_ID, property, i % 2 ? unitA : unitB, `B059 load ${i}`));
  const photos = (await db.query(`WITH src AS (SELECT gen_random_uuid() id, t FROM unnest($2::uuid[]) t CROSS JOIN generate_series(1,2) g),
    f AS (INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,uploaded_by,size_bytes)
      SELECT src.id,$1::uuid,'ticket-photos-private','org/'||$1::text||'/tickets/'||src.t::text||'/'||src.id::text||'.png','x.png','image/png',$3::uuid,42
      FROM src RETURNING id)
    INSERT INTO ticket_attachments(org_id,ticket_id,file_id) SELECT $1::uuid,src.t,f.id FROM f JOIN src ON src.id=f.id RETURNING id`, [ORG_ID, many, USERS.admin])).rowCount;
  assert.equal(photos, 300);
  // Test-only invocation counters (this cloned database only). The policies hold each helper by OID, so each helper is
  // replaced IN PLACE (CREATE OR REPLACE keeps the OID): its original body moves to app.<fn>_impl and the helper becomes
  // "bump app.<fn>_calls (nextval is never rolled back), then return app.<fn>_impl(...)". Restored at the end.
  const HELPERS4: [string, string, string, string][] = [
    ["b059_scoped_orgs", "", "", "uuid[]"], ["b059_visible_units", "", "", "uuid[]"], ["b059_own_members", "", "", "uuid[]"],
    ["b059_ticket_visible", "p_ticket uuid", "p_ticket", "boolean"]];
  const originals: Record<string, string> = {};
  for (const [fn, params, args, returns] of HELPERS4) {
    const sig = `app.${fn}(${params.replace(/p_\w+ /g, "")})`;
    originals[fn] = (await db.query(`SELECT pg_get_functiondef($1::regprocedure) d`, [sig])).rows[0].d;
    await db.query(originals[fn].replace(`FUNCTION app.${fn}(`, `FUNCTION app.${fn}_impl(`));
    await db.query(`CREATE SEQUENCE app.${fn}_calls;
      CREATE OR REPLACE FUNCTION app.${fn}(${params}) RETURNS ${returns} LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$
      BEGIN PERFORM nextval('app.${fn}_calls'); RETURN app.${fn}_impl(${args}); END $f$;`);
  }
  try {
    const names = HELPERS4.map(h => h[0]);
    const counters = async () => Object.fromEntries(await Promise.all(names.map(async fn =>
      [fn, Number((await db.query(`SELECT last_value, is_called FROM app.${fn}_calls`)).rows.map(r => r.is_called ? r.last_value : 0)[0])])));
    const asMaintenance = async <T>(sql: string): Promise<{ rows: T[]; calls: Record<string, number> }> => {
      const before = await counters();
      await db.query("BEGIN");
      try {
        await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)", [USERS.maintenance, ORG_ID]);
        await db.query("SET LOCAL ROLE authenticated");
        const rows = (await db.query(sql)).rows as T[];
        await db.query("RESET ROLE");
        const after = await counters();
        return { rows, calls: Object.fromEntries(names.map(fn => [fn, after[fn] - before[fn]]).filter(([, n]) => n)) };
      } finally { await db.query("ROLLBACK"); }
    };
    type Plan = { rows: { "QUERY PLAN": unknown }[] };
    const planOf = async (sql: string) => JSON.stringify(((await asMaintenance(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`)) as Plan).rows[0]["QUERY PLAN"]);
    const attSql = `SELECT id FROM ticket_attachments WHERE org_id='${ORG_ID}'`, tixSql = `SELECT id FROM maintenance_tickets WHERE org_id='${ORG_ID}'`;
    // Ticket policy: three uncorrelated InitPlans, each executed once; no correlated SubPlan.
    const tixPlan = await planOf(tixSql);
    const inits = [...tixPlan.matchAll(/"Subplan Name":"InitPlan \d+[^"]*"[^}]*?"Actual Loops":(\d+)/g)];
    assert.equal(inits.length, 3, tixPlan.slice(0, 600));
    for (const m of inits) assert.equal(Number(m[1]), 1, `InitPlan loops ${m[1]}`);
    assert.doesNotMatch(tixPlan, /"Subplan Name":"SubPlan/);
    // Photo policy: no sublink at all (42P17 on ticket_attachments), so no InitPlan and no SubPlan.
    assert.doesNotMatch(await planOf(attSql), /"Subplan Name"/);
    // Behaviour is unchanged: maintenance sees the photos of unit A's tickets only (75 tickets × 2).
    const visibleTickets = new Set((await db.query("SELECT id::text FROM maintenance_tickets WHERE unit_id=$1 AND id = ANY($2::uuid[])", [unitA, many])).rows.map(r => r.id));
    const seen = (await asMaintenance<{ ticket_id: string }>(`SELECT ticket_id::text FROM ticket_attachments WHERE org_id='${ORG_ID}' AND ticket_id = ANY(ARRAY['${many.join("','")}']::uuid[])`)).rows;
    assert.equal(seen.length, 150);
    assert.ok(seen.every(r => visibleTickets.has(r.ticket_id)));
    // Execution calls (planning may pre-evaluate STABLE calls for estimates: calls(statement) − calls(EXPLAIN only)).
    const execCalls = async (sql: string) => {
      const run = await asMaintenance<{ id: string }>(sql), plan = await asMaintenance(`EXPLAIN (COSTS OFF) ${sql}`);
      const all = new Set([...Object.keys(run.calls), ...Object.keys(plan.calls)]);
      return { rows: run.rows.length, calls: Object.fromEntries([...all].sort().map(n => [n, (run.calls[n] ?? 0) - (plan.calls[n] ?? 0)])) };
    };
    const evaluated = async () => (await db.query<{ n: number }>("SELECT count(*)::int n FROM ticket_attachments WHERE org_id=$1", [ORG_ID])).rows[0].n;
    const tix = await execCalls(tixSql), att = await execCalls(attSql), attRows = await evaluated();
    assert.ok(tix.rows >= 75 && att.rows >= 150, `${tix.rows} ${att.rows}`);
    // Ticket policy: a per-statement constant (the scoped-org InitPlan + one read inside each of the two others).
    assert.deepEqual(tix.calls, { b059_own_members: 1, b059_scoped_orgs: 3, b059_visible_units: 1 });
    // Photo policy: exactly one scoped-org check and at most one O(1) ticket check per evaluated row; never an array helper.
    assert.equal(att.calls.b059_scoped_orgs, attRows);
    assert.ok(att.calls.b059_ticket_visible <= attRows && att.calls.b059_ticket_visible >= 300, JSON.stringify(att.calls));
    assert.equal(att.calls.b059_visible_units ?? 0, 0); assert.equal(att.calls.b059_own_members ?? 0, 0);
    // The per-row check is a fixed set of caller-first index probes (statements asserted against the function body).
    await assertProbePlans(originals.b059_ticket_visible, many[1], fixer, unitA);
    // Fewer rows: the ticket policy's calls are unchanged; the photo policy's scale with the rows, one each.
    await db.query("DELETE FROM ticket_attachments WHERE ticket_id = ANY($1::uuid[])", [many]);
    await db.query("DELETE FROM maintenance_tickets WHERE id = ANY($1::uuid[])", [many]);
    const tixFew = await execCalls(tixSql), attFew = await execCalls(attSql);
    assert.deepEqual(tixFew.calls, tix.calls, "ticket policy helper calls do not depend on the number of rows");
    assert.equal(attFew.calls.b059_scoped_orgs ?? 0, await evaluated());
    // OFF: the photo policy decides every row on the empty scoped-org array; the ticket check never runs.
    await flag(false);
    const off = await execCalls(attSql);
    assert.equal(off.calls.b059_ticket_visible ?? 0, 0, "OFF never checks a ticket");
    assert.equal(off.calls.b059_visible_units ?? 0, 0); assert.equal(off.calls.b059_own_members ?? 0, 0);
    assert.deepEqual((await execCalls(tixSql)).calls, { b059_scoped_orgs: 1 }, "OFF: one scoped-org InitPlan per ticket statement, nothing else");
  } finally {
    for (const [fn, params] of HELPERS4)
      await db.query(`${originals[fn]}; DROP FUNCTION app.${fn}_impl(${params.replace(/p_\w+ /g, "")}); DROP SEQUENCE app.${fn}_calls;`);
  }
});

/** app.b059_ticket_visible called DIRECTLY by an authenticated caller (bypassing the photo policy's own scope test). */
async function directVisible(user: string, ticketIds: string[]): Promise<boolean[]> {
  await db.query("BEGIN");
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [user]);
    await db.query("SET LOCAL ROLE authenticated");
    const out: boolean[] = [];
    for (const id of ticketIds) out.push((await db.query<{ v: boolean }>("SELECT app.b059_ticket_visible($1::uuid) v", [id])).rows[0].v);
    return out;
  } finally { await db.query("ROLLBACK"); }
}

test("MGT-118 r2: b059_ticket_visible validates the caller itself — a direct call is true only for an active maintenance member, only for tickets the ticket policy shows", async () => {
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  await save("admin", fixer, [unitA]);
  const probe = [tA, tB, tC, tProperty, tAssigned, org2Ticket, randomUUID()];
  // (a) active maintenance member, flag ON: exactly the visible ones (assigned unit + explicitly assigned), and each
  // of them is one the ticket list already shows.
  const active = await directVisible(USERS.maintenance, probe);
  assert.deepEqual(active, [true, false, false, false, true, false, false]);
  const listed = ids(await listTickets(maint()));
  probe.forEach((id, i) => { if (active[i]) assert.ok(listed.includes(id), id); });
  // (b) the same member, no longer active (suspended), or no longer maintenance — its member and assignment rows
  // remain — gets false for everything.
  for (const change of [["status", "suspended"], ["role", "manager"]] as const) {
    const before = (await db.query(`SELECT ${change[0]}::text v FROM public.org_members WHERE id=$1`, [fixer])).rows[0].v;
    await db.query(`ALTER TABLE public.org_members DISABLE TRIGGER USER`);
    try {
      await db.query(`UPDATE public.org_members SET ${change[0]}=$2::${change[0] === "status" ? "member_status" : "org_role"} WHERE id=$1`, [fixer, change[1]]);
      assert.equal((await db.query("SELECT count(*)::int n FROM app.b059_unit_assignments WHERE member_id=$1", [fixer])).rows[0].n, 1, "rows retained");
      assert.deepEqual(await directVisible(USERS.maintenance, probe), probe.map(() => false), `${change[0]}=${change[1]}`);
    } finally {
      await db.query(`UPDATE public.org_members SET ${change[0]}=$2::${change[0] === "status" ? "member_status" : "org_role"} WHERE id=$1`, [fixer, before]);
      await db.query(`ALTER TABLE public.org_members ENABLE TRIGGER USER`);
    }
  }
  // (c) another organization's member: ORG2's admin, and a maintenance member of ORG2 only.
  assert.deepEqual(await directVisible(USERS.coastAdmin, probe), probe.map(() => false), "ORG2 admin");
  const outsider = randomUUID();
  await db.query(`INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, role, aud)
    VALUES ($1, $2, 'x', '{}'::jsonb, now(), 'authenticated', 'authenticated')`, [outsider, `b059-${outsider.slice(0, 8)}@example.test`]);
  await db.query("ALTER TABLE public.org_members DISABLE TRIGGER USER");
  try {
    await db.query("INSERT INTO public.org_members(org_id,user_id,role,status) VALUES ($1,$2,'maintenance','active')", [ORG2_ID, outsider]);
  } finally { await db.query("ALTER TABLE public.org_members ENABLE TRIGGER USER"); }
  assert.deepEqual(await directVisible(outsider, probe), probe.map(() => false), "ORG2 maintenance member");
  // (d) this organization's admin (and manager, accountant): never true — they are not scoped at all.
  for (const user of [USERS.admin, USERS.manager, USERS.accountant, USERS.tenant, USERS.owner])
    assert.deepEqual(await directVisible(user, probe), probe.map(() => false), user);
  // Flag OFF: false for the active maintenance member too.
  await flag(false);
  assert.deepEqual(await directVisible(USERS.maintenance, probe), probe.map(() => false), "flag OFF");
  await flag(true);
  // Why authenticated keeps EXECUTE: a policy expression runs with the querying role's privileges, so revoking it
  // makes the scoped caller's photo read fail with 42501 (checked in a rolled-back transaction).
  await db.query("BEGIN");
  try {
    await db.query("REVOKE EXECUTE ON FUNCTION app.b059_ticket_visible(uuid) FROM authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)", [USERS.maintenance, ORG_ID]);
    await db.query("SET LOCAL ROLE authenticated");
    await assert.rejects(db.query("SELECT id FROM public.ticket_attachments WHERE id=$1", [attachmentB]), code("42501"));
  } finally { await db.query("ROLLBACK"); }
});

test("MGT-118 r2: the per-photo probes are caller-first — 1 vs 50 assignees on the ticket's unit: the same exact-key probes, no row read or filtered", async () => {
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  await save("admin", fixer, [unitA]);
  // The caller also holds an accepted invitation (so the invitation probe really runs), assigned to unit C only.
  const accepted = (await db.query(`INSERT INTO public.invitations(org_id,kind,role,email,code_hash,status,invited_by,accepted_by,accepted_at)
    VALUES($1,'team_member','maintenance','b059-fan@example.test',$2,'accepted',$3,$4,clock_timestamp()) RETURNING id`,
  [ORG_ID, randomUUID(), USERS.admin, USERS.maintenance])).rows[0].id;
  await db.query("INSERT INTO app.b059_unit_assignments(org_id,invitation_id,unit_id,created_by) VALUES($1,$2,$3,$4)", [ORG_ID, accepted, unitC, USERS.admin]);
  // Start unit B from zero assignees (an earlier test pre-assigned it to a pending invitation).
  await db.query("DELETE FROM app.b059_unit_assignments WHERE org_id=$1 AND unit_id=$2", [ORG_ID, unitB]);
  const body = (await db.query("SELECT pg_get_functiondef('app.b059_ticket_visible(uuid)'::regprocedure) d")).rows[0].d as string;
  const others: string[] = [];
  async function fanOut(n: number) {
    while (others.length < n) {
      const inv = (await db.query(`INSERT INTO public.invitations(org_id,kind,role,email,code_hash,status,invited_by)
        VALUES($1,'team_member','maintenance',$2,$3,'pending',$4) RETURNING id`, [ORG_ID, `b059-fan-${others.length}@example.test`, randomUUID(), USERS.admin])).rows[0].id;
      await db.query("INSERT INTO app.b059_unit_assignments(org_id,invitation_id,unit_id,created_by) VALUES($1,$2,$3,$4)", [ORG_ID, inv, unitB, USERS.admin]);
      others.push(inv);
    }
    assert.equal((await db.query("SELECT count(*)::int n FROM app.b059_unit_assignments WHERE org_id=$1 AND unit_id=$2", [ORG_ID, unitB])).rows[0].n, n);
    await db.query("ANALYZE app.b059_unit_assignments");
    // tB sits on unit B, assigned to n OTHER people and not to the caller: the worst (unsuccessful) case.
    return { plans: await assertProbePlans(body, tB, fixer, unitB, accepted), visible: (await directVisible(USERS.maintenance, [tB, tA]))[0] };
  }
  const one = await fanOut(1), fifty = await fanOut(50);
  assert.equal(one.visible, false); assert.equal(fifty.visible, false);
  // Same work at both fan-outs: every assignment scan is keyed by the caller (asserted inside assertProbePlans) and
  // returns / filters exactly the same number of rows.
  assert.deepEqual(fifty.plans.map(p => p.assignmentRows), one.plans.map(p => p.assignmentRows), "same assignment rows read");
  assert.ok(fifty.plans.flatMap(p => p.assignmentRows).every(([rows, filtered]) => rows === 0 && filtered === 0), JSON.stringify(fifty.plans.map(p => p.assignmentRows)));
  assert.deepEqual(fifty.plans.map(p => p.text.replace(/'[0-9a-f-]{36}'/g, "'…'")), one.plans.map(p => p.text.replace(/'[0-9a-f-]{36}'/g, "'…'")), "same plans");
  // The positive paths still answer true: the caller's own unit and its accepted invitation's unit.
  assert.deepEqual(await directVisible(USERS.maintenance, [tA, tC]), [true, true]);
  for (const [label, run] of [["1", one], ["50", fifty]] as const)
    console.log(`B059PLANS fan-out ${label}:\n${run.plans.map(p => `${p.text}\n  assignment rows [returned, filtered]: ${JSON.stringify(p.assignmentRows)}`).join("\n--\n")}`);
  await db.query("DELETE FROM app.b059_unit_assignments WHERE invitation_id = ANY($1::uuid[])", [[accepted, ...others]]);
  await db.query("DELETE FROM public.invitations WHERE id = ANY($1::uuid[])", [[accepted, ...others]]);
});

test("MGT-118 policy baseline: with the flag OFF the policies change no row for any role (compared with the policies dropped)", async () => {
  const fixer = member[`${ORG_ID}:${USERS.maintenance}`];
  await save("admin", fixer, [unitA]);
  await flag(false);
  const read = async () => Promise.all([admin(), manager(), accountant(), maint()].map(async s => {
    try { return ids(await listTickets(s)); } catch (error) { return `error:${(error as { key?: string }).key ?? "?"}`; }
  }));
  const withPolicies = await read();
  const photos = async () => Promise.all([admin(), maint()].map(s => readRepairPhoto(s, attachmentB).then(r => r?.ticket_id ?? null)));
  const photoWith = await photos();
  const sql = readFileSync(new URL("../../supabase/migrations/20261118100000_b059_maint_unit_assign.sql", import.meta.url), "utf8");
  const creates = [...sql.matchAll(/CREATE POLICY[\s\S]*?;\n/g)].map(m => m[0]);
  assert.equal(creates.length, 2);
  await db.query("DROP POLICY b059_maint_unit_scope ON public.maintenance_tickets; DROP POLICY b059_maint_unit_photo_scope ON public.ticket_attachments");
  try {
    assert.deepEqual(await read(), withPolicies);
    assert.deepEqual(await photos(), photoWith);
  } finally {
    for (const create of creates) await db.query(create);
  }
});

test("GS-24: units saved on a pending invitation apply once that invitation is accepted by the maintenance user", async () => {
  const user = USERS.maintenance, fixer = member[`${ORG_ID}:${user}`];
  await save("admin", fixer, []);
  const pending = (await db.query(`INSERT INTO public.invitations(org_id,kind,role,email,code_hash,status,invited_by)
    VALUES($1,'team_member','maintenance','b059-accept@example.test',$2,'pending',$3) RETURNING id`, [ORG_ID, randomUUID(), USERS.admin])).rows[0].id;
  assert.deepEqual(await save("admin", pending, [unitC]), { status: "saved", units: 1, replayed: false });
  assert.ok(!ids(await listTickets(maint())).includes(tC), "not before acceptance");
  await db.query("UPDATE public.invitations SET status='accepted',accepted_by=$2,accepted_at=clock_timestamp() WHERE id=$1", [pending, user]);
  assert.ok(ids(await listTickets(maint())).includes(tC), "applies after acceptance");
  const list = await view("admin") as { people: { id: string; units: number }[] };
  assert.equal(list.people.find(p => p.id === fixer)?.units, 1, "the member row counts the accepted invitation's units");
  // Saving the member replaces both (the invitation's rows move to the member).
  assert.deepEqual(await save("admin", fixer, [unitA]), { status: "saved", units: 1, replayed: false });
  assert.deepEqual(await unitsOf(pending), []);
  assert.deepEqual(await unitsOf(fixer), [unitA]);
});
