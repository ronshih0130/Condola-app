import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { GET as leaseApi } from "@/app/api/pdf/leases/[id]/route";
import { GET as statementApi } from "@/app/api/pdf/statements/[id]/route";
import { GET as signedApi } from "@/app/m/leases/[id]/signed/route";
import { GET as photoApi } from "@/app/api/tickets/photos/[id]/route";
import { GET as idPhotoApi } from "@/app/api/id-documents/photo/route";
import { SESSION_COOKIE } from "./auth";
import { loadAuditHistory, loadAuditScreen } from "./audit-read";
import { query, tx } from "./db";
import { FlowError } from "./errors";
import { signPhotoToken } from "./id-crypto";
import { issuePhotoUrls, openSignedPhoto, serveSignedPhoto } from "./id-docs";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { requireOrgScope } from "./org-guard";
import { ROLE_KEYS } from "./perms";
import { propertyDetail, leaseDetail, tenantDetail, statementDetail, ticketDetail, signedLeasePdf } from "./queries";
import { readRepairPhoto } from "./repairs";
import { PHOTO_BUCKET, ticketPhotoPath } from "./repair-rules";
import { sessionTokenHash } from "./session";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { openTicketPhoto } from "./ticket-photos";
import type { Session } from "./types";
import { readVendorDocumentPdf } from "./vendor-receipt";

// Never bootstrap, reset, or touch a hosted database from this suite.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const knownGap = process.env.B027_RUN_KNOWN_GAP === "1";
const marker = "b027-denial-fixture";
const pdfBytes = Buffer.from(`%PDF-1.4\n${marker}\n%%EOF\n`);
const photoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(marker)]);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let storage: Server | undefined;
let storageCalls = 0;
let storageBase = "";
let cookie: string | null = null;
const cookies = new Map<string, string>();
const savedEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
const fixture = { property: "", lease: "", tenant: "", statement: "", ticket: "", attachment: "", file: randomUUID(), path: "", idDocument: "", vendorDocument: randomUUID() };

function staff(userId: string, role: Session["role"], orgId = ORG_ID): Session {
  return { userId, role, orgId, liveOrgId: orgId, environment: "live", kind: "staff", sessionId: "b027",
    email: "synthetic@example.test", name: "Synthetic", locale: "zh-TW", calendar: "gregorian", leaseId: null };
}
const admin = staff(USERS.admin, "admin");
const manager = staff(USERS.manager, "manager");
const foreign = staff(USERS.coastAdmin, "admin", ORG2_ID);
const accountant = staff(USERS.accountant, "accountant");
const nonAdmins = ROLE_KEYS.filter((role) => role !== "admin").map((role) => staff(USERS[role], role));

function forbidden(error: unknown) {
  return error instanceof FlowError && ["errors.forbidden", "errors.notFound"].includes(error.key);
}
async function denied(run: () => Promise<unknown>) {
  // Accept only the named denial contracts; DB/connection/programming errors must fail.
  try { assert.equal(await run(), null); } catch (error) { if (!forbidden(error)) throw error; }
}
async function login(session: Session) { cookie = cookies.get(session.userId)!; assert.ok(cookie); }
async function httpDenied(response: Response, body = "Not found") {
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("content-disposition"), null);
  assert.equal(await response.text(), body);
}

// Each executable case owns its source anchors. Regeneration resolves real line numbers.
type Entry = { surface: string; file: string; anchor: string; role: string; expected: string; name: string };
const entries: Entry[] = [];
function inventory(entry: Entry, run: () => Promise<void>, gap = false) {
  entries.push(entry);
  test(entry.name, { skip: gap && !knownGap ? "Known gap; opt in with B027_RUN_KNOWN_GAP=1" : false }, run);
}

