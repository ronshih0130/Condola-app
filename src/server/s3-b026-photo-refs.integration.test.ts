import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withClient } from "./db";
import { createTicket } from "./domain";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { __setVendorLinkKillSwitchForTests, approveVendorSharing, dispatchVendor } from "./vendor-repair";
import { managerVendorEstimates, submitVendorEstimate } from "./vendor-estimates";
import { ownerPending } from "./repair-approval";
import { PHOTO_BUCKET, ticketPhotoPath } from "./repair-rules";
import type { VendorEstimateInput } from "./vendor-estimate-rules";
import { hashVendorToken } from "./vendor-repair-rules";
import type { Session } from "./types";

// Session 3 cross-stack: B-026 vendor estimate evidence must satisfy the B-028 package 4
// photo rule (same org + ticket attachment, backed by a same-org file in the private
// ticket-photo bucket, not internal), not only the B-013 shape check. The B-026 vendor-job
// allowlist (42501) keeps its precedence; refs it accepts but the B-028 rule rejects are a
// recorded rejected_invalid command with no domain write and nothing exposed to readers.

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
const admin: Session = { userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID, sessionId: randomUUID(),
  email: "staff@demo", name: "Staff", kind: "staff", role: "admin", environment: "live",
  locale: "zh-TW", calendar: "gregorian", leaseId: null };
const tenant: Session = { ...admin, userId: USERS.tenant2, sessionId: randomUUID(), kind: "tenant", role: null };
const tables = ["public.maintenance_tickets", "public.repair_vendor_jobs", "public.files", "public.ticket_attachments",
  "public.audit_log", "app.b026_vendor_estimates", "app.b013_estimate_heads", "app.b013_estimate_versions",
  "app.b013_estimate_decisions", "app.b013_repair_commands", "app.b013_repair_appointments",
  "app.b013_repair_emergencies", "app.b013_repair_event_outbox"];
