import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { TestContext } from "node:test";
import { hashVendorToken } from "@/server/vendor-repair-rules";

type Result = { status: string; version_id: string; appointment_id: string };
type Command = { signature: string; result: Result };

export async function exerciseHttpRetry(
  t: TestContext,
  post: (request: Request) => Promise<Response>,
  path: string,
  initial: Record<string, unknown>,
  mutations: Record<string, unknown>[],
  afterPhotoCount = 0,
) {
  const token = "v".repeat(43);
  const orgId = randomUUID(), jobId = randomUUID(), ticketId = randomUUID(), versionId = randomUUID();
  let headVersionId = versionId;
  const requestId = randomUUID();
  const payload = { ...initial, token, requestId, versionId };
  const committed = new Map<string, Command>();
  const events: Result[] = [];
  const pending = new Map<Client, { key: string; command: Command } | null>();
  const calls: unknown[][] = [];
  let vendorEnabled = true, approvalsEnabled = true, allowed = true;
  let restrictedReads = 0;
  let permissionError = false;
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "end", async () => {});
  t.mock.method(Client.prototype, "query", async function (
    this: Client, sql: string, values: unknown[] = [],
  ) {
    if (sql === "BEGIN") { pending.set(this, null); return { rows: [] }; }
    if (sql.includes("set_config(") || sql === "SET LOCAL ROLE service_role") return { rows: [] };
    if (sql.includes("app.open_vendor_job(")) {
      assert.deepEqual(values, [hashVendorToken(token)]);
      return { rows: [{ job_id: jobId, org_id: orgId, ticket_id: ticketId }] };
    }
    if (sql.includes("FROM organizations")) return { rows: [{
      environment: "sandbox", plan_tier: "beta", feature_flags: { vendor_dispatch: vendorEnabled },
    }] };
    if (sql.includes("public.platform_settings")) return { rows: [{ enabled: approvalsEnabled }] };
    if (sql.includes("app.b013_estimate_heads")) {
      restrictedReads++;
      assert.deepEqual(values, [orgId, ticketId]);
      return { rows: [{ version_id: headVersionId }] };
    }
    if (sql.includes("FROM ticket_attachments a")) {
      restrictedReads++;
      assert.ok(pending.has(this), "photo lookup must run inside a transaction");
      assert.deepEqual(values, [orgId, ticketId, jobId]);
      assert.match(sql, /a\.vendor_job_id=\$3 AND NOT a\.is_internal/);
      return { rows: [{ n: afterPhotoCount }] };
    }
    if (sql.includes("app.b013_dispatch_allowed(")) {
      restrictedReads++;
      assert.deepEqual(values, [orgId, versionId]);
      return { rows: [{ r: allowed }] };
    }
    if (sql.includes("app.b013_record_vendor_appointment(")) {
      assert.ok(pending.has(this), "gateway must run inside a transaction");
      assert.deepEqual(values.slice(0, 3), [orgId, jobId, hashVendorToken(token)]);
      assert.equal(values[4], headVersionId);
      assert.notEqual(values[5], "company_confirmed");
      assert.ok(Buffer.isBuffer(values[11]));
      calls.push(values);
      if (permissionError) throw Object.assign(new Error("Forbidden"), { code: "42501" });
      const key = JSON.stringify([values[0], values[1], values[3]]);
      const signature = JSON.stringify([...values.slice(0, 3), ...values.slice(4)]);
      const previous = committed.get(key);
      if (previous) {
        if (previous.signature !== signature) {
          throw Object.assign(new Error("Request payload changed"), { code: "40001" });
        }
        return { rows: [{ r: previous.result }] };
      }
      if (!allowed) return { rows: [{ r: { status: "rejected_locked" } }] };
      const command = {
        signature,
        result: { status: "recorded", version_id: String(values[4]), appointment_id: randomUUID() },
      };
      pending.set(this, { key, command });
      return { rows: [{ r: command.result }] };
    }
    if (sql === "COMMIT") {
      assert.ok(pending.has(this));
      const entry = pending.get(this);
      if (entry) {
        committed.set(entry.key, entry.command);
        events.push(entry.command.result);
      }
      pending.delete(this);
      return { rows: [] };
    }
    if (sql === "ROLLBACK") { pending.delete(this); return { rows: [] }; }
    assert.fail("Unexpected vendor HTTP retry SQL: " + sql);
  });
  function request(fields: Record<string, unknown> = payload) {
    return new Request("http://localhost:43123" + path, {
      method: "POST",
      headers: { origin: "http://localhost:43123", "content-type": "application/json" },
      body: JSON.stringify(fields),
    });
  }
  const first = await post(request());
  assert.equal(first.status, 200);
  assert.equal(committed.size, 1);
  assert.equal(events.length, 1);
  const recorded = structuredClone(events[0]);
  await first.body?.cancel();
  const retry = await post(request());
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), recorded);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  for (const mutation of mutations) {
    const conflict = await post(request({ ...payload, ...mutation }));
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { status: "rejected_conflict" });
  }
  assert.equal(events.length, 1);
  assert.equal(committed.size, 1);
  const replay = await post(request());
  assert.deepEqual(await replay.json(), recorded);
  const fresh = await post(request({ ...payload, requestId: randomUUID() }));
  assert.equal(fresh.status, 200);
  assert.notDeepEqual(await fresh.json(), recorded);
  assert.equal(committed.size, 2);
  assert.equal(events.length, 2);
  const beforeHeadChange = calls.length;
  headVersionId = randomUUID();
  for (const id of [requestId, randomUUID()]) {
    const stale = await post(request({ ...payload, requestId: id }));
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { status: "rejected_conflict" });
  }
  assert.equal(calls.length, beforeHeadChange, "stale versions must not be retargeted");
  const changedVersion = await post(request({ ...payload, versionId: headVersionId }));
  assert.equal(changedVersion.status, 409);
  assert.deepEqual(await changedVersion.json(), { status: "rejected_conflict" });
  assert.equal(calls.length, beforeHeadChange + 1, "changed signatures must reach gateway conflict detection");
  headVersionId = versionId;
  if (path === "/api/vendor-job-completion" && afterPhotoCount === 0) {
    const beforeMissingPhoto = calls.length;
    for (const hasAfterPhoto of [false, true]) {
      const missingPhoto = await post(request({ ...payload, requestId: randomUUID(), hasAfterPhoto, reason: null }));
      assert.equal(missingPhoto.status, 403);
    }
    assert.equal(calls.length, beforeMissingPhoto, "client photo claims must not authorize completion");
  }
  const writes = calls.length;
  for (const disabled of ["vendor", "approvals"]) {
    vendorEnabled = disabled !== "vendor";
    approvalsEnabled = disabled !== "approvals";
    const reads = restrictedReads;
    const off = await post(request({ ...payload, requestId: randomUUID() }));
    assert.deepEqual(await off.json(), { status: "rejected_disabled" });
    assert.equal(restrictedReads, reads);
  }
  vendorEnabled = approvalsEnabled = true;
  allowed = false;
  const lockedReplay = await post(request());
  assert.equal(lockedReplay.status, 200);
  assert.deepEqual(await lockedReplay.json(), recorded);
  assert.deepEqual(calls[writes], calls[0]);
  const lockedConflict = await post(request({ ...payload, ...mutations[0] }));
  assert.equal(lockedConflict.status, 409);
  assert.deepEqual(await lockedConflict.json(), { status: "rejected_conflict" });
  const locked = await post(request({ ...payload, requestId: randomUUID() }));
  assert.deepEqual(await locked.json(), { status: "rejected_locked" });
  assert.equal(calls.length, writes + 3, "replay, conflict and fresh lock decisions must reach the gateway");
  allowed = true;
  permissionError = true;
  assert.equal((await post(request({ ...payload, requestId: randomUUID() }))).status, 403);
  permissionError = false;
  const invalidCases = [
    { requestId: null }, { requestId: "bad" }, { token: 42 }, { reason: 42 },
    { versionId: undefined }, { versionId: null }, { versionId: "bad" }, { versionId: 42 },
  ];
  for (const invalid of invalidCases) {
    const response = await post(request({ ...payload, ...invalid }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "rejected_invalid" });
  }
  const crossOrigin = request();
  crossOrigin.headers.set("origin", "https://example.test");
  assert.equal((await post(crossOrigin)).status, 403);
  const wrongType = request();
  wrongType.headers.set("content-type", "text/plain");
  assert.equal((await post(wrongType)).status, 415);
  const oversized = await post(request({ ...payload, padding: "x".repeat(20001) }));
  assert.equal(oversized.status, 413);
  assert.equal(events.length, 2);
  assert.equal(committed.size, 2);
  assert.equal(pending.size, 0);
  return calls;
}