test.before(async () => {
  clone = await cloneTestDatabase();
  // Earlier test:rls suites mutate the shared source DB (e.g. id-purge, statements);
  // reseed inside the owned clone so fixtures never depend on suite order.
  await resetAndSeed();
  mock.method(nextHeaders, "cookies", async () => ({ get: (name: string) => name === SESSION_COOKIE && cookie ? { value: cookie } : undefined }));
  mock.method(nextHeaders, "headers", async () => new Headers());
  // Private-object transport is a localhost fixture; real readers, SQL and guards remain intact.
  storage = createServer(async (req, res) => {
    storageCalls++;
    if (req.method === "POST" && req.url === `/storage/v1/object/sign/${PHOTO_BUCKET}`) {
      let body = ""; for await (const chunk of req) body += chunk;
      const { paths } = JSON.parse(body) as { paths: string[] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(paths.map((path) => ({ path, signedURL: `/object/${PHOTO_BUCKET}/${path}` }))));
    } else if (req.method === "GET" && req.url === `/storage/v1/object/${PHOTO_BUCKET}/${fixture.path}`) {
      res.setHeader("content-type", "image/jpeg"); res.end(photoBytes);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => storage!.listen(0, "127.0.0.1", resolve));
  const address = storage.address(); assert.ok(address && typeof address !== "string");
  storageBase = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_URL = storageBase;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-b027-local-only";
  for (const session of [admin, manager, foreign, ...nonAdmins]) {
    if (cookies.has(session.userId)) continue;
    const raw = randomUUID(); cookies.set(session.userId, raw);
    await query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`, [session.userId, sessionTokenHash(raw)]);
  }
  const lease = (await query<{ id: string; property_id: string; contact_id: string }>(
    `SELECT l.id,l.property_id,lp.contact_id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id
     JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 AND l.status='active' LIMIT 1`, [ORG_ID, USERS.tenant])).rows[0];
  assert.ok(lease, "db:reset fixture required");
  Object.assign(fixture, { lease: lease.id, property: lease.property_id, tenant: lease.contact_id });
  fixture.statement = (await query<{ id: string }>(`SELECT id FROM owner_statements WHERE org_id=$1 LIMIT 1`, [ORG_ID])).rows[0].id;
  fixture.idDocument = (await query<{ id: string }>(`SELECT id FROM identity_documents WHERE lease_id=$1 AND deleted_at IS NULL`, [fixture.lease])).rows[0].id;
  fixture.ticket = (await query<{ id: string }>(`INSERT INTO maintenance_tickets(org_id,property_id,title,description,reported_by_user,ticket_number)
    VALUES($1,$2,$3,$3,$4,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1)) RETURNING id`, [ORG_ID, fixture.property, marker, USERS.admin])).rows[0].id;
  fixture.path = ticketPhotoPath(ORG_ID, fixture.ticket, fixture.file, "image/jpeg");
  await query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)
    VALUES($1,$2,$3,$4,$5,'image/jpeg',$6,$7)`, [fixture.file, ORG_ID, PHOTO_BUCKET, fixture.path, `${marker}.jpg`, photoBytes.length, USERS.admin]);
  fixture.attachment = (await query<{ id: string }>(`INSERT INTO ticket_attachments(org_id,ticket_id,file_id,is_internal,content)
    VALUES($1,$2,$3,false,$4) RETURNING id`, [ORG_ID, fixture.ticket, fixture.file, photoBytes])).rows[0].id;
  const pdfFile = randomUUID(), pdfPath = `${ORG_ID}/${fixture.lease}/${pdfFile}.pdf`;
  await query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)
    VALUES($1,$2,'lease-documents-private',$3,$4,'application/pdf',$5,$6)`, [pdfFile, ORG_ID, pdfPath, `${marker}.pdf`, pdfBytes.length, USERS.admin]);
  await query(`INSERT INTO lease_signed_pdfs(org_id,lease_id,file_id,object_path,content) VALUES($1,$2,$3,$4,$5)`, [ORG_ID, fixture.lease, pdfFile, pdfPath, pdfBytes]);
  await query(`INSERT INTO audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,reason)
    VALUES($1,$2,'admin','maintenance_tickets',$3,'update',$4)`, [ORG_ID, USERS.admin, fixture.ticket, marker]);
  const contact = (await query<{ id: string }>(`INSERT INTO contacts(org_id,is_vendor,display_name) VALUES($1,true,$2) RETURNING id`, [ORG_ID, marker])).rows[0].id;
  const profile = (await query<{ id: string }>(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164)
    VALUES($1,$2,'B027','individual',$3,'+16505550270') RETURNING id`, [ORG_ID, contact, marker])).rows[0].id;
  const hash = createHash("sha256").update(pdfBytes).digest("hex");
  await query(`INSERT INTO vendor_documents(id,org_id,vendor_profile_id,ticket_id,kind,seq,doc_no,buyer,items,total_minor,pdf_sha256,idempotency_key)
    VALUES($1,$2,$3,$4,'completion_statement',1,'B027-1','{}','[]',0,$5,$6)`, [fixture.vendorDocument, ORG_ID, profile, fixture.ticket, hash, marker]);
  await query(`INSERT INTO vendor_document_pdf_bytes(document_id,org_id,bytes,snapshot) VALUES($1,$2,$3,$4::jsonb)`,
    [fixture.vendorDocument, ORG_ID, pdfBytes, JSON.stringify({ document: { id: fixture.vendorDocument }, documentDate: "2026-11-06", issuedAt: "2026-11-06T00:00:00Z" })]);
});

test.after(async () => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { if (storage) await new Promise<void>((resolve, reject) => storage!.close((error) => error ? reject(error) : resolve())); }
  finally { await clone?.cleanup(); }
});

