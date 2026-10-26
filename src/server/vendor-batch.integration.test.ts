import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import test from "node:test";
import { svc, tx } from "./db";
import { createTicket } from "./domain";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import type { Session } from "./types";
import {
  createVendorOnboardingInvite,
  openVendorOnboarding,
  revokeVendorOnboarding,
  submitVendorOnboarding,
} from "./vendor-onboarding";
import {
  createVendorDocumentInvite,
  issueVendorDocument,
  previewVendorDocument,
  readVendorDocumentPdf,
  reissueVendorDocument,
  revokeVendorDocumentInvite,
  voidVendorDocument,
  type VendorDocumentContext,
} from "./vendor-receipt";
import { sha256 } from "./vendor-receipt-pdf";

const font = readFileSync(
  new URL("../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url),
);

function staff(userId: string, orgId: string): Session {
  return {
    userId,
    sessionId: "vendor-batch-test",
    email: "vendor-batch@example.invalid",
    name: "Test",
    kind: "staff",
    role: "admin",
    orgId,
    liveOrgId: orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

function tenant(): Session {
  return {
    ...staff(USERS.tenant2, ORG_ID),
    kind: "tenant",
    role: null,
    email: "tenant@demo",
    name: "租客",
  };
}

function tokenOf(url: string) {
  return url.slice(url.lastIndexOf("/") + 1);
}

test(
  "vendor onboarding and transactional document lifecycle",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const admin = staff(USERS.admin, ORG_ID);
    const outsider = staff(USERS.coastAdmin, ORG2_ID);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
    });
    const contactId = randomUUID();
    const ownerId = randomUUID();
    const ticketIds: string[] = [];
    let profileId = "";
    let propertyId = "";
    const prefix = `vendor-batch-${randomUUID()}`;

    t.after(async () => {
      try {
        const cleanup = await pool.connect();
        try {
          await cleanup.query("BEGIN");
          await cleanup.query(
            `ALTER TABLE vendor_document_pdf_bytes
               DISABLE TRIGGER vendor_document_pdf_bytes_immutable`,
          );
          await cleanup.query(
            `ALTER TABLE vendor_profile_versions
               DISABLE TRIGGER vendor_profile_versions_immutable`,
          );
          await cleanup.query(
            `DELETE FROM vendor_document_pdf_bytes
              WHERE document_id IN (
                SELECT id FROM vendor_documents WHERE ticket_id = ANY($1::uuid[])
              )`,
            [ticketIds],
          );
          await cleanup.query(
            `UPDATE vendor_documents SET reissued_from = NULL
              WHERE ticket_id = ANY($1::uuid[])`,
            [ticketIds],
          );
          await cleanup.query(
            `DELETE FROM vendor_documents WHERE ticket_id = ANY($1::uuid[])`,
            [ticketIds],
          );
          await cleanup.query(
            `DELETE FROM vendor_document_grants WHERE ticket_id = ANY($1::uuid[])`,
            [ticketIds],
          );
          await cleanup.query(
            `DELETE FROM vendor_onboarding_invites WHERE contact_id = $1`,
            [contactId],
          );
          await cleanup.query(
            `DELETE FROM vendor_profile_versions WHERE vendor_profile_id = $1`,
            [profileId || "00000000-0000-0000-0000-000000000000"],
          );
          await cleanup.query(
            `DELETE FROM vendor_document_sequences WHERE vendor_profile_id = $1`,
            [profileId || "00000000-0000-0000-0000-000000000000"],
          );
          await cleanup.query(
            `DELETE FROM vendor_profiles WHERE contact_id = $1`,
            [contactId],
          );
          await cleanup.query(
            `DELETE FROM repair_vendor_jobs WHERE ticket_id = ANY($1::uuid[])`,
            [ticketIds],
          );
          await cleanup.query(
            `DELETE FROM maintenance_tickets WHERE id = ANY($1::uuid[])`,
            [ticketIds],
          );
          await cleanup.query(
            `DELETE FROM property_owners WHERE owner_contact_id = $1`,
            [ownerId],
          );
          await cleanup.query(
            `DELETE FROM contacts WHERE id = ANY($1::uuid[])`,
            [[contactId, ownerId]],
          );
          await cleanup.query(
            `ALTER TABLE vendor_document_pdf_bytes
               ENABLE TRIGGER vendor_document_pdf_bytes_immutable`,
          );
          await cleanup.query(
            `ALTER TABLE vendor_profile_versions
               ENABLE TRIGGER vendor_profile_versions_immutable`,
          );
          await cleanup.query("COMMIT");
        } catch (error) {
          await cleanup.query("ROLLBACK");
          throw error;
        } finally {
          cleanup.release();
        }
      } finally {
        await pool.end();
      }
    });

    // Use the same seeded tenant/lease and createTicket path as vendor-repair.
    const lease = await tx(USERS.admin, (client) =>
      client.query<{ id: string; property_id: string }>(
        `SELECT l.id::text, l.property_id::text
           FROM leases l
           JOIN lease_parties lp ON lp.lease_id = l.id
           JOIN contacts c ON c.id = lp.contact_id
           JOIN properties p ON p.id = l.property_id AND p.org_id = l.org_id
          WHERE c.user_id = $1 AND l.org_id = $2 AND l.status = 'active'
            AND p.archived_at IS NULL
            AND COALESCE(p.address_display, '') <> ''
          ORDER BY l.created_at LIMIT 1`,
        [USERS.tenant2, ORG_ID],
      ),
    );
    assert.ok(lease.rows[0], "run the standard local seed first");
    propertyId = lease.rows[0].property_id;

    for (let index = 0; index < 3; index++) {
      const ticketId = await createTicket(tenant(), {
        leaseId: lease.rows[0].id,
        category: "other",
        title: `${prefix}-${index}`,
        description: "Test",
      });
      ticketIds.push(ticketId);
    }

    await svc(null, async (client) => {
      await client.query(
        `INSERT INTO contacts
           (id,org_id,is_vendor,display_name,phone_e164)
         VALUES ($1,$2,true,$3,'+886912000111')`,
        [contactId, ORG_ID, prefix],
      );
      await client.query(
        `INSERT INTO contacts
           (id,org_id,is_owner,display_name,phone_e164,receipt_title)
         VALUES ($1,$2,true,'PRIVATE OWNER NAME','+886922000222',NULL)`,
        [ownerId, ORG_ID],
      );
      await client.query(
        `INSERT INTO property_owners
           (org_id,property_id,owner_contact_id,is_primary)
         VALUES ($1,$2,$3,false)`,
        [ORG_ID, propertyId, ownerId],
      );
      for (const ticketId of ticketIds) {
        await client.query(
          `UPDATE maintenance_tickets
              SET status = 'closed',
                  assigned_vendor_contact_id = $3,
                  final_cost_minor = 120000
            WHERE id = $1 AND org_id = $2`,
          [ticketId, ORG_ID, contactId],
        );
        await client.query(
          `INSERT INTO repair_vendor_jobs
             (org_id,ticket_id,vendor_name,vendor_phone,contact_window,
              token_hash,expires_at,created_by)
           VALUES ($1,$2,'Test','+886912000111','Test',
                   $3,clock_timestamp() + interval '1 day',$4)`,
          [
            ORG_ID,
            ticketId,
            randomUUID().replaceAll("-", "").padEnd(64, "0"),
            USERS.admin,
          ],
        );
      }
    });

    await assert.rejects(
      createVendorOnboardingInvite(outsider, contactId),
    );

    const invite = await createVendorOnboardingInvite(admin, contactId);
    const token = tokenOf(invite.url);
    const opened = await openVendorOnboarding(token);
    assert.equal(opened.inviteId, invite.inviteId);
    const submitted = await submitVendorOnboarding(token, {
      kind: "individual",
      display_name: "測試師傅",
      phone: "0912-000-111",
      service_job_types: ["cleaning"],
    });
    profileId = submitted.profileId;
    assert.equal(submitted.version, 1);
    await assert.rejects(openVendorOnboarding(token));
    await assert.rejects(
      submitVendorOnboarding(token, {
        kind: "individual",
        display_name: "測試師傅",
        phone: "0912000111",
      }),
    );

    await svc(null, async (client) => {
      const rows = await client.query<{ version: number }>(
        `SELECT version FROM vendor_profile_versions
          WHERE vendor_profile_id = $1`,
        [profileId],
      );
      assert.deepEqual(rows.rows.map((row) => row.version), [1]);
      const stored = await client.query<{ token_hash: string; scope: string }>(
        `SELECT token_hash,scope FROM vendor_onboarding_invites WHERE id = $1`,
        [invite.inviteId],
      );
      assert.match(stored.rows[0].token_hash, /^[0-9a-f]{64}$/);
      assert.notEqual(stored.rows[0].token_hash, token);
      assert.equal(stored.rows[0].scope, "vendor_onboarding");
    });

    const expired = await createVendorOnboardingInvite(admin, contactId);
    await svc(null, (client) =>
      client.query(
        `UPDATE vendor_onboarding_invites
            SET expires_at = clock_timestamp() - interval '1 second'
          WHERE id = $1`,
        [expired.inviteId],
      ),
    );
    await assert.rejects(openVendorOnboarding(tokenOf(expired.url)));
    await assert.rejects(
      submitVendorOnboarding(tokenOf(expired.url), {
        kind: "individual",
        display_name: "Test",
        phone: "0912000111",
      }),
    );

    const revoked = await createVendorOnboardingInvite(admin, contactId);
    await assert.rejects(
      revokeVendorOnboarding(outsider, revoked.inviteId),
    );
    await revokeVendorOnboarding(admin, revoked.inviteId);
    await assert.rejects(openVendorOnboarding(tokenOf(revoked.url)));
    await assert.rejects(
      submitVendorOnboarding(tokenOf(revoked.url), {
        kind: "individual",
        display_name: "Test",
        phone: "0912000111",
      }),
    );

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const context = (ticketId: string): VendorDocumentContext => ({
      actor: admin,
      ticketId,
      vendorProfileId: profileId,
      buyer: { kind: "owner", contactId: ownerId },
      items: [
        {
          name: "清潔",
          quantity: 2,
          unit: "次",
          unit_price_minor: 600,
          amount_minor: 1200,
          category: "service",
        },
      ],
      totalMinor: 1200,
      documentDate: today,
      fontBytes: font,
    });

    await assert.rejects(previewVendorDocument(context(ticketIds[0])));
    await assert.rejects(
      issueVendorDocument(context(ticketIds[0]), {
        idempotencyKey: `${prefix}:missing-title`,
      }),
    );
    await svc(null, (client) =>
      client.query(
        `UPDATE contacts SET receipt_title = '測試收據抬頭' WHERE id = $1`,
        [ownerId],
      ),
    );

    const operation = await createVendorDocumentInvite(
      admin,
      ticketIds[0],
      profileId,
      { kind: "owner", contactId: ownerId },
    );
    const vendorContext = {
      ...context(ticketIds[0]),
      actor: tokenOf(operation.url),
      buyer: undefined,
    };
    await assert.rejects(
      previewVendorDocument({ ...vendorContext, actor: token }),
    );
    await assert.rejects(
      previewVendorDocument({ ...vendorContext, ticketId: ticketIds[1] }),
    );
    await assert.rejects(
      previewVendorDocument({ ...context(ticketIds[0]), actor: outsider }),
    );

    const draft = await previewVendorDocument(vendorContext);
    assert.equal(draft.document.kind, "completion_statement");
    assert.equal(draft.document.seq, 0);
    assert.equal(draft.document.doc_no, "");
    assert.equal(draft.document.apply_receipt_seal, false);
    assert.deepEqual(draft.document.buyer, {
      kind: "owner",
      receipt_title: "測試收據抬頭",
    });
    assert.doesNotMatch(JSON.stringify(draft.document), /PRIVATE OWNER NAME/);

    await svc(null, async (client) => {
      const rows = await client.query(
        `SELECT next_seq FROM vendor_document_sequences WHERE vendor_profile_id = $1`,
        [profileId],
      );
      assert.equal(rows.rowCount, 0, "preview must not allocate a sequence");
    });

    const first = await issueVendorDocument(vendorContext, {
      idempotencyKey: `${prefix}:first`,
    });
    const retry = await issueVendorDocument(vendorContext, {
      idempotencyKey: `${prefix}:first`,
    });
    assert.equal(first.document.id, retry.document.id);
    assert.equal(first.document.doc_no, retry.document.doc_no);
    assert.equal(first.document.seq, 1);
    assert.equal(first.sha256, retry.sha256);

    await assert.rejects(
      issueVendorDocument(context(ticketIds[1]), {
        idempotencyKey: `${prefix}:first`,
      }),
    );
    await assert.rejects(
      issueVendorDocument(vendorContext, {
        idempotencyKey: `${prefix}:duplicate`,
      }),
    );
    await assert.rejects(
      readVendorDocumentPdf(outsider, first.document.id),
    );
    await assert.rejects(
      voidVendorDocument(outsider, first.document.id, "Test"),
    );

    const stored = await readVendorDocumentPdf(
      tokenOf(operation.url),
      first.document.id,
    );
    assert.equal(await sha256(stored.bytes), first.sha256);

    const holder = await pool.connect();
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof issueVendorDocument>>>[]> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT id FROM vendor_profiles WHERE id = $1 FOR UPDATE`,
        [profileId],
      );
      pending = Promise.allSettled([
        issueVendorDocument(context(ticketIds[1]), {
          idempotencyKey: `${prefix}:parallel-1`,
        }),
        issueVendorDocument(context(ticketIds[2]), {
          idempotencyKey: `${prefix}:parallel-2`,
        }),
      ]);
      const deadline = Date.now() + 10000;
      for (;;) {
        const waiting = await holder.query<{ count: string }>(
          `SELECT count(DISTINCT pid)::text AS count
             FROM pg_locks
            WHERE NOT granted
              AND pid <> pg_backend_pid()
              AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`,
        );
        if (Number(waiting.rows[0].count) >= 2) break;
        assert.ok(Date.now() < deadline, "both issue connections must block");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query("COMMIT");
      const results = await pending;
      const documents = results.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      assert.deepEqual(
        documents.map((result) => result.document.seq).sort((a, b) => a - b),
        [2, 3],
      );
      assert.equal(new Set(documents.map((result) => result.document.doc_no)).size, 2);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (pending) await pending;
    }

    await assert.rejects(
      voidVendorDocument(tokenOf(operation.url), first.document.id, " "),
    );
    const voided = await voidVendorDocument(
      tokenOf(operation.url),
      first.document.id,
      "測試更正",
    );
    assert.equal(voided.document.status, "voided");
    await assert.rejects(
      voidVendorDocument(tokenOf(operation.url), first.document.id, "Again"),
    );
    const replacement = await reissueVendorDocument(
      vendorContext,
      first.document.id,
      { idempotencyKey: `${prefix}:replacement` },
    );
    assert.equal(replacement.document.seq, 4);
    assert.equal(replacement.document.reissued_from, first.document.id);
    assert.notEqual(replacement.document.doc_no, first.document.doc_no);
    const replacementRetry = await reissueVendorDocument(
      vendorContext,
      first.document.id,
      { idempotencyKey: `${prefix}:replacement` },
    );
    assert.equal(replacementRetry.document.id, replacement.document.id);
    const original = await readVendorDocumentPdf(
      tokenOf(operation.url),
      first.document.id,
    );
    assert.equal(original.document.status, "voided");
    assert.equal(original.sha256, first.sha256);
    assert.deepEqual(original.bytes, stored.bytes);

    await revokeVendorDocumentInvite(admin, operation.grantId);
    await assert.rejects(
      readVendorDocumentPdf(tokenOf(operation.url), replacement.document.id),
    );

    await svc(null, async (client) => {
      const rows = await client.query<{ seq: string }>(
        `SELECT seq::text FROM vendor_documents
          WHERE vendor_profile_id = $1 ORDER BY seq`,
        [profileId],
      );
      assert.deepEqual(rows.rows.map((row) => row.seq), ["1", "2", "3", "4"]);
      const forbidden = await client.query(
        `SELECT table_name,column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN (
              'vendor_profiles','vendor_profile_versions',
              'vendor_onboarding_invites','vendor_documents',
              'vendor_document_grants','vendor_document_pdf_bytes'
            )
            AND column_name ~* 'national|id_no|id_number|身分|身份'`,
      );
      assert.equal(forbidden.rowCount, 0);
    });

    const productionFiles = [
      "vendor-onboarding.ts",
      "vendor-receipt.ts",
      "vendor-receipt-pdf.ts",
    ];
    for (const name of productionFiles) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      assert.doesNotMatch(source, /\b(?:national_id|id_number|id_no)\s*[?:=]/i);
    }
  },
);
