import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("sanitizer masks PII by value regardless of the field name", () => {
  const { newRow } = sanitizeAuditPayload({
    contact_id: "a@b.com",
    status: "0912-345-678",
    phone: 912345678,
    nested: { contact_id: "a@b.com" },
    items: [{ status: "0912-345-678" }, 912345678, "a@b.com"],
  });
  assert.deepEqual(newRow, {
    contact_id: MASK,
    status: MASK,
    phone: MASK,
    nested: { contact_id: MASK },
    items: [{ status: MASK }, MASK, MASK],
  });
  assert.notEqual(newRow!.phone, 912345678);
  const json = JSON.stringify(newRow);
  for (const raw of ["a@b.com", "0912-345-678", "912345678"]) {
    assert.ok(!json.includes(raw));
  }
});

test("sanitizer masks bigint PII and preserves non-PII numeric values", () => {
  assert.deepEqual(sanitizeAuditPayload({
    phone: BigInt(912345678),
    internationalPhone: BigInt(886912345678),
    amount: BigInt(1200),
    due_day: 5,
  }).newRow, {
    phone: MASK,
    internationalPhone: MASK,
    amount: BigInt(1200),
    due_day: 5,
  });
});

test("sanitizer preserves standalone UUID values under any field name", () => {
  assert.deepEqual(sanitizeAuditPayload({ status: UUID, items: [UUID] }).newRow, {
    status: UUID,
    items: [UUID],
  });
});

test("sanitizer preserves UUID identifiers and non-PII structured scalars", () => {
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

test("service audit scopes use server/session provenance at every production call site", () => {
  // audit.ts adapters forward orgId/userId parameters or the authenticated
  // download event. SigningActor is trusted request context; party.org_id is
  // selected through the session user's lease, never taken from the command.
  const allowedPairs: Record<string, Set<string>> = {
    "./audit.ts": new Set([
      "orgId|userId",
      "event.orgId|event.userId",
    ]),
    "./esign/repo.ts": new Set(["actor.orgId|actor.userId"]),
    "./id-docs.ts": new Set(["party.org_id|session.userId"]),
  };

  for (const [path, allowed] of Object.entries(allowedPairs)) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const scopes = [...source.matchAll(
      /\bsvcAuditScope\s*\(\s*\{([^{}]*)\}\s*\)/g,
    )];
    const calls = [...source.matchAll(/\bsvcAuditScope\s*\(/g)];
    const auditCalls = [...source.matchAll(
      /\brecordAudit\s*\(\s*svcAuditScope\s*\(/g,
    )];
    assert.ok(scopes.length > 0, `${path}: missing scope evidence`);
    assert.equal(scopes.length, calls.length, `${path}: unrecognized scope`);
    assert.equal(scopes.length, auditCalls.length, `${path}: scope outside recordAudit`);

    for (const [call, block] of scopes) {
      assert.doesNotMatch(
        call,
        /\b(?:input|body|formData|searchParams)\b/,
        `${path}: client input in audit scope`,
      );
      const fields = block.split(",").map((field) => field.trim()).filter(Boolean);
      const expressions = new Map<string, string>();
      for (const field of fields) {
        const match = /^(orgId|actorUserId|actorRole)(?:\s*:\s*([\s\S]+))?$/.exec(field);
        assert.ok(match, `${path}: unrecognized scope field: ${field}`);
        assert.ok(!expressions.has(match[1]), `${path}: duplicate scope field`);
        expressions.set(match[1], (match[2] ?? match[1]).replace(/\s+/g, ""));
      }
      assert.equal(expressions.size, 3, `${path}: incomplete scope`);
      assert.ok(
        allowed.has(`${expressions.get("orgId")}|${expressions.get("actorUserId")}`),
        `${path}: untrusted org/actor provenance: ${call}`,
      );
    }
  }
});