for (const [surface, anchor, run] of [
  ["/m/properties/[id] loader", "export async function propertyDetail(", (s: Session) => propertyDetail(s, fixture.property)],
  ["/m/leases/[id] loader", "export async function leaseDetail(", (s: Session) => leaseDetail(s, fixture.lease)],
  ["/m/tenants/[id] loader", "export async function tenantDetail(", (s: Session) => tenantDetail(s, fixture.tenant)],
  ["/m/statements/[id] loader", "export async function statementDetail(", (s: Session) => statementDetail(s, fixture.statement)],
  ["/m/tickets/[id] loader", "export async function ticketDetail(", (s: Session) => ticketDetail(s, fixture.ticket)],
  ["signed PDF bytes reader", "export async function signedLeasePdf(", (s: Session) => signedLeasePdf(s, fixture.lease)],
] as const) {
  inventory({ surface, file: "src/server/queries.ts", anchor, role: "foreign staff Admin; own Admin/Manager", expected: "null; same fixture non-null", name: `B027 loader: ${surface}` }, async () => {
    assert.equal(await run(foreign), null);
    for (const allowed of [admin, manager]) assert.ok(await run(allowed));
  });
}
for (const [surface, route, id, handler] of [
  ["lease PDF API", "src/app/api/pdf/leases/[id]/route.ts", () => fixture.lease, leaseApi],
  ["statement PDF API", "src/app/api/pdf/statements/[id]/route.ts", () => fixture.statement, statementApi],
  ["signed PDF download", "src/app/m/leases/[id]/signed/route.ts", () => fixture.lease, signedApi],
  ["ticket photo redirect/bytes", "src/app/api/tickets/photos/[id]/route.ts", () => fixture.attachment, photoApi],
] as const) {
  inventory({ surface, file: route, anchor: "export async function GET(", role: "foreign staff Admin; own Admin/Manager", expected: "404, no body/filename/URL leakage; own 200 or photo 302", name: `B027 HTTP: ${surface}` }, async () => {
    const call = () => handler(new Request("http://127.0.0.1/b027"), { params: Promise.resolve({ id: id() }) });
    await login(foreign); const before = storageCalls; await httpDenied(await call()); assert.equal(storageCalls, before);
    for (const allowed of [admin, manager]) {
      await login(allowed); const response = await call();
      if (handler === photoApi) {
        assert.equal(response.status, 302);
        const url = response.headers.get("location")!; assert.ok(url.startsWith(`${storageBase}/`));
        assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), photoBytes);
      } else if (handler === signedApi) {
        assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdfBytes);
      } else { assert.equal(response.status, 200); assert.ok(Object.keys(await response.json()).length); }
    }
  });
}

inventory({ surface: "repair photo metadata + URL + byte route", file: "src/server/repairs.ts", anchor: "export async function readRepairPhoto(", role: "Accountant / foreign staff; own Admin/Manager", expected: "forbidden/null/404; no storage call; own filename and bytes", name: "B027 Accountant photo readers deny metadata URLs and bytes" }, async () => {
  for (const deniedSession of [foreign, accountant]) {
    const before = storageCalls;
    await denied(() => readRepairPhoto(deniedSession, fixture.attachment));
    await denied(() => openTicketPhoto(deniedSession, fixture.attachment));
    await login(deniedSession);
    await httpDenied(await photoApi(new Request("http://127.0.0.1/b027"), { params: Promise.resolve({ id: fixture.attachment }) }));
    assert.equal(storageCalls, before);
  }
  for (const allowed of [admin, manager]) {
    assert.equal((await readRepairPhoto(allowed, fixture.attachment))?.name, `${marker}.jpg`);
    const opened = await openTicketPhoto(allowed, fixture.attachment); assert.ok(opened);
    assert.deepEqual(Buffer.from(await (await fetch(opened.url)).arrayBuffer()), photoBytes);
  }
});

inventory({ surface: "company audit screen/history + direct RLS", file: "src/server/audit-read.ts", anchor: "export async function loadAuditScreen(", role: "Manager / Accountant / Staff=maintenance / foreign Admin; own Admin", expected: "empty entries; own Admin sees fixture", name: "B027 company audit excludes every non-Admin role" }, async () => {
  assert.deepEqual(nonAdmins.map((s) => s.role), ["manager", "accountant", "maintenance"]);
  for (const deniedSession of [...nonAdmins, foreign]) {
    const history = await loadAuditHistory(deniedSession, "maintenance_tickets", fixture.ticket);
    assert.deepEqual(history.entries, []);
    const page = await loadAuditScreen(deniedSession, {});
    if (deniedSession !== foreign) { assert.deepEqual(page.entries, []); assert.deepEqual(page.actors, []); }
    assert.equal(JSON.stringify(page).includes(marker), false);
    const rows = await tx(deniedSession.userId, (client) => client.query(`SELECT * FROM audit_log WHERE row_id=$1`, [fixture.ticket]), requireOrgScope(deniedSession));
    assert.deepEqual(rows.rows, []);
  }
  assert.ok((await loadAuditHistory(admin, "maintenance_tickets", fixture.ticket)).entries.some((e) => e.reason === marker));
  // Same-fixture positive control for the screen too: an always-empty screen must not pass.
  assert.ok(JSON.stringify((await loadAuditScreen(admin, {})).entries).includes(marker), "own Admin audit screen shows the fixture");
});

