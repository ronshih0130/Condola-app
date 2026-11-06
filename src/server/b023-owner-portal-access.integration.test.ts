import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import {
  openOwnerDocument, ownerDocuments, ownerPortalExtensionsEnabled, ownerPortalExtensionsOn,
  ownerRepairDetail, ownerRepairs, type OwnerDocumentRow,
} from "./owner-portal-access";
import { ownerDocumentHeadHttp, ownerDocumentHttp } from "./owner-portal-access-http";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const FLAG = "owner_portal_extensions";
const PDF = Buffer.from("%PDF-1.4\n% synthetic B-023 fixture\n%%EOF\n");
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client, staff: Session;
let A: Session, B: Session, C: Session, D: Session, E: Session, G: Session, F: Fixture;

test.before(async () => {
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  staff = await session(USERS.admin, "staff", "admin");
  F = await fixture();
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });
test.beforeEach(async () => { await flag(true); });

async function session(userId: string, kind: Session["kind"], role: Session["role"], orgId = ORG_ID): Promise<Session> {
  const id = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [id, userId, randomUUID()]);
  return { userId, sessionId: id, orgId, liveOrgId: orgId, environment: "live", kind, role, email: "fixture@example.invalid", name: "Fixture", locale: "en", calendar: "gregorian", leaseId: null };
}
async function flag(on: boolean) {
  await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($3::text,$4::text)))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [FLAG, on, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($1::text,$2::boolean) WHERE id=ANY($3::uuid[])`, [FLAG, on, [ORG_ID, ORG2_ID]]);
}
async function ownerUser(org: string, name: string) {
  const user = randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [user, `${user}@example.invalid`]);
  const contact = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_owner,user_id,display_name) VALUES($1,true,$2,$3) RETURNING id`, [org, user, name])).rows[0].id;
  return { session: await session(user, "owner", null, org), contact };
}
async function property(org: string) {
  const id = (await db.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id`,
    [org, `Synthetic ${randomUUID().slice(0, 8)}`])).rows[0].id;
  const unit = (await db.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'5F') RETURNING id`, [org, id])).rows[0].id;
  return { id, unit };
}
async function own(org: string, prop: string, contact: string, from: string, to: string | null) {
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from,effective_to) VALUES($1,$2,$3,$4,$5)`, [org, prop, contact, from, to]);
}
async function lease(org: string, p: { id: string; unit: string }, start: string, end: string | null, status = "active") {
  return (await db.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,due_day)
    VALUES($1,$2,$3,$3,$4,$5,$6,'TWD',2000000,1) RETURNING id`, [org, p.id, p.unit, status, start, end])).rows[0].id;
}
async function pdf(org: string, leaseId: string, at: string, supersedes: string | null = null, pointer = false) {
  const id = randomUUID(), file = randomUUID(), path = `${org}/${leaseId}/${id}.pdf`;
  await db.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes) VALUES($1,$2,'lease-documents-private',$3,'signed.pdf','application/pdf',$4)`,
    [file, org, path, PDF.length]);
  await db.query(`INSERT INTO lease_signed_pdfs(id,org_id,lease_id,file_id,object_path,content,created_at,supersedes_id,replace_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, org, leaseId, file, path, PDF, at, supersedes, supersedes ? "wrong_file" : null]);
  if (pointer) await db.query(`UPDATE leases SET document_file_id=$1 WHERE id=$2`, [file, leaseId]);
  return id;
}
let ticketNo = 900000;
async function ticket(org: string, prop: string, at: string, events: [string, string, boolean?][], status: string) {
  const id = (await db.query<{ id: string }>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,title,description,preferred_times,status,created_at,updated_at,closed_at)
    VALUES($1,$2,$3,'Water heater','PRIVATE TENANT DESCRIPTION 0912-000-000','PRIVATE TIMES',$4,$5,$6,$7) RETURNING id`,
    [org, ++ticketNo, prop, status, at, events.at(-1)?.[1] ?? at, ["closed", "cancelled"].includes(status) ? events.at(-1)?.[1] ?? at : null])).rows[0].id;
  let prev: string | null = null;
  for (const [to, when, internal] of events) {
    await db.query(`INSERT INTO ticket_comments(org_id,ticket_id,body,is_internal,status_from,status_to,created_at) VALUES($1,$2,$3,$4,$5::ticket_status,$6::ticket_status,$7)`,
      [org, id, internal ? "INTERNAL STAFF NOTE" : "Visible note body", !!internal, prev, to, when]);
    if (!internal) prev = to;
  }
  await db.query(`INSERT INTO ticket_comments(org_id,ticket_id,body,is_internal,created_at) VALUES($1,$2,'INTERNAL BODY ONLY',true,$3)`, [org, id, at]);
  return id;
}

async function fixture() {
  const a = await ownerUser(ORG_ID, "Owner A"), b = await ownerUser(ORG_ID, "Owner B"), c = await ownerUser(ORG_ID, "Owner C"), d = await ownerUser(ORG2_ID, "Owner D");
  A = a.session; B = b.session; C = c.session; D = d.session;
  const p1 = await property(ORG_ID), p2 = await property(ORG_ID), p3 = await property(ORG_ID), p4 = await property(ORG2_ID);
  await own(ORG_ID, p1.id, a.contact, "2020-01-01", null);            // A current on P1
  await own(ORG_ID, p2.id, b.contact, "2020-01-01", null);            // B current on P2
  await own(ORG_ID, p3.id, a.contact, "2019-01-01", "2022-01-01");    // A ended on P3 (exclusive end)
  await own(ORG_ID, p3.id, c.contact, "2022-01-01", null);            // C current on P3
  await own(ORG2_ID, p4.id, d.contact, "2020-01-01", null);           // D in another org
  const l1 = await lease(ORG_ID, p1, "2024-01-01", null);
  const d1 = await pdf(ORG_ID, l1, "2024-01-05T03:00:00Z");
  const d2 = await pdf(ORG_ID, l1, "2024-02-01T03:00:00Z", d1, true);
  const l2 = await lease(ORG_ID, p2, "2024-01-01", null), d3 = await pdf(ORG_ID, l2, "2024-01-05T03:00:00Z");
  const l3a = await lease(ORG_ID, p3, "2020-01-01", "2021-12-31", "ended");
  const d4 = await pdf(ORG_ID, l3a, "2020-01-10T03:00:00Z"), d4late = await pdf(ORG_ID, l3a, "2023-03-01T03:00:00Z", d4);
  const l3c = await lease(ORG_ID, p3, "2021-06-01", "2023-05-31", "ended");
  const d6 = await pdf(ORG_ID, l3c, "2021-07-01T03:00:00Z"), d7 = await pdf(ORG_ID, l3c, "2022-03-01T03:00:00Z", d6);
  // Exclusive end: an upload on the local end date (2022-01-01 Asia/Taipei) is outside A's window.
  const d6edge = await pdf(ORG_ID, l3c, "2021-12-31T17:00:00Z", d6);
  const l3b = await lease(ORG_ID, p3, "2022-06-01", null), d5 = await pdf(ORG_ID, l3b, "2022-06-05T03:00:00Z");
  const draft = await lease(ORG_ID, p1, "2025-01-01", null, "draft"), dDraft = await pdf(ORG_ID, draft, "2025-01-02T03:00:00Z");
  const l4 = await lease(ORG2_ID, p4, "2024-01-01", null), d8 = await pdf(ORG2_ID, l4, "2024-01-05T03:00:00Z");
  const t1 = await ticket(ORG_ID, p1.id, "2025-03-01T03:00:00Z", [["open", "2025-03-01T03:00:00Z"], ["in_progress", "2025-03-02T03:00:00Z"], ["on_hold", "2025-03-03T03:00:00Z", true]], "on_hold");
  const t2 = await ticket(ORG_ID, p2.id, "2025-03-01T03:00:00Z", [["open", "2025-03-01T03:00:00Z"]], "open");
  const t3 = await ticket(ORG_ID, p3.id, "2021-05-01T03:00:00Z", [["open", "2021-05-01T03:00:00Z"], ["in_progress", "2021-06-01T03:00:00Z"], ["resolved", "2022-02-01T03:00:00Z"], ["closed", "2022-02-05T03:00:00Z"]], "closed");
  const t4 = await ticket(ORG_ID, p3.id, "2023-01-01T03:00:00Z", [["open", "2023-01-01T03:00:00Z"]], "open");
  const t5 = await ticket(ORG2_ID, p4.id, "2025-01-01T03:00:00Z", [["open", "2025-01-01T03:00:00Z"]], "open");
  // Re-acquisition with a gap: E owns P5 in 2019 and again from 2023; G owns it in between.
  const e = await ownerUser(ORG_ID, "Owner E"), g = await ownerUser(ORG_ID, "Owner G");
  E = e.session; G = g.session;
  const p5 = await property(ORG_ID);
  await own(ORG_ID, p5.id, e.contact, "2019-01-01", "2020-01-01");
  await own(ORG_ID, p5.id, g.contact, "2020-01-01", "2023-01-01");
  await own(ORG_ID, p5.id, e.contact, "2023-01-01", null);
  const l5 = await lease(ORG_ID, p5, "2019-06-01", null);
  const e1 = await pdf(ORG_ID, l5, "2019-07-01T03:00:00Z"), e2 = await pdf(ORG_ID, l5, "2021-06-01T03:00:00Z", e1), e3 = await pdf(ORG_ID, l5, "2023-06-01T03:00:00Z", e2);
  const t6 = await ticket(ORG_ID, p5.id, "2019-10-01T03:00:00Z", [["open", "2019-10-01T03:00:00Z"], ["in_progress", "2021-01-15T03:00:00Z"], ["on_hold", "2023-02-01T03:00:00Z"]], "on_hold");
  const t7 = await ticket(ORG_ID, p5.id, "2021-03-01T03:00:00Z", [["open", "2021-03-01T03:00:00Z"], ["closed", "2021-04-01T03:00:00Z"]], "closed");
  return { d1, d2, d3, d4, d4late, d5, d6, d7, d6edge, dDraft, d8, t1, t2, t3, t4, t5, e1, e2, e3, t6, t7, aContact: a.contact };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function raw(s: Session, sql: string, params: unknown[] = []) {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [s.userId, s.orgId, s.environment]);
    await db.query("SET LOCAL ROLE authenticated"); const result = await db.query(sql, params); await db.query("COMMIT"); return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
const denied = (error: unknown) => (error as { code?: string }).code === "42501";
const ids = (rows: OwnerDocumentRow[] | null) => (rows ?? []).map(r => r.document_id).sort();
/** Consent, signature, acknowledgement, confirmation and read state across the schema. */
async function consentFacts() {
  const tables = ["public.consents", "public.partner_agreement_consents", "public.lease_signatures", "public.lease_signature_events",
    "public.esign_signers", "public.esign_audit_events", "public.thread_participants", "public.notifications",
    "app.deposit_settlement_confirmations", "app.b022_report_replies", "app.b012_response_versions", "app.b013_estimate_decisions",
    "app.b028_center_reads", "app.b028_read_markers", "app.b010_payment_confirmations"];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    if (!(await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t])).rows[0].ok) continue;
    out[t] = (await db.query(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) h, count(*)::int n FROM ${t} x`)).rows[0];
  }
  // Flag fixture toggles (organizations/platform_settings) are themselves audited; everything else must be untouched.
  out.audit_log = (await db.query(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text), '')) h, count(*)::int n
    FROM public.audit_log x WHERE table_name NOT IN ('organizations','platform_settings')`)).rows[0];
  out.leases = (await db.query(`SELECT md5(string_agg(id::text||esign_status::text||coalesce(signed_at::text,'')||coalesce(document_file_id::text,''), ',' ORDER BY id)) h FROM leases`)).rows[0];
  out.pdfs = (await db.query(`SELECT md5(string_agg(to_jsonb(x)::text, ',' ORDER BY id)) h FROM lease_signed_pdfs x`)).rows[0];
  return out;
}
async function accessRows() { return (await db.query(`SELECT * FROM app.b023_owner_document_access_events ORDER BY created_at, id`)).rows; }

test("multi-property isolation: current owner, other owner, ended owner sees only their authority period", async () => {
  const a = await ownerDocuments(A), b = await ownerDocuments(B), c = await ownerDocuments(C);
  assert.deepEqual(ids(a), [F.d1, F.d2, F.d4, F.d6].sort());
  assert.deepEqual(ids(b), [F.d3]);
  assert.deepEqual(ids(c), [F.d5, F.d7, F.d6edge].sort(), "successor C never sees uploads from A's period (before C's window start)");
  const byId = new Map((a ?? []).map(r => [r.document_id, r]));
  assert.equal(byId.get(F.d2)?.access, "current"); assert.equal(byId.get(F.d2)?.is_current_version, true);
  assert.equal(byId.get(F.d1)?.is_current_version, false);
  assert.equal(byId.get(F.d4)?.access, "history"); assert.equal(byId.get(F.d6)?.access, "history");
  assert.ok(!ids(a).includes(F.d4late) && !ids(a).includes(F.d7) && !ids(a).includes(F.d6edge), "post-authority content hidden (exclusive end)");
  assert.equal(new Map((c ?? []).map(r => [r.document_id, r])).get(F.d7)?.access, "current");
  assert.ok(!ids(a).includes(F.dDraft), "draft lease documents are not listed");
  for (const row of a ?? []) assert.deepEqual(Object.keys(row).sort(), ["access", "document_id", "is_current_version", "lease_end", "lease_id", "lease_start", "lease_status", "property_name", "room_label", "size_bytes", "unit_label", "uploaded_at"]);
  assert.equal(await ownerPortalExtensionsOn(A), true);
});

test("gap period and re-acquisition: only content dated inside the owner's own windows", async () => {
  const e = await ownerDocuments(E), g = await ownerDocuments(G);
  assert.deepEqual(ids(e), [F.e1, F.e3].sort(), "gap-period upload hidden from the re-acquiring owner");
  assert.deepEqual(ids(g), [F.e2], "gap owner sees only their period");
  assert.ok((e ?? []).every(r => r.access === "current"));
  assert.equal(g?.[0].access, "history"); assert.equal(g?.[0].is_current_version, false);
  assert.equal(await openOwnerDocument(E, F.e2, "download", randomUUID()), null);
  assert.equal(await openOwnerDocument(G, F.e3, "download", randomUUID()), null);
  assert.equal(await openOwnerDocument(G, F.e1, "download", randomUUID()), null, "before G's window start");
  const list = async (s: Session) => ((await ownerRepairs(s)) ?? []).map(r => r.ticket_id).sort();
  assert.deepEqual(await list(E), [F.t6], "repair entirely in the gap is not listed");
  assert.deepEqual(await list(G), [F.t6, F.t7].sort());
  const t6e = await ownerRepairDetail(E, F.t6), t6g = await ownerRepairDetail(G, F.t6);
  assert.ok(t6e && t6g);
  assert.equal(t6e.access, "current"); assert.equal(t6e.status, "on_hold");
  assert.deepEqual(t6e.timeline.map(x => x.to), ["open", "on_hold"], "gap-period status entry hidden");
  assert.equal(t6g.access, "history"); assert.equal(t6g.status, "in_progress");
  assert.deepEqual(t6g.timeline.map(x => x.to), ["in_progress"], "entries before and after G's window hidden");
  assert.equal(await ownerRepairDetail(E, F.t7), null);
});

test("cross-org, staff and foreign file ids are denied with no access row", async () => {
  const before = await accessRows();
  assert.deepEqual(ids(await ownerDocuments(D)), [F.d8]);
  assert.equal(await ownerDocuments({ ...A, orgId: ORG2_ID }), null);
  assert.equal(await ownerDocuments({ ...A, environment: "sandbox" }), null);
  assert.equal(await ownerDocuments(staff), null);
  await assert.rejects(() => raw(staff, `SELECT * FROM app.b023_owner_documents($1)`, [ORG_ID]), denied);
  await assert.rejects(() => raw({ ...D, orgId: ORG_ID }, `SELECT * FROM app.b023_owner_documents($1)`, [ORG_ID]), denied);
  for (const foreign of [F.d8, F.d3, F.d4late, F.d7, F.dDraft, randomUUID()]) {
    assert.equal(await openOwnerDocument(A, foreign, "download", randomUUID()), null);
    await assert.rejects(() => raw(A, `SELECT * FROM app.b023_open_owner_document($1,$2,$3,'download')`, [ORG_ID, foreign, randomUUID()]), denied);
  }
  assert.equal(await openOwnerDocument(D, F.d2, "download", randomUUID()), null);
  assert.equal(await openOwnerDocument({ ...A, orgId: ORG2_ID }, F.d8, "download", randomUUID()), null);
  assert.equal(await openOwnerDocument(staff, F.d2, "download", randomUUID()), null);
  // Revoked login session cannot open (and writes nothing).
  const revoked = await session(A.userId, "owner", null);
  await db.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`, [revoked.sessionId]);
  assert.equal(await openOwnerDocument(revoked, F.d2, "download", randomUUID()), null);
  // Direct table access is closed to API roles.
  await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_document_access_events`), denied);
  await assert.rejects(() => raw(staff, `INSERT INTO app.b023_owner_document_access_events(org_id,owner_contact_id,actor_user_id,source_kind,document_id,lease_id,property_id,access_kind,access_basis,request_id)
    VALUES($1,$2,$3,'lease_signed_pdf',$4,$4,$4,'view','current',$4)`, [ORG_ID, F.aContact, USERS.admin, randomUUID()]), denied);
  assert.deepEqual(await accessRows(), before);
});

test("download and view write exactly one access row each and never change consent or confirmation state", async () => {
  const consentBefore = await consentFacts(), before = (await accessRows()).length;
  const request = randomUUID();
  const file = await openOwnerDocument(A, F.d2, "download", request);
  assert.ok(file); assert.deepEqual(Buffer.from(file.content), PDF); assert.equal(file.file_name, `signed-lease-${F.d2}.pdf`);
  assert.deepEqual(await openOwnerDocument(A, F.d2, "download", request), file, "exact replay returns the same bytes");
  assert.equal(await openOwnerDocument(A, F.d1, "download", request), null, "request id cannot be reused for another document");
  assert.ok(await openOwnerDocument(A, F.d4, "view", randomUUID()), "history document view");
  const rows = await accessRows();
  assert.equal(rows.length, before + 2);
  const [dl, view] = rows.slice(-2);
  assert.equal(dl.document_id, F.d2); assert.equal(dl.access_kind, "download"); assert.equal(dl.access_basis, "current");
  assert.equal(dl.owner_contact_id, F.aContact); assert.equal(dl.actor_user_id, A.userId); assert.equal(dl.request_id, request);
  assert.equal(view.document_id, F.d4); assert.equal(view.access_kind, "view"); assert.equal(view.access_basis, "history");
  assert.deepEqual(await consentFacts(), consentBefore, "no consent/signature/ack/confirmation/read/audit_log rows changed");
  await assert.rejects(() => db.query(`UPDATE app.b023_owner_document_access_events SET access_kind='view' WHERE id=$1`, [dl.id]), (e: { code?: string }) => e.code === "55000");
  await assert.rejects(() => db.query(`DELETE FROM app.b023_owner_document_access_events WHERE id=$1`, [dl.id]), (e: { code?: string }) => e.code === "55000");
  // HTTP wrapper: inline for ?view=1, attachment otherwise, private no-store.
  const inline = await ownerDocumentHttp({ documentId: F.d2, url: "http://localhost/o/files/x?view=1", open: (k, r) => openOwnerDocument(A, F.d2, k, r), logError: () => {} });
  assert.equal(inline.status, 200); assert.match(inline.headers.get("Content-Disposition") ?? "", /^inline;/);
  assert.equal(inline.headers.get("Cache-Control"), "private, no-store");
  assert.equal(inline.headers.get("Content-Security-Policy"), "sandbox");
  assert.equal(inline.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(inline.headers.get("X-Frame-Options"), "DENY");
  const attach = await ownerDocumentHttp({ documentId: F.d2, url: "http://localhost/o/files/x", open: (k, r) => openOwnerDocument(A, F.d2, k, r), logError: () => {} });
  assert.match(attach.headers.get("Content-Disposition") ?? "", /^attachment;/);
  assert.deepEqual(Buffer.from(await attach.arrayBuffer()), PDF);
  const last = (await accessRows()).slice(-2).map(r => r.access_kind);
  assert.deepEqual(last, ["view", "download"]);
  const rowsBeforeHead = (await accessRows()).length;
  const head = await ownerDocumentHeadHttp({ enabled: () => ownerPortalExtensionsOn(A) });
  assert.equal(head.status, 405); assert.equal(head.headers.get("Allow"), "GET");
  assert.equal((await ownerDocumentHeadHttp({ enabled: () => ownerPortalExtensionsOn(staff) })).status, 404);
  assert.equal((await accessRows()).length, rowsBeforeHead, "HEAD writes no access row");
  const foreign = await ownerDocumentHttp({ documentId: F.d8, url: "http://localhost/o/files/x", open: (k, r) => openOwnerDocument(A, F.d8, k, r), logError: () => {} });
  assert.equal(foreign.status, 404);
});

test("repair list/detail isolation, history clipping and owner-safe fields", async () => {
  const list = async (s: Session) => ((await ownerRepairs(s)) ?? []).map(r => r.ticket_id).sort();
  assert.deepEqual(await list(A), [F.t1, F.t3].sort());
  assert.deepEqual(await list(B), [F.t2]);
  assert.deepEqual(await list(C), [F.t3, F.t4].sort());
  assert.deepEqual(await list(D), [F.t5]);
  const rows = await ownerRepairs(A) ?? [];
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["access", "category", "last_status_at", "priority", "property_name", "reported_at", "room_label", "status", "ticket_id", "ticket_number", "title", "unit_label"]);
  const t1 = await ownerRepairDetail(A, F.t1);
  assert.ok(t1); assert.equal(t1.access, "current"); assert.equal(t1.status, "on_hold");
  assert.deepEqual(t1.timeline.map(e => e.to), ["open", "in_progress"], "internal status entries excluded");
  const t3a = await ownerRepairDetail(A, F.t3), t3c = await ownerRepairDetail(C, F.t3);
  assert.ok(t3a && t3c);
  assert.equal(t3a.access, "history"); assert.equal(t3a.status, "in_progress", "status as of the end of A's authority");
  assert.deepEqual(t3a.timeline.map(e => e.to), ["open", "in_progress"]);
  assert.equal(t3c.access, "current"); assert.equal(t3c.status, "closed");
  assert.deepEqual(t3c.timeline.map(e => e.to), ["resolved", "closed"], "successor C sees no status entries from A's period");
  const serialized = JSON.stringify([rows, t1, t3a, t3c]);
  for (const secret of ["PRIVATE TENANT DESCRIPTION", "0912", "PRIVATE TIMES", "INTERNAL", "Visible note body"]) assert.ok(!serialized.includes(secret), secret);
  for (const event of t1.timeline) assert.deepEqual(Object.keys(event).sort(), ["at", "from", "to"]);
  for (const [s, id] of [[A, F.t2], [A, F.t4], [A, F.t5], [B, F.t1], [D, F.t1], [staff, F.t1]] as const) assert.equal(await ownerRepairDetail(s, id), null);
  assert.equal(await ownerRepairs({ ...A, orgId: ORG2_ID }), null);
  await assert.rejects(() => raw(A, `SELECT * FROM app.b023_owner_repair_detail($1,$2)`, [ORG_ID, F.t2]), denied);
  await assert.rejects(() => raw(staff, `SELECT * FROM app.b023_owner_repairs($1)`, [ORG_ID]), denied);
  for (const fn of ["b023_owner_repair_scope", "b023_owner_authority", "b023_owner_contact", "b023_owner_repair_events"]) {
    const ok = (await db.query(`SELECT bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) ok FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      unnest(ARRAY['anon','authenticated','service_role']) r WHERE n.nspname='app' AND p.proname=$1`, [fn])).rows[0].ok;
    assert.equal(ok, false, `${fn} is private`);
  }
});

test("OFF matrix: absent/false/malformed global, org not allowed, org flag false ⇒ null/404, no gateway call, zero writes", async () => {
  const before = await consentFacts(), rowsBefore = await accessRows();
  const cases: [string, () => Promise<void>][] = [
    ["absent", async () => { await db.query(`DELETE FROM platform_settings WHERE key=$1`, [FLAG]); }],
    ["enabled false", async () => { await flag(false); await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":true}' WHERE id=$1`, [ORG_ID]); }],
    ["enabled string", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: "true", allowed_org_ids: [ORG_ID] })]); }],
    ["allowlist not array", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: true, allowed_org_ids: ORG_ID })]); }],
    ["malformed json", async () => { await db.query(`UPDATE platform_settings SET value='"enabled"' WHERE key=$1`, [FLAG]); }],
    ["org not in allowlist", async () => { await db.query(`UPDATE platform_settings SET value=$2 WHERE key=$1`, [FLAG, JSON.stringify({ enabled: true, allowed_org_ids: [ORG2_ID] })]); }],
    ["org flag false", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":false}' WHERE id=$1`, [ORG_ID]); }],
    ["org flag string", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"owner_portal_extensions":"true"}' WHERE id=$1`, [ORG_ID]); }],
    ["org flag absent", async () => { await db.query(`UPDATE organizations SET feature_flags=feature_flags-'owner_portal_extensions' WHERE id=$1`, [ORG_ID]); }],
  ];
  for (const [name, apply] of cases) {
    await flag(true); await apply();
    assert.equal(await ownerPortalExtensionsEnabled(db, ORG_ID), false, name);
    assert.equal((await db.query(`SELECT app.b023_flag_on($1) AS enabled`, [ORG_ID])).rows[0].enabled, false, name);
    const spy = mock.method(Client.prototype, "query");
    try {
      assert.equal(await ownerPortalExtensionsOn(A), false, name);
      assert.equal(await ownerDocuments(A), null, name);
      assert.equal(await openOwnerDocument(A, F.d2, "download", randomUUID()), null, name);
      assert.equal(await ownerRepairs(A), null, name);
      assert.equal(await ownerRepairDetail(A, F.t1), null, name);
      const http = await ownerDocumentHttp({ documentId: F.d2, url: "http://localhost/o/files/x", open: (k, r) => openOwnerDocument(A, F.d2, k, r), logError: () => {} });
      assert.equal(http.status, 404, name);
      assert.equal((await ownerDocumentHeadHttp({ enabled: () => ownerPortalExtensionsOn(A) })).status, 404, `${name}: HEAD`);
      assert.equal(spy.mock.calls.some(c => typeof c.arguments[0] === "string" && /app\.b023_/.test(c.arguments[0] as string)), false, name);
    } finally { mock.restoreAll(); }
    for (const [sql, params] of [[`SELECT * FROM app.b023_owner_documents($1)`, [ORG_ID]], [`SELECT * FROM app.b023_open_owner_document($1,$2,$3,'download')`, [ORG_ID, F.d2, randomUUID()]],
      [`SELECT * FROM app.b023_owner_repairs($1)`, [ORG_ID]], [`SELECT * FROM app.b023_owner_repair_detail($1,$2)`, [ORG_ID, F.t1]]] as const) {
      await assert.rejects(() => raw(A, sql, [...params]), denied, `${name}: ${sql}`);
    }
  }
  assert.deepEqual(await accessRows(), rowsBefore, "zero B-023 writes while OFF");
  assert.deepEqual(await consentFacts(), before);
  await flag(true);
  assert.ok((await ownerDocuments(A))?.length, "ON again restores the positive control");
});
