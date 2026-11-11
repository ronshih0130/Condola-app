import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { GET } from "@/app/m/leases/[id]/signed/route";
import { SESSION_COOKIE } from "./auth";
import { query } from "./db";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { sessionTokenHash } from "./session";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

let token: string | null = null;
const previousPaper = process.env.PAPER_LEASE_VERSIONS_ENABLED;
const sessions: string[] = [];
const leases: string[] = [];
const files: string[] = [];
const properties: string[] = [];
const pdfs: string[] = [];
let refusedUser: string | undefined;

mock.method(nextHeaders, "cookies", async () => ({
  get(name: string) {
    if (name === SESSION_COOKIE && token) return { value: token };
    return undefined;
  },
}));
mock.method(nextHeaders, "headers", async () => new Headers());

function call(leaseId: string) {
  return GET(new Request(`http://127.0.0.1/m/leases/${leaseId}/signed`), {
    params: Promise.resolve({ id: leaseId }),
  });
}

function loginRedirect(error: unknown) {
  if (!error || typeof error !== "object" || !("digest" in error)) return false;
  const digest = String((error as { digest?: unknown }).digest);
  return digest.startsWith("NEXT_REDIRECT;") && digest.includes("/login");
}

async function openSession(userId: string) {
  const raw = randomUUID();
  const id = randomUUID();
  await query(
    `INSERT INTO auth_sessions(id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`,
    [id, userId, sessionTokenHash(raw)],
  );
  sessions.push(id);
  return raw;
}

async function addPdf(
  orgId: string,
  lease: string,
  bytes: Buffer,
  extra: { replaceReason?: string; supersedesId?: string; createdLater?: boolean } = {},
) {
  const path = `${orgId}/${lease}/${randomUUID()}.pdf`;
  const file = (await query<{ id: string }>(
    `INSERT INTO files(org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
     VALUES ($1, 'lease-documents-private', $2, 'signed.pdf', 'application/pdf', $3, $4) RETURNING id::text`,
    [orgId, path, bytes.length, USERS.admin],
  )).rows[0].id;
  files.push(file);
  const pdf = (await query<{ id: string }>(
    `INSERT INTO lease_signed_pdfs(org_id, lease_id, file_id, object_path, content, replace_reason, supersedes_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp()${extra.createdLater ? " + interval '1 second'" : ""})
     RETURNING id::text`,
    [orgId, lease, file, path, bytes, extra.replaceReason ?? null, extra.supersedesId ?? null],
  )).rows[0].id;
  pdfs.push(pdf);
  return { file, pdf };
}

async function version(orgId: string) {
  const bytes = Buffer.from(`%PDF-1.4\n${orgId}\n%%EOF\n`);
  const property = (await query<{ id: string }>(
    `INSERT INTO properties(org_id, name, country_code, currency, timezone, default_rental_mode)
     VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei', 'whole_unit') RETURNING id::text`,
    [orgId, `Legacy route ${randomUUID()}`],
  )).rows[0].id;
  properties.push(property);
  const unit = (await query<{ id: string }>(
    `INSERT INTO units(org_id, property_id, label, rental_mode)
     VALUES ($1, $2, $3, 'whole_unit') RETURNING id::text`,
    [orgId, property, `Legacy ${randomUUID().slice(0, 8)}`],
  )).rows[0].id;
  const lease = (await query<{ id: string }>(
    `INSERT INTO leases(org_id, property_id, unit_id, target_unit_id, status, start_date, currency, rent_amount_minor)
     VALUES ($1, $2, $3, $3, 'active', current_date, 'TWD', 0) RETURNING id::text`,
    [orgId, property, unit],
  )).rows[0].id;
  leases.push(lease);
  const { pdf } = await addPdf(orgId, lease, bytes);
  return { lease, pdf, bytes };
}

async function downloads(pdfId: string) {
  return query<{
    reason: string | null;
    actor_role: string;
    actor_user_id: string;
    org_id: string;
    table_name: string;
    row_id: string;
    new_row: { event: string; lease_id: string };
    request_id: string;
    occurred_at: Date;
  }>(
    `SELECT reason, actor_role::text, actor_user_id::text, org_id::text, table_name, row_id, new_row, request_id, occurred_at
       FROM audit_log
      WHERE event_type = 'signed_pdf_downloaded' AND row_id = $1
      ORDER BY id`,
    [pdfId],
  );
}