inventory({ surface: "ID document URL and decrypted bytes readers", file: "src/server/id-docs.ts", anchor: "export async function serveSignedPhoto(", role: "foreign staff / Accountant; own Admin/Manager", expected: "forbidden/null; own watermarked image bytes", name: "B027 ID document bytes and URLs are scoped" }, async () => {
  for (const deniedSession of [foreign, accountant]) {
    await denied(() => issuePhotoUrls(deniedSession, fixture.idDocument));
    assert.equal(await serveSignedPhoto({ tokenHash: null, userId: deniedSession.userId, preferredOrg: deniedSession.orgId, env: "live", documentId: fixture.idDocument, slot: "front" }), null);
  }
  for (const allowed of [admin, manager]) {
    const issued = await issuePhotoUrls(allowed, fixture.idDocument); assert.ok(issued.shots.length);
    const token = new URL(issued.shots[0].url, "http://127.0.0.1").searchParams.get("token")!;
    const photo = await openSignedPhoto(allowed, token); assert.ok(photo.bytes.length); assert.equal(photo.mime, "image/jpeg");
  }
});
inventory({ surface: "ID document photo API", file: "src/app/api/id-documents/photo/route.ts", anchor: "export async function GET(", role: "foreign staff / Accountant; own Admin/Manager", expected: "404 empty; own 200 image bytes", name: "B027 HTTP ID photo reauthorizes known document and signed token" }, async () => {
  for (const caller of [foreign, accountant, admin, manager]) {
    await login(caller);
    const token = signPhotoToken({ documentId: fixture.idDocument, slot: "front", userId: caller.userId, exp: Date.now() + 60_000 });
    const response = await idPhotoApi(new Request(`http://127.0.0.1/api/id-documents/photo?token=${token}`));
    if ([foreign, accountant].includes(caller)) await httpDenied(response, "");
    else { assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/jpeg"); assert.ok((await response.arrayBuffer()).byteLength); }
  }
});
inventory({ surface: "vendor persisted document bytes", file: "src/server/vendor-receipt.ts", anchor: "export async function readVendorDocumentPdf(", role: "foreign staff / Accountant; own Admin/Manager", expected: "notFound/forbidden; own exact PDF bytes and hash", name: "B027 vendor document reader denies foreign org and Accountant" }, async () => {
  for (const caller of [foreign, accountant]) await denied(() => readVendorDocumentPdf(caller, fixture.vendorDocument));
  for (const caller of [admin, manager]) assert.deepEqual(Buffer.from((await readVendorDocumentPdf(caller, fixture.vendorDocument)).bytes), pdfBytes);
});

inventory({ surface: "direct photo file metadata and legacy attachment bytes", file: "src/server/b027-denial-inventory.integration.test.ts", anchor: "// Direct org isolation:", role: "foreign staff; own Admin/Manager", expected: "zero rows; same fixture exact filename/path/bytes", name: "B027 direct photo data remains isolated across organizations" }, async () => {
  // Direct org isolation: exercise both tables even while same-org Accountant gaps are parked.
  for (const caller of [foreign, admin, manager]) {
    const result = await tx(caller.userId, async (client) => ({
      files: (await client.query(`SELECT file_name,storage_path FROM files WHERE id=$1`, [fixture.file])).rows,
      bytes: (await client.query(`SELECT content FROM ticket_attachments WHERE id=$1`, [fixture.attachment])).rows,
    }), requireOrgScope(caller));
    assert.deepEqual(result, caller === foreign ? { files: [], bytes: [] } : {
      files: [{ file_name: `${marker}.jpg`, storage_path: fixture.path }], bytes: [{ content: photoBytes }],
    });
  }
});

inventory({ surface: "direct files metadata via authenticated RLS", file: "src/server/b027-denial-inventory.integration.test.ts", anchor: "// GAP-01:", role: "Accountant; own Admin positive control", expected: "zero filename/path rows (GAP-01 fixed by 20261106232000)", name: "B027 GAP-01 Accountant must not read ticket photo file metadata" }, async () => {
  // GAP-01: exercise the actual direct-table privilege, not a mocked application guard.
  const read = (session: Session) => tx(session.userId, (client) => client.query(`SELECT file_name,storage_path FROM files WHERE id=$1`, [fixture.file]), requireOrgScope(session));
  assert.equal((await read(admin)).rows.length, 1);
  assert.deepEqual((await read(accountant)).rows, [], "Accountant can read a ticket photo filename/storage path through files.team_read");
  // Maintenance holds tickets.update: positive control for the narrowed policy.
  const maintenance = nonAdmins.find((session) => session.role === "maintenance")!;
  assert.equal((await read(maintenance)).rows.length, 1);
  // Accountant keeps non-photo files (other buckets) and its own uploads.
  const other = randomUUID(), own = randomUUID();
  await query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes) VALUES($1,$2,'documents-private',$3,'b027-other.pdf','application/pdf',1)`, [other, ORG_ID, `org/${ORG_ID}/b027/${other}.pdf`]);
  await query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by) VALUES($1,$2,'ticket-photos-private',$3,'b027-own.jpg','image/jpeg',1,$4)`, [own, ORG_ID, `org/${ORG_ID}/tickets/${fixture.ticket}/${own}.jpg`, USERS.accountant]);
  const visible = (session: Session, id: string) => tx(session.userId, (client) => client.query(`SELECT id FROM files WHERE id=$1`, [id]), requireOrgScope(session));
  assert.equal((await visible(accountant, other)).rows.length, 1, "non-photo files stay readable");
  assert.deepEqual((await visible(accountant, own)).rows, [], "a member's photo access follows the role, not upload history");
  assert.deepEqual((await visible(foreign, other)).rows, [], "foreign org stays denied");
  await query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [[other, own]]);
  // Write-then-read bypass: an Accountant UPDATE without WHERE/RETURNING must not
  // claim photo rows for the own-upload read (rolled back; probe only).
  let probe: unknown[] = ["not run"];
  await assert.rejects(tx(accountant.userId, async (client) => {
    await client.query(`UPDATE files SET uploaded_by = auth.uid()`);
    probe = (await client.query(`SELECT file_name,storage_path FROM files WHERE id=$1`, [fixture.file])).rows;
    throw new Error("probe rollback");
  }, requireOrgScope(accountant)));
  assert.deepEqual(probe, [], "UPDATE then own-read must not expose the photo row");
  assert.notEqual((await query<{ uploaded_by: string | null }>(`SELECT uploaded_by FROM files WHERE id=$1`, [fixture.file])).rows[0].uploaded_by, USERS.accountant);
  // Staff-reporter bypass: a member who reported the ticket (e.g. downgraded to
  // Accountant) gets no portal-path access to photo metadata or attachment rows.
  const reporter = (await query<{ reported_by_user: string | null }>(`SELECT reported_by_user FROM maintenance_tickets WHERE id=$1`, [fixture.ticket])).rows[0].reported_by_user;
  await query(`UPDATE maintenance_tickets SET reported_by_user=$2 WHERE id=$1`, [fixture.ticket, USERS.accountant]);
  try {
    assert.deepEqual((await read(accountant)).rows, [], "staff reporter identity is not tenant access");
    const rows = await tx(accountant.userId, (client) => client.query(`SELECT id FROM ticket_attachments WHERE ticket_id=$1`, [fixture.ticket]), requireOrgScope(accountant));
    assert.deepEqual(rows.rows, []);
    // Forged/mismatched session pins must not turn staff into a "non-member".
    for (const pins of [{ env: "sandbox", org: ORG_ID }, { env: "live", org: randomUUID() }, { env: "", org: "" }]) {
      const probe = await tx(accountant.userId, async (client) => {
        await client.query(`SELECT set_config('app.env',$1,true), set_config('app.active_org_id',$2,true)`, [pins.env, pins.org]);
        return {
          attachments: (await client.query(`SELECT id,content FROM ticket_attachments WHERE ticket_id=$1`, [fixture.ticket])).rows,
          files: (await client.query(`SELECT file_name,storage_path FROM files WHERE id=$1`, [fixture.file])).rows,
        };
      }, requireOrgScope(accountant));
      assert.deepEqual(probe, { attachments: [], files: [] }, `pins ${JSON.stringify(pins)}`);
    }
  } finally {
    await query(`UPDATE maintenance_tickets SET reported_by_user=$2 WHERE id=$1`, [fixture.ticket, reporter]);
  }
  // Genuine tenant (no org_members row) reporting the ticket keeps portal access.
  const tenantUser = (await query<{ id: string }>(`SELECT u.id::text FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.user_id=u.id) AND EXISTS (SELECT 1 FROM contacts c WHERE c.user_id=u.id AND c.org_id=$1 AND c.is_tenant) LIMIT 1`, [ORG_ID])).rows[0]?.id;
  assert.ok(tenantUser, "a genuine tenant user exists in the seed");
  await query(`UPDATE maintenance_tickets SET reported_by_user=$2 WHERE id=$1`, [fixture.ticket, tenantUser]);
  try {
    const internal = (await query<{ is_internal: boolean }>(`SELECT is_internal FROM ticket_attachments WHERE id=$1`, [fixture.attachment])).rows[0].is_internal;
    const seen = await tx(tenantUser!, async (client) => ({
      attachments: (await client.query(`SELECT id FROM ticket_attachments WHERE id=$1`, [fixture.attachment])).rows.length,
      files: (await client.query(`SELECT id FROM files WHERE id=$1`, [fixture.file])).rows.length,
    }));
    assert.deepEqual(seen, internal ? { attachments: 0, files: 0 } : { attachments: 1, files: 1 }, "tenant portal photo access unchanged");
  } finally {
    await query(`UPDATE maintenance_tickets SET reported_by_user=$2 WHERE id=$1`, [fixture.ticket, reporter]);
  }
});

