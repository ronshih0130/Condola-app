import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { GET } from "@/app/t/lease/signed/[pdfId]/route";
import { SESSION_COOKIE } from "./auth";
import { buildStoredConsent } from "./consent";
import { query, withClient } from "./db";
import { ORG2_ID, ORG_ID } from "./ids";
import { sessionTokenHash } from "./session";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

let token: string | null = null;
let leaseCookie: string | null = null;
const previousTenantPdf = process.env.TENANT_SIGNED_PDF_ENABLED;
const sessions: string[] = [];
const leases: string[] = [];
const files: string[] = [];
const properties: string[] = [];
const contacts: string[] = [];
const users: string[] = [];
let originalFlags: unknown;
let originalSetting: string | null | undefined;

mock.method(nextHeaders, "cookies", async () => ({
  get(name: string) {
    if (name === SESSION_COOKIE && token) return { value: token };
    if (name === "condola_lease" && leaseCookie) return { value: leaseCookie };
    if (name === "condola_portal_role") return { value: "tenant" };
    return undefined;
  },
}));
mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/t/lease/signed" }));

function call(pdfId: string) {
  return GET(new Request(`http://127.0.0.1/t/lease/signed/${pdfId}`), {
    params: Promise.resolve({ pdfId }),
  });
}

function loginRedirect(error: unknown) {
  if (!error || typeof error !== "object" || !("digest" in error)) return false;
  const digest = String((error as { digest?: unknown }).digest);
  return digest.startsWith("NEXT_REDIRECT;") && digest.includes("/login");
}

