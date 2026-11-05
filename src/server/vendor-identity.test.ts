import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolveVendorIdentity, type VendorResolveCtx } from "./vendor-identity";
import type { VendorLinkCapability } from "./vendor-link-rules";

const token = "a".repeat(43);
const tokenHash = createHash("sha256").update(token).digest("hex");
const ctx: VendorResolveCtx = {
  token,
  now: new Date("2026-11-05T12:00:00Z"),
  linkedUserId: null,
};

type Row = Record<string, unknown>;
type Step = {
  rows: Row[];
  check?: (sql: string, params: unknown[]) => void;
};

function scripted(steps: Step[]) {
  let index = 0;
  return {
    async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const step = steps[index++];
      assert.ok(step, "Unexpected query");
      const query = sql.replace(/\s+/g, " ").trim();
      assert.match(query, /^SELECT /i);
      assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|org_members)\b/i);
      assert.ok(query.includes("FROM repair_vendor_secrets s"));
      assert.ok(query.includes("JOIN repair_vendor_jobs j ON j.id = s.job_id"));
      assert.ok(query.includes("JOIN maintenance_tickets t ON t.id = j.ticket_id AND t.org_id = j.org_id"));
      assert.match(query, /WHERE j\.token_hash = \$1 LIMIT 1$/);
      assert.equal(params.length, 1);
      assert.match(String(params[0]), /^[a-f0-9]{64}$/);
      step.check?.(query, params);
      return { rows: step.rows as T[] };
    },
    done() {
      assert.equal(index, steps.length);
    },
  };
}

const job = {
  id: "job-a",
  org_id: "org-a",
  ticket_id: "ticket-a",
  active: true,
  revoked_at: null,
  expires_at: "2026-11-06T12:00:00Z",
  status: "open",
};

test("missing or unacceptable tokens return null without querying", async () => {
  for (const value of ["", "   ", "short", "a".repeat(42), "!".repeat(43), "a".repeat(43) + "/"]) {
    const sql = scripted([]);
    assert.equal(await resolveVendorIdentity(sql, { ...ctx, token: value }), null);
    sql.done();
  }
});

test("an acceptable token with no SQL row returns null", async () => {
  const sql = scripted([{
    rows: [],
    check(_query, params) { assert.deepEqual(params, [tokenHash]); },
  }]);
  assert.equal(await resolveVendorIdentity(sql, ctx), null);
  sql.done();
});

test("capability and linkable preserve the status and validity matrix", async () => {
  const statuses: Array<{ status: string; capability: VendorLinkCapability; linkable: boolean }> = [
    ...["open", "triaged", "assigned", "in_progress", "on_hold", "resolved"].map((status) => ({
      status, capability: "write" as const, linkable: true,
    })),
    { status: "unknown", capability: "read_only", linkable: true },
    { status: "closed", capability: "read_only", linkable: false },
    { status: "cancelled", capability: "read_only", linkable: false },
  ];
  const states = [
    { name: "active and unexpired", row: {}, now: ctx.now, valid: true },
    { name: "inactive", row: { active: false }, now: ctx.now, valid: false },
    { name: "revoked", row: { revoked_at: "2026-11-04T12:00:00Z" }, now: ctx.now, valid: false },
    { name: "expiry boundary", row: { expires_at: ctx.now }, now: ctx.now, valid: false },
    { name: "expired", row: { expires_at: "2026-11-04T12:00:00Z" }, now: ctx.now, valid: false },
    { name: "invalid expiry", row: { expires_at: "invalid" }, now: ctx.now, valid: false },
    { name: "invalid clock", row: {}, now: new Date(NaN), valid: false },
  ];
  for (const status of statuses) {
    for (const state of states) {
      const sql = scripted([{ rows: [{ ...job, status: status.status, ...state.row }] }]);
      assert.deepEqual(await resolveVendorIdentity(sql, { ...ctx, now: state.now }), {
        kind: "vendor",
        jobId: job.id,
        orgId: job.org_id,
        ticketId: job.ticket_id,
        capability: state.valid ? status.capability : "invalid",
        tokenHash,
        linkable: state.valid && status.linkable,
      }, `${status.status}: ${state.name}`);
      sql.done();
    }
  }
});

test("a non-null linkedUserId only prevents linking", async () => {
  for (const linkedUserId of [null, "already-linked-user", ""]) {
    const sql = scripted([{
      rows: [job],
      check(_query, params) { assert.deepEqual(params, [tokenHash]); },
    }]);
    const result = await resolveVendorIdentity(sql, { ...ctx, linkedUserId });
    assert.equal(result?.capability, "write");
    assert.equal(result?.linkable, linkedUserId === null);
    sql.done();
  }
});

test("tokenHash is sha256 hex of the trimmed token", async () => {
  const sql = scripted([{
    rows: [job],
    check(_query, params) { assert.deepEqual(params, [tokenHash]); },
  }]);
  const result = await resolveVendorIdentity(sql, { ...ctx, token: `  \t${token}\n ` });
  assert.equal(result?.tokenHash, tokenHash);
  sql.done();
});

test("resolution returns one vendor identity with no Session fields", async () => {
  const sql = scripted([{
    rows: [job, { ...job, id: "other-job", org_id: "other-org", ticket_id: "other-ticket" }],
  }]);
  const result = await resolveVendorIdentity(sql, ctx);
  assert.ok(result);
  assert.equal(Array.isArray(result), false);
  assert.deepEqual(result, {
    kind: "vendor",
    jobId: job.id,
    orgId: job.org_id,
    ticketId: job.ticket_id,
    capability: "write",
    tokenHash,
    linkable: true,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "capability", "jobId", "kind", "linkable", "orgId", "ticketId", "tokenHash",
  ]);
  sql.done();
});