inventory({ surface: "direct ticket attachment bytes via authenticated RLS", file: "src/server/b027-denial-inventory.integration.test.ts", anchor: "// GAP-02:", role: "Accountant; foreign staff and own Admin controls", expected: "zero bytes rows (GAP-02 fixed by 20261106232000)", name: "B027 GAP-02 Accountant must not read legacy ticket attachment bytes" }, async () => {
  // GAP-02: legacy inline content remains selectable despite the application photo guard.
  const read = (session: Session) => tx(session.userId, (client) => client.query(`SELECT content FROM ticket_attachments WHERE id=$1`, [fixture.attachment]), requireOrgScope(session));
  assert.deepEqual((await read(foreign)).rows, []);
  assert.deepEqual((await read(admin)).rows[0].content, photoBytes);
  assert.deepEqual((await read(accountant)).rows, [], "Accountant can read ticket_attachments.content");
  const maintenance = nonAdmins.find((session) => session.role === "maintenance")!;
  assert.deepEqual((await read(maintenance)).rows[0].content, photoBytes);
  // The no-permission count definer: same-org members only; no row data.
  const count = async (session: Session, ticket: string) => Number((await tx(session.userId, (client) =>
    client.query<{ n: number }>(`SELECT app.b027_ticket_attachment_count($1) AS n`, [ticket]), requireOrgScope(session))).rows[0].n);
  const expected = Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ticket_attachments WHERE ticket_id=$1`, [fixture.ticket])).rows[0].n);
  assert.ok(expected > 0);
  assert.equal(await count(accountant, fixture.ticket), expected);
  assert.equal(await count(admin, fixture.ticket), expected);
  assert.equal(await count(foreign, fixture.ticket), 0, "foreign org gets no count");
  assert.equal(await count(accountant, randomUUID()), 0, "missing ticket");
  const fn = (await query<{ definer: boolean; config: string[] | null; anon: boolean; authenticated: boolean; public: boolean }>(`
    SELECT p.prosecdef AS definer, p.proconfig AS config,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public
      FROM pg_proc p WHERE p.oid = 'app.b027_ticket_attachment_count(uuid)'::regprocedure`)).rows[0];
  assert.deepEqual(fn, { definer: true, config: ["search_path=pg_catalog, public, app"], anon: false, authenticated: true, public: false });
});
inventory({ surface: "/m/tickets/[id] photo metadata loader", file: "src/server/queries.ts", anchor: "export async function ticketDetail(", role: "Accountant; own Admin positive control", expected: "empty photos (no filenames/paths/ids), count only (GAP-03 fixed)", name: "B027 GAP-03 Accountant ticket loader must not return photo metadata" }, async () => {
  const own = await ticketDetail(admin, fixture.ticket);
  assert.equal(own?.photos[0].name, `${marker}.jpg`);
  assert.equal(own?.hiddenPhotoCount, 0);
  const restricted = await ticketDetail(accountant, fixture.ticket);
  assert.deepEqual(restricted?.photos, [], "Accountant ticketDetail exposes photo metadata");
  assert.equal(restricted?.hiddenPhotoCount, own?.photos.length, "count drives the no-permission notice");
  const payload = JSON.stringify(restricted);
  for (const secret of [`${marker}.jpg`, fixture.path, fixture.attachment]) {
    assert.equal(payload.includes(secret), false, "no photo name/path/id anywhere in the payload");
  }
});

// Reviewed against migrations through this checkout, not learned at test runtime.
// SQL privileges are necessary but not sufficient: the exact RLS policy set is pinned too.
const grants = [
  { table: "id_document_objects", privileges: [], forced: false, hash: "d751713988987e9331980363e24189ce", why: "encrypted identity image bytes; service-only", policy: "no policies and no client ACL" },
  { table: "lease_signed_pdfs", privileges: ["SELECT", "INSERT", "DELETE"], forced: false, hash: "a55506695b086d27507d16baffe84cd9", why: "signed contractual bytes", policy: "member SELECT; scoped tenant SELECT; Admin/Manager INSERT/DELETE" },
  { table: "payee_account_numbers", privileges: [], forced: false, hash: "fbed9f776e88e9d3ab382ae4a0a0d8da", why: "unmasked payee bank account data", policy: "Admin policies exist but client ACL revoked; gateway only" },
  { table: "audit_log", privileges: ["SELECT"], forced: false, hash: "a70678f6ca0de54cb79fdfee017ebeef", why: "company activity and sensitive row snapshots", policy: "Admin SELECT only" },
  { table: "consents", privileges: ["SELECT"], forced: false, hash: "e432e0ae23c6888ebaf23eab8f96c078", why: "user legal consent evidence", policy: "own-user SELECT; no client mutation" },
  { table: "platform_settings", privileges: ["SELECT"], forced: false, hash: "5b90ddfd20a8d3d42e3f934a87a84a10", why: "global control plane and rollout settings", policy: "authenticated SELECT intentionally global; no client mutation" },
  { table: "files", privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"], forced: false, hash: "4978b8afb738b4008ea6cd37121ab08f", why: "private object paths and filenames", policy: "member CRUD (ticket-photo bucket SELECT only for tickets.update roles) + portal own/attached-photo policies; GAP-01 fixed" },
] as const;
const supplementary = { table: "vendor_document_pdf_bytes", privileges: [], forced: true, hash: "d751713988987e9331980363e24189ce", why: "persisted vendor PDF bytes", policy: "service-only, forced RLS" } as const;
const operations = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const columnOperations = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
for (const spec of [...grants, supplementary]) {
  inventory({ surface: `public.${spec.table} catalog`, file: "src/server/b027-denial-inventory.integration.test.ts", anchor: `table: "${spec.table}"`, role: "anon / authenticated (effective, inherited + PUBLIC + columns)", expected: `anon none; authenticated ${spec.privileges.join("/") || "none"}; RLS ON; FORCE ${spec.forced}`, name: `B027 grants: public.${spec.table}` }, async () => {
    const table = `public.${spec.table}`;
    const catalog = (await query<{ enabled: boolean; forced: boolean; hash: string }>(`
      SELECT c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,
        md5(coalesce((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd,'permissive',p.polpermissive,
          'roles',(SELECT array_agg(q.n ORDER BY q.n) FROM (SELECT CASE WHEN x.oid=0 THEN 'PUBLIC' ELSE r.rolname::text END AS n
            FROM unnest(p.polroles) AS x(oid) LEFT JOIN pg_roles r ON r.oid=x.oid) q),
          'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)::text
          FROM pg_policy p WHERE p.polrelid=c.oid),'[]')) AS hash
      FROM pg_class c WHERE c.oid=$1::regclass`, [table])).rows[0];
    assert.deepEqual(catalog, { enabled: true, forced: spec.forced, hash: spec.hash }, `${table}: RLS/policy drift needs review`);
    for (const role of ["anon", "authenticated"]) {
      const roleFlags = (await query<{ bypass: boolean; superuser: boolean }>(`SELECT rolbypassrls AS bypass,rolsuper AS superuser FROM pg_roles WHERE rolname=$1`, [role])).rows[0];
      assert.deepEqual(roleFlags, { bypass: false, superuser: false });
      const allowed: readonly string[] = role === "anon" ? [] : spec.privileges;
      for (const operation of operations) {
        const result = (await query<{ allowed: boolean; grantable: boolean }>(`SELECT has_table_privilege($1,$2,$3) AS allowed, has_table_privilege($1,$2,$4) AS grantable`, [role, table, operation, `${operation} WITH GRANT OPTION`])).rows[0];
        assert.deepEqual(result, { allowed: allowed.includes(operation), grantable: false }, `${role} ${table} ${operation}`);
      }
      // A column-only GRANT can bypass a table ACL check. Inspect every live column.
      const columns = (await query<{ name: string }>(`SELECT attname AS name FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [table])).rows;
      assert.ok(columns.length);
      for (const operation of columnOperations) {
        const rows = (await query<{ name: string; allowed: boolean; grantable: boolean }>(`SELECT attname AS name,
          has_column_privilege($1,attrelid,attnum,$3) AS allowed,
          has_column_privilege($1,attrelid,attnum,$4) AS grantable
          FROM pg_attribute WHERE attrelid=$2::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`, [role, table, operation, `${operation} WITH GRANT OPTION`])).rows;
        assert.deepEqual(rows, columns.map(({ name }) => ({ name, allowed: allowed.includes(operation), grantable: false })), `${role} ${table} column ${operation}`);
      }
    }
  });
}