test.before(async () => {
  refusedUser = randomUUID();
  await query(
    `INSERT INTO auth.users(id, email, role, aud) VALUES ($1, $2, 'authenticated', 'authenticated')`,
    [refusedUser, `${refusedUser}@example.test`],
  );
  await query(
    `INSERT INTO org_members(org_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [ORG_ID, refusedUser],
  );
});

test.after(async () => {
  mock.restoreAll();
  if (previousPaper === undefined) delete process.env.PAPER_LEASE_VERSIONS_ENABLED;
  else process.env.PAPER_LEASE_VERSIONS_ENABLED = previousPaper;
  if (leases.length) await query(`DELETE FROM leases WHERE id = ANY($1::uuid[])`, [leases]);
  if (files.length) await query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [files]);
  if (properties.length) await query(`DELETE FROM units WHERE property_id = ANY($1::uuid[])`, [properties]);
  if (properties.length) await query(`DELETE FROM properties WHERE id = ANY($1::uuid[])`, [properties]);
  if (sessions.length) await query(`DELETE FROM auth_sessions WHERE id = ANY($1::uuid[])`, [sessions]);
  if (refusedUser) {
    await query(`DELETE FROM org_members WHERE user_id = $1`, [refusedUser]);
    await query(`DELETE FROM auth.users WHERE id = $1`, [refusedUser]);
  }
});

test("legacy signed-PDF route redirects a logged-out request", async () => {
  const own = await version(ORG_ID);
  token = null;
  const before = await downloads(own.pdf);
  await assert.rejects(() => call(own.lease), loginRedirect);
  assert.equal((await downloads(own.pdf)).rows.length, before.rows.length);
});

test("legacy signed-PDF route refuses a session without current consent", async () => {
  const own = await version(ORG_ID);
  token = await openSession(refusedUser!);
  const response = await call(own.lease);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("content-type")?.includes("application/pdf"), false);
  assert.deepEqual(await response.json(), { ok: false, error: "errors.consentRequired" });
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("legacy signed-PDF route refuses an accountant", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.accountant);
  const response = await call(own.lease);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.equal(response.headers.get("content-type")?.includes("application/pdf"), false);
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("legacy signed-PDF route refuses a maintenance member", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.maintenance);
  const response = await call(own.lease);
  assert.equal(response.status, 404);
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("legacy signed-PDF route refuses the tenant signer", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.tenant);
  const response = await call(own.lease);
  assert.equal(response.status, 404);
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("legacy signed-PDF route hides another organization's lease", async () => {
  const foreign = await version(ORG2_ID);
  token = await openSession(USERS.admin);
  const response = await call(foreign.lease);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.equal((await downloads(foreign.pdf)).rows.length, 0);
});

test("legacy signed-PDF route serves a manager download", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.manager);
  const response = await call(own.lease);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), own.bytes);
  const rows = await downloads(own.pdf);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].actor_role, "manager");
});

test("legacy signed-PDF route writes one DB audit row with actor role, user id, org id, lease id and timestamp", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.admin);
  const startedAt = new Date(Date.now() - 5000);
  const response = await call(own.lease);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), own.bytes);
  const rows = await downloads(own.pdf);
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0];
  assert.equal(row.reason, "signed_pdf_downloaded");
  assert.equal(row.actor_role, "admin");
  assert.equal(row.actor_user_id, USERS.admin);
  assert.equal(row.org_id, ORG_ID);
  assert.equal(row.table_name, "lease_signed_pdfs");
  assert.equal(row.row_id, own.pdf);
  assert.deepEqual(row.new_row, { event: "signed_pdf_downloaded", lease_id: own.lease });
  assert.ok(row.occurred_at instanceof Date);
  assert.ok(row.occurred_at >= startedAt);
  assert.ok(row.occurred_at <= new Date(Date.now() + 5000));
  assert.equal(typeof row.request_id, "string");
  assert.ok(row.request_id.length > 0);
  assert.equal(JSON.stringify(row).includes("signed.pdf"), false);
});

test("legacy signed-PDF route audit row records the manager role and user", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.manager);
  const response = await call(own.lease);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), own.bytes);
  const rows = await downloads(own.pdf);
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0];
  assert.equal(row.actor_role, "manager");
  assert.equal(row.actor_user_id, USERS.manager);
  assert.equal(row.org_id, ORG_ID);
  assert.equal(row.new_row.lease_id, own.lease);
});

test("legacy signed-PDF route serves the newest version", async () => {
  const first = await version(ORG_ID);
  const secondBytes = Buffer.from(`%PDF-1.4\n${randomUUID()}\n%%EOF\n`);
  const second = await addPdf(ORG_ID, first.lease, secondBytes, {
    replaceReason: "wrong_file",
    supersedesId: first.pdf,
    createdLater: true,
  });
  token = await openSession(USERS.admin);
  const response = await call(first.lease);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), secondBytes);
  assert.equal((await downloads(second.pdf)).rows.length, 1);
  assert.equal((await downloads(first.pdf)).rows.length, 0);
});

test("legacy signed-PDF route is independent of the paper-versions flag", async () => {
  const own = await version(ORG_ID);
  for (const enabled of [false, true]) {
    if (enabled) process.env.PAPER_LEASE_VERSIONS_ENABLED = "true";
    else delete process.env.PAPER_LEASE_VERSIONS_ENABLED;

    token = await openSession(USERS.admin);
    const allowed = await call(own.lease);
    assert.equal(allowed.status, 200);
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), own.bytes);

    token = await openSession(USERS.accountant);
    const denied = await call(own.lease);
    assert.equal(denied.status, 404);
  }
});
