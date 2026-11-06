import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test, { mock } from "node:test";
import { Client, type QueryResult } from "pg";
import { withClient } from "./db";
import { createTicket } from "./domain";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { __setVendorLinkKillSwitchForTests, approveVendorSharing, dispatchVendor, loadVendorJob, loadVendorDispatch } from "./vendor-repair";
import { submitVendorEstimate, managerVendorEstimates, vendorEstimateContext } from "./vendor-estimates";
import { decideEstimate, recordVendorAppointment, repairApprovalsEnabled, managerApprovalView } from "./repair-approval";
import { hashVendorToken } from "./vendor-repair-rules";
import { PHOTO_BUCKET, ticketPhotoPath } from "./repair-rules";
import { POST } from "../app/api/vendor-estimate/route";
import type { VendorEstimateInput } from "./vendor-estimate-rules";
import type { Session } from "./types";
import { ticketDetail } from "./queries";
import { ApprovalPanel } from "../app/m/tickets/[id]/approval-panel";
import { VendorEstimatePanel } from "../app/m/tickets/[id]/vendor-estimate-panel";
import { isValidElement, type ReactNode } from "react";

async function renderEstimateChildren(node: ReactNode): Promise<void> {
  if (Array.isArray(node)) { for (const child of node) await renderEstimateChildren(child); }
  else if (isValidElement<{ children?: ReactNode }>(node)) {
    if (node.type === VendorEstimatePanel) {
      await VendorEstimatePanel(node.props as Parameters<typeof VendorEstimatePanel>[0]);
    } else await renderEstimateChildren(node.props.children);
  }
}
async function trace(work: () => Promise<unknown>) {
  const spy = mock.method(Client.prototype, "query");
  try { await work(); return spy.mock.calls.map(call => String(call.arguments[0])); }
  finally { spy.mock.restore(); }
}


disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
const admin: Session = { userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID, sessionId: randomUUID(),
  email: "staff@demo", name: "Staff", kind: "staff", role: "admin", environment: "live",
  locale: "zh-TW", calendar: "gregorian", leaseId: null };
const tenant: Session = { ...admin, userId: USERS.tenant2, sessionId: randomUUID(), kind: "tenant", role: null };
const foreign: Session = { ...admin, userId: USERS.coastAdmin, sessionId: randomUUID() };
const tables = ["public.maintenance_tickets", "public.repair_vendor_jobs", "public.repair_vendor_secrets",
  "public.repair_vendor_job_shared_photos", "public.files", "public.ticket_attachments", "public.ticket_comments",
  "public.expenses", "public.audit_log", "app.b026_vendor_estimates", "app.b013_estimate_heads",
  "app.b013_estimate_versions", "app.b013_estimate_decisions", "app.b013_repair_commands",
  "app.b013_repair_appointments", "app.b013_repair_emergencies", "app.b013_repair_event_outbox"];