async function person(withConsent: boolean) {
  const userId = randomUUID();
  await query(
    `INSERT INTO auth.users(id, email, role, aud) VALUES ($1, $2, 'authenticated', 'authenticated')`,
    [userId, `${userId}@example.test`],
  );
  users.push(userId);
  if (withConsent) {
    const consent = buildStoredConsent("reconsent");
    await query(
      `INSERT INTO public.consents(user_id, accepted_at, terms_version, privacy_version, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source],
    );
  }
  const contact = (await query<{ id: string }>(
    `INSERT INTO contacts(org_id, user_id, is_tenant, display_name)
     VALUES ($1, $2, true, 'Tenant route') RETURNING id::text`,
    [ORG_ID, userId],
  )).rows[0].id;
  contacts.push(contact);
  const raw = randomUUID();
  const sessionId = randomUUID();
  await query(
    `INSERT INTO auth_sessions(id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, clock_timestamp() + interval '1 hour')`,
    [sessionId, userId, sessionTokenHash(raw)],
  );
  sessions.push(sessionId);
  return { userId, contact, token: raw };
}

async function version(orgId: string, contactId: string | null) {
  const bytes = Buffer.from(`%PDF-1.4\n${orgId}\n%%EOF\n`);
  const property = (await query<{ id: string }>(
    `INSERT INTO properties(org_id, name, country_code, currency, timezone, default_rental_mode)
     VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei', 'whole_unit') RETURNING id::text`,
    [orgId, `Tenant route ${randomUUID()}`],
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
  if (contactId) {
    await query(
      `INSERT INTO lease_parties(org_id, lease_id, contact_id) VALUES ($1, $2, $3)`,
      [orgId, lease, contactId],
    );
  }
  const path = `${orgId}/${lease}/${randomUUID()}.pdf`;
  const file = (await query<{ id: string }>(
    `INSERT INTO files(org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes)
     VALUES ($1, 'lease-documents-private', $2, 'signed.pdf', 'application/pdf', $3) RETURNING id::text`,
    [orgId, path, bytes.length],
  )).rows[0].id;
  files.push(file);
  const pdf = (await query<{ id: string }>(
    `INSERT INTO lease_signed_pdfs(org_id, lease_id, file_id, object_path, content)
     VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
    [orgId, lease, file, path, bytes],
  )).rows[0].id;
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
  process.env.TENANT_SIGNED_PDF_ENABLED = "true";
  const flags = await query<{ feature_flags: unknown }>(
    `SELECT feature_flags FROM organizations WHERE id = $1`,
    [ORG_ID],
  );
  originalFlags = flags.rows[0]?.feature_flags ?? null;
  await query(
    `UPDATE organizations
        SET feature_flags = coalesce(feature_flags, '{}'::jsonb) || '{"tenant_signed_pdf":true}'::jsonb
      WHERE id = $1`,
    [ORG_ID],
  );
  const setting = await query<{ value: string }>(
    `SELECT value::text AS value FROM platform_settings WHERE key = 'tenant_signed_pdf'`,
  );
  originalSetting = setting.rows[0]?.value ?? null;
  await query(
    `INSERT INTO platform_settings(key, value)
     VALUES ('tenant_signed_pdf', 'true'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
});

test.after(async () => {
  mock.restoreAll();
  if (previousTenantPdf === undefined) delete process.env.TENANT_SIGNED_PDF_ENABLED;
  else process.env.TENANT_SIGNED_PDF_ENABLED = previousTenantPdf;
  if (leases.length) await query(`DELETE FROM leases WHERE id = ANY($1::uuid[])`, [leases]);
  if (files.length) await query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [files]);
  if (properties.length) await query(`DELETE FROM units WHERE property_id = ANY($1::uuid[])`, [properties]);
  if (properties.length) await query(`DELETE FROM properties WHERE id = ANY($1::uuid[])`, [properties]);
  if (contacts.length) await query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [contacts]);
  if (sessions.length) await query(`DELETE FROM auth_sessions WHERE id = ANY($1::uuid[])`, [sessions]);
  if (users.length) {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(`DELETE FROM public.consents WHERE user_id = ANY($1::uuid[])`, [users]);
        await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }
  if (originalFlags !== undefined) {
    await query(`UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1`, [
      ORG_ID, originalFlags === null ? null : JSON.stringify(originalFlags),
    ]);
  }
  if (originalSetting === null) {
    await query(`DELETE FROM platform_settings WHERE key = 'tenant_signed_pdf'`);
  } else if (originalSetting !== undefined) {
    await query(
      `UPDATE platform_settings SET value = $1::jsonb WHERE key = 'tenant_signed_pdf'`,
      [originalSetting],
    );
  }
});

test("tenant signed-PDF route redirects a logged-out request", async () => {
  const holder = await person(true);
  const own = await version(ORG_ID, holder.contact);
  token = null;
  leaseCookie = own.lease;
  await assert.rejects(() => call(own.pdf), loginRedirect);
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("tenant signed-PDF route refuses a session without current consent", async () => {
  const holder = await person(false);
  const own = await version(ORG_ID, holder.contact);
  token = holder.token;
  leaseCookie = own.lease;
  const response = await call(own.pdf);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("content-type")?.includes("application/pdf"), false);
  assert.deepEqual(await response.json(), { ok: false, error: "errors.consentRequired" });
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("tenant signed-PDF route hides another organization's version", async () => {
  const holder = await person(true);
  const own = await version(ORG_ID, holder.contact);
  const foreign = await version(ORG2_ID, null);
  token = holder.token;
  leaseCookie = own.lease;
  const response = await call(foreign.pdf);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.equal((await downloads(foreign.pdf)).rows.length, 0);
  assert.equal((await downloads(own.pdf)).rows.length, 0);
});

test("tenant signed-PDF route serves the selected own lease", async () => {
  const holder = await person(true);
  const own = await version(ORG_ID, holder.contact);
  token = holder.token;
  leaseCookie = own.lease;
  const response = await call(own.pdf);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), own.bytes);
});

test("tenant signed-PDF route writes one audit row whose reason is the code", async () => {
  const holder = await person(true);
  const own = await version(ORG_ID, holder.contact);
  token = holder.token;
  leaseCookie = own.lease;
  const response = await call(own.pdf);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const rows = await downloads(own.pdf);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].reason, "signed_pdf_downloaded");
  assert.equal(rows.rows[0].actor_role, "tenant");
  assert.deepEqual(rows.rows[0].new_row, { event: "signed_pdf_downloaded", lease_id: own.lease });
  assert.equal(JSON.stringify(rows.rows[0]).includes("signed.pdf"), false);
});
