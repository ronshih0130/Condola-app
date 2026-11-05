import assert from "node:assert/strict";
import test from "node:test";
import {
  auditScope,
  recordAudit,
  sanitizeAuditPayload,
  svcAuditScope,
  type Sql,
} from "./audit-write";

const UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const RAW = ["0912-345-678", "a@b.com", "A123456789", UUID];
const TEXT = `退租 聯絡 ${RAW[0]} / ${RAW[1]} 身分證 ${RAW[2]} uuid ${UUID}`;
const MASK = "••••••••••";

test("sanitizer masks PII in reasons and free-text payload fields", () => {
  const payload = sanitizeAuditPayload({
    description: TEXT,
    notes: TEXT,
    email: "a@b.com",
    phone: "0912-345-678",
    nested: { message: TEXT },
    messages: [TEXT],
  }, TEXT);

  assert.ok(payload.reason?.includes(MASK));
  assert.ok(payload.newRow);
  const row = payload.newRow!;
  assert.equal(row.email, MASK);
  assert.equal(row.phone, MASK);
  for (const value of [
    payload.reason,
    row.description,
    row.notes,
    (row.nested as Record<string, unknown>).message,
    (row.messages as unknown[])[0],
  ]) {
    assert.equal(typeof value, "string");
    assert.ok((value as string).includes(MASK));
    for (const raw of RAW) assert.ok(!(value as string).includes(raw));
  }
});

test("sanitizer strips secret keys recursively without mutating its input", () => {
  const input = {
    token_hash: "deadbeef",
    token: "raw-token",
    code_hash: "code-digest",
    password: "raw-password",
    clientSecret: "raw-secret",
    encrypted_value: "ciphertext",
    storage_path: "private/path",
    nested: { PASSWORD: "nested-password", message: "safe" },
    items: [{ refresh_token: "refresh-token", amount: 1200 }],
    email: "a@b.com",
  };
  const { newRow } = sanitizeAuditPayload(input);
  assert.deepEqual(newRow, {
    nested: { message: "safe" },
    items: [{ amount: 1200 }],
    email: MASK,
  });
  assert.equal(input.token_hash, "deadbeef");
  assert.equal(input.nested.PASSWORD, "nested-password");
  assert.equal(input.email, "a@b.com");
});

test("sanitizer preserves identifiers, amounts, and structured fields", () => {
  const input = {
    id: UUID,
    lease_id: UUID,
    contact_id: UUID,
    amount: 1200,
    rent_amount_minor: "120000",
    deposit_amount_minor: "240000",
    deposit_months: 2,
    status: "active",
    start_date: "2026-11-05",
    end_date: "2027-11-04",
    role: "tenant",
    due_day: 5,
    currency: "TWD",
    rental_mode: "whole",
    enabled: true,
    optional: null,
  };
  assert.deepEqual(sanitizeAuditPayload(input).newRow, input);
  assert.deepEqual(sanitizeAuditPayload(), { newRow: undefined, reason: undefined });
});

test("auditScope pins the supplied requireOrgScope org and derives the actor role", () => {
  const session = {
    userId: "staff-user",
    kind: "staff" as const,
    role: "admin" as const,
    orgId: "other-org",
  };
  assert.deepEqual(auditScope(session, { orgId: "request-org", environment: "live" }), {
    orgId: "request-org",
    actorUserId: "staff-user",
    actorRole: "admin",
  });
  assert.deepEqual(
    auditScope({ userId: "tenant-user", role: null, kind: "tenant" }, {
      orgId: "portal-org",
      environment: "sandbox",
    }),
    { orgId: "portal-org", actorUserId: "tenant-user", actorRole: "tenant" },
  );
});

test("recordAudit inserts sanitized parameters through the injected client", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client: Sql = {
    async query(sql, params) {
      calls.push({ sql, params: params ?? [] });
    },
  };
  await recordAudit(
    svcAuditScope({ orgId: "explicit-org", actorUserId: "actor", actorRole: "app" }),
    {
      table: "auth_events",
      rowId: "test-event",
      action: "insert",
      eventType: "test-event",
      newRow: { token_hash: "deadbeef", message: TEXT, lease_id: UUID, amount: 1200 },
      reason: TEXT,
      requestId: "request-1",
    },
    client,
  );
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.match(sql, /^\s*INSERT INTO audit_log\b/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE)\b/i);
  assert.deepEqual(params.slice(0, 7), [
    "explicit-org", "actor", "app", "auth_events", "test-event", "insert", "test-event",
  ]);
  const stored = JSON.parse(params[7] as string);
  assert.equal(Object.hasOwn(stored, "token_hash"), false);
  assert.equal(stored.lease_id, UUID);
  assert.equal(stored.amount, 1200);
  for (const raw of RAW) {
    assert.ok(!stored.message.includes(raw));
    assert.ok(!(params[8] as string).includes(raw));
  }
  assert.equal(params[9], "request-1");

  await recordAudit(
    svcAuditScope({ orgId: null, actorUserId: null, actorRole: "app" }),
    { table: "auth_events", rowId: "empty", action: "insert", eventType: "empty" },
    client,
  );
  assert.deepEqual(calls[1].params.slice(7), [null, null, null]);
});