async function snapshot(on?: Client) {
  const read = async (client: Client) => {
    const out: Record<string, string> = {};
    for (const name of tables) out[name] = (await client.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) hash FROM ${name} r`)).rows[0].hash;
    return out;
  };
  return on ? read(on) : withClient(read);
}
async function setting(value: unknown, orgFlag: unknown = true) {
  await withClient(async client => {
    await client.query("UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_estimates'", [JSON.stringify(value)]);
    await client.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('vendor_estimates',$2::jsonb) WHERE id=$1", [ORG_ID, JSON.stringify(orgFlag)]);
  });
}
const on = () => setting({ enabled: true, allowed_org_ids: [ORG_ID] });
async function issue() {
  await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"repair_approvals\":false}' WHERE id=$1", [ORG_ID]));
  const lease = await withClient(client => client.query(`SELECT l.id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id
    JOIN contacts c ON c.id=lp.contact_id WHERE c.user_id=$1 AND l.org_id=$2 AND l.status='active' ORDER BY l.id LIMIT 1`, [USERS.tenant2, ORG_ID]));
  const ticketId = await createTicket(tenant, { leaseId: lease.rows[0].id, category: "plumbing", title: "Estimate fixture", description: "Private request" });
  const job = await dispatchVendor(admin, ticketId, { vendorName: `B026-${randomUUID()}`, vendorPhone: "0912000111",
    vendorTrade: "plumbing", contactWindow: "Monday" }, origin);
  __setVendorLinkKillSwitchForTests(true);
  try { await approveVendorSharing(admin, ticketId, job.jobId, { description: "Approved work", attachmentIds: [] }); }
  finally { __setVendorLinkKillSwitchForTests(false); }
  await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"repair_approvals\":true}' WHERE id=$1", [ORG_ID]));
  const token = new URL(job.url).pathname.slice(3);
  const region = await withClient(async client => (await client.query(`SELECT p.currency::text currency,r.minor_unit FROM maintenance_tickets t
    JOIN properties p ON p.id=t.property_id JOIN organizations o ON o.id=t.org_id
    JOIN app.b013_regional_defaults r ON r.country_code=o.country_code::text AND r.currency=p.currency WHERE t.id=$1`, [ticketId])).rows[0]);
  const input: VendorEstimateInput = { requestId: randomUUID(), expectedHeadId: null, amountMinor: BigInt(500001),
    currency: region.currency.trim(), minorUnit: region.minor_unit, workScope: "Replace valve", evidence: [] };
  return { ...job, ticketId, token, input };
}
type Job = Awaited<ReturnType<typeof issue>>;
async function attachment(job: Job) {
  const id = randomUUID(), fileId = randomUUID();
  await withClient(async client => {
    await client.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes)
      VALUES($1,$2,$3,$4,'estimate.jpg','image/jpeg',4)`, [fileId, ORG_ID, PHOTO_BUCKET, ticketPhotoPath(ORG_ID, job.ticketId, fileId, "image/jpeg")]);
    await client.query(`INSERT INTO ticket_attachments(id,org_id,ticket_id,file_id,is_internal,vendor_job_id)
      VALUES($1,$2,$3,$4,false,$5)`, [id, ORG_ID, job.ticketId, fileId, job.jobId]);
  });
  return { id };
}
async function http(job: Job, input = job.input) {
  return POST(new Request(origin + "/api/vendor-estimate", { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token: job.token, ...input, amountMinor: input.amountMinor.toString() }) }));
}
async function waitForLock(client: Client, fragment: string, polling = false) {
  for (let i = 0; i < 100; i++) {
    await client.query("SELECT pg_stat_clear_snapshot()");
    const result = await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (CASE WHEN $2 THEN wait_event='PgSleep' ELSE wait_event_type='Lock' END) AND position($1 in query)>0", [fragment, polling]);
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Expected observed PostgreSQL lock wait");
}

test("B-026 vendor estimate submission and manager comparison", async t => {
  const clone = await cloneTestDatabase();
  try {
    await withClient(async client => {
      const flag = (await client.query("SELECT value FROM platform_settings WHERE key='vendor_estimates'")).rows[0].value;
      assert.deepEqual(flag, { enabled: false, allowed_org_ids: [] });
      for (const session of [admin, tenant, foreign]) await client.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [session.sessionId, session.userId, randomUUID()]);
      await client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}' WHERE id=$1", [ORG_ID]);
      await client.query("UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'", [ORG_ID]);
      await client.query("UPDATE property_owners SET repair_approval_threshold_minor=500000 WHERE org_id=$1", [ORG_ID]);
    });
    const job = await issue();
    await t.test("OFF and malformed flags: zero writes; legacy response and source unchanged", async () => {
      const legacy = JSON.stringify(await loadVendorJob(job.token));
      for (const [global, org] of [
        [{ enabled: false, allowed_org_ids: [ORG_ID] }, true],
        [{ enabled: "true", allowed_org_ids: [ORG_ID] }, true],
        [{ enabled: true, allowed_org_ids: ORG_ID }, true],
        [{ enabled: true, allowed_org_ids: [ORG2_ID] }, true],
        [{ enabled: true, allowed_org_ids: [ORG_ID] }, "true"],
        [{ enabled: true, allowed_org_ids: [ORG_ID] }, false], [null, true], [{}, null],
      ] as [unknown, unknown][]) {
        await setting(global, org);
        const before = await snapshot();
        assert.deepEqual(await submitVendorEstimate(job.token, job.input), { status: "rejected_disabled" });
        assert.equal(await vendorEstimateContext(job.token), null);
        assert.deepEqual(await managerVendorEstimates(admin, job.ticketId), []);
        assert.equal((await http(job)).status, 200);
        assert.deepEqual(await snapshot(), before);
        assert.equal(JSON.stringify(await loadVendorJob(job.token)), legacy);
      }
      const file = "src/app/v/[token]/page.tsx";
      // B-035 (#83) adds a strictly flag-gated "Continue in LINE" entry to this page. Strip exactly
      // those reviewed additions; everything else must still equal the B-026 baseline byte for byte.
      const withoutB035 = (source: string) => source
        .replace('import { vendorLineEntryEnabled } from "@/server/line/vendor-entry";\n', "")
        .replace('import { VendorLineEntry } from "./vendor-line-entry";\n', "")
        .replace(/  \/\/ B-035: only while[^\n]*\n  const showLine = [^\n]*\n  const lineEntry = showLine\n[^\n]*\n[^\n]*\n/, "")
        .replace(/\{lineEntry \? <><VendorNotificationCenterEntry token=\{token\} locale=\{prefs\.locale\} \/>\{lineEntry\}<\/>\n\s*: (<VendorNotificationCenterEntry token=\{token\} locale=\{prefs\.locale\} \/>)\}/g, "$1");
      assert.equal(withoutB035(readFileSync(file, "utf8")), execFileSync("git", ["show", `4c3f3f7:${file}`], { encoding: "utf8" }));
      await on();
    });
    await t.test("manager page estimate OFF retains baseline query count and transactions", async () => {
      for (const [global, org] of [
        [{ enabled: false, allowed_org_ids: [ORG_ID] }, true],
        [{ enabled: true, allowed_org_ids: [ORG_ID] }, false],
        [{ enabled: "true", allowed_org_ids: [ORG_ID] }, true],
        [{ enabled: true, allowed_org_ids: [ORG2_ID] }, true],
      ] as [unknown, unknown][]) {
        await setting(global, org);
        const pageData = async () => {
          await ticketDetail(admin, job.ticketId);
          await loadVendorDispatch(admin, job.ticketId, origin);
        };
        // The pre-slice manager page: detail, dispatch, then B-013 panel.
        const baseline = await trace(async () => {
          await pageData();
          if (await repairApprovalsEnabled(admin.orgId)) await managerApprovalView(admin, { ticketId: job.ticketId });
        });
        const current = await trace(async () => {
          await pageData();
          await renderEstimateChildren(await ApprovalPanel({ session: admin, ticketId: job.ticketId }));
        });
        assert.equal(current.length, baseline.length, "OFF must add zero client queries");
        t.diagnostic(`Manager OFF queries: baseline=${baseline.length}, current=${current.length}`);
        const withoutPolicy = (sql: string[]) => sql.filter(q => !q.includes("AS enabled"));
        assert.deepEqual(withoutPolicy(current), withoutPolicy(baseline), "all other SQL and transaction boundaries stay identical");
        assert.equal(current.filter(q => q.includes("AS enabled")).length, 1);
        assert.ok(!current.some(q => q.includes("b026_manager_estimates")));
      }
      await on();
      const enabled = await trace(async () => {
        await renderEstimateChildren(await ApprovalPanel({ session: admin, ticketId: job.ticketId }));
      });
      assert.equal(enabled.filter(q => q.includes("b026_manager_estimates")).length, 1, "ON control reaches the estimate reader");
      const page = readFileSync("src/app/m/tickets/[id]/page.tsx", "utf8");
      assert.ok(page.includes("<ApprovalPanel"));
      assert.ok(!page.includes("<VendorEstimatePanel"), "page must not mount an ungated second reader");
    });
    await t.test("concurrent platform/org disable during property contention rejects with zero writes", async () => {
      const blocked = await issue();
      for (const control of ["vendor_estimates", "repair_approvals", "org:vendor_estimates", "org:repair_approvals", "org:vendor_dispatch"]) {
        const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
        let pending: ReturnType<typeof submitVendorEstimate> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT p.id FROM properties p JOIN maintenance_tickets t ON t.property_id=p.id WHERE t.id=$1 FOR UPDATE OF p", [blocked.ticketId]);
          pending = submitVendorEstimate(blocked.token, blocked.input);
          await waitForLock(blocker, "b026_submit_vendor_estimate", true);
          // Every failed attempt releases flags and ticket, not just the last lock.
          await blocker.query("SELECT id FROM maintenance_tickets WHERE id=$1 FOR UPDATE NOWAIT", [blocked.ticketId]);
          if (control.startsWith("org:")) {
            await blocker.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE NOWAIT", [ORG_ID]);
            await blocker.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,false) WHERE id=$1", [ORG_ID, control.slice(4)]);
          } else {
            await blocker.query("SELECT key FROM platform_settings WHERE key=$1 FOR UPDATE NOWAIT", [control]);
            await blocker.query("UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false') WHERE key=$1", [control]);
          }
          // Include only the disabling transaction's own audit; the submission must add nothing.
          const before = await snapshot(blocker);
          await blocker.query("COMMIT");
          assert.deepEqual(await pending, { status: "rejected_disabled" });
          assert.deepEqual(await snapshot(), before);
        } finally {
          await blocker.query("ROLLBACK"); await blocker.end(); if (pending) await pending.catch(() => undefined);
          await on();
          await withClient(async client => {
            await client.query("UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','true') WHERE key='repair_approvals'");
            await client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"repair_approvals\":true,\"vendor_dispatch\":true}' WHERE id=$1", [ORG_ID]);
          });
        }
      }
    });
    await t.test("successful admission holds both platform flags and organization through commit", async () => {
      const job = await issue();
      let head: string | null = null;
      for (const control of ["vendor_estimates", "repair_approvals", "organization"]) {
        const writer = new Client({ connectionString: process.env.DATABASE_URL });
        const disabler = new Client({ connectionString: process.env.DATABASE_URL });
        await writer.connect(); await disabler.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await writer.query("BEGIN"); await disabler.query("BEGIN");
          const submitted: QueryResult<{ result: { status: string; version_id: string } }> = await writer.query(`SELECT app.b026_submit_vendor_estimate(
            $1::text,$2::uuid,$3::uuid,1::bigint,$4::text,$5::smallint,'Work','[]'::jsonb) result`,
          [hashVendorToken(job.token), randomUUID(), head, job.input.currency, job.input.minorUnit]);
          assert.equal(submitted.rows[0].result.status, "recorded");
          head = submitted.rows[0].result.version_id;
          if (control === "organization") {
            pending = disabler.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('vendor_estimates',false) WHERE id=$1", [ORG_ID]);
          } else {
            pending = disabler.query("UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false') WHERE key=$1", [control]);
          }
          await waitForLock(writer, control === "organization" ? "UPDATE organizations" : "UPDATE platform_settings");
          await writer.query("COMMIT");
          await pending;
        } finally {
          await writer.query("ROLLBACK");
          if (pending) await pending.catch(() => undefined);
          await disabler.query("ROLLBACK"); await writer.end(); await disabler.end();
        }
      }
    });
    await t.test("appointment job-first interleaves with estimate without deadlock for either enhanced flag state", async () => {
      for (const enhanced of [false, true]) {
        const concurrent = await issue();
        const first = await submitVendorEstimate(concurrent.token, { ...concurrent.input, amountMinor: BigInt(1) });
        await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('vendor_link',$2::boolean) WHERE id=$1", [ORG_ID, enhanced]));
        const appointment = new Client({ connectionString: process.env.DATABASE_URL }); await appointment.connect();
        let pending: ReturnType<typeof submitVendorEstimate> | undefined;
        try {
          await appointment.query("BEGIN");
          await appointment.query("SET LOCAL statement_timeout='8s'");
          // Exact first lock in legacy b013_record_vendor_appointment.
          await appointment.query("SELECT id FROM repair_vendor_jobs WHERE id=$1 FOR SHARE", [concurrent.jobId]);
          pending = submitVendorEstimate(concurrent.token, { ...concurrent.input, requestId: randomUUID(),
            expectedHeadId: String(first.version_id), amountMinor: BigInt(2) });
          await waitForLock(appointment, "b026_submit_vendor_estimate", true);
          // The estimate acquired ticket before failing on job; NOWAIT retry must release ticket.
          await appointment.query("SELECT id FROM maintenance_tickets WHERE id=$1 FOR UPDATE NOWAIT", [concurrent.ticketId]);
          const result = await appointment.query(`SELECT app.b013_record_vendor_appointment(
            $1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,'vendor_proposed',
            '2026-11-08T09:00:00Z','2026-11-08T10:00:00Z',NULL,NULL,NULL,$6::bytea) result`,
          [ORG_ID, concurrent.jobId, hashVendorToken(concurrent.token), randomUUID(), first.version_id, Buffer.alloc(32, 1)]);
          assert.equal(result.rows[0].result.status, "recorded");
          await appointment.query("COMMIT");
          assert.equal((await pending).status, "recorded", "both real gateways finish; no 40P01");
        } finally {
          await appointment.query("ROLLBACK"); await appointment.end(); if (pending) await pending.catch(() => undefined);
          await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('vendor_link',true) WHERE id=$1", [ORG_ID]));
        }
      }
    });
    let first = "";
    await t.test("above threshold starts B-013 pending approval; scheduling/completion blocked until owner approves", async () => {
      const response = await http(job);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.state, "pending_approval"); first = result.version_id;
      const before = await snapshot();
      for (const eventKind of ["vendor_proposed", "vendor_completion_submitted"]) {
        if (eventKind === "vendor_proposed") await assert.rejects(recordVendorAppointment({ token: job.token, enhanced: false }, {
          orgId: ORG_ID, requestId: randomUUID(), versionId: first, vendorJobId: job.jobId, eventKind,
          proposedStart: "2026-11-08T09:00:00Z", proposedEnd: "2026-11-08T10:00:00Z",
        }));
        else {
          const r = await recordVendorAppointment({ token: job.token, enhanced: false }, {
            orgId: ORG_ID, requestId: randomUUID(), versionId: first, vendorJobId: job.jobId, eventKind, reason: "No photo",
          });
          assert.equal(r.status, "rejected_conflict");
        }
      }
      // Completion's existing B-013 ledger records its rejected command; domain stays unchanged.
      const after = await snapshot(); delete before["app.b013_repair_commands"]; delete after["app.b013_repair_commands"];
      assert.deepEqual(after, before);
      await assert.rejects(withClient(client => client.query("UPDATE maintenance_tickets SET scheduled_on='2026-11-08' WHERE id=$1", [job.ticketId])));
      await assert.rejects(withClient(client => client.query("UPDATE repair_vendor_jobs SET reported_at=clock_timestamp() WHERE id=$1", [job.jobId])));
      // QA r2: starting work (status -> in_progress, dates unchanged) is blocked too.
      await assert.rejects(withClient(client => client.query("UPDATE maintenance_tickets SET status='in_progress' WHERE id=$1 AND status::text<>'in_progress'", [job.ticketId])),
        (error: unknown) => (error as { code?: string }).code === "40001");
      const ownerId = await withClient(async client => (await client.query("SELECT designated_principal_id FROM app.b013_estimate_versions WHERE id=$1", [first])).rows[0].designated_principal_id);
      const owner = { ...admin, userId: ownerId, sessionId: randomUUID(), kind: "owner" as const, role: null };
      await withClient(client => client.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [owner.sessionId, owner.userId, randomUUID()]));
      assert.equal((await decideEstimate(owner, { versionId: first, requestId: randomUUID(), decision: "approved" })).status, "recorded");
      assert.equal((await recordVendorAppointment({ token: job.token, enhanced: false }, { orgId: ORG_ID, requestId: randomUUID(),
        versionId: first, vendorJobId: job.jobId, eventKind: "vendor_proposed", proposedStart: "2026-11-08T09:00:00Z", proposedEnd: "2026-11-08T10:00:00Z" })).status, "recorded");
      // After approval the same staff transition succeeds (rolled back to keep later fixtures intact).
      await withClient(async client => {
        await client.query("BEGIN");
        try {
          const started = await client.query("UPDATE maintenance_tickets SET status='in_progress' WHERE id=$1 AND status::text<>'in_progress'", [job.ticketId]);
          assert.equal(started.rowCount, 1);
        } finally { await client.query("ROLLBACK"); }
      });
    });
    await t.test("append revisions, exact replay, payload conflict, below/equal threshold and current document comparison", async () => {
      const photo = await attachment(job);
      const input = { ...job.input, requestId: randomUUID(), expectedHeadId: first, amountMinor: BigInt(500000), evidence: [photo] };
      const result = await submitVendorEstimate(job.token, input);
      assert.equal(result.state, "policy_qualified");
      const before = await snapshot();
      assert.deepEqual(await submitVendorEstimate(job.token, input), result);
      assert.equal((await submitVendorEstimate(job.token, { ...input, workScope: "Changed" })).status, "rejected_conflict");
      assert.equal((await http(job, { ...input, amountMinor: BigInt(1) })).status, 409);
      assert.deepEqual(await snapshot(), before);
      await setting({ enabled: false, allowed_org_ids: [ORG_ID] });
      const disabled = await snapshot();
      assert.deepEqual(await submitVendorEstimate(job.token, input), { status: "rejected_disabled" });
      assert.deepEqual(await snapshot(), disabled);
      await on();
      const lower = await submitVendorEstimate(job.token, { ...input, requestId: randomUUID(), expectedHeadId: String(result.version_id), amountMinor: BigInt(1) });
      assert.equal(lower.requires_owner_decision, false);
      const rows = await managerVendorEstimates(admin, job.ticketId);
      assert.equal(rows.length, 3); assert.equal(rows[0].amountMinor, "1"); assert.deepEqual(rows[0].photos, [photo]);
      assert.equal(rows[2].amountMinor, "500001"); assert.equal(rows[2].isCurrent, false);
      assert.deepEqual((await vendorEstimateContext(job.token))?.photos, [photo]);
      const audit = await withClient(async client => (await client.query("SELECT new_row FROM audit_log WHERE row_id=$1 AND event_type='vendor_estimate_comparison' ORDER BY occurred_at DESC LIMIT 1", [job.ticketId])).rows);
      // Reader audit never contains vendor text or attachment/storage/token details.
      assert.equal(audit.length, 1);
      assert.ok(!JSON.stringify(audit).includes("Replace valve"));
      assert.deepEqual(Object.keys(audit[0].new_row), ["version_ids"]);
      await withClient(async client => {
        await assert.rejects(client.query("UPDATE app.b013_estimate_versions SET amount_minor=0 WHERE id=$1", [first]));
        await assert.rejects(client.query("DELETE FROM app.b026_vendor_estimates WHERE version_id=$1", [first]));
      });
    });
    await t.test("token lifecycle, foreign photos/org and non-member manager denial; private tables inaccessible", async () => {
      const other = await issue(); const photo = await attachment(other);
      const head = (await vendorEstimateContext(job.token))!.headId;
      const input = { ...job.input, requestId: randomUUID(), expectedHeadId: head, evidence: [photo] };
      // A valid different job token cannot revise this job's head or replay its request.
      const versionsBefore = await withClient(client => client.query("SELECT row_to_json(v) row FROM app.b013_estimate_versions v ORDER BY id"));
      assert.equal((await submitVendorEstimate(other.token, { ...other.input, expectedHeadId: head })).status, "rejected_conflict");
      assert.deepEqual((await withClient(client => client.query("SELECT row_to_json(v) row FROM app.b013_estimate_versions v ORDER BY id"))).rows, versionsBefore.rows);
      let before = await snapshot();
      await assert.rejects(submitVendorEstimate(job.token, input));
      await assert.rejects(submitVendorEstimate("x".repeat(48), input));
      await assert.rejects(managerVendorEstimates(foreign, job.ticketId));
      await assert.rejects(managerVendorEstimates({ ...admin, orgId: ORG2_ID, liveOrgId: ORG2_ID }, job.ticketId));
      await assert.rejects(managerVendorEstimates(tenant, job.ticketId));
      assert.deepEqual(await snapshot(), before);
      await withClient(client => client.query("UPDATE repair_vendor_jobs SET revoked_at=clock_timestamp() WHERE id=$1", [other.jobId]));
      before = await snapshot(); await assert.rejects(submitVendorEstimate(other.token, other.input)); assert.deepEqual(await snapshot(), before);
      await withClient(async client => {
        await client.query("SET ROLE service_role");
        await assert.rejects(client.query("SELECT * FROM app.b026_vendor_estimates"));
        await client.query("RESET ROLE");
        for (const role of ["anon", "authenticated"]) {
          await client.query(`SET ROLE ${role}`);
          await assert.rejects(client.query("SELECT app.b026_vendor_estimate_context($1)", [hashVendorToken(job.token)]));
          await client.query("RESET ROLE");
        }
      });
    });
    await t.test("bigint roundtrip above Number.MAX_SAFE_INTEGER and missing/dependency OFF gates", async () => {
      const large = await issue();
      const result = await submitVendorEstimate(large.token, { ...large.input, amountMinor: BigInt("9007199254740993") });
      assert.equal(result.status, "recorded");
      assert.equal((await managerVendorEstimates(admin, large.ticketId))[0].amountMinor, "9007199254740993");
      for (const flag of ["repair_approvals", "vendor_dispatch", "vendor_estimates"]) {
        // Legacy vendor_dispatch deliberately falls back to the plan when absent.
        // Exercise its explicit OFF value; the new estimate/approval gates require a present true value.
        await withClient(client => client.query("UPDATE organizations SET feature_flags=CASE WHEN $2::text='vendor_dispatch' THEN feature_flags||jsonb_build_object($2::text,false) ELSE feature_flags-$2::text END WHERE id=$1", [ORG_ID, flag]));
        const before = await snapshot();
        assert.deepEqual(await submitVendorEstimate(large.token, large.input), { status: "rejected_disabled" });
        assert.deepEqual(await snapshot(), before);
        await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,true) WHERE id=$1", [ORG_ID, flag]));
      }
      await withClient(client => client.query("DELETE FROM platform_settings WHERE key='vendor_estimates'"));
      const before = await snapshot();
      assert.deepEqual(await submitVendorEstimate(large.token, large.input), { status: "rejected_disabled" });
      assert.deepEqual(await snapshot(), before);
      await withClient(client => client.query("INSERT INTO platform_settings(key,value) VALUES('vendor_estimates',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))", [ORG_ID]));
    });
    await t.test("closed/cancelled jobs reject submission and replay without writes", async () => {
      for (const status of ["closed", "cancelled"]) {
        const closed = await issue();
        const input = { ...closed.input, amountMinor: BigInt(1) };
        assert.equal((await submitVendorEstimate(closed.token, input)).status, "recorded");
        await withClient(client => client.query("UPDATE maintenance_tickets SET status=$2 WHERE id=$1", [closed.ticketId, status]));
        const before = await snapshot();
        assert.equal((await http(closed, input)).status, 403);
        await assert.rejects(submitVendorEstimate(closed.token, { ...input, requestId: randomUUID() }));
        await assert.rejects(vendorEstimateContext(closed.token));
        assert.deepEqual(await snapshot(), before);
      }
    });
    await t.test("concurrent same request replays once; competing revisions serialize; request lock precedes ticket/jobs", async () => {
      const concurrent = await issue();
      const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
      let pending: ReturnType<typeof submitVendorEstimate> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('b013/approval/request/' || $1::text || '/' || $2::text,0))", [concurrent.jobId, concurrent.input.requestId]);
        pending = submitVendorEstimate(concurrent.token, concurrent.input);
        await waitForLock(blocker, "b026_submit_vendor_estimate");
        await blocker.query("SELECT id FROM maintenance_tickets WHERE id=$1 FOR UPDATE NOWAIT", [concurrent.ticketId]);
        await blocker.query("SELECT id FROM repair_vendor_jobs WHERE ticket_id=$1 FOR UPDATE NOWAIT", [concurrent.ticketId]);
        const replay = submitVendorEstimate(concurrent.token, concurrent.input);
        await blocker.query("COMMIT");
        const [a, b] = await Promise.all([pending, replay]); assert.deepEqual(a, b); assert.equal(a.status, "recorded");
        const results = await Promise.all([1, 2].map(n => submitVendorEstimate(concurrent.token, {
          ...concurrent.input, requestId: randomUUID(), expectedHeadId: String(a.version_id), amountMinor: BigInt(n),
        })));
        assert.deepEqual(results.map(r => r.status).sort(), ["recorded", "rejected_conflict"]);
        const versions = await withClient(client => client.query("SELECT count(*)::int n FROM app.b013_estimate_versions WHERE ticket_id=$1", [concurrent.ticketId]));
        assert.equal(versions.rows[0].n, 2);
      } finally {
        await blocker.query("ROLLBACK"); await blocker.end(); if (pending) await pending.catch(() => undefined);
      }
    });
    await t.test("closure while waiting for ticket lock denies without writes", async () => {
      const closing = await issue();
      const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1", [closing.ticketId]);
        pending = assert.rejects(submitVendorEstimate(closing.token, closing.input));
        await waitForLock(blocker, "b026_submit_vendor_estimate", true);
        await blocker.query("COMMIT");
        const before = await snapshot(); await pending; assert.deepEqual(await snapshot(), before);
      } finally { await blocker.query("ROLLBACK"); await blocker.end(); if (pending) await pending; }
    });
  } finally { await clone.cleanup(); }
});
