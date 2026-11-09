import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationCenter } from "../components/notification-center";
import { centerVendorItems } from "./notification-center";
import { POST as markNotification } from "../app/api/notification-center/vendor-mark/route";
import { withClient } from "./db";
import { createTicket } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { PHOTO_BUCKET, ticketPhotoPath } from "./repair-rules";
import { recordVendorAppointment, submitEstimate } from "./repair-approval";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { issueVendorUploadGrant } from "./ticket-photos";
import type { Session } from "./types";
import { hashVendorToken } from "./vendor-repair-rules";
import {
  __setVendorLinkKillSwitchForTests, approveVendorSharing, dispatchVendor,
  loadVendorJob, submitVendorReport, orgVendorDispatchPolicy,
} from "./vendor-repair";
import { POST as respond } from "../app/api/vendor-job-response/route";
import { POST as complete } from "../app/api/vendor-job-completion/route";
import { POST as sign } from "../app/api/vendor-jobs/photos/sign/route";
import { POST as confirm } from "../app/api/vendor-jobs/photos/confirm/route";
import { GET as photo } from "../app/api/vendor-jobs/[token]/photos/[id]/route";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
const denied = (error: unknown) => error instanceof FlowError && error.key === "errors.notFound";
function request(path: string, body: unknown) {
  return new Request(origin + path, {
    method: "POST", headers: { origin, host: new URL(origin).host, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const tables = [
  "public.maintenance_tickets", "public.repair_vendor_jobs", "public.repair_vendor_secrets",
  "public.repair_vendor_job_shared_photos", "public.ticket_attachments", "public.files",
  "public.ticket_comments", "public.expenses", "public.audit_log",
  "app.b013_estimate_heads", "app.b013_estimate_versions", "app.b013_estimate_decisions",
  "app.b013_repair_emergencies", "app.b013_repair_appointments", "app.b013_repair_commands",
  "app.b013_repair_event_outbox",
  "app.b028_center_events", "app.b028_center_recipients", "app.b028_center_reads",
  "app.b028_center_mark_contexts", "app.b028_center_cursors",
];
async function snapshot(on?: Client) {
  const read = async (client: Client) => {
    const result: Record<string, string> = {};
    for (const table of tables) {
      result[table] = (await client.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text, '' ORDER BY row_to_json(r)::text),'')) AS hash FROM ${table} r`)).rows[0].hash;
    }
    return result;
  };
  return on ? read(on) : withClient(read);
}

async function trace<T>(work: () => Promise<T>) {
  const spy = mock.method(Client.prototype, "query");
  try {
    const value = await work();
    const raw = spy.mock.calls.map(call => String(call.arguments[0]));
    return { value, raw, sql: raw.map(sql => sql.replace(/\s+/g, " ").trim()) };
  } finally { spy.mock.restore(); }
}

test("B-026 closed enhanced jobs are read-only with explicitly shared photos; legacy remains unchanged", async t => {
  const clone = await cloneTestDatabase();
  const envKeys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const env = envKeys.map(key => [key, process.env[key]] as const);
  const fetchBefore = globalThis.fetch;
  let storageCalls = 0;
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const admin: Session = {
    userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID, sessionId: randomUUID(),
    email: "staff@demo", name: "Staff", kind: "staff", role: "admin", environment: "live",
    locale: "zh-TW", calendar: "gregorian", leaseId: null,
  };
  const tenant: Session = { ...admin, userId: USERS.tenant2, sessionId: randomUUID(), kind: "tenant", role: null };
  const saved = await withClient(async client => ({
    flags: (await client.query("SELECT feature_flags FROM organizations WHERE id=$1", [ORG_ID])).rows[0].feature_flags,
    notifications: (await client.query("SELECT value FROM platform_settings WHERE key='notification_center_v2'")).rows[0].value,
    approvals: (await client.query("SELECT value FROM platform_settings WHERE key='repair_approvals'")).rows[0].value,
  }));
  async function approvals(enabled: boolean) {
    await withClient(async client => {
      await client.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('repair_approvals',$2::boolean) WHERE id=$1", [ORG_ID, enabled]);
      await client.query("UPDATE platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text)) WHERE key='repair_approvals'", [enabled, ORG_ID]);
    });
  }
  async function issue() {
    const lease = await withClient(client => client.query(`SELECT l.id FROM leases l
      JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id
      WHERE c.user_id=$1 AND l.org_id=$2 AND l.status='active' ORDER BY l.id LIMIT 1`, [USERS.tenant2, ORG_ID]));
    const ticketId = await createTicket(tenant, {
      leaseId: lease.rows[0].id, category: "plumbing", title: "B026 private title", description: "B026 private description",
    });
    const job = await dispatchVendor(admin, ticketId, {
      vendorName: `B026-${randomUUID()}`, vendorPhone: "0912000111", vendorTrade: "plumbing", contactWindow: "Monday",
    }, origin);
    return { ...job, ticketId, token: new URL(job.url).pathname.slice(3) };
  }
  async function estimateFor(ticketId: string) {
    await approvals(true);
    const property = await withClient(async client => {
      const row = (await client.query(`SELECT p.currency::text currency, r.minor_unit FROM maintenance_tickets t
        JOIN properties p ON p.id=t.property_id JOIN organizations o ON o.id=t.org_id
        JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
        WHERE t.id=$1`, [ticketId])).rows[0];
      await client.query("UPDATE property_owners SET repair_approval_threshold_minor=500000 WHERE org_id=$1", [ORG_ID]);
      return row;
    });
    const estimate = await submitEstimate(admin, {
      ticketId, requestId: randomUUID(), expectedHeadId: null, amountMinor: 100,
      currency: property.currency.trim(), minorUnit: property.minor_unit, workScope: "Repair pipe", evidence: [],
    });
    assert.equal(estimate.status, "recorded");
    return String(estimate.version_id);
  }
  type Job = Awaited<ReturnType<typeof issue>>;
  async function attachment(job: Job, name: string, vendor = false) {
    const id = randomUUID(), fileId = randomUUID();
    const path = ticketPhotoPath(ORG_ID, job.ticketId, fileId, "image/jpeg");
    await withClient(async client => {
      await client.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes)
        VALUES($1,$2,$3,$4,$5,'image/jpeg',4)`, [fileId, ORG_ID, PHOTO_BUCKET, path, name]);
      await client.query(`INSERT INTO ticket_attachments(id,org_id,ticket_id,file_id,is_internal,vendor_job_id)
        VALUES($1,$2,$3,$4,false,$5)`, [id, ORG_ID, job.ticketId, fileId, vendor ? job.jobId : null]);
    });
    return { id, name, path };
  }
  const getPhoto = (job: Job, id: string) => photo(new Request(origin + `/api/vendor-jobs/${job.token}/photos/${id}`), {
    params: Promise.resolve({ token: job.token, id }),
  });
  try {
    process.env.SUPABASE_URL = origin;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "b026-local-fixture-only";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.ok(url.startsWith(origin + "/storage/v1/"), "storage must remain local and mocked");
      storageCalls++;
      if (url.includes("/object/info/")) return Response.json({ size: 4, contentType: "image/jpeg" });
      if (url.includes("/object/upload/sign/")) return Response.json({ url: "/object/upload/fixture", token: "fixture" });
      if (url.includes("/object/sign/")) {
        const paths = JSON.parse(String(init?.body)).paths as string[];
        return Response.json(paths.map(path => ({ path, signedURL: "/object/sign/fixture" })));
      }
      return new Response(bytes, { headers: { "content-type": "image/jpeg", "content-length": "4" } });
    };
    await withClient(async client => {
      for (const session of [admin, tenant]) await client.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [session.sessionId, session.userId, randomUUID()]);
      await client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_link\":true,\"vendor_dispatch\":true}'::jsonb WHERE id=$1", [ORG_ID]);
    });
    await withClient(async client => {
      await client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"notification_center_v2\":true}'::jsonb WHERE id=$1", [ORG_ID]);
      await client.query("UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'", [ORG_ID]);
    });
    __setVendorLinkKillSwitchForTests(true);
    await approvals(false);

    for (const status of ["closed", "cancelled"]) await t.test(status, async () => {
      const job = await issue();
      const shared = await attachment(job, "approved-issue.jpg");
      const sharedDone = await attachment(job, "approved-done.jpg", true);
      const unshared = await attachment(job, "hidden-issue.jpg");
      const unsharedDone = await attachment(job, "hidden-done.jpg", true);
      const internal = await attachment(job, "hidden-internal.jpg");
      await approveVendorSharing(admin, job.ticketId, job.jobId, {
        description: "Approved work", attachmentIds: [shared.id, sharedDone.id, internal.id],
      });
      const versionId = await estimateFor(job.ticketId);
      const responseBodies = ["propose", "reject", "accept_confirm"].map(action => ({
        token: job.token, versionId, requestId: randomUUID(), action, reason: "Unavailable", enhanced: false,
        times: { proposedStart: "2027-01-01T10:00:00Z", proposedEnd: "2027-01-01T11:00:00Z",
          confirmedStart: "2027-01-01T10:00:00Z", confirmedEnd: "2027-01-01T11:00:00Z" },
      }));
      const completionBody = { token: job.token, versionId, requestId: randomUUID(), reason: "No photo available" };
      // Existing B-024 SELECT permissions block open HTTP at the reader. Observe that
      // boundary explicitly; closed controls below must reject BEFORE those readers.
      for (const body of responseBodies) {
        const open = await trace(() => respond(request("/api/vendor-job-response", body)));
        assert.equal(open.value.status, 403);
        assert.ok(open.sql.some(sql => sql.includes("FROM app.b013_estimate_heads")));
      }
      const openCompletion = await trace(() => complete(request("/api/vendor-job-completion", completionBody)));
      assert.equal(openCompletion.value.status, 403);
      assert.ok(openCompletion.sql.some(sql => sql.includes("FROM app.b013_repair_commands c")));
      await withClient(async client => {
        await client.query("BEGIN");
        const event = (await client.query(`INSERT INTO app.b028_center_events(org_id,kind,ticket_id,job_id,occurred_at)
          SELECT org_id,'vendor_job_assigned',ticket_id,id,created_at FROM repair_vendor_jobs WHERE id=$1
          RETURNING id`, [job.jobId])).rows[0];
        await client.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,ticket_id,job_id)
          VALUES($1,$2,'vendor_job',$3,$4)`, [ORG_ID, event.id, job.ticketId, job.jobId]);
        await client.query("COMMIT");
      });
      const notifications = await centerVendorItems(job.token);
      assert.ok(notifications.items.length > 0);
      assert.equal(notifications.readOnly, undefined);
      // A populated open-job page through the B-026 sibling equals the unchanged B-028 gateway.
      __setVendorLinkKillSwitchForTests(false);
      const legacyPage = await centerVendorItems(job.token);
      __setVendorLinkKillSwitchForTests(true);
      assert.equal(JSON.stringify(notifications), JSON.stringify(legacyPage));
      assert.deepEqual(Object.keys(notifications.items[0]).sort(), ["continuation", "kind", "occurred_at", "read_at", "recipient_id"], "no read_only key leaks into items");
      const recipientId = notifications.items[0].recipient_id;
      assert.equal((await markNotification(request("/api/notification-center/vendor-mark", { token: job.token, recipientId }))).status, 200);
      await withClient(client => client.query("DELETE FROM app.b028_center_reads WHERE recipient_id=$1", [recipientId]));
      await withClient(async client => {
        await client.query("BEGIN");
        // A stale sharing row must never override the current internal marker.
        await client.query("UPDATE ticket_attachments SET is_internal=true WHERE id=$1", [internal.id]);
        await client.query("UPDATE maintenance_tickets SET status=$2::ticket_status WHERE id=$1", [job.ticketId, status]);
        try {
          const closing = await snapshot(client);
          const busy = await markNotification(request("/api/notification-center/vendor-mark", { token: job.token, recipientId }));
          assert.equal(busy.status, 200);
          assert.deepEqual(await busy.json(), { status: "busy" });
          assert.deepEqual(await snapshot(client), closing, "closure race must not mark or write notification rows");
          await client.query("COMMIT");
        } finally { await client.query("ROLLBACK"); }
      });
      await approvals(true);
      // An expired cursor the B-028 gateway would delete, plus a live one for the
      // read-only pagination lookup: a closed-job read must leave both untouched.
      const expiredCursor = (await withClient(client => client.query(`INSERT INTO app.b028_center_cursors(org_id,job_id,after_time,after_id,expires_at)
        VALUES($1,$2,now()-interval '1 day',$3,now()-interval '1 hour') RETURNING id::text`, [ORG_ID, job.jobId, randomUUID()]))).rows[0].id;
      const liveCursor = (await withClient(client => client.query(`INSERT INTO app.b028_center_cursors(org_id,job_id,after_time,after_id)
        VALUES($1,$2,'-infinity',$3) RETURNING id::text`, [ORG_ID, job.jobId, "00000000-0000-0000-0000-000000000000"]))).rows[0].id;
      const before = await snapshot();
      const view = await loadVendorJob(job.token);
      assert.equal(view?.vendorLink?.capability, "read_only");
      assert.deepEqual(view?.issuePhotos, [{ id: shared.id, name: shared.name }]);
      assert.deepEqual(view?.donePhotos, [{ id: sharedDone.id, name: sharedDone.name }]);
      for (const hidden of [unshared, unsharedDone, internal]) {
        for (const value of [hidden.id, hidden.name, hidden.path]) assert.ok(!JSON.stringify(view).includes(value));
        const calls = storageCalls;
        assert.equal((await getPhoto(job, hidden.id)).status, 404);
        assert.equal(storageCalls, calls, "hidden photos must not touch storage");
      }
      for (const allowed of [shared, sharedDone]) {
        const response = await getPhoto(job, allowed.id);
        assert.equal(response.status, 200);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      }
      const closedTrace = await trace(() => centerVendorItems(job.token));
      const closedNotifications = closedTrace.value;
      assert.equal(closedNotifications.readOnly, true);
      assert.equal(closedTrace.sql.length, 5, "closed-job read is one gateway call (no extra policy query)");
      assert.ok(closedTrace.sql.some(sql => sql.includes("FROM app.b026_center_vendor(")));
      assert.ok(!closedTrace.sql.some(sql => sql.includes("app.b028_center_vendor(")));
      const paged = await centerVendorItems(job.token, null, liveCursor);
      assert.equal(paged.readOnly, true);
      assert.deepEqual(paged.items.map(item => item.recipient_id), closedNotifications.items.map(item => item.recipient_id));
      // A live cursor at the last item's exact (occurred_at, recipient_id) boundary yields
      // an empty read-only page (sentinel row), no continuation, and no writes.
      const lastItem = closedNotifications.items.at(-1)!;
      const boundaryCursor = (await withClient(client => client.query(`INSERT INTO app.b028_center_cursors(org_id,job_id,after_time,after_id)
        VALUES($1,$2,$3::timestamptz,$4) RETURNING id::text`, [ORG_ID, job.jobId, lastItem.occurred_at, lastItem.recipient_id]))).rows[0].id;
      const boundaryBefore = await snapshot();
      const boundary = await centerVendorItems(job.token, null, boundaryCursor);
      assert.deepEqual(boundary, { items: [], continuation: null, readOnly: true });
      assert.deepEqual(await snapshot(), boundaryBefore);
      await withClient(client => client.query("DELETE FROM app.b028_center_cursors WHERE id=$1", [boundaryCursor]));
      await assert.rejects(centerVendorItems(job.token, null, expiredCursor));
      assert.equal((await withClient(client => client.query("SELECT count(*)::int n FROM app.b028_center_cursors WHERE id = ANY($1::uuid[])", [[expiredCursor, liveCursor]]))).rows[0].n, 2);
      const html = renderToStaticMarkup(createElement(NotificationCenter, { page: closedNotifications, locale: "en", kind: "vendor" }));
      assert.ok(!html.includes("notification-mark"));
      assert.ok(!html.includes("<button"));
      assert.equal(closedNotifications.items[0].read_at, null);
      assert.equal((await markNotification(request("/api/notification-center/vendor-mark", { token: job.token, recipientId }))).status, 404);
      assert.deepEqual(await snapshot(), before);
      for (const body of responseBodies) {
        const closed = await trace(() => respond(request("/api/vendor-job-response", body)));
        assert.equal(closed.value.status, 403);
        assert.ok(closed.sql.some(sql => sql.includes("FROM maintenance_tickets") && sql.includes("FOR UPDATE")));
        assert.ok(!closed.sql.some(sql => /FROM app.b013_(estimate_heads|repair_commands)/.test(sql)));
        assert.deepEqual(await snapshot(), before);
      }
      const closedCompletion = await trace(() => complete(request("/api/vendor-job-completion", completionBody)));
      assert.equal(closedCompletion.value.status, 403);
      assert.ok(closedCompletion.sql.some(sql => sql.includes("FROM maintenance_tickets") && sql.includes("FOR UPDATE")));
      assert.ok(!closedCompletion.sql.some(sql => /FROM app.b013_(estimate_heads|repair_commands)/.test(sql)));
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(recordVendorAppointment({ token: job.token, enhanced: true }, {
        orgId: ORG_ID, vendorJobId: job.jobId, versionId, requestId: randomUUID(),
        eventKind: "vendor_rejected", reason: "Unavailable",
      }), denied);
      await assert.rejects(submitVendorReport(job.token, { done: true, cost: "100" }), denied);
      assert.deepEqual(await snapshot(), before);
      const calls = storageCalls;
      const meta = { token: job.token, fileName: "upload.jpg", mime: "image/jpeg", size: 4 };
      assert.equal((await sign(request("/api/vendor-jobs/photos/sign", meta))).status, 404);
      const path = ticketPhotoPath(ORG_ID, job.ticketId, randomUUID(), "image/jpeg");
      assert.equal((await confirm(request("/api/vendor-jobs/photos/confirm", {
        ...meta, path, uploadToken: issueVendorUploadGrant(hashVendorToken(job.token), job.ticketId, path),
      }))).status, 404);
      assert.equal(storageCalls, calls);
      assert.deepEqual(await snapshot(), before);
      await approvals(false);
    });

    await t.test("open enhanced report and upload remain mutable; OFF and org-OFF views retain legacy bytes", async () => {
      await approvals(false);
      const job = await issue();
      await approveVendorSharing(admin, job.ticketId, job.jobId, { description: "Approved", attachmentIds: [] });
      assert.equal((await loadVendorJob(job.token))?.vendorLink?.capability, "write");
      const meta = { token: job.token, fileName: "open.jpg", mime: "image/jpeg", size: 4 };
      const signed = await sign(request("/api/vendor-jobs/photos/sign", meta));
      assert.equal(signed.status, 200);
      const upload = await signed.json();
      const attached = await confirm(request("/api/vendor-jobs/photos/confirm", { ...meta, ...upload, token: job.token }));
      assert.equal(attached.status, 200);
      assert.equal((await attached.json()).ok, true);
      await submitVendorReport(job.token, { done: true, cost: "100" });
      assert.equal((await loadVendorJob(job.token))?.reported, true);

      const legacy = await issue();
      const visible = await attachment(legacy, "legacy-unshared.jpg");
      await withClient(client => client.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1", [legacy.ticketId]));
      __setVendorLinkKillSwitchForTests(false);
      const off = await loadVendorJob(legacy.token);
      assert.ok(off && !("vendorLink" in off));
      assert.equal(off.title, "B026 private title");
      assert.equal(off.description, "B026 private description");
      assert.deepEqual(off.issuePhotos, [{ id: visible.id, name: visible.name }]);
      assert.equal((await getPhoto(legacy, visible.id)).status, 302);
      await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_link\":false}'::jsonb WHERE id=$1", [ORG_ID]));
      __setVendorLinkKillSwitchForTests(true);
      assert.equal(JSON.stringify(await loadVendorJob(legacy.token)), JSON.stringify(off));
      assert.equal((await getPhoto(legacy, visible.id)).status, 302);
      await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_link\":true}'::jsonb WHERE id=$1", [ORG_ID]));
    });

    await t.test("V-12 both OFF configurations keep the baseline mutation query sequence", async () => {
      await approvals(false);
      const job = await issue();
      const versionId = await estimateFor(job.ticketId);
      const body = { token: job.token, versionId, requestId: randomUUID(), action: "reject", reason: "Unavailable" };
      const input = { orgId: ORG_ID, vendorJobId: job.jobId, versionId, requestId: randomUUID(),
        eventKind: "vendor_rejected" as const, reason: "Unavailable" };
      const traces: string[][][] = [];
      const notifications: string[] = [];
      for (const [kill, org] of [[false, true], [true, false]]) {
        __setVendorLinkKillSwitchForTests(kill);
        await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('vendor_link',$2::boolean) WHERE id=$1", [ORG_ID, org]));
        const response = await trace(() => respond(request("/api/vendor-job-response", body)));
        const completion = await trace(() => complete(request("/api/vendor-job-completion", body)));
        const policy = await orgVendorDispatchPolicy(ORG_ID);
        assert.equal(policy.enhanced, false);
        const gateway = await trace(() => recordVendorAppointment({ token: job.token, enhanced: policy.enhanced }, input));
        const notes = await trace(() => centerVendorItems(job.token).then(page => ({ page }), (error: unknown) => ({ error: (error as Error).constructor.name })));
        assert.equal(notes.sql.length, 5, "notification read: BEGIN, claim, role, one gateway call, end");
        // Kill ON uses the B-026 sibling gateway (it delegates to B-028 when the org is not
        // enhanced); apart from that one name/column, the statement sequence is identical.
        const normalized = (t: typeof notes) => JSON.stringify({ value: t.value, sql: t.sql.map(sql =>
          sql.replace(",read_only FROM app.b026_center_vendor(", " FROM app.b028_center_vendor(")) });
        if (kill) {
          // Same org state through the unchanged B-028 gateway (kill OFF) is the legacy baseline.
          __setVendorLinkKillSwitchForTests(false);
          const baseline = await trace(() => centerVendorItems(job.token).then(page => ({ page }), (error: unknown) => ({ error: (error as Error).constructor.name })));
          __setVendorLinkKillSwitchForTests(true);
          assert.equal(normalized(notes), normalized(baseline), "kill ON + org OFF notification read equals the B-028 baseline");
          assert.ok(notes.sql.some(sql => sql.includes("FROM app.b026_center_vendor(")));
        }
        notifications.push(normalized(notes));
        assert.equal(response.value.status, 403); // baseline B-024 reader privilege failure
        assert.equal(completion.value.status, 403);
        assert.equal(gateway.value.status, "recorded");
        for (const [operation, reader] of [[response, "FROM app.b013_estimate_heads"], [completion, "FROM app.b013_repair_commands c"]] as const) {
          // Baseline: open-job tx, dispatch-flag tx, approval flag SELECT, reader tx.
          assert.equal(operation.sql.length, 16);
          assert.deepEqual(operation.sql.filter(sql => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)),
            ["BEGIN", "COMMIT", "BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
          assert.match(operation.sql[3], /^SELECT job_id::text, org_id::text, ticket_id::text FROM app.open_vendor_job/);
          assert.equal(operation.sql[8], "SELECT environment::text, plan_tier::text, feature_flags, (SELECT value FROM platform_settings WHERE key = 'vendor_link') AS vendor_link FROM organizations WHERE id = $1");
          assert.ok(operation.sql[10].includes("FROM public.organizations o CROSS JOIN public.platform_settings f"));
          assert.ok(operation.sql[14].includes(reader));
          assert.ok(!operation.sql.some(sql => /advisory|FOR UPDATE|SELECT feature_flags FROM/.test(sql)));
        }
        assert.equal(gateway.sql.length, 5);
        assert.deepEqual(gateway.sql.slice(0, 3), ["BEGIN", "SELECT set_config('request.jwt.claim.role', 'service_role', true)", "SET LOCAL ROLE service_role"]);
        assert.match(gateway.sql[3], /^SELECT app.b013_record_vendor_appointment\(/);
        assert.equal(gateway.sql[4], "COMMIT");
        traces.push([response.raw, completion.raw, gateway.raw]);
      }
      assert.deepEqual(traces[0], traces[1], "OFF SQL text and transaction boundaries must match byte for byte");
      assert.equal(notifications.length, 2);
      await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_link\":true}'::jsonb WHERE id=$1", [ORG_ID]));
      __setVendorLinkKillSwitchForTests(true);
      await approvals(false);
    });

    await t.test("request advisory lock precedes ticket/jobs when staff and vendor share a request ID", async () => {
      const job = await issue();
      await approveVendorSharing(admin, job.ticketId, job.jobId, { description: "Approved", attachmentIds: [] });
      const versionId = await estimateFor(job.ticketId);
      const requestId = randomUUID();
      const staff = new Client({ connectionString: process.env.DATABASE_URL });
      const observer = new Client({ connectionString: process.env.DATABASE_URL });
      let pending: Promise<Awaited<ReturnType<typeof recordVendorAppointment>>> | undefined;
      try {
        await staff.connect(); await observer.connect();
        await staff.query("BEGIN");
        await staff.query("SET LOCAL statement_timeout='10s'");
        const pid = (await staff.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await staff.query("SELECT pg_advisory_xact_lock(hashtextextended('b013/approval/request/' || $1::text || '/' || $2::text,0))", [admin.userId, requestId]);
        pending = recordVendorAppointment({ token: job.token, enhanced: true }, {
          orgId: ORG_ID, vendorJobId: job.jobId, versionId, requestId,
          eventKind: "vendor_rejected", reason: "Vendor request",
        });
        void pending.catch(() => {});
        const deadline = Date.now() + 10000;
        let waiting = false;
        while (Date.now() < deadline) {
          waiting = (await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event='advisory') AS waiting", [pid])).rows[0].waiting;
          if (waiting) break;
        }
        assert.ok(waiting, "vendor must wait on the shared request advisory lock");
        // Deterministic inversion detector: old code holds this ticket while waiting
        // for staff's request lock, making NOWAIT fail. No timing/sleep assumption.
        await staff.query("SELECT id FROM maintenance_tickets WHERE id=$1 FOR UPDATE NOWAIT", [job.ticketId]);
        await staff.query("SELECT id FROM repair_vendor_jobs WHERE ticket_id=$1 ORDER BY id FOR UPDATE NOWAIT", [job.ticketId]);
        await staff.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)", [admin.userId]);
        await staff.query("SET LOCAL ROLE service_role");
        const result = await staff.query(`SELECT app.b013_record_appointment($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,'vendor_rejected',NULL,NULL,NULL,NULL,$8::bytea,'Staff request') AS r`,
          [admin.orgId, admin.liveOrgId, admin.environment, admin.sessionId, requestId, versionId, job.jobId, Buffer.alloc(32, 1)]);
        assert.equal(result.rows[0].r.status, "recorded");
        await staff.query("COMMIT");
        assert.equal((await pending).status, "rejected_conflict");
      } finally {
        await staff.query("ROLLBACK");
        try { await pending; } finally { await Promise.all([staff.end(), observer.end()]); }
      }
      await approvals(false);
    });

    await t.test("open enhanced appointment gateway remains mutable", async () => {
      const job = await issue();
      await approveVendorSharing(admin, job.ticketId, job.jobId, { description: "Approved", attachmentIds: [] });
      await approvals(true);
      const property = await withClient(async client => {
        const row = (await client.query(`SELECT p.currency::text currency, r.minor_unit FROM maintenance_tickets t
          JOIN properties p ON p.id=t.property_id JOIN organizations o ON o.id=t.org_id
          JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency
          WHERE t.id=$1`, [job.ticketId])).rows[0];
        await client.query("UPDATE property_owners SET repair_approval_threshold_minor=500000 WHERE org_id=$1", [ORG_ID]);
        return row;
      });
      const estimate = await submitEstimate(admin, {
        ticketId: job.ticketId, requestId: randomUUID(), expectedHeadId: null, amountMinor: 100,
        currency: property.currency.trim(), minorUnit: property.minor_unit, workScope: "Repair pipe", evidence: [],
      });
      assert.equal(estimate.status, "recorded");
      const replayRequestId = randomUUID();
      for (const eventKind of ["vendor_proposed", "vendor_completion_submitted"] as const) {
        const result = await recordVendorAppointment({ token: job.token, enhanced: true }, {
          orgId: ORG_ID, vendorJobId: job.jobId, versionId: String(estimate.version_id), requestId: eventKind === "vendor_proposed" ? replayRequestId : randomUUID(),
          eventKind, reason: "Local fixture", proposedStart: "2027-01-01T10:00:00Z", proposedEnd: "2027-01-01T11:00:00Z",
        });
        assert.equal(result.status, "recorded");
      }
      // Observe an actual lock wait: closure commits while the enhanced gateway waits.
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      const observer = new Client({ connectionString: process.env.DATABASE_URL });
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.connect();
        await observer.connect();
        await blocker.query("BEGIN");
        const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await blocker.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1", [job.ticketId]);
        const closedRows = await snapshot(blocker);
        const input = {
          orgId: ORG_ID, vendorJobId: job.jobId, versionId: String(estimate.version_id), requestId: replayRequestId,
          eventKind: "vendor_proposed" as const, reason: "Local fixture",
          proposedStart: "2027-01-01T10:00:00Z", proposedEnd: "2027-01-01T11:00:00Z",
        };
        pending = recordVendorAppointment({ token: job.token, enhanced: true }, input).then(
          () => { throw new Error("closed enhanced replay must reject"); }, error => { assert.ok(denied(error)); },
        );
        const deadline = Date.now() + 10000;
        let waiting = false;
        while (Date.now() < deadline) {
          waiting = (await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting", [pid])).rows[0].waiting;
          if (waiting) break;
        }
        assert.ok(waiting, "gateway must wait for the ticket lock");
        await blocker.query("COMMIT");
        await pending;
        assert.deepEqual(await snapshot(), closedRows, "closed replay writes no ledger, event, or audit rows");
      } finally {
        await blocker.query("ROLLBACK");
        try { await pending; } finally { await Promise.all([blocker.end(), observer.end()]); }
      }
    });
  } finally {
    __setVendorLinkKillSwitchForTests(false);
    globalThis.fetch = fetchBefore;
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    try {
      await withClient(async client => {
        await client.query("UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1", [ORG_ID, JSON.stringify(saved.flags)]);
        await client.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='repair_approvals'", [JSON.stringify(saved.approvals)]);
        await client.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='notification_center_v2'", [JSON.stringify(saved.notifications)]);
        assert.deepEqual((await client.query("SELECT value FROM platform_settings WHERE key='notification_center_v2'")).rows[0].value, saved.notifications);
        assert.deepEqual((await client.query("SELECT feature_flags FROM organizations WHERE id=$1", [ORG_ID])).rows[0].feature_flags, saved.flags);
        assert.deepEqual((await client.query("SELECT value FROM platform_settings WHERE key='repair_approvals'")).rows[0].value, saved.approvals);
      });
    } finally { await clone.cleanup(); }
  }
});
