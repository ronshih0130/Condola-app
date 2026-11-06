import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client, Pool, type PoolClient } from "pg";
import { svc, tx } from "./db";
import { createTicket } from "./domain";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { getJobTypeByCode } from "./job-types-rules";
import type { Session } from "./types";
import {
  createVendorOnboardingInvite,
  openVendorOnboarding,
  revokeVendorOnboarding,
  submitVendorOnboarding,
} from "./vendor-onboarding";
import { validateTaiwanTaxId } from "./vendor-onboarding-rules";
import {
  createVendorDocumentInvite,
  issueVendorDocument,
  previewVendorDocument,
  readVendorDocumentPdf,
  reissueVendorDocument,
  requestVendorDocumentCorrection,
  revokeVendorDocumentInvite,
  voidVendorDocument,
  type VendorDocumentContext,
} from "./vendor-receipt";
import { sha256 } from "./vendor-receipt-pdf";
import { insertTestAuthSession } from "./test-auth-session";

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

async function waitForBlockedConnections(
  observer: PoolClient,
  expected: number,
) {
  const deadline = Date.now() + 10000;
  for (;;) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const waiting = await observer.query<{ count: string }>(
      `WITH RECURSIVE blocked(pid) AS (
         SELECT a.pid FROM pg_stat_activity a
          WHERE a.datname = current_database()
            AND a.pid <> pg_backend_pid()
            AND pg_backend_pid() = ANY(pg_blocking_pids(a.pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a
           JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
          WHERE a.datname = current_database()
            AND a.pid <> pg_backend_pid()
       )
       SELECT count(DISTINCT pid)::text AS count FROM blocked`,
    );
    if (Number(waiting.rows[0].count) >= expected) return;
    assert.ok(Date.now() < deadline, "operations must wait on separate connections");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
    const nextContactId = randomUUID();
    const vendorContactIds = [contactId, nextContactId];
    const ownerId = randomUUID();
    const ticketIds: string[] = [];
    let tenantSessionId = "";
    let profileId = "";
    const prefix = `vendor-batch-${randomUUID()}`;
    const jobTypeCode = prefix;
    const pricing = { mode: "per_visit", quantity: 2, unit: "次" };

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
          // Delete the whole fixture chain in one statement; reissue links are
          // immutable and the self-FK is satisfied when all siblings are removed.
          await cleanup.query(
            `DELETE FROM vendor_documents WHERE ticket_id = ANY($1::uuid[])`,
            [ticketIds],
          );
          await cleanup.query(
            `DELETE FROM vendor_document_grants WHERE ticket_id = ANY($1::uuid[])`,
            [ticketIds],
          );
          await cleanup.query(
            `DELETE FROM vendor_onboarding_invites
              WHERE contact_id = ANY($1::uuid[])`,
            [vendorContactIds],
          );
          await cleanup.query(
            `DELETE FROM vendor_profile_versions
              WHERE vendor_profile_id IN (
                SELECT id FROM vendor_profiles WHERE contact_id = ANY($1::uuid[])
              )`,
            [vendorContactIds],
          );
          await cleanup.query(
            `DELETE FROM vendor_document_sequences
              WHERE vendor_profile_id IN (
                SELECT id FROM vendor_profiles WHERE contact_id = ANY($1::uuid[])
              )`,
            [vendorContactIds],
          );
          await cleanup.query(
            `DELETE FROM vendor_profiles WHERE contact_id = ANY($1::uuid[])`,
            [vendorContactIds],
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
            `DELETE FROM job_types WHERE code = $1`,
            [jobTypeCode],
          );
          await cleanup.query(
            `DELETE FROM property_owners WHERE owner_contact_id = $1`,
            [ownerId],
          );
          await cleanup.query(
            `DELETE FROM contacts WHERE id = ANY($1::uuid[])`,
            [[...vendorContactIds, ownerId]],
          );
          await cleanup.query(
            `ALTER TABLE vendor_document_pdf_bytes
               ENABLE TRIGGER vendor_document_pdf_bytes_immutable`,
          );
          await cleanup.query(
            `ALTER TABLE vendor_profile_versions
               ENABLE TRIGGER vendor_profile_versions_immutable`,
          );
          if(tenantSessionId)await cleanup.query(`DELETE FROM auth_sessions WHERE id=$1`,[tenantSessionId]);
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

    const lease = await tx(USERS.admin, (client) =>
      client.query<{ id: string; property_id: string }>(
        `SELECT l.id::text, l.property_id::text
           FROM leases l
           JOIN lease_parties lp ON lp.lease_id = l.id
           JOIN contacts c ON c.id = lp.contact_id
           JOIN properties p ON p.id = l.property_id AND p.org_id = l.org_id
          WHERE c.user_id = $1 AND l.org_id = $2 AND l.status = 'active'
            AND p.archived_at IS NULL AND p.currency = 'TWD'
            AND COALESCE(p.address_display, '') <> ''
          ORDER BY l.created_at LIMIT 1`,
        [USERS.tenant2, ORG_ID],
      ),
    );
    assert.ok(lease.rows[0], "run the standard local seed first");
    const propertyId = lease.rows[0].property_id;
    const sessionClient=await pool.connect();try{tenantSessionId=await insertTestAuthSession(sessionClient,USERS.tenant2);}finally{sessionClient.release();}
    for (let index = 0; index < 3; index++) {
      ticketIds.push(await createTicket({...tenant(),sessionId:tenantSessionId}, {
        leaseId: lease.rows[0].id,
        category: "other",
        title: `${prefix}-${index}`,
        description: "Test",
      }));
    }

    await svc(null, async (client) => {
      // resetAndSeed() wipes job_types after migrations. Own this catalog row
      // rather than depending on migration replay or changing shared seed rows.
      const cleaning = getJobTypeByCode("cleaning");
      assert.ok(cleaning);
      await client.query(
        `INSERT INTO job_types
           (code,name_zh,name_en,required_fields,photo_rules,
            acceptance_checklist,pricing_modes,sort,active)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::text[],$8,true)`,
        [
          jobTypeCode,
          cleaning.name_zh,
          cleaning.name_en,
          JSON.stringify(cleaning.required_fields),
          JSON.stringify(cleaning.photo_rules),
          JSON.stringify(cleaning.acceptance_checklist),
          cleaning.pricing_modes,
          cleaning.sort,
        ],
      );
      await client.query(
        `INSERT INTO contacts (id,org_id,is_vendor,display_name,phone_e164)
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
              SET status = 'closed', assigned_vendor_contact_id = $3,
                  final_cost_minor = 120000, currency = 'TWD',
                  job_type_code = $4,
                  type_fields = $5::jsonb
            WHERE id = $1 AND org_id = $2`,
          [
            ticketId,
            ORG_ID,
            contactId,
            jobTypeCode,
            JSON.stringify({
              cleaning_scope: "室內",
              area_ping_or_rooms: "2 rooms",
            }),
          ],
        );
        await client.query(
          `INSERT INTO repair_vendor_jobs
             (org_id,ticket_id,vendor_name,vendor_phone,contact_window,
              token_hash,expires_at,created_by,vendor_contact_id)
           VALUES ($1,$2,'Test','+886912000111','Test',
                   $3,clock_timestamp() + interval '1 day',$4,$5)`,
          [
            ORG_ID, ticketId,
            randomUUID().replaceAll("-", "").padEnd(64, "0"),
            USERS.admin,
            contactId,
          ],
        );
      }
    });

    const onboardingInput = {
      kind: "individual",
      display_name: "測試師傅",
      phone: "0912-000-111",
      service_job_types: [jobTypeCode],
    };
    await assert.rejects(createVendorOnboardingInvite(outsider, contactId));
    const invite = await createVendorOnboardingInvite(admin, contactId);
    const token = tokenOf(invite.url);
    assert.equal((await openVendorOnboarding(token)).inviteId, invite.inviteId);
    const submitted = await submitVendorOnboarding(token, onboardingInput);
    profileId = submitted.profileId;
    assert.equal(submitted.version, 1);
    await assert.rejects(openVendorOnboarding(token));
    await assert.rejects(submitVendorOnboarding(token, onboardingInput));

    await svc(null, async (client) => {
      const rows = await client.query<{ version: number }>(
        `SELECT version FROM vendor_profile_versions WHERE vendor_profile_id = $1`,
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
    await svc(null, (client) => client.query(
      `UPDATE vendor_onboarding_invites
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [expired.inviteId],
    ));
    await assert.rejects(openVendorOnboarding(tokenOf(expired.url)));
    await assert.rejects(
      submitVendorOnboarding(tokenOf(expired.url), onboardingInput),
    );

    const revoked = await createVendorOnboardingInvite(admin, contactId);
    await assert.rejects(revokeVendorOnboarding(outsider, revoked.inviteId));
    await revokeVendorOnboarding(admin, revoked.inviteId);
    await assert.rejects(openVendorOnboarding(tokenOf(revoked.url)));
    await assert.rejects(
      submitVendorOnboarding(tokenOf(revoked.url), onboardingInput),
    );

    // Queue replacement first, then submission, on distinct service connections.
    // Both must wait for contact without submission retaining an invite lock.
    const raced = await createVendorOnboardingInvite(admin, contactId);
    const contactHolder = await pool.connect();
    let replacing:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof createVendorOnboardingInvite>>>[]>
      | undefined;
    let submitting:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof submitVendorOnboarding>>>[]>
      | undefined;
    try {
      await contactHolder.query("BEGIN");
      await contactHolder.query(
        `SELECT id FROM contacts WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [contactId, ORG_ID],
      );
      replacing = Promise.allSettled([
        createVendorOnboardingInvite(admin, contactId),
      ]);
      await waitForBlockedConnections(contactHolder, 1);
      submitting = Promise.allSettled([
        submitVendorOnboarding(tokenOf(raced.url), onboardingInput),
      ]);
      await waitForBlockedConnections(contactHolder, 2);
      await contactHolder.query("COMMIT");
      const [replacement] = await replacing;
      const [submission] = await submitting;
      if (replacement.status === "rejected") throw replacement.reason;
      assert.equal(submission.status, "rejected");
      await assert.rejects(openVendorOnboarding(tokenOf(raced.url)));
      const current = await submitVendorOnboarding(
        tokenOf(replacement.value.url),
        onboardingInput,
      );
      assert.equal(current.profileId, profileId);
      assert.equal(current.version, 2);
    } finally {
      try {
        await contactHolder.query("ROLLBACK");
      } finally {
        contactHolder.release(true);
        await Promise.allSettled([replacing, submitting]);
      }
    }

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
      items: [{
        name: "清潔",
        quantity: 2,
        unit: "次",
        unit_price_minor: 600,
        amount_minor: 1200,
        category: "service",
      }],
      totalMinor: 1200,
      documentDate: today,
      fontBytes: font,
    });

    await assert.rejects(previewVendorDocument(context(ticketIds[0])));
    // B-022: API roles can no longer write receipt_title directly (owner-entered only);
    // the fixture writes it as the table owner, like a maintenance operation.
    {
      const owner = new Client({ connectionString: process.env.DATABASE_URL });
      await owner.connect();
      try { await owner.query(`UPDATE contacts SET receipt_title = '測試收據抬頭' WHERE id = $1`, [ownerId]); }
      finally { await owner.end(); }
    }

    const operations = await Promise.all(ticketIds.map((ticketId) =>
      createVendorDocumentInvite(
        admin, ticketId, profileId, { kind: "owner", contactId: ownerId },
      ),
    ));
    const vendorContexts = ticketIds.map((ticketId, index) => ({
      ...context(ticketId),
      actor: tokenOf(operations[index].url),
      buyer: undefined,
    }));
    const vendorContext = vendorContexts[0];
    const operation = operations[0];

    // Caller-supplied pricing cannot substitute for missing persisted pricing.
    const invalidPricing = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "errors.generic");
      assert.equal((error.cause as { reason?: unknown } | undefined)?.reason, "invalid_ticket_pricing");
      return true;
    };
    await assert.rejects(previewVendorDocument(vendorContext), invalidPricing);
    await assert.rejects(issueVendorDocument(vendorContext, {
      idempotencyKey: `${prefix}:missing-pricing`,
    }), invalidPricing);
    await svc(null, async (client) => {
      const counters = await client.query(
        `SELECT next_seq FROM vendor_document_sequences WHERE vendor_profile_id = $1`,
        [profileId],
      );
      assert.equal(counters.rowCount, 0, "missing pricing must not consume a sequence");
      const documents = await client.query(
        `SELECT id FROM vendor_documents WHERE vendor_profile_id = $1`,
        [profileId],
      );
      assert.equal(documents.rowCount, 0, "missing pricing must not persist a document");
      await client.query(
        `UPDATE maintenance_tickets
            SET type_fields = type_fields || jsonb_build_object('pricing', $3::jsonb)
          WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [ORG_ID, ticketIds, JSON.stringify(pricing)],
      );
    });

    await assert.rejects(previewVendorDocument({ ...vendorContext, actor: token }));
    await assert.rejects(
      previewVendorDocument({ ...vendorContext, ticketId: ticketIds[1] }),
    );
    await assert.rejects(
      previewVendorDocument({ ...context(ticketIds[0]), actor: outsider }),
    );
    await assert.rejects(
      issueVendorDocument({ ...vendorContext, actor: token }, {
        idempotencyKey: `${prefix}:wrong-scope`,
      }),
    );
    await assert.rejects(
      issueVendorDocument({ ...vendorContext, ticketId: ticketIds[1] }, {
        idempotencyKey: `${prefix}:wrong-ticket`,
      }),
    );

    const draft = await previewVendorDocument({
      ...vendorContext,
      items: vendorContext.items.map((item) => ({
        ...item,
        quantity: 99,
        unit: "caller unit",
        unit_price_minor: 1,
      })),
    });
    assert.equal(draft.document.items[0].quantity, 2);
    assert.equal(draft.document.items[0].unit, "次");
    assert.equal(draft.document.items[0].unit_price_minor, 600);
    assert.equal(draft.document.items[0].amount_minor, 1200);
    const staffDraft = await previewVendorDocument(context(ticketIds[0]));
    assert.equal(staffDraft.document.kind, draft.document.kind);
    assert.equal(draft.document.kind, "completion_statement");
    assert.equal(draft.document.seq, 0);
    assert.equal(draft.document.doc_no, "");
    assert.equal(draft.document.apply_receipt_seal, false);
    assert.deepEqual(draft.document.buyer, {
      kind: "owner", receipt_title: "測試收據抬頭",
    });
    assert.doesNotMatch(JSON.stringify(draft.document), /PRIVATE OWNER NAME/);
    await svc(null, async (client) => {
      const rows = await client.query(
        `SELECT next_seq FROM vendor_document_sequences WHERE vendor_profile_id = $1`,
        [profileId],
      );
      assert.equal(rows.rowCount, 0, "preview must not allocate a sequence");
    });

    // Fail after allocation during PDF rendering, then retry the same operation.
    await assert.rejects(issueVendorDocument({
      ...vendorContext,
      fontBytes: new Uint8Array([0, 1, 2]),
    }, {
      idempotencyKey: `${prefix}:first`,
    }));
    await svc(null, async (client) => {
      const counters = await client.query(
        `SELECT next_seq FROM vendor_document_sequences WHERE vendor_profile_id = $1`,
        [profileId],
      );
      assert.equal(counters.rowCount, 0, "failed PDF must roll allocation back");
      const documents = await client.query(
        `SELECT id FROM vendor_documents WHERE org_id = $1 AND idempotency_key = $2`,
        [ORG_ID, `${prefix}:first`],
      );
      assert.equal(documents.rowCount, 0);
    });

    // A same-org administrator with update permission cannot execute.
    await assert.rejects(issueVendorDocument(context(ticketIds[0]), {
      idempotencyKey: `${prefix}:staff`,
    }));
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
    await assert.rejects(issueVendorDocument(context(ticketIds[0]), {
      idempotencyKey: `${prefix}:first`,
    }));
    await assert.rejects(issueVendorDocument(vendorContexts[1], {
      idempotencyKey: `${prefix}:first`,
    }));
    await assert.rejects(issueVendorDocument(vendorContext, {
      idempotencyKey: `${prefix}:duplicate`,
    }));
    await assert.rejects(readVendorDocumentPdf(outsider, first.document.id));
    await assert.rejects(voidVendorDocument(outsider, first.document.id, "Test"));
    await assert.rejects(voidVendorDocument(admin, first.document.id, "Test"));
    await assert.rejects(
      requestVendorDocumentCorrection(outsider, first.document.id, "Test"),
    );
    await assert.rejects(
      requestVendorDocumentCorrection(admin, first.document.id, " "),
    );
    const requested = await requestVendorDocumentCorrection(
      admin, first.document.id, "測試更正",
    );
    assert.equal(requested.status, "requested");
    const staffCopy = await readVendorDocumentPdf(admin, first.document.id);
    assert.equal(staffCopy.document.status, "issued");
    assert.equal(staffCopy.sha256, first.sha256);

    const stored = await readVendorDocumentPdf(
      tokenOf(operation.url), first.document.id,
    );
    assert.equal(await sha256(stored.bytes), first.sha256);

    const holder = await pool.connect();
    let pending:
      | Promise<PromiseSettledResult<Awaited<ReturnType<typeof issueVendorDocument>>>[]>
      | undefined;
    try {
      await holder.query("BEGIN");
      const locked = await holder.query(
        `SELECT id FROM maintenance_tickets
          WHERE org_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id FOR UPDATE`,
        [ORG_ID, [ticketIds[1], ticketIds[2]]],
      );
      assert.equal(locked.rowCount, 2);
      pending = Promise.allSettled([
        issueVendorDocument(vendorContexts[1], {
          idempotencyKey: `${prefix}:parallel-1`,
        }),
        issueVendorDocument(vendorContexts[2], {
          idempotencyKey: `${prefix}:parallel-2`,
        }),
      ]);
      await waitForBlockedConnections(holder, 2);
      await holder.query("COMMIT");
      const documents = (await pending).map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      assert.deepEqual(
        documents.map((result) => result.document.seq).sort((a, b) => a - b),
        [2, 3],
      );
      assert.equal(new Set(documents.map((result) => result.document.id)).size, 2);
      assert.equal(new Set(documents.map((result) => result.document.doc_no)).size, 2);
      assert.deepEqual(
        documents.map((result) => result.document.ticket_id).sort(),
        [ticketIds[1], ticketIds[2]].sort(),
      );
    } finally {
      try {
        await holder.query("ROLLBACK");
      } finally {
        holder.release(true);
        if (pending) await pending;
      }
    }

    // Exercise enhanced reassignment invalidation without changing the kill switch.
    // The document capability must survive the original collaboration job's revoke.
    await svc(null, async (client) => {
      await client.query(
        `INSERT INTO contacts (id,org_id,is_vendor,display_name,phone_e164)
         VALUES ($1,$2,true,'Next vendor','+886912000112')`,
        [nextContactId, ORG_ID],
      );
      await client.query(
        `SELECT set_config('app.vendor_link_reassignment','on',true)`,
      );
      await client.query(
        `UPDATE maintenance_tickets SET assigned_vendor_contact_id = $3
          WHERE id = $1 AND org_id = $2`,
        [ticketIds[0], ORG_ID, nextContactId],
      );
      const oldJobs = await client.query<{ active: boolean; revoked: boolean }>(
        `SELECT active,revoked_at IS NOT NULL AS revoked
           FROM repair_vendor_jobs
          WHERE ticket_id = $1 AND org_id = $2 AND vendor_contact_id = $3`,
        [ticketIds[0], ORG_ID, contactId],
      );
      assert.equal(oldJobs.rowCount, 1);
      assert.deepEqual(oldJobs.rows, [{ active: false, revoked: true }]);
      await client.query(
        `INSERT INTO repair_vendor_jobs
           (org_id,ticket_id,vendor_name,vendor_phone,contact_window,
            token_hash,expires_at,created_by,vendor_contact_id)
         VALUES ($1,$2,'Next vendor','+886912000112','Test',
                 $3,clock_timestamp() + interval '1 day',$4,$5)`,
        [
          ORG_ID, ticketIds[0],
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          USERS.admin, nextContactId,
        ],
      );
    });
    const nextOnboarding = await createVendorOnboardingInvite(admin, nextContactId);
    const nextProfile = await submitVendorOnboarding(tokenOf(nextOnboarding.url), {
      ...onboardingInput,
      display_name: "接手師傅",
      phone: "0912-000-112",
    });
    const nextOperation = await createVendorDocumentInvite(
      admin, ticketIds[0], nextProfile.profileId,
      { kind: "owner", contactId: ownerId },
    );
    const nextContext = {
      ...vendorContext,
      actor: tokenOf(nextOperation.url),
      vendorProfileId: nextProfile.profileId,
    };

    const historicalStaffCopy = await readVendorDocumentPdf(admin, first.document.id);
    assert.equal(historicalStaffCopy.document.status, "issued");
    assert.equal(historicalStaffCopy.sha256, first.sha256);
    assert.deepEqual(historicalStaffCopy.bytes, stored.bytes);
    const historicalVendorCopy = await readVendorDocumentPdf(
      tokenOf(operation.url), first.document.id,
    );
    assert.deepEqual(historicalVendorCopy.bytes, stored.bytes);
    assert.equal((await requestVendorDocumentCorrection(
      admin, first.document.id, "重新指派後更正",
    )).status, "requested");
    await assert.rejects(readVendorDocumentPdf(outsider, first.document.id));
    await assert.rejects(
      requestVendorDocumentCorrection(outsider, first.document.id, "Test"),
    );
    await assert.rejects(
      readVendorDocumentPdf(tokenOf(operations[1].url), first.document.id),
    );
    await assert.rejects(
      readVendorDocumentPdf(tokenOf(nextOperation.url), first.document.id),
    );
    await assert.rejects(
      voidVendorDocument(tokenOf(nextOperation.url), first.document.id, "Test"),
    );
    await assert.rejects(voidVendorDocument(admin, first.document.id, "Test"));
    await assert.rejects(previewVendorDocument(vendorContext));
    await assert.rejects(issueVendorDocument(vendorContext, {
      idempotencyKey: `${prefix}:old-vendor-new-issue`,
    }));
    await assert.rejects(
      createVendorDocumentInvite(
        admin, ticketIds[0], profileId, { kind: "owner", contactId: ownerId },
      ),
    );

    await assert.rejects(
      voidVendorDocument(tokenOf(operation.url), first.document.id, " "),
    );
    const voided = await voidVendorDocument(
      tokenOf(operation.url), first.document.id, "測試更正",
    );
    assert.equal(voided.document.status, "voided");
    await assert.rejects(
      voidVendorDocument(tokenOf(operation.url), first.document.id, "Again"),
    );
    // A valid voided source still belongs exclusively to its original issuer.
    await assert.rejects(
      reissueVendorDocument(nextContext, first.document.id, {
        idempotencyKey: `${prefix}:next-vendor-replacement`,
      }),
    );
    await assert.rejects(
      reissueVendorDocument({
        ...nextContext,
        vendorProfileId: profileId,
      }, first.document.id, {
        idempotencyKey: `${prefix}:spoofed-issuer`,
      }),
    );
    await assert.rejects(
      reissueVendorDocument({
        ...vendorContext,
        ticketId: ticketIds[1],
      }, first.document.id, {
        idempotencyKey: `${prefix}:wrong-reissue-ticket`,
      }),
    );
    await assert.rejects(
      reissueVendorDocument(context(ticketIds[0]), first.document.id, {
        idempotencyKey: `${prefix}:staff-replacement`,
      }),
    );
    const replacement = await reissueVendorDocument(
      vendorContext, first.document.id, {
        idempotencyKey: `${prefix}:replacement`,
      },
    );
    assert.equal(replacement.document.seq, 4);
    assert.equal(replacement.document.reissued_from, first.document.id);
    assert.notEqual(replacement.document.doc_no, first.document.doc_no);
    await assert.rejects(
      reissueVendorDocument(context(ticketIds[0]), first.document.id, {
        idempotencyKey: `${prefix}:replacement`,
      }),
    );
    const replacementRetry = await reissueVendorDocument(
      vendorContext, first.document.id, {
        idempotencyKey: `${prefix}:replacement`,
      },
    );
    assert.equal(replacementRetry.document.id, replacement.document.id);
    const original = await readVendorDocumentPdf(
      tokenOf(operation.url), first.document.id,
    );
    assert.equal(original.document.status, "voided");
    assert.equal(original.sha256, first.sha256);
    assert.deepEqual(original.bytes, stored.bytes);

    // The current assignee can issue independently while the old issuer's
    // replacement remains issued; neither vendor gains the other's authority.
    const nextDocument = await issueVendorDocument(nextContext, {
      idempotencyKey: `${prefix}:next-vendor-first`,
    });
    assert.equal(nextDocument.document.vendor_profile_id, nextProfile.profileId);
    assert.equal(nextDocument.document.ticket_id, ticketIds[0]);
    assert.equal(nextDocument.document.seq, 1);
    assert.equal(nextDocument.document.reissued_from, null);
    assert.notEqual(nextDocument.document.doc_no, replacement.document.doc_no);
    assert.equal(
      (await readVendorDocumentPdf(admin, replacement.document.id)).document.status,
      "issued",
    );
    await assert.rejects(
      readVendorDocumentPdf(outsider, nextDocument.document.id),
    );
    await assert.rejects(
      readVendorDocumentPdf(tokenOf(operation.url), nextDocument.document.id),
    );
    await assert.rejects(
      voidVendorDocument(tokenOf(operation.url), nextDocument.document.id, "Test"),
    );
    await assert.rejects(
      voidVendorDocument(tokenOf(nextOperation.url), replacement.document.id, "Test"),
    );

    // Expiry and explicit revocation remain effective for historical authority.
    await svc(null, (client) => client.query(
      `UPDATE vendor_document_grants
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE id = $1`,
      [operation.grantId],
    ));
    await assert.rejects(
      readVendorDocumentPdf(tokenOf(operation.url), replacement.document.id),
    );
    await assert.rejects(
      voidVendorDocument(tokenOf(operation.url), replacement.document.id, "Test"),
    );
    await assert.rejects(
      reissueVendorDocument(vendorContext, first.document.id, {
        idempotencyKey: `${prefix}:replacement`,
      }),
    );
    await svc(null, (client) => client.query(
      `UPDATE vendor_document_grants
          SET expires_at = clock_timestamp() + interval '14 days'
        WHERE id = $1`,
      [operation.grantId],
    ));
    await revokeVendorDocumentInvite(admin, operation.grantId);
    await assert.rejects(
      readVendorDocumentPdf(tokenOf(operation.url), replacement.document.id),
    );
    await assert.rejects(
      voidVendorDocument(tokenOf(operation.url), replacement.document.id, "Test"),
    );
    await assert.rejects(
      reissueVendorDocument(vendorContext, first.document.id, {
        idempotencyKey: `${prefix}:replacement`,
      }),
    );
    assert.equal(
      (await readVendorDocumentPdf(
        tokenOf(nextOperation.url), nextDocument.document.id,
      )).sha256,
      nextDocument.sha256,
    );
    assert.deepEqual(
      (await readVendorDocumentPdf(admin, first.document.id)).bytes,
      stored.bytes,
    );

    await svc(null, async (client) => {
      const rows = await client.query<{ seq: string }>(
        `SELECT seq::text FROM vendor_documents
          WHERE vendor_profile_id = $1 ORDER BY seq`,
        [profileId],
      );
      assert.deepEqual(rows.rows.map((row) => row.seq), ["1", "2", "3", "4"]);
      const counters = await client.query<{ kind: string; next_seq: string }>(
        `SELECT kind,next_seq::text FROM vendor_document_sequences
          WHERE vendor_profile_id = $1`,
        [profileId],
      );
      assert.deepEqual(counters.rows, [
        { kind: "completion_statement", next_seq: "5" },
      ]);
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

    for (const name of [
      "vendor-onboarding.ts", "vendor-receipt.ts", "vendor-receipt-pdf.ts",
    ]) {
      const source = readFileSync(new URL(name, import.meta.url), "utf8");
      assert.doesNotMatch(source, /\b(?:national_id|id_number|id_no)\s*[?:=]/i);
    }
  },
);

test(
  "tax-ID issuer spans organizations and duplicate profiles with transactional allocation",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    const a = await pool.connect();
    const b = await pool.connect();
    const observer = await pool.connect();
    const contacts = Array.from({ length: 5 }, () => randomUUID());
    const profiles = Array.from({ length: 5 }, () => randomUUID());
    let taxId: string;
    do {
      taxId = String(Math.floor(Math.random() * 90000000) + 10000000);
    } while (!validateTaiwanTaxId(taxId));
    const phone = `+8869${String(Math.floor(Math.random() * 100000000)).padStart(8, "0")}`;

    async function allocate(client: PoolClient, profile: string) {
      const result = await client.query<{ seq: string }>(
        `SELECT app.next_vendor_document_seq($1,'receipt')::text AS seq`,
        [profile],
      );
      return Number(result.rows[0].seq);
    }

    try {
      // Exercise the same database identity binding used by onboarding without
      // requiring an external seal-object upload for this allocation test.
      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role");
      for (let i = 0; i < contacts.length; i++) {
        const org = i === 1 || i === 4 ? ORG2_ID : ORG_ID;
        await a.query(
          `INSERT INTO contacts (id,org_id,is_vendor,display_name,phone_e164)
           VALUES ($1,$2,true,'Issuer test',$3)`,
          [contacts[i], org, phone],
        );
        if (i < 3) {
          await a.query(
            `INSERT INTO vendor_profiles
               (id,org_id,contact_id,vendor_code,kind,display_name,
                business_name,tax_id,phone_e164)
             VALUES ($1,$2,$3,'ignored','business','Issuer test',
                     'Issuer test',$4,$5)`,
            [profiles[i], org, contacts[i], taxId, phone],
          );
        }
      }
      await a.query(
        `INSERT INTO vendor_profiles
           (id,org_id,contact_id,vendor_code,kind,display_name,phone_e164)
         VALUES ($1,$2,$3,'ignored','individual','Individual test',$4)`,
        [profiles[3], ORG_ID, contacts[3], phone],
      );
      await a.query(
        `INSERT INTO vendor_profiles
           (id,org_id,contact_id,vendor_code,kind,display_name,phone_e164)
         VALUES ($1,$2,$3,'ignored','individual','Individual test',$4)`,
        [profiles[4], ORG2_ID, contacts[4], phone],
      );
      await a.query("COMMIT");

      const identities = await a.query(
        `SELECT issuer_id::text,vendor_code FROM vendor_profiles
          WHERE id = ANY($1::uuid[])`,
        [profiles.slice(0, 3)],
      );
      assert.equal(identities.rowCount, 3);
      assert.equal(new Set(identities.rows.map((r) => r.issuer_id)).size, 1);
      assert.equal(new Set(identities.rows.map((r) => r.vendor_code)).size, 1);
      assert.match(identities.rows[0].vendor_code, /^[0-9a-f]{32}$/);
      assert.ok(!contacts.some((id) =>
        id.replaceAll("-", "") === identities.rows[0].vendor_code,
      ));

      const security = await a.query(
        `SELECT relrowsecurity,relforcerowsecurity,
                has_table_privilege('anon',oid,'SELECT') AS anon_read,
                has_table_privilege('authenticated',oid,'SELECT') AS auth_read,
                has_table_privilege('service_role',oid,'SELECT') AS service_read,
                has_table_privilege('service_role',oid,'UPDATE') AS service_update
           FROM pg_class WHERE oid = 'public.vendor_issuers'::regclass`,
      );
      assert.deepEqual(security.rows, [{
        relrowsecurity: true,
        relforcerowsecurity: true,
        anon_read: false,
        auth_read: false,
        service_read: false,
        service_update: false,
      }]);

      // Independently authenticated members cannot see another org's profiles
      // or invoke the private allocator/binding function.
      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE authenticated");
      await a.query(
        `SELECT set_config('request.jwt.claim.sub',$1,true)`,
        [USERS.admin],
      );
      assert.equal((await a.query(
        `SELECT id FROM vendor_profiles WHERE id = $1`,
        [profiles[1]],
      )).rowCount, 0);
      await assert.rejects(a.query(`SELECT * FROM vendor_issuers`), {
        code: "42501",
      });
      await a.query("ROLLBACK");

      for (const functionName of [
        "app.bind_vendor_issuer()",
        "app.next_vendor_document_seq(uuid,text)",
      ]) {
        const info = await a.query(
          `SELECT prosecdef,proconfig,
                  has_function_privilege('anon',oid,'EXECUTE') AS anon_execute,
                  has_function_privilege('authenticated',oid,'EXECUTE') AS auth_execute,
                  has_function_privilege('service_role',oid,'EXECUTE') AS service_execute,
                  EXISTS (
                    SELECT 1 FROM aclexplode(proacl)
                     WHERE grantee = 0 AND privilege_type = 'EXECUTE'
                  ) AS public_execute
             FROM pg_proc WHERE oid = $1::regprocedure`,
          [functionName],
        );
        assert.equal(info.rows[0].prosecdef, true);
        assert.ok(info.rows[0].proconfig.includes("search_path=pg_catalog, public"));
        assert.equal(info.rows[0].anon_execute, false);
        assert.equal(info.rows[0].auth_execute, false);
        assert.equal(info.rows[0].service_execute, true);
        assert.equal(info.rows[0].public_execute, false);
      }

      // Read backend identities before b starts its blocked allocation.
      const aBackend = await a.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS pid`,
      );
      const bBackend = await b.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS pid`,
      );
      const aPid = aBackend.rows[0].pid;
      const bPid = bBackend.rows[0].pid;
      assert.notEqual(aPid, bPid);

      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role");
      assert.equal(await allocate(a, profiles[0]), 1);
      await b.query("BEGIN");
      await b.query("SET LOCAL ROLE service_role");
      const blocked = Promise.allSettled([allocate(b, profiles[1])]);
      try {
        // Observe b waiting specifically on a's issuer allocation lock.
        const deadline = Date.now() + 10000;
        for (;;) {
          const state = await observer.query<{ blockers: number[] }>(
            `SELECT pg_blocking_pids($1) AS blockers`,
            [bPid],
          );
          if (state.rows[0].blockers.includes(aPid)) break;
          assert.ok(Date.now() < deadline, "cross-org allocation must serialize");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await a.query("COMMIT");
        const [result] = await blocked;
        if (result.status === "rejected") throw result.reason;
        assert.equal(result.value, 2);
        await b.query("COMMIT");
      } finally {
        await a.query("ROLLBACK");
        await b.query("ROLLBACK");
        await blocked;
      }

      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role");
      assert.equal(await allocate(a, profiles[2]), 3, "same-org duplicate shares issuer");
      await a.query("COMMIT");

      // A downstream persistence error aborts allocation and its local mirror.
      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role");
      assert.equal(await allocate(a, profiles[1]), 4);
      await assert.rejects(a.query("SELECT 1 / 0"), { code: "22012" });
      await a.query("ROLLBACK");
      await b.query("BEGIN");
      await b.query("SET LOCAL ROLE service_role");
      assert.equal(await allocate(b, profiles[0]), 4, "failed issuance consumes nothing");
      await b.query("COMMIT");

      // Current-phone uniqueness is only a same-org duplicate-profile guard.
      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role");
      await assert.rejects(a.query(
        `INSERT INTO vendor_profiles
           (org_id,contact_id,vendor_code,kind,display_name,phone_e164)
         VALUES ($1,$2,'ignored','individual','Duplicate',$3)`,
        [ORG_ID, contacts[0], phone],
      ), { code: "23505" });
      await a.query("ROLLBACK");

      // Business tax-ID identity remains immutable; individual phone updates
      // and their audit/counter continuity have a dedicated integration suite.
      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role");
      await assert.rejects(a.query(
        `UPDATE vendor_profiles SET tax_id = NULL WHERE id = $1`,
        [profiles[0]],
      ), { code: "23514" });
      await a.query("ROLLBACK");

      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role");
      for (const profile of profiles.slice(3)) {
        const completion = await a.query(
          `SELECT app.next_vendor_document_seq($1,'completion_statement')::text AS seq`,
          [profile],
        );
        assert.equal(completion.rows[0].seq, "1");
      }
      await assert.rejects(allocate(a, profiles[3]), { code: "23514" });
      await a.query("ROLLBACK");

      // Replaying the edited migration must preserve issuer identity/counter.
      await a.query(readFileSync(
        new URL(
          "../../supabase/migrations/20261030150800_vendor_onboarding_job_types_receipts.sql",
          import.meta.url,
        ),
        "utf8",
      ));
      await a.query("BEGIN");
      await a.query("SET LOCAL ROLE service_role");
      assert.equal(await allocate(a, profiles[1]), 5);
      await a.query("COMMIT");
    } finally {
      try {
        await a.query("ROLLBACK");
        await b.query("ROLLBACK");
        await a.query(`DELETE FROM vendor_profiles WHERE id = ANY($1::uuid[])`, [profiles]);
        await a.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [contacts]);
        await a.query(
          `DELETE FROM vendor_issuers WHERE tax_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM vendor_profiles WHERE issuer_id = vendor_issuers.id
             )`,
          [taxId],
        );
      } finally {
        a.release();
        b.release();
        observer.release();
        await pool.end();
      }
    }
  },
);
