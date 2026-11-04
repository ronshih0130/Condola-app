import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { query, withClient } from "./db";
import { uploadSignedLeasePdf } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import type { Session } from "./types";
import { insertTestAuthSession } from "./test-auth-session";

const bytes = Buffer.from("%PDF-1.4\narchived lease fixture\n%%EOF\n");
const previousPaper = process.env.PAPER_LEASE_VERSIONS_ENABLED;

function notFound(error: unknown) {
  return error instanceof FlowError && error.key === "errors.notFound";
}

function archivedInsert(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const row = value as { code?: string; message?: string; cause?: unknown };
    if (
      row.code === "42501"
      && typeof row.message === "string"
      && row.message.includes("archived lease cannot receive a signed PDF")
    ) return true;
    return walk(row.cause);
  };
  return walk(error);
}

async function staff(): Promise<Session> {
  const sessionId = await withClient((client) => insertTestAuthSession(client, USERS.admin));
  return {
    userId: USERS.admin,
    sessionId,
    email: "",
    name: "admin",
    kind: "staff",
    role: "admin",
    orgId: ORG_ID,
    liveOrgId: ORG_ID,
    environment: "live",
    locale: "en",
    calendar: "gregorian",
    leaseId: null,
  };
}

async function space(archived: "property" | "unit" | "room" | "none") {
  const property = (await query<{ id: string }>(
    `INSERT INTO properties(org_id, name, country_code, currency, timezone, archived_at)
     VALUES ($1, $2, 'TW', 'TWD', 'Asia/Taipei', CASE WHEN $3 THEN now() ELSE NULL END)
     RETURNING id::text`,
    [ORG_ID, `Archived PDF ${randomUUID()}`, archived === "property"],
  )).rows[0].id;
  const unit = (await query<{ id: string }>(
    `INSERT INTO units(org_id, property_id, label, rental_mode, archived_at)
     VALUES ($1, $2, 'Floor', 'by_room', CASE WHEN $3 THEN now() ELSE NULL END)
     RETURNING id::text`,
    [ORG_ID, property, archived === "unit"],
  )).rows[0].id;
  const room = (await query<{ id: string }>(
    `INSERT INTO rooms(org_id, unit_id, label, archived_at)
     VALUES ($1, $2, 'A', CASE WHEN $3 THEN now() ELSE NULL END)
     RETURNING id::text`,
    [ORG_ID, unit, archived === "room"],
  )).rows[0].id;
  const lease = (await query<{ id: string }>(
    `INSERT INTO leases(
       org_id, property_id, unit_id, target_room_id, status, esign_status,
       start_date, end_date, currency, rent_amount_minor
     ) VALUES ($1, $2, $3, $4, 'ended', 'imported', '2098-01-01', '2098-12-31', 'TWD', 0)
     RETURNING id::text`,
    [ORG_ID, property, unit, room],
  )).rows[0].id;
  return { property, unit, room, lease };
}

async function footprint(leaseId: string) {
  return (await query<{ pdfs: number; files: number; replaced: number; lease_audits: number }>(
    `SELECT
       (SELECT count(*)::int FROM lease_signed_pdfs d WHERE d.lease_id = $1) AS pdfs,
       (SELECT count(*)::int FROM files f WHERE f.org_id = $2 AND f.storage_path LIKE $3) AS files,
       (SELECT count(*)::int FROM audit_log a
         WHERE a.org_id = $2 AND a.event_type = 'paper_lease_replaced'
           AND a.new_row->>'lease_id' = $1::text) AS replaced,
       (SELECT count(*)::int FROM audit_log a
         WHERE a.org_id = $2 AND a.new_row->>'lease_id' = $1::text) AS lease_audits`,
    [leaseId, ORG_ID, `${ORG_ID}/${leaseId}/%`],
  )).rows[0];
}

test("an archived lease refuses the first signed PDF with no row and no audit", async () => {
  const session = await staff();
  const { lease } = await space("property");
  await assert.rejects(
    () => uploadSignedLeasePdf(session, lease, { bytes, fileName: "first.pdf" }),
    notFound,
  );
  const saved = await footprint(lease);
  assert.equal(saved.pdfs, 0);
  assert.equal(saved.files, 0);
  assert.equal(saved.replaced, 0);
  assert.equal(saved.lease_audits, 0);
});

