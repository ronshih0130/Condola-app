import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { GET } from "@/app/m/leases/[id]/signed/[pdfId]/route";
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
let originalFlags: unknown;

mock.method(nextHeaders, "cookies", async () => ({
  get(name: string) {
    if (name === SESSION_COOKIE && token) return { value: token };
    return undefined;
  },
}));
mock.method(nextHeaders, "headers", async () => new Headers());

function call(leaseId: string, pdfId: string) {
  return GET(new Request(`http://127.0.0.1/m/leases/${leaseId}/signed/${pdfId}`), {
    params: Promise.resolve({ id: leaseId, pdfId }),
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

async function version(orgId: string) {
  const bytes = Buffer.from(`%PDF-1.4\n${orgId}\n%%EOF\n`);
  const property = (await query<{ id: string }>(
    `INSERT INTO properties(org_id, name, country_code, currency, timezone, default_rental_mode)
     VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei', 'whole_unit') RETURNING id::text`,
    [orgId, `Staff route ${randomUUID()}`],
  )).rows[0].id;
  properties.push(property);
  const unit = (await query<{ id: string }>(
    `INSERT INTO units(org_id, property_id, label, rental_mode)
     VALUES ($1, $2, 'Route', 'whole_unit') RETURNING id::text`,
    [orgId, property],
  )).rows[0].id;
  const lease = (await query<{ id: string }>(
    `INSERT INTO leases(org_id, property_id, unit_id, target_unit_id, status, start_date, currency, rent_amount_minor)
     VALUES ($1, $2, $3, $3, 'active', current_date, 'TWD', 0) RETURNING id::text`,
    [orgId, property, unit],
  )).rows[0].id;
  leases.push(lease);
  const path = `${orgId}/${lease}/${randomUUID()}.pdf`;
  const file = (await query<{ id: string }>(
    `INSERT INTO files(org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
     VALUES ($1, 'lease-documents-private', $2, 'signed.pdf', 'application/pdf', $3, $4) RETURNING id::text`,
    [orgId, path, bytes.length, USERS.admin],
  )).rows[0].id;
  files.push(file);
  const pdf = (await query<{ id: string }>(
    `INSERT INTO lease_signed_pdfs(org_id, lease_id, file_id, object_path, content)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [orgId, lease, file, path, bytes],
  )).rows[0].id;
  pdfs.push(pdf);
  return { lease, pdf, bytes };
}

async function downloads(pdfId: string) {
  return query<{ reason: string | null; actor_role: string; new_row: unknown }>(
    `SELECT reason, actor_role::text, new_row
       FROM audit_log
      WHERE event_type = 'signed_pdf_downloaded' AND row_id = $1
      ORDER BY id`,
    [pdfId],
  );
}

test.before(async () => {
  process.env.PAPER_LEASE_VERSIONS_ENABLED = "true";
  const flags = await query<{ feature_flags: unknown }>(
    `SELECT feature_flags FROM organizations WHERE id = $1`,
    [ORG_ID],
  );
  originalFlags = flags.rows[0]?.feature_flags ?? null;
  await query(
    `UPDATE organizations
        SET feature_flags = coalesce(feature_flags, '{}'::jsonb) || '{"paper_lease_versions":true}'::jsonb
      WHERE id = $1`,
    [ORG_ID],
  );
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
  if (originalFlags !== undefined) {
    await query(`UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1`, [
      ORG_ID, originalFlags === null ? null : JSON.stringify(originalFlags),
    ]);
  }
});

test("staff signed-PDF route redirects a logged-out request", async () => {
  const own = await version(ORG_ID);
  token = null;
  const before = await downloads(own.pdf);
  await assert.rejects(() => call(own.lease, own.pdf), loginRedirect);
  assert.equal((await downloads(own.pdf)).rows.length, before.rows.length);
});

test("staff signed-PDF route refuses a session without current consent", async () => {
  const own = await version(ORG_ID);
  token = await openSession(refusedUser!);
  const response = await call(own.lease, own.pdf);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("content-type")?.includes("application/pdf"), false);
  assert.deepEqual(await response.json(), { ok: false, error: "errors.consentRequired" });
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("staff signed-PDF route hides another organization's version", async () => {
  const foreign = await version(ORG2_ID);
  token = await openSession(USERS.admin);
  const response = await call(foreign.lease, foreign.pdf);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.equal((await downloads(foreign.pdf)).rows.length, 0);
});

test("staff signed-PDF route refuses a role outside admin and manager", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.accountant);
  const response = await call(own.lease, own.pdf);
  assert.equal(response.status, 404);
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("staff signed-PDF route serves a manager download", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.manager);
  const response = await call(own.lease, own.pdf);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), own.bytes);
});

test("staff signed-PDF route serves an admin download", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.admin);
  const response = await call(own.lease, own.pdf);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), own.bytes);
});

test("staff signed-PDF route writes one audit row whose reason is the code", async () => {
  const own = await version(ORG_ID);
  token = await openSession(USERS.admin);
  const response = await call(own.lease, own.pdf);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const rows = await downloads(own.pdf);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].reason, "signed_pdf_downloaded");
  assert.equal(rows.rows[0].actor_role, "admin");
  assert.deepEqual(rows.rows[0].new_row, { event: "signed_pdf_downloaded", lease_id: own.lease });
  assert.equal(JSON.stringify(rows.rows[0]).includes("signed.pdf"), false);
});
