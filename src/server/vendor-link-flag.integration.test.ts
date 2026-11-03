import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "pg";
import { svc, tx, withClient } from "./db";
import { createTicket } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { PHOTO_BUCKET, ticketPhotoPath } from "./repair-rules";
import { saveRepairRecord } from "./repairs";
import { issueVendorUploadGrant } from "./ticket-photos";
import type { Session } from "./types";
import { hashVendorToken } from "./vendor-repair-rules";
import {
  __setVendorLinkKillSwitchForTests, addVendor, approveVendorSharing, confirmVendorPhoto, dispatchVendor,
  loadVendorJob, prepareVendorPhoto,
  openVendorPhoto, revokeVendorJob, streamVendorPhoto, submitVendorReport,
} from "./vendor-repair";
import { GET } from "../app/api/vendor-jobs/[token]/photos/[id]/route";

const adminSessionId = randomUUID(), tenantSessionId = randomUUID();
test.before(async () => { await withClient(async client => { for (const [id,user] of [[adminSessionId,USERS.admin],[tenantSessionId,USERS.tenant2]]) await client.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')`,[id,user,randomUUID()]); }); });
test.after(async () => { await withClient(client => client.query(`DELETE FROM auth_sessions WHERE id=ANY($1::uuid[])`,[[adminSessionId,tenantSessionId]])); });
const admin: Session = {
  userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID,
  sessionId: adminSessionId, email: "staff@demo", name: "Staff",
  kind: "staff", role: "admin", environment: "live",
  locale: "zh-TW", calendar: "gregorian", leaseId: null,
};
const tenant: Session = {
  ...admin, userId: USERS.tenant2, sessionId: tenantSessionId, kind: "tenant", role: null,
};
const notFound = (error: unknown) => error instanceof FlowError && error.key === "errors.notFound";
const report = (token: string) => submitVendorReport(token, { done: true, cost: "100" });
const outcome = (work: Promise<unknown>) => work.then(
  (value) => ({ value, error: null }),
  (error: unknown) => ({ value: null, error }),
);

// Observe real PostgreSQL wait queues, including waiters queued behind a waiter.
// No timing delay is used to infer that a request reached its lock.
async function waitForBlocked(observer: Client, root: number, count: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ n: number }>(
      `WITH RECURSIVE waiting(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN waiting w
           ON w.pid = ANY(pg_blocking_pids(a.pid))
       ) SELECT count(DISTINCT pid)::int AS n FROM waiting`,
      [root],
    );
    if (result.rows[0].n >= count) return;
  }
  assert.fail("request did not enter the ticket lock wait queue");
}

test("flag ON serializes invalidation and proxies authorized photos; OFF retains redirects", async (t) => {
  assert.ok(process.env.DATABASE_URL, "use local PostgreSQL DATABASE_URL");
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  const observer = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  await observer.connect();
  const root = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const tickets: string[] = [];
  const files: string[] = [];
  const pending: Promise<unknown>[] = [];
  const vendorName = `lane-c-${randomUUID()}`;
  const replacementName = `lane-y-${randomUUID()}`;
  const input = { vendorName, vendorPhone: "0912000111", vendorTrade: "plumbing", contactWindow: "Monday" };
  const saved = await svc(null, (c) => c.query(
    "SELECT feature_flags FROM organizations WHERE id = $1", [ORG_ID],
  ));
  const originalFetch = globalThis.fetch;
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  async function issue() {
    const lease = await tx(USERS.admin, (c) => c.query<{ id: string }>(
      `SELECT l.id::text FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id
         JOIN contacts c ON c.id = lp.contact_id
        WHERE c.user_id = $1 AND l.org_id = $2 AND l.status = 'active'
        ORDER BY l.created_at LIMIT 1`, [USERS.tenant2, ORG_ID],
    ));
    assert.ok(lease.rows[0]);
    const ticketId = await createTicket(tenant, {
      leaseId: lease.rows[0].id, category: "plumbing",
      title: vendorName, description: "Shared work",
    });
    tickets.push(ticketId);
    const job = await dispatchVendor(admin, ticketId, input, "http://127.0.0.1:43123");
    return { ...job, ticketId, token: decodeURIComponent(new URL(job.url).pathname.slice(3)) };
  }
  async function lock(ticketId: string) {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM maintenance_tickets WHERE id = $1 AND org_id = $2 FOR UPDATE",
      [ticketId, ORG_ID],
    );
  }
  function track(work: Promise<unknown>) {
    const result = outcome(work);
    pending.push(result);
    return result;
  }
  async function attachment(ticketId: string, orgId = ORG_ID) {
    const id = randomUUID();
    files.push(id);
    const path = ticketPhotoPath(orgId, ticketId, id, "image/jpeg");
    const row = await svc(null, async (c) => {
      await c.query(
        `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes)
         VALUES ($1,$2,$3,$4,'photo.jpg','image/png',3)`, [id, orgId, PHOTO_BUCKET, path],
      );
      return c.query<{ id: string }>(
        `INSERT INTO ticket_attachments (org_id, ticket_id, file_id, is_internal)
         VALUES ($1,$2,$3,false) RETURNING id::text`, [orgId, ticketId, id],
      );
    });
    return { id: row.rows[0].id, path };
  }
  try {
    await svc(null, (c) => c.query(
      `UPDATE organizations SET feature_flags = coalesce(feature_flags, '{}'::jsonb)
         || '{"vendor_link":true}'::jsonb WHERE id = $1`, [ORG_ID],
    ));
    __setVendorLinkKillSwitchForTests(true);
    process.env.SUPABASE_URL = "https://storage.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "lane-c-fixture-key";
    const bytes = Uint8Array.of(255, 216, 255);
    let downloads = 0;
    globalThis.fetch = async (url, init) => {
      assert.ok(String(url).startsWith("https://storage.invalid/storage/v1/"));
      assert.equal(init?.cache, "no-store");
      if (String(url).includes("/object/sign/")) {
        return Response.json([{ path: photo.path, signedURL: "/object/sign/fixture" }]);
      }
      downloads++;
      return new Response(bytes, { headers: { "Content-Type": "text/html" } });
    };

    const revoked = await issue();
    await lock(revoked.ticketId);
    const revoke = track(revokeVendorJob(admin, revoked.ticketId, revoked.jobId));
    await waitForBlocked(observer, root, 1);
    const blockedReport = track(report(revoked.token));
    await waitForBlocked(observer, root, 2);
    await blocker.query("COMMIT");
    assert.equal((await revoke).error, null);
    assert.ok(notFound((await blockedReport).error));

    const closed = await issue();
    const path = ticketPhotoPath(ORG_ID, closed.ticketId, randomUUID(), "image/jpeg");
    const grant = issueVendorUploadGrant(hashVendorToken(closed.token), closed.ticketId, path);
    assert.ok(grant);
    await lock(closed.ticketId);
    await blocker.query("UPDATE maintenance_tickets SET status = 'closed' WHERE id = $1", [closed.ticketId]);
    const beforeConfirm = downloads;
    const confirm = track(confirmVendorPhoto(closed.token, {
      path, fileName: "photo.jpg", mime: "image/jpeg", size: 3, uploadToken: grant,
    }));
    await waitForBlocked(observer, root, 1);
    await blocker.query("COMMIT");
    assert.ok(notFound((await confirm).error));
    assert.equal(downloads, beforeConfirm);

    const old = await issue();
    await lock(old.ticketId);
    const replacement = track(dispatchVendor(admin, old.ticketId, input, "http://127.0.0.1:43123"));
    await waitForBlocked(observer, root, 1);
    const oldReport = track(report(old.token));
    await waitForBlocked(observer, root, 2);
    await blocker.query("COMMIT");
    assert.equal((await replacement).error, null);
    assert.ok(notFound((await oldReport).error));
    const state = await svc(null, (c) => c.query(
      "SELECT active, revoked_at, reported_at FROM repair_vendor_jobs WHERE id = $1", [old.jobId],
    ));
    assert.equal(state.rows[0].active, false);
    assert.ok(state.rows[0].revoked_at);
    assert.equal(state.rows[0].reported_at, null);

    await t.test("flag ON manual reassignment rejects the previous vendor capability", async () => {
      const assigned = await issue();
      const shared = await attachment(assigned.ticketId);
      const ownPhoto = await attachment(assigned.ticketId);
      await svc(null, (c) => c.query(
        "UPDATE ticket_attachments SET vendor_job_id = $2 WHERE id = $1",
        [ownPhoto.id, assigned.jobId],
      ));
      const nextVendorId = await addVendor(admin, assigned.ticketId, {
        name: replacementName, phone: "0912000222", trade: "water",
      });
      await approveVendorSharing(admin, assigned.ticketId, assigned.jobId, {
        description: "Approved work", attachmentIds: [shared.id],
      });
      assert.ok((await loadVendorJob(assigned.token))?.vendorLink?.sharingApproved);
      assert.deepEqual(await streamVendorPhoto(assigned.token, shared.id), { bytes, contentType: "image/jpeg" });
      const uploadPath = ticketPhotoPath(ORG_ID, assigned.ticketId, randomUUID(), "image/jpeg");
      const uploadToken = issueVendorUploadGrant(hashVendorToken(assigned.token), assigned.ticketId, uploadPath);
      assert.ok(uploadToken);
      const beforeReassignment = downloads;
      await lock(assigned.ticketId);
      const reassign = track(saveRepairRecord(admin, assigned.ticketId, {
        status: "assigned", note: "", internal: false, vendorName: replacementName,
        estimated: "", finalCost: "", costBearer: "undecided",
        scheduledOn: "", completedOn: "", postExpense: false,
      }));
      await waitForBlocked(observer, root, 1);
      const queuedReport = track(report(assigned.token));
      await waitForBlocked(observer, root, 2);
      await blocker.query("COMMIT");
      assert.equal((await reassign).error, null);
      assert.ok(notFound((await queuedReport).error));
      const reassigned = await svc(null, (c) => c.query(
        `SELECT t.assigned_vendor_contact_id::text, j.vendor_contact_id::text,
                j.active, j.revoked_at, j.sharing_approved_at, j.sharing_approved_by,
                j.shared_description, j.reported_at,
                (SELECT count(*)::int FROM repair_vendor_job_shared_photos s
                  WHERE s.job_id = j.id) AS shared_count
           FROM maintenance_tickets t
           JOIN repair_vendor_jobs j ON j.ticket_id = t.id AND j.org_id = t.org_id
          WHERE t.id = $1 AND j.id = $2`, [assigned.ticketId, assigned.jobId],
      ));
      const job = reassigned.rows[0];
      assert.equal(job.assigned_vendor_contact_id, nextVendorId);
      assert.ok(job.vendor_contact_id);
      assert.notEqual(job.vendor_contact_id, nextVendorId);
      assert.equal(job.active, false);
      assert.ok(job.revoked_at);
      assert.equal(job.sharing_approved_at, null);
      assert.equal(job.sharing_approved_by, null);
      assert.equal(job.shared_description, null);
      assert.equal(job.reported_at, null);
      assert.equal(job.shared_count, 0);

      async function assertRejected() {
        assert.equal(await loadVendorJob(assigned.token), null);
        await assert.rejects(report(assigned.token), notFound);
        await assert.rejects(prepareVendorPhoto(assigned.token, {
          fileName: "photo.jpg", mime: "image/jpeg", size: 3,
        }), notFound);
        await assert.rejects(confirmVendorPhoto(assigned.token, {
          path: uploadPath, fileName: "photo.jpg", mime: "image/jpeg", size: 3, uploadToken,
        }), notFound);
        assert.equal(await streamVendorPhoto(assigned.token, shared.id), null);
        assert.equal(await streamVendorPhoto(assigned.token, ownPhoto.id), null);
        assert.equal(await openVendorPhoto(assigned.token, shared.id), null);
        const response = await GET(new Request("http://localhost"), {
          params: Promise.resolve({ token: assigned.token, id: shared.id }),
        });
        assert.equal(response.status, 404);
        await assert.rejects(approveVendorSharing(admin, assigned.ticketId, assigned.jobId, {
          description: "Rejected", attachmentIds: [shared.id],
        }), notFound);
        assert.equal(downloads, beforeReassignment);
      }
      await assertRejected();

      // Simulate a stale active job with approval to exercise identity checks independently.
      await svc(null, async (c) => {
        await c.query(
          `UPDATE repair_vendor_jobs
              SET active = true, revoked_at = NULL,
                  sharing_approved_at = clock_timestamp(), sharing_approved_by = $2,
                  shared_description = 'Approved work'
            WHERE id = $1`, [assigned.jobId, admin.userId],
        );
        await c.query(
          `INSERT INTO repair_vendor_secrets (job_id, token) VALUES ($1,$2)`,
          [assigned.jobId, assigned.token],
        );
        await c.query(
          `INSERT INTO repair_vendor_job_shared_photos (org_id, job_id, attachment_id, approved_by)
           VALUES ($1,$2,$3,$4)`, [ORG_ID, assigned.jobId, shared.id, admin.userId],
        );
      });
      await assertRejected();
      const untouched = await svc(null, (c) => c.query(
        `SELECT reported_at FROM repair_vendor_jobs WHERE id = $1`, [assigned.jobId],
      ));
      assert.equal(untouched.rows[0].reported_at, null);
    });

    const valid = await issue();
    const photo = await attachment(valid.ticketId);
    // Unreviewed links expose no work data and cannot write, including uploads.
    const unapproved = await loadVendorJob(valid.token);
    assert.ok(unapproved?.vendorLink);
    assert.equal(unapproved.vendorLink.sharingApproved, false);
    for (const field of ["description", "title", "address", "place", "window"] as const) {
      assert.equal(unapproved[field], "");
    }
    assert.deepEqual(unapproved.issuePhotos, []);
    assert.deepEqual(unapproved.donePhotos, []);
    await assert.rejects(report(valid.token), notFound);
    await assert.rejects(prepareVendorPhoto(valid.token, {
      fileName: "photo.jpg", mime: "image/jpeg", size: 3,
    }), notFound);
    assert.equal(await streamVendorPhoto(valid.token, photo.id), null);
    const unapprovedPath = ticketPhotoPath(ORG_ID, valid.ticketId, randomUUID(), "image/jpeg");
    const beforeUnapprovedConfirm = downloads;
    await assert.rejects(confirmVendorPhoto(valid.token, {
      path: unapprovedPath, fileName: "photo.jpg", mime: "image/jpeg", size: 3,
      uploadToken: issueVendorUploadGrant(hashVendorToken(valid.token), valid.ticketId, unapprovedPath),
    }), notFound);
    assert.equal(downloads, beforeUnapprovedConfirm);
    const unshared = await attachment(valid.ticketId);
    const own = await attachment(valid.ticketId);
    await svc(null, (c) => c.query(
      "UPDATE ticket_attachments SET vendor_job_id = $2 WHERE id = $1", [own.id, valid.jobId],
    ));
    const internal = await attachment(valid.ticketId);
    await svc(null, (c) => c.query(
      "UPDATE ticket_attachments SET is_internal = true WHERE id = $1", [internal.id],
    ));
    await assert.rejects(approveVendorSharing(admin, valid.ticketId, valid.jobId, {
      description: "Do not share", attachmentIds: [internal.id],
    }), notFound);
    const forbidden = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";
    for (const session of [tenant, { ...admin, role: "accountant" as const }]) {
      await assert.rejects(approveVendorSharing(session, valid.ticketId, valid.jobId, {
        description: "Rejected", attachmentIds: [photo.id],
      }), forbidden);
    }
    await approveVendorSharing(admin, valid.ticketId, valid.jobId, {
      description: "Redacted work instructions", attachmentIds: [photo.id],
    });
    const approved = await loadVendorJob(valid.token);
    assert.ok(approved?.vendorLink?.sharingApproved);
    assert.equal(approved.description, "Redacted work instructions");
    assert.equal(approved.title, "");
    assert.deepEqual(approved.issuePhotos.map((p) => p.id), [photo.id]);
    assert.deepEqual(approved.donePhotos.map((p) => p.id), [own.id]);
    assert.equal(await streamVendorPhoto(valid.token, unshared.id), null);
    assert.equal(await streamVendorPhoto(valid.token, internal.id), null);
    assert.deepEqual(await streamVendorPhoto(valid.token, own.id), { bytes, contentType: "image/jpeg" });
    const persisted = await svc(null, (c) => c.query(
      `SELECT scope, sharing_approved_at, sharing_approved_by::text
         FROM repair_vendor_jobs WHERE id = $1`, [valid.jobId],
    ));
    assert.equal(persisted.rows[0].scope, "case_collaboration");
    assert.ok(persisted.rows[0].sharing_approved_at);
    assert.equal(persisted.rows[0].sharing_approved_by, admin.userId);
    assert.deepEqual(await streamVendorPhoto(valid.token, photo.id), { bytes, contentType: "image/jpeg" });
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ token: valid.token, id: photo.id }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    for (const [key, value] of Object.entries({
      "content-type": "image/jpeg", "cache-control": "private, no-store, max-age=0",
      pragma: "no-cache", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer", "content-disposition": "inline",
    })) assert.equal(response.headers.get(key), value);
    const foreign = await issue();
    const foreignPhoto = await attachment(foreign.ticketId);
    assert.equal(await streamVendorPhoto(valid.token, foreignPhoto.id), null);
    const foreignOrgTicket = await svc(null, (c) => c.query<{ id: string }>(
      `INSERT INTO maintenance_tickets (org_id, ticket_number, property_id, title)
       SELECT $1, (SELECT coalesce(max(ticket_number), 1000) + 1
                     FROM maintenance_tickets WHERE org_id = $1), p.id, $2
         FROM properties p WHERE p.org_id = $1 ORDER BY p.id LIMIT 1 RETURNING id::text`,
      [ORG2_ID, vendorName],
    ));
    assert.ok(foreignOrgTicket.rows[0]);
    tickets.push(foreignOrgTicket.rows[0].id);
    const otherOrgPhoto = await attachment(foreignOrgTicket.rows[0].id, ORG2_ID);
    assert.equal(await streamVendorPhoto(valid.token, otherOrgPhoto.id), null);
    for (const attachmentId of [foreignPhoto.id, otherOrgPhoto.id]) {
      await assert.rejects(approveVendorSharing(admin, valid.ticketId, valid.jobId, {
        description: "Rejected", attachmentIds: [attachmentId],
      }), notFound);
    }
    assert.equal((await loadVendorJob(valid.token))?.description, "Redacted work instructions");
    await assert.rejects(approveVendorSharing(admin, revoked.ticketId, revoked.jobId, {
      description: "Rejected after revoke", attachmentIds: [],
    }), notFound);
    // Reapproval replaces the durable selection; earlier photos immediately lose access.
    await approveVendorSharing(admin, valid.ticketId, valid.jobId, {
      description: "Replacement redaction", attachmentIds: [unshared.id],
    });
    assert.equal(await streamVendorPhoto(valid.token, photo.id), null);
    assert.deepEqual(await streamVendorPhoto(valid.token, unshared.id), { bytes, contentType: "image/jpeg" });
    await approveVendorSharing(admin, valid.ticketId, valid.jobId, {
      description: "Redacted work instructions", attachmentIds: [photo.id],
    });
    assert.equal(await streamVendorPhoto(revoked.token, photo.id), null);
    await report(valid.token);
    await svc(null, (c) => c.query(
      "UPDATE repair_vendor_jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [valid.jobId],
    ));
    assert.equal(await streamVendorPhoto(valid.token, photo.id), null);
    await svc(null, (c) => c.query(
      "UPDATE repair_vendor_jobs SET expires_at = clock_timestamp() + interval '1 day' WHERE id = $1",
      [valid.jobId],
    ));
    const storageFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("<svg></svg>");
    assert.equal(await streamVendorPhoto(valid.token, photo.id), null);
    globalThis.fetch = async () => { throw new Error("storage unavailable"); };
    assert.equal(await streamVendorPhoto(valid.token, photo.id), null);
    globalThis.fetch = storageFetch;
    const missing = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ token: revoked.token, id: photo.id }),
    });
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Not found");
    __setVendorLinkKillSwitchForTests(false);
    const legacy = await openVendorPhoto(valid.token, photo.id);
    assert.ok(legacy && "url" in legacy);
    assert.equal(legacy.mime, "image/png");
    const redirect = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ token: valid.token, id: photo.id }),
    });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), legacy.url);
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled(pending);
    __setVendorLinkKillSwitchForTests(false);
    globalThis.fetch = originalFetch;
    if (savedUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    try {
      await svc(null, async (c) => {
        await c.query("UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1",
          [ORG_ID, JSON.stringify(saved.rows[0].feature_flags)]);
        await c.query("DELETE FROM ticket_attachments WHERE ticket_id = ANY($1::uuid[])", [tickets]);
        await c.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [files]);
        await c.query("DELETE FROM repair_vendor_jobs WHERE ticket_id = ANY($1::uuid[])", [tickets]);
        await c.query("DELETE FROM maintenance_tickets WHERE id = ANY($1::uuid[])", [tickets]);
        await c.query("DELETE FROM contacts WHERE org_id = $1 AND display_name = ANY($2::text[])",
          [ORG_ID, [vendorName, replacementName]]);
      });
    } finally {
      await Promise.allSettled([blocker.end(), observer.end()]);
    }
  }
});
