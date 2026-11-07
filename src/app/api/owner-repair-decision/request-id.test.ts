import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import nextHeaders from "next/headers";
import { Client } from "pg";
import { buildStoredConsent } from "@/server/consent";
import { ORG_ID, USERS } from "@/server/ids";
import { NOTIFICATION_EVENTS_PROBE } from "@/server/notification-event-producers";
import { parseRequestId } from "./request-id";
import { POST } from "./route";

test("valid UUID requestId is accepted unchanged", () => {
  for (const value of [
    "6dbf5a6c-2458-4daa-9f32-291a6b61d332",
    "6DBF5A6C-2458-4DAA-9F32-291A6B61D332",
  ]) assert.equal(parseRequestId(value), value);
});

test("missing or malformed requestId is rejected", () => {
  for (const value of [
    undefined, null, "", 42, {}, [],
    "not-a-uuid",
    "6dbf5a6c24584daa9f32291a6b61d332",
    "6dbf5a6c-2458-4daa-9f32-291a6b61d33g",
    " 6dbf5a6c-2458-4daa-9f32-291a6b61d332",
    "6dbf5a6c-2458-4daa-9f32-291a6b61d332\n",
  ]) assert.equal(parseRequestId(value), null);
});

test("route never generates a requestId", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /randomUUID/);
});

test("rendered decision form retains its requestId across submission retries", () => {
  const cards = readFileSync(new URL("../../o/approvals/approval-cards.tsx", import.meta.url), "utf8");
  const form = readFileSync(new URL("../../o/approvals/decision-form.tsx", import.meta.url), "utf8");
  assert.match(cards, /<DecisionForm\b[^>]*>[\s\S]*?<input type="hidden" name="requestId" value=\{crypto\.randomUUID\(\)\} \/>[\s\S]*?<\/DecisionForm>/);
  assert.match(form, /const requestId = new FormData\(event\.currentTarget\)\.get\("requestId"\)/);
  assert.match(form, /body: JSON\.stringify\(\{ requestId, versionId, decision, reason:/);
  assert.match(form, /<form onSubmit=\{submit\}>[\s\S]*?\{children\}/);
  assert.doesNotMatch(form, /randomUUID|name="requestId"|\.set\("requestId"/);
});

// This file is already registered in package.json test:unit.
test("HTTP lost-response retry replays one committed decision", async (t) => {
  const requestId = randomUUID(), versionId = randomUUID(), sessionId = randomUUID();
  const form = new FormData();
  form.set("requestId", requestId);
  const payload = {
    requestId: form.get("requestId"), versionId, decision: "approved", reason: null,
  };
  type Result = { status: string; version_id: string; decision_id: string };
  type Command = { signature: string; result: Result };
  const committed = new Map<string, Command>();
  const decisions: { version_id: string; id: string }[] = [];
  const pending = new Map<Client, { key: string; command: Command } | null>();
  const calls: unknown[][] = [];
  const probes: unknown[][] = [];
  let commits = 0, bounds = 0;
  t.mock.method(nextHeaders, "cookies", async () => ({
    get: (name: string) => name === "condola_session" ? { value: "unit-session" } : undefined,
  }));
  t.mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/o/approvals" }));
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "end", async () => {});
  t.mock.method(Client.prototype, "query", async function (
    this: Client, sql: string, values: unknown[] = [],
  ) {
    if (sql.includes("FROM auth_sessions s")) return { rows: [{
      session_id: sessionId, user_id: USERS.owner, name: "Unit Owner",
      email: "owner@example.test", consent: buildStoredConsent("portal"),
    }] };
    if (sql.includes("UPDATE auth_sessions")) return { rows: [] };
    if (sql.includes("FROM org_members m")) return { rows: [] };
    if (sql.includes("FROM contacts c")) return { rows: [{
      org_id: ORG_ID, live_org_id: ORG_ID, environment: "live",
      is_owner: true, is_tenant: false, latest_kind: "owner", latest_at: null,
    }] };
    if (sql === "BEGIN") {
      pending.set(this, null);
      return { rows: [] };
    }
    if (sql.includes("set_config(") || sql === "SET LOCAL ROLE service_role") return { rows: [] };
    // S3 BLK-MAC-24: the producer and COMMIT after a recorded call run under a bounded lock wait.
    if (sql === "SET LOCAL lock_timeout = '3s'") {
      assert.ok(pending.has(this), "lock bound is set inside the open transaction");
      bounds++;
      return { rows: [] };
    }
    // B-028 notification_events_v2 OFF: one read-only probe inside the open decision
    // transaction, right after its gateway call, then nothing else.
    if (sql.startsWith(NOTIFICATION_EVENTS_PROBE)) {
      assert.ok(pending.has(this), "probe runs inside the open transaction");
      assert.equal(probes.length, calls.length - 1, "exactly one probe per recorded decision call");
      assert.equal(bounds, calls.length, "the lock bound precedes the producer probe");
      probes.push(values);
      return { rows: [{ enabled: false, role: "service_role", owner: false }] };
    }
    if (sql.includes("app.b013_decide_estimate(")) {
      assert.ok(pending.has(this), "gateway must run inside a transaction");
      // B-028 package 4: org, live org and environment precede the session.
      assert.deepEqual(values.slice(0, 8), [
        ORG_ID, ORG_ID, "live", sessionId, payload.requestId, versionId, "approved", null,
      ]);
      calls.push(values);
      // Model B-013 request-key replay at the database boundary. Different
      // request keys can insert independently; row count is not hardcoded.
      const key = JSON.stringify([values[0], USERS.owner, values[4]]);
      const signature = JSON.stringify([values[5], values[6], values[7], values[8]]);
      const previous = committed.get(key);
      if (previous) {
        assert.equal(signature, previous.signature);
        return { rows: [{ r: previous.result }] };
      }
      const command = {
        signature,
        result: { status: "recorded", version_id: versionId, decision_id: randomUUID() },
      };
      pending.set(this, { key, command });
      return { rows: [{ r: command.result }] };
    }
    if (sql === "COMMIT") {
      assert.ok(pending.has(this));
      const entry = pending.get(this);
      if (entry) {
        committed.set(entry.key, entry.command);
        decisions.push({ version_id: versionId, id: entry.command.result.decision_id });
      }
      pending.delete(this);
      commits++;
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      pending.delete(this);
      return { rows: [] };
    }
    assert.fail("Unexpected HTTP retry SQL: " + sql);
  });
  function request() {
    return new Request("http://localhost:43123/api/owner-repair-decision", {
      method: "POST",
      headers: { origin: "http://localhost:43123", "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  const first = await POST(request());
  assert.equal(first.status, 200);
  assert.equal(commits, 1);
  assert.equal(committed.size, 1);
  const recorded = structuredClone([...committed.values()][0].result);
  assert.equal(recorded.status, "recorded");
  assert.equal(decisions.filter(row => row.version_id === versionId).length, 1);
  // Simulate response loss: discard the body without parsing or asserting it.
  await first.body?.cancel();
  const retry = await POST(request());
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), recorded);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(commits, 2);
  assert.equal(committed.size, 1);
  assert.equal(decisions.filter(row => row.version_id === versionId).length, 1);
  assert.deepEqual(probes, [[ORG_ID], [ORG_ID]], "one OFF probe per POST");
});
