import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { createProperty, uploadSignedLeasePdf } from "./domain";
import { FlowError } from "./errors";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import {
  insertPaperLeaseVersion,
  paperLeaseVersionsEnabled,
  preparePaperLeaseVersion,
  REASON_MAX,
} from "./paper-lease-versions";
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

function requiredReason(error: unknown) {
  return error instanceof FlowError && error.key === "errors.required";
}

function databaseError(code: string, constraint?: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    if (!error || typeof error !== "object") return false;
    const metadata = error as { code?: string; constraint?: string; cause?: unknown };
    if (metadata.code === code && (!constraint || metadata.constraint === constraint)) return true;
    return metadata.cause != null && databaseError(code, constraint)(metadata.cause);
  };
}

test("paper versions preserve flag-off uploads and isolate audited, concurrent replacements", async () => {
  const stamp = randomUUID();
  let propertyId: string | undefined;
  const tenantUserIds: string[] = [];
  const leaseIds: string[] = [];
  const flags = await query<{ feature_flags: unknown }>(
    `SELECT feature_flags FROM organizations WHERE id = $1`,
    [ORG_ID],
  );
  const originalFlags = flags.rows[0].feature_flags;

  const policies = await query<{ policyname: string }>(
    `SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'lease_signed_pdfs'
      ORDER BY policyname`,
  );
  assert.deepEqual(
    policies.rows.map((row) => row.policyname),
    ["team_delete", "team_insert", "team_read"],
  );

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
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10000 },
        { label: "B", roomType: "suite", baseRentMajor: 10000 },
      ],
    });
    propertyId = rooms.propertyId;

    for (const [index, roomId] of rooms.roomIds.entries()) {
      const created = await createLeaseFromForm(admin, form({
        roomId,
        tenantName: `Paper tenant ${index}`,
        tenantPhone: index === 0 ? "0912345678" : "0912345679",
        tenantEmail: `paper.tenant.${index}.${stamp}@example.com`,
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
      leaseIds.push(created.leaseId);
      tenantUserIds.push(created.tenantUserId);
      // Imported paper leases do not need electronic identity documents.
      await query(`UPDATE leases SET esign_status = 'imported' WHERE id = $1`, [created.leaseId]);
    }
    const [leaseId, otherLeaseId] = leaseIds;

    await tx(admin.userId, async (client) => {
      assert.equal(await paperLeaseVersionsEnabled(client, ORG_ID), false);
      assert.equal(await paperLeaseVersionsEnabled(client, ORG_ID, true), true);
    }, { orgId: ORG_ID });

    // Exercise the real upload entry point twice, without replacement reasons.
    await uploadSignedLeasePdf(admin, leaseId, { bytes, fileName: "legacy-first.pdf" });
    await uploadSignedLeasePdf(admin, leaseId, { bytes, fileName: "legacy-second.pdf" });
    await uploadSignedLeasePdf(admin, otherLeaseId, { bytes, fileName: "other-lease.pdf" });
    const legacy = await query<{
      id: string;
      file_id: string;
      file_name: string;
      uploaded_by: string | null;
      replace_reason: string | null;
      supersedes_id: string | null;
      content: Buffer;
      current: boolean;
    }>(
      `SELECT p.id::text, p.file_id::text, f.file_name,
              p.uploaded_by::text, p.replace_reason, p.supersedes_id::text,
              p.content, p.file_id = l.document_file_id AS current
         FROM lease_signed_pdfs p
         JOIN files f ON f.org_id = p.org_id AND f.id = p.file_id
         JOIN leases l ON l.org_id = p.org_id AND l.id = p.lease_id
        WHERE p.lease_id = $1`,
      [leaseId],
    );
    assert.equal(legacy.rows.length, 2);
    assert.ok(legacy.rows.every((row) =>
      row.uploaded_by === null && row.replace_reason === null && row.supersedes_id === null));
    assert.ok(legacy.rows.every((row) => row.content.equals(bytes)));
    assert.equal(legacy.rows.filter((row) => row.current).length, 1);
    assert.equal(legacy.rows.find((row) => row.current)?.file_name, "legacy-second.pdf");

    // With the global flag off, team_read still exposes both leases to org staff.
    const flagOffRows = await query<{ id: string }>(
      `SELECT id::text FROM lease_signed_pdfs
        WHERE org_id = $1 AND lease_id = ANY($2::uuid[])
        ORDER BY id`,
      [ORG_ID, leaseIds],
    );
    assert.equal(flagOffRows.rows.length, 3);
    await tx(admin.userId, async (client) => {
      const history = await client.query<{ id: string }>(
        `SELECT id::text FROM lease_signed_pdfs
          WHERE org_id = $1 AND lease_id = ANY($2::uuid[])
          ORDER BY id`,
        [ORG_ID, leaseIds],
      );
      assert.deepEqual(history.rows, flagOffRows.rows);
    }, { orgId: ORG_ID });

    // There is no tenant SELECT policy, including for the tenant's own lease.
    for (const tenantUserId of tenantUserIds) {
      await withClient(async (client) => {
        await client.query("BEGIN");
        try {
          await client.query("SET LOCAL ROLE authenticated");
          await client.query(
            `SELECT set_config('request.jwt.claim.sub', $1, true),
                    set_config('request.jwt.claims', $2, true)`,
            [tenantUserId, JSON.stringify({ sub: tenantUserId, role: "authenticated" })],
          );
          const history = await client.query(`SELECT id FROM lease_signed_pdfs`);
          assert.equal(history.rows.length, 0);
        } finally {
          await client.query("ROLLBACK");
        }
      });
    }

    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE authenticated");
        await client.query(
          `SELECT set_config('request.jwt.claim.sub', $1, true),
                  set_config('request.jwt.claims', $2, true)`,
          [
            tenantUserIds[0],
            JSON.stringify({ sub: tenantUserIds[0], role: "authenticated" }),
          ],
        );
        await assert.rejects(
          client.query(
            `INSERT INTO lease_signed_pdfs
               (org_id, lease_id, file_id, bucket, object_path, content)
             VALUES ($1,$2,$3,'lease-documents-private',$4,$5)`,
            [
              ORG_ID, leaseId, legacy.rows[0].file_id,
              `${ORG_ID}/${leaseId}/${randomUUID()}.pdf`, bytes,
            ],
          ),
          databaseError("42501"),
        );
      } finally {
        await client.query("ROLLBACK");
      }
    });

    // Reset the legacy fixture on one client, suppressing append-only guards
    // only within this cleanup transaction.
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(`DELETE FROM lease_signed_pdfs WHERE lease_id = $1`, [leaseId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });

    const uploadEnabled = async (reason?: string) => tx(admin.userId, async (client) => {
      const version = await preparePaperLeaseVersion(client, admin, leaseId, reason, true);
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
        leaseId, fileId: stored.rows[0].id, path, content: bytes, version,
      });
      await client.query(`UPDATE leases SET document_file_id = $2 WHERE id = $1`, [
        leaseId, stored.rows[0].id,
      ]);
      return id;
    }, { orgId: ORG_ID });

    const firstId = await uploadEnabled();
    for (const reason of [undefined, "", " \n ", "x".repeat(REASON_MAX + 1)]) {
      await assert.rejects(() => uploadEnabled(reason), requiredReason);
    }
    const secondId = await uploadEnabled("  corrected signature \n");

    const versions = await query<{
      id: string;
      file_id: string;
      size_bytes: string;
      uploaded_by: string;
      replace_reason: string | null;
      supersedes_id: string | null;
      current: boolean;
      content: Buffer;
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
    assert.deepEqual(first.content, bytes);
    assert.deepEqual(second.content, bytes);

    const audit = await query<{
      reason: string;
      new_row: Record<string, unknown>;
    }>(
      `SELECT reason, new_row FROM audit_log
        WHERE org_id = $1 AND event_type = 'paper_lease_replaced'
          AND table_name = 'lease_signed_pdfs'
          AND row_id = $3
          AND new_row->>'lease_id' = $2`,
      [ORG_ID, leaseId, secondId],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].reason, "corrected signature");
    assert.equal(audit.rows[0].new_row.supersedes_id, firstId);
    assert.equal(audit.rows[0].new_row.lease_signed_pdf_id, secondId);
    assert.equal(audit.rows[0].new_row.file_id, second.file_id);
    assert.equal(audit.rows[0].new_row.size_bytes, bytes.length);

    const directInsert = (
      targetLeaseId: string,
      reason: string | null,
      supersedesId: string | null,
    ) => tx(admin.userId, (client) => client.query(
      `INSERT INTO lease_signed_pdfs
         (org_id, lease_id, file_id, bucket, object_path, content, replace_reason, supersedes_id)
       VALUES ($1,$2,$3,'lease-documents-private',$4,$5,$6,$7)`,
      [
        ORG_ID, targetLeaseId, second.file_id,
        `${ORG_ID}/${targetLeaseId}/${randomUUID()}.pdf`,
        bytes, reason, supersedesId,
      ],
    ), { orgId: ORG_ID });

    for (const reason of ["", "   ", "x".repeat(REASON_MAX + 1)]) {
      await assert.rejects(
        () => directInsert(leaseId, reason, secondId),
        databaseError("23514", "lease_signed_pdfs_replace_reason_length"),
      );
    }
    await assert.rejects(
      () => directInsert(leaseId, null, secondId),
      databaseError("23514", "lease_signed_pdfs_supersedes_reason"),
    );
    await assert.rejects(
      () => directInsert(otherLeaseId, "Different lease", secondId),
      databaseError("23503", "lease_signed_pdfs_supersedes_fk"),
    );

    await tx(tenantUserIds[0], async (client) => {
      const history = await client.query(
        `SELECT id FROM lease_signed_pdfs WHERE lease_id = ANY($1::uuid[])`,
        [leaseIds],
      );
      assert.equal(history.rows.length, 0);
    }, { orgId: ORG_ID });

    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE anon");
        await client.query(
          `SELECT set_config('request.jwt.claim.sub', '', true),
                  set_config('request.jwt.claims', '{"role":"anon"}', true)`,
        );
        // anon has no table grant at all: denied by privilege, stronger than 0 rows via RLS.
        await assert.rejects(
          client.query(`SELECT id FROM lease_signed_pdfs WHERE lease_id = $1`, [leaseId]),
          (error: unknown) => (error as { code?: string }).code === "42501",
        );
      } finally {
        await client.query("ROLLBACK");
      }
    });

    // Find a seeded identity that actually has staff access in the other org.
    // This avoids depending on a particular name for that identity in USERS.
    let otherStaffUserId: string | undefined;
    for (const userId of new Set(Object.values(USERS))) {
      if (userId === admin.userId || tenantUserIds.includes(userId)) continue;
      const hasStaffAccess = await tx(userId, async (client) => {
        const visible = await client.query(
          `SELECT id FROM organizations WHERE id = $1`,
          [ORG2_ID],
        );
        if (visible.rows.length === 0) return false;
        const ownPdfs = await client.query(
          `SELECT id FROM lease_signed_pdfs WHERE org_id = $1 LIMIT 1`,
          [ORG2_ID],
        );
        const policies = await client.query<{ allowed: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND tablename = 'lease_signed_pdfs'
                AND cmd IN ('SELECT', 'ALL')
                AND qual IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM organizations WHERE id = $1
                )
           ) AS allowed`,
          [ORG2_ID],
        );
        return ownPdfs.rows.length > 0 || policies.rows[0].allowed;
      }, { orgId: ORG2_ID });
      if (hasStaffAccess) {
        otherStaffUserId = userId;
        break;
      }
    }
    assert.ok(otherStaffUserId, "Expected a seeded staff identity in ORG2_ID");

    await tx(otherStaffUserId, async (client) => {
      const history = await client.query(
        `SELECT id FROM lease_signed_pdfs WHERE org_id = $1 AND lease_id = $2`,
        [ORG_ID, leaseId],
      );
      assert.equal(history.rows.length, 0);
    }, { orgId: ORG2_ID });
    await assert.rejects(
      () => tx(otherStaffUserId!, (client) => client.query(
        `INSERT INTO lease_signed_pdfs
           (org_id, lease_id, file_id, bucket, object_path, content)
         VALUES ($1,$2,$3,'lease-documents-private',$4,$5)`,
        [
          ORG_ID, leaseId, second.file_id,
          `${ORG_ID}/${leaseId}/${randomUUID()}.pdf`, bytes,
        ],
      ), { orgId: ORG2_ID }),
      databaseError("42501"),
    );

    const concurrentIds = await Promise.all([
      uploadEnabled("Concurrent replacement A"),
      uploadEnabled("Concurrent replacement B"),
    ]);
    assert.notEqual(concurrentIds[0], concurrentIds[1]);
    const concurrent = await query<{
      id: string;
      supersedes_id: string;
      current: boolean;
    }>(
      `SELECT p.id::text, p.supersedes_id::text,
              p.file_id = l.document_file_id AS current
         FROM lease_signed_pdfs p
         JOIN leases l ON l.org_id = p.org_id AND l.id = p.lease_id
        WHERE p.id = ANY($1::uuid[])`,
      [concurrentIds],
    );
    assert.equal(concurrent.rows.length, 2);
    const earlier = concurrent.rows.find((row) => row.supersedes_id === secondId);
    assert.ok(earlier);
    const later = concurrent.rows.find((row) => row.supersedes_id === earlier.id);
    assert.ok(later);
    assert.equal(earlier.current, false);
    assert.equal(later.current, true);

    await tx(admin.userId, async (client) => {
      const history = await client.query<{ content: Buffer }>(
        `SELECT content FROM lease_signed_pdfs WHERE org_id = $1 AND lease_id = $2`,
        [ORG_ID, leaseId],
      );
      assert.equal(history.rows.length, 4);
      assert.ok(history.rows.every((row) => row.content.equals(bytes)));
      const grants = await client.query<{ allowed: boolean }>(
        `SELECT has_table_privilege(current_user, 'lease_signed_pdfs', 'UPDATE') AS allowed`,
      );
      assert.equal(grants.rows[0].allowed, false);
    }, { orgId: ORG_ID });
  } finally {
    // The harness requires postgres superuser privileges. Suppress append-only
    // guards transactionally on a dedicated client and delete children explicitly.
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1`,
          [ORG_ID, JSON.stringify(originalFlags)],
        );

        for (const leaseId of leaseIds) {
          await client.query(
            `DELETE FROM lease_signature_events
              WHERE signature_id IN (
                SELECT id FROM lease_signatures WHERE lease_id = $1
              )`,
            [leaseId],
          );
          await client.query(
            `DELETE FROM lease_signatures WHERE lease_id = $1`,
            [leaseId],
          );
          await client.query(
            `DELETE FROM audit_log
              WHERE org_id = $1
                AND new_row->>'lease_id' = $2`,
            [ORG_ID, leaseId],
          );
          await client.query(
            `DELETE FROM lease_signed_pdfs WHERE lease_id = $1`,
            [leaseId],
          );
          await client.query(
            `DELETE FROM invoice_lines
              WHERE invoice_id IN (
                SELECT id FROM invoices WHERE lease_id = $1
              )`,
            [leaseId],
          );
          await client.query(
            `DELETE FROM invoices WHERE lease_id = $1`,
            [leaseId],
          );
          await client.query(`DELETE FROM leases WHERE id = $1`, [leaseId]);
          await client.query(
            `DELETE FROM files WHERE org_id = $1 AND storage_path LIKE $2`,
            [ORG_ID, `${ORG_ID}/${leaseId}/%`],
          );
        }

        if (propertyId) {
          await client.query(
            `DELETE FROM rooms WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM properties WHERE id = $1`,
            [propertyId],
          );
        }

        for (const tenantUserId of tenantUserIds) {
          await client.query(
            `DELETE FROM contacts WHERE org_id = $1 AND user_id = $2`,
            [ORG_ID, tenantUserId],
          );
          await client.query(
            `DELETE FROM auth.users WHERE id = $1`,
            [tenantUserId],
          );
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }
});