function lineOf(file: string, anchor: string) {
  const lines = readFileSync(file, "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(anchor));
  assert.ok(index >= 0, `${file}: missing source anchor ${anchor}`);
  return index + 1;
}
function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => item.isDirectory() ? routeFiles(`${dir}/${item.name}`) : item.name === "route.ts" ? [`${dir}/${item.name}`] : []).sort();
}
function inventoryMarkdown() {
  const lines = ["# B-027 slice 2 — executable denial inventory", "",
    "Generated by `B027_WRITE_INVENTORY=1 npx tsx --test --test-concurrency=1 src/server/b027-denial-inventory.integration.test.ts` on a seeded, explicitly disposable localhost DB. The ordinary test compares this artifact with current source anchors and route enumeration; regenerate after line changes. A generated row is a coverage declaration, not a passing verdict. See the design for verification and findings.", "",
    "Real loaders, HTTP handlers, session cookies, authorization and PostgreSQL RLS are executed. Only Next request headers/cookies and private-object storage transport use local fixtures. The source database is cloned and the owned clone is dropped afterward. No flag is enabled. Staff means `maintenance` in `perms.ts`. Foreign staff uses the other organization's real Admin membership (stronger than a low-privilege role). Positive controls use the same target rows.", "",
    "| Surface | File:line | Role | Expected | Test name |", "|---|---|---|---|---|"];
  for (const e of entries) lines.push(`| ${e.surface} | ${e.file}:${lineOf(e.file, e.anchor)} | ${e.role} | ${e.expected} | ${e.name} |`);
  lines.push("", "## Seven-table grants contract", "", "All seven tables are in `public`. Each checks effective table and every column privilege (including inherited/PUBLIC access and grant options), client BYPASSRLS/superuser bits, RLS state, and a pinned hash of policy names, commands, roles, permissiveness and expressions. This is a reviewed baseline, not proof that every baseline policy is ideal. Policy helper-function implementation drift is outside the hash; behavioral tests cover the selected paths.", "",
    "| Table | Sensitivity | Authenticated privilege contract | Intended policy / known limit | FORCE RLS |", "|---|---|---|---|---|");
  for (const s of grants) lines.push(`| public.${s.table} | ${s.why} | ${s.privileges.join(", ") || "none"}; anon none | ${s.policy} | ${s.forced} |`);
  lines.push("", "These seven existing migrations enable RLS but do not FORCE it. The test pins that fact rather than claiming owner isolation. Supplemental `vendor_document_pdf_bytes` asserts ENABLE + FORCE and no client grants, exercising the forced expectation where the migration requires it. Service roles and table owners remain trusted. `platform_settings` reads are intentionally global; they are not an org-denial surface. Files' Accountant ticket-photo metadata exposure (GAP-01) is closed by 20261106232000.", "", "## Route enumeration and scope", "",
    "Every current `src/app/**/route.ts` is listed below. Selected read routes execute above; other routes are explicitly not covered by this representative slice. This is not an exhaustive route, browser, mutation, bearer-token, staging or production security audit.", "", "| Route source | Coverage |", "|---|---|");
  for (const file of routeFiles("src/app")) lines.push(`| ${file}:1 | ${entries.some((e) => e.file === file) ? "HTTP handler executed above" : "Enumerated only; outside representative selection"} |`);
  lines.push("", "## Reader boundaries", "", "Ticket/repair metadata, signed URLs, redirect delivery and local object bytes are covered together. Raw `downloadRepairObject`, `signTicketPhotoUrls` and `readCiphertext` accept already-authorized paths/DB clients and are not session entrypoints; their caller guards are the tested boundary. Vendor persisted documents execute the service-role reader with real membership rechecks. Vendor bearer-link photo routes and feature-gated handover/esign/versioned PDF routes are enumerated but not claimed as exercised here. The legacy signed-PDF route supplies an active positive control without changing flags.", "", "## Known gap execution", "", "GAP-01/02 (RLS policy gaps, hub BLK-MAC-12) are fixed by migration 20261106232000 and run as ordinary cases in the normal gate, as does GAP-03 (ticket loader photo metadata). `B027_RUN_KNOWN_GAP=1` is no longer needed; with it set the run is identical.", "");
  return lines.join("\n");
}
test("B027 generated denial inventory matches executable cases and source lines", () => {
  const file = "e2e-evidence/B-027/denial-inventory.md";
  const markdown = inventoryMarkdown();
  if (process.env.B027_WRITE_INVENTORY === "1") { mkdirSync("e2e-evidence/B-027", { recursive: true }); writeFileSync(file, markdown); }
  assert.equal(readFileSync(file, "utf8"), markdown, "Regenerate B027 inventory after reviewing source/coverage changes");
});
