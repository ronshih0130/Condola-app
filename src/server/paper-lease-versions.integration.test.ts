import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { query, tx } from "./db";
import { createProperty, uploadSignedLeasePdf } from "./domain";
import { ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import {
  insertPaperLeaseVersion,
  paperLeaseVersionsEnabled,
  preparePaperLeaseVersion,
} from "./paper-lease-versions";
import { PaperLeaseReasonError } from "./paper-lease-versions-rules";
import type { Session } from "./types";

const admin: Session = {
  userId: USERS.admin,
  sessionId: "paper-lease-versions",
  email: "yating.lin@songxin.demo",
  name: "Admin",
  kind: "staff",
  role: "admin",
  orgId: ORG_ID,
  liveOrgId: ORG_ID,
  environment: "live",
  locale: "zh-TW",
  calendar: "gregorian",
  leaseId: null,
};

const bytes = Buffer.from("%PDF-1.4\npaper lease fixture\n%%EOF\n");

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

test("paper versions preserve legacy writes and serialize reasoned, audited replacements", async () => {
  const stamp = randomUUID();
  let propertyId: string | undefined;
  let tenantUserId: string | undefined;
  let leaseId: string | undefined;
  const flags = await query<{ feature_flags: unknown }>(
    `SELECT feature_flags FROM organizations WHERE id = $1`,
    [ORG_ID],
  );
  const originalFlags = flags.rows[0].feature_flags;
  const auditIds: string[] = [];
  try {
    await query(
      `UPDATE organizations
          SET feature_flags = coalesce(feature_flags, '{}'::jsonb)
                            || '{"paper_lease_versions":true}'::jsonb
        WHERE id = $1`,
      [ORG_ID],
    );
    const rooms = await createProperty(admin, {
      name: `Paper versions ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路9號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "Paper owner",
      ownerPhone: "",
      ownerEmail: `paper.owner.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "9F",
      floor: "9",
      rentalMode: "by_room",
      rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
    });
    propertyId = rooms.propertyId;
    const created = await createLeaseFromForm(admin, form({
      roomId: rooms.roomIds[0],
      tenantName: "Paper tenant",
      tenantPhone: "0912345678",
      tenantEmail: `paper.tenant.${stamp}@example.com`,
      lineUserId: "",
      startDate: "2026-11-01",
      months: "12",
      rent: "10000",
      depositMonths: "2",
      depositReason: "",
      dueDay: "5",
      splitMethod: "even",
      billTotal: "",
      usage: "",
      rate: "",
      overrideReason: "",
    }));
    leaseId = created.leaseId;
    tenantUserId = created.tenantUserId;
    // Imported paper leases do not need electronic identity documents.
    await query(`UPDATE leases SET esign_status = 'imported' WHERE id = $1`, [leaseId]);

    await tx(admin.userId, async (client) => {
      assert.equal(await paperLeaseVersionsEnabled(client, ORG_ID), false);
      assert.equal(await paperLeaseVersionsEnabled(client, ORG_ID, true), true);
    }, { orgId: ORG_ID });

    // Production's disabled branch executes the old INSERT without new columns.
    await uploadSignedLeasePdf(admin, leaseId, { bytes, fileName: "legacy-first.pdf" });
    await uploadSignedLeasePdf(admin, leaseId, { bytes, fileName: "legacy-second.pdf" });
    const legacy = await query<{
      id: string; uploaded_by: string | null; replace_reason: string | null; supersedes_id: string | null;
    }>(
      `SELECT id::text, uploaded_by::text, replace_reason, supersedes_id::text
         FROM lease_signed_pdfs WHERE lease_id = $1`,
      [leaseId],
    );
    assert.equal(legacy.rows.length, 2);
    assert.ok(legacy.rows.every((row) =>
      row.uploaded_by === null && row.replace_reason === null && row.supersedes_id === null));

    // Empty this isolated fixture to exercise the enabled first-upload path.
    await query(`DELETE FROM lease_signed_pdfs WHERE lease_id = $1`, [leaseId]);
    const uploadEnabled = async (reason?: string) => tx(admin.userId, async (client) => {
      const version = await preparePaperLeaseVersion(client, admin, leaseId!, reason, true);
      assert.equal(version.enabled, true);
      if (!version.enabled) throw new Error("Expected enabled fixture");
      const path = `${ORG_ID}/${leaseId}/${randomUUID()}.pdf`;
      const stored = await client.query<{ id: string }>(
        `INSERT INTO files
           (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, sha256, uploaded_by)
         VALUES ($1,'lease-documents-private',$2,'version.pdf','application/pdf',$3,$4,$5)
         RETURNING id::text`,
        [ORG_ID, path, bytes.length, createHash("sha256").update(bytes).digest("hex"), admin.userId],
      );
      const id = await insertPaperLeaseVersion(client, admin, {
        leaseId: leaseId!, fileId: stored.rows[0].id, path, content: bytes, version,
      });
      await client.query(`UPDATE leases SET document_file_id = $2 WHERE id = $1`, [
        leaseId, stored.rows[0].id,
      ]);
      return id;
    }, { orgId: ORG_ID });

    const firstId = await uploadEnabled();
    await assert.rejects(() => uploadEnabled(), PaperLeaseReasonError);
    await assert.rejects(() => uploadEnabled(" \n "), PaperLeaseReasonError);
    await assert.rejects(() => uploadEnabled("x".repeat(501)), PaperLeaseReasonError);
    const secondId = await uploadEnabled("  corrected signature \n");
    const versions = await query<{
      id: string; file_id: string; size_bytes: string; uploaded_by: string;
      replace_reason: string | null; supersedes_id: string | null; current: boolean; content: Buffer;
    }>(
      `SELECT p.id::text, f.id::text AS file_id, f.size_bytes::text,
              p.uploaded_by::text, p.replace_reason, p.supersedes_id::text,
              p.file_id = l.document_file_id AS current, p.content
         FROM lease_signed_pdfs p
         JOIN files f ON f.org_id = p.org_id AND f.id = p.file_id
         JOIN leases l ON l.org_id = p.org_id AND l.id = p.lease_id
        WHERE p.lease_id = $1`,
      [leaseId],
    );
    assert.equal(versions.rows.length, 2);
    const first = versions.rows.find((row) => row.id === firstId)!;
    const second = versions.rows.find((row) => row.id === secondId)!;
    assert.equal(first.replace_reason, null);
    assert.equal(first.supersedes_id, null);
    assert.equal(first.current, false);
    assert.equal(second.current, true);
    assert.equal(second.replace_reason, "corrected signature");
    assert.equal(second.supersedes_id, firstId);
    assert.equal(second.uploaded_by, admin.userId);
    assert.equal(second.size_bytes, String(bytes.length));
    assert.ok(second.file_id);
    assert.deepEqual(first.content, bytes);
    assert.deepEqual(second.content, bytes);
    const audit = await query<{ id: string; new_row: Record<string, unknown> }>(
      `SELECT id::text, new_row FROM audit_log
        WHERE org_id = $1 AND event_type = 'paper_lease_replaced'
          AND new_row->>'lease_id' = $2`,
      [ORG_ID, leaseId],
    );
    auditIds.push(...audit.rows.map((row) => row.id));
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].new_row.reason, "corrected signature");
    assert.equal(audit.rows[0].new_row.supersedes_id, firstId);
    assert.equal(audit.rows[0].new_row.lease_signed_pdf_id, secondId);
    assert.equal(audit.rows[0].new_row.file_id, second.file_id);
    assert.equal(audit.rows[0].new_row.size_bytes, bytes.length);

    await tx(admin.userId, async (client) => {
      const history = await client.query<{ id: string; content: Buffer }>(
        `SELECT id::text, content FROM lease_signed_pdfs WHERE org_id = $1 AND lease_id = $2`,
        [ORG_ID, leaseId],
      );
      assert.equal(history.rows.length, 2);
      assert.ok(history.rows.every((row) => row.content.equals(bytes)));
      const grants = await client.query<{ allowed: boolean }>(
        `SELECT has_table_privilege(current_user, 'lease_signed_pdfs', 'UPDATE') AS allowed`,
      );
      assert.equal(grants.rows[0].allowed, false);
    }, { orgId: ORG_ID });
  } finally {
    await query(`UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1`, [
      ORG_ID, JSON.stringify(originalFlags),
    ]);
    if (leaseId) {
      await query(
        `DELETE FROM audit_log
          WHERE org_id = $1 AND event_type = 'paper_lease_replaced' AND new_row->>'lease_id' = $2`,
        [ORG_ID, leaseId],
      );
      await query(`DELETE FROM lease_signed_pdfs WHERE lease_id = $1`, [leaseId]);
      await query(`DELETE FROM leases WHERE id = $1`, [leaseId]);
      await query(
        `DELETE FROM files WHERE org_id = $1 AND storage_path LIKE $2`,
        [ORG_ID, `${ORG_ID}/${leaseId}/%`],
      );
    }
    if (propertyId) await query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
    if (tenantUserId) {
      await query(`DELETE FROM contacts WHERE org_id = $1 AND user_id = $2`, [ORG_ID, tenantUserId]);
      await query(`DELETE FROM auth.users WHERE id = $1`, [tenantUserId]);
    }
  }
});