test("replacing a signed PDF after the unit is archived leaves the first row and writes no audit", async () => {
  const session = await staff();
  const flags = await query<{ feature_flags: unknown }>(
    `SELECT feature_flags FROM organizations WHERE id = $1`,
    [ORG_ID],
  );
  const original = flags.rows[0].feature_flags;
  process.env.PAPER_LEASE_VERSIONS_ENABLED = "true";
  try {
    await query(
      `UPDATE organizations
          SET feature_flags = coalesce(feature_flags, '{}'::jsonb) || '{"paper_lease_versions":true}'::jsonb
        WHERE id = $1`,
      [ORG_ID],
    );
    const { unit, lease } = await space("none");
    await uploadSignedLeasePdf(session, lease, { bytes, fileName: "first.pdf" });
    const before = await footprint(lease);
    assert.equal(before.pdfs, 1);
    assert.equal(before.files, 1);
    assert.equal(before.replaced, 0);
    await query(`UPDATE units SET archived_at = clock_timestamp() WHERE id = $1`, [unit]);
    await assert.rejects(
      () => uploadSignedLeasePdf(session, lease, {
        bytes: Buffer.from("%PDF-1.4\narchived replacement\n%%EOF\n"),
        fileName: "second.pdf",
        replaceReason: "corrected_signature",
      }),
      notFound,
    );
    const after = await footprint(lease);
    assert.equal(after.pdfs, 1);
    assert.equal(after.files, 1);
    assert.equal(after.replaced, 0);
    assert.equal(after.lease_audits, before.lease_audits);
  } finally {
    await query(`UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1`, [
      ORG_ID,
      original == null ? null : JSON.stringify(original),
    ]);
    if (previousPaper === undefined) delete process.env.PAPER_LEASE_VERSIONS_ENABLED;
    else process.env.PAPER_LEASE_VERSIONS_ENABLED = previousPaper;
  }
});

test("a direct insert on a room-archived lease raises 42501 and keeps the prior version without an audit", async () => {
  const { room, lease } = await space("none");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = `${ORG_ID}/${lease}/${randomUUID()}.pdf`;
  const file = (await query<{ id: string }>(
    `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, sha256, uploaded_by)
     VALUES ($1, 'lease-documents-private', $2, 'first.pdf', 'application/pdf', $3, $4, $5)
     RETURNING id::text`,
    [ORG_ID, path, bytes.length, hash, USERS.admin],
  )).rows[0].id;
  await query(
    `INSERT INTO lease_signed_pdfs (org_id, lease_id, file_id, bucket, object_path, content)
     VALUES ($1, $2, $3, 'lease-documents-private', $4, $5)`,
    [ORG_ID, lease, file, path, bytes],
  );
  await query(`UPDATE rooms SET archived_at = clock_timestamp() WHERE id = $1`, [room]);
  const before = await footprint(lease);
  assert.equal(before.pdfs, 1);
  assert.equal(before.replaced, 0);

  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const replacement = `${ORG_ID}/${lease}/${randomUUID()}.pdf`;
      const next = await client.query<{ id: string }>(
        `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, 'lease-documents-private', $2, 'second.pdf', 'application/pdf', $3, $4, $5)
         RETURNING id::text`,
        [ORG_ID, replacement, bytes.length, hash, USERS.admin],
      );
      const current = (await client.query<{ id: string }>(
        `SELECT id::text FROM lease_signed_pdfs WHERE lease_id = $1`,
        [lease],
      )).rows[0].id;
      await assert.rejects(
        () => client.query(
          `INSERT INTO lease_signed_pdfs
             (org_id, lease_id, file_id, bucket, object_path, content, uploaded_by, replace_reason, supersedes_id)
           VALUES ($1, $2, $3, 'lease-documents-private', $4, $5, $6, 'corrected_signature', $7)`,
          [ORG_ID, lease, next.rows[0].id, replacement, bytes, USERS.admin, current],
        ),
        archivedInsert,
      );
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  const after = await footprint(lease);
  assert.equal(after.pdfs, 1);
  assert.equal(after.files, 1);
  assert.equal(after.replaced, 0);
  assert.equal(after.lease_audits, before.lease_audits);
});
