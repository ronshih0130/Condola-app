import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "pg";
import { svc, tx } from "./db";
import { createTicket } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { PHOTO_BUCKET, ticketPhotoPath } from "./repair-rules";
import { issueVendorUploadGrant } from "./ticket-photos";
import type { Session } from "./types";
import { hashVendorToken } from "./vendor-repair-rules";
import {
  __setVendorLinkKillSwitchForTests, confirmVendorPhoto, dispatchVendor,
  openVendorPhoto, revokeVendorJob, streamVendorPhoto, submitVendorReport,
} from "./vendor-repair";
import { GET } from "../app/api/vendor-jobs/[token]/photos/[id]/route";

const admin: Session = {
  userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID,
  sessionId: "vendor-link-flag", email: "staff@demo", name: "Staff",
  kind: "staff", role: "admin", environment: "live",
  locale: "zh-TW", calendar: "gregorian", leaseId: null,
};
const tenant: Session = {
  ...admin, userId: USERS.tenant2, kind: "tenant", role: null,
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

test("flag ON serializes invalidation and proxies authorized photos; OFF retains redirects", async () => {
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

    const valid = await issue();
    const photo = await attachment(valid.ticketId);
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
    assert.equal(await streamVendorPhoto(revoked.token, photo.id), null);
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
    await svc(null, async (c) => {
      await c.query("UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1",
        [ORG_ID, JSON.stringify(saved.rows[0].feature_flags)]);
      await c.query("DELETE FROM ticket_attachments WHERE ticket_id = ANY($1::uuid[])", [tickets]);
      await c.query("DELETE FROM files WHERE id = ANY($1::uuid[])", [files]);
      await c.query("DELETE FROM repair_vendor_jobs WHERE ticket_id = ANY($1::uuid[])", [tickets]);
      await c.query("DELETE FROM maintenance_tickets WHERE id = ANY($1::uuid[])", [tickets]);
      await c.query("DELETE FROM contacts WHERE org_id = $1 AND display_name = $2", [ORG_ID, vendorName]);
    });
    await blocker.end();
    await observer.end();
  }
});