async function snapshot() {
  return withClient(async client => {
    const out: Record<string, string> = {};
    for (const name of tables) out[name] = (await client.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) hash FROM ${name} r`)).rows[0].hash;
    return out;
  });
}
async function commands(requestId: string) {
  return withClient(async client => (await client.query(
    "SELECT operation_kind,outcome,result_version_id FROM app.b013_repair_commands WHERE request_id=$1", [requestId])).rows);
}
async function issue() {
  await withClient(client => client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"repair_approvals\":false}' WHERE id=$1", [ORG_ID]));
  const lease = await withClient(client => client.query(`SELECT l.id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id
    JOIN contacts c ON c.id=lp.contact_id WHERE c.user_id=$1 AND l.org_id=$2 AND l.status='active' ORDER BY l.id LIMIT 1`, [USERS.tenant2, ORG_ID]));
  const ticketId = await createTicket(tenant, { leaseId: lease.rows[0].id, category: "plumbing", title: "S3 photo fixture", description: "Private request" });
  const job = await dispatchVendor(admin, ticketId, { vendorName: `S3-${randomUUID()}`, vendorPhone: "0912000111",
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
/** A real vendor-job photo: private-bucket file + non-internal ticket attachment linked to the job. */
async function attachment(job: Job, options: { internal?: boolean; vendorJob?: string | null } = {}) {
  const id = randomUUID(), fileId = randomUUID();
  await withClient(async client => {
    await client.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes)
      VALUES($1,$2,$3,$4,'estimate.jpg','image/jpeg',4)`, [fileId, ORG_ID, PHOTO_BUCKET, ticketPhotoPath(ORG_ID, job.ticketId, fileId, "image/jpeg")]);
    await client.query(`INSERT INTO ticket_attachments(id,org_id,ticket_id,file_id,is_internal,vendor_job_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [id, ORG_ID, job.ticketId, fileId, options.internal ?? false,
      options.vendorJob === undefined ? job.jobId : options.vendorJob]);
  });
  return { id, fileId };
}
async function owner(job: Job): Promise<Session> {
  const userId = await withClient(async client => (await client.query(`SELECT c.user_id FROM maintenance_tickets t
    JOIN property_owners po ON po.org_id=t.org_id AND po.property_id=t.property_id
    JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
    WHERE t.id=$1 AND c.is_owner AND c.user_id IS NOT NULL AND c.archived_at IS NULL ORDER BY po.id LIMIT 1`, [job.ticketId])).rows[0].user_id);
  const sessionId = randomUUID();
  await withClient(client => client.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sessionId, userId, randomUUID()]));
  return { ...admin, userId, sessionId, kind: "owner", role: null };
}
/** Ids every reader (manager B-026 comparison, owner B-013 pending) exposes for this ticket. */
async function exposed(job: Job, ownerSession: Session) {
  const manager = (await managerVendorEstimates(admin, job.ticketId)).flatMap(row => row.photos.map(photo => photo.id));
  const pending = (await ownerPending(ownerSession)).filter(row => (row as { ticket_id?: string }).ticket_id === job.ticketId)
    .flatMap(row => ((row as { evidence_snapshot?: { id: string }[] }).evidence_snapshot ?? []).map(photo => photo.id));
  return { manager, pending };
}

test("S3 cross-stack: B-026 vendor estimate evidence uses the B-028 repair photo rule", async t => {
  const clone = await cloneTestDatabase();
  try {
    await withClient(async client => {
      for (const session of [admin, tenant]) await client.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [session.sessionId, session.userId, randomUUID()]);
      await client.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true,\"vendor_estimates\":true}' WHERE id=$1", [ORG_ID]);
      await client.query("UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'", [ORG_ID]);
      await client.query("UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='vendor_estimates'", [ORG_ID]);
      await client.query("UPDATE property_owners SET repair_approval_threshold_minor=500000 WHERE org_id=$1", [ORG_ID]);
    });

    await t.test("a job photo whose file left the private bucket is rejected_invalid (ledger only) and never exposed", async () => {
      const job = await issue();
      const ownerSession = await owner(job);
      const valid = await attachment(job), moved = await attachment(job);
      // The attachment trigger only checks the bucket when the attachment is written;
      // moving the file afterwards is the gap the B-028 rule closes.
      await withClient(client => client.query("UPDATE files SET storage_bucket='ticket-files-other' WHERE id=$1", [moved.fileId]));
      for (const evidence of [[{ id: moved.id }], [{ id: valid.id }, { id: moved.id }]]) {
        const requestId = randomUUID();
        const before = await snapshot();
        const result = await submitVendorEstimate(job.token, { ...job.input, requestId, evidence });
        const after = await snapshot();
        const changed = Object.keys(before).filter(name => before[name] !== after[name]);
        const seen = await exposed(job, ownerSession);
        assert.deepEqual({ result, changed, commands: await commands(requestId), seen },
          { result: { status: "rejected_invalid" }, changed: ["app.b013_repair_commands"],
            commands: [{ operation_kind: "submit", outcome: "rejected_invalid", result_version_id: null }],
            seen: { manager: [], pending: [] } });
        // Exact replay returns the stored rejection without another write.
        const replayBefore = await snapshot();
        assert.deepEqual(await submitVendorEstimate(job.token, { ...job.input, requestId, evidence }), { status: "rejected_invalid" });
        assert.deepEqual(await snapshot(), replayBefore);
      }
      // Positive control: an authorized private photo of this job is recorded and projected as {id} only.
      const ok = await submitVendorEstimate(job.token, { ...job.input, requestId: randomUUID(), evidence: [{ id: valid.id }] });
      assert.equal(ok.status, "recorded");
      assert.deepEqual(await exposed(job, ownerSession), { manager: [valid.id], pending: [valid.id] });
      const rows = await managerVendorEstimates(admin, job.ticketId);
      assert.deepEqual(rows.map(row => row.photos), [[{ id: valid.id }]]);
      assert.ok(!JSON.stringify(rows).includes(PHOTO_BUCKET) && !JSON.stringify(rows).includes(valid.fileId));
    });

    await t.test("the B-026 vendor-job allowlist keeps 42501 precedence with zero writes", async () => {
      const job = await issue(), other = await issue();
      const internal = await attachment(job, { internal: true });
      const unassigned = await attachment(job, { vendorJob: null });
      const foreignTicket = await attachment(other);
      for (const ref of [internal.id, unassigned.id, foreignTicket.id, randomUUID()]) {
        const before = await snapshot();
        await assert.rejects(submitVendorEstimate(job.token, { ...job.input, requestId: randomUUID(), evidence: [{ id: ref }] }));
        // Same call at the gateway, to observe the SQLSTATE the wrapper redacts.
        await assert.rejects(withClient(async client => {
          await client.query("BEGIN");
          try {
            await client.query("SET LOCAL ROLE service_role");
            await client.query("SELECT app.b026_submit_vendor_estimate($1::text,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::smallint,$7::text,$8::jsonb)",
              [hashVendorToken(job.token), randomUUID(), null, "500001", job.input.currency, job.input.minorUnit, "Replace valve", JSON.stringify([{ id: ref }])]);
          } finally { await client.query("ROLLBACK"); }
        }), (error: { code?: string }) => error.code === "42501");
        assert.deepEqual(await snapshot(), before);
      }
    });

    await t.test("catalog: B-026 submit calls the B-028 rule; helper stays private and executable by the definer", async () => {
      await withClient(async client => {
        const row = (await client.query(`SELECT p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) def,pg_get_userbyid(p.proowner) owner,
          has_function_privilege(pg_get_userbyid(p.proowner),'app.b028_repair_photo_refs(uuid,uuid,jsonb,integer)','EXECUTE') owner_exec
          FROM pg_proc p WHERE p.oid='app.b026_submit_vendor_estimate(text,uuid,uuid,bigint,text,smallint,text,jsonb)'::regprocedure`)).rows[0];
        assert.equal(row.prosecdef, true);
        assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public, app, pg_temp"]);
        assert.equal(row.owner_exec, true);
        const body = row.def.replace(/--[^\n]*/g, "");
        // Shape precondition before the vendor-job allowlist stays; the stored validation uses the B-028 rule.
        assert.equal(body.match(/app\.b013_photo_refs\(/g)?.length, 1);
        assert.equal(body.match(/app\.b028_repair_photo_refs\(p_org, ?p_ticket, ?p_evidence, ?0\)/g)?.length, 1);
        for (const role of ["anon", "authenticated", "service_role"]) {
          assert.equal((await client.query("SELECT has_function_privilege($1,'app.b028_repair_photo_refs(uuid,uuid,jsonb,integer)','EXECUTE') ok", [role])).rows[0].ok, false);
        }
        assert.equal((await client.query("SELECT has_function_privilege('service_role','app.b026_submit_vendor_estimate(text,uuid,uuid,bigint,text,smallint,text,jsonb)','EXECUTE') ok")).rows[0].ok, true);
        for (const role of ["anon", "authenticated"]) {
          assert.equal((await client.query("SELECT has_function_privilege($1,'app.b026_submit_vendor_estimate(text,uuid,uuid,bigint,text,smallint,text,jsonb)','EXECUTE') ok", [role])).rows[0].ok, false);
        }
      });
    });
  } finally { await clone.cleanup(); }
});
