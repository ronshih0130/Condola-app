import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_RENEWAL_RULE, ownerRuleView, parseOwnerRule, parseStaffRuleChanges, RENEWAL_RULES, setOwnerRule, staffRuleChanges } from "./b091-owner-rules";
import type { Session } from "./types";

// B-091 OWN-RULE (OWN-34-AC3/AC4). Synthetic data only.
const read = (p: string) => readFileSync(p, "utf8");
const ORG = "00000000-0000-4000-8000-000000000001", C = "00000000-0000-4000-8000-0000000000c1";
const base = { orgId: ORG, liveOrgId: ORG, userId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003",
  name: "Synthetic", email: "", environment: "live" as const, locale: "zh-TW" as const, calendar: "gregorian" as const, leaseId: null };
const owner: Session = { ...base, kind: "owner", role: null };
const staff: Session = { ...base, kind: "staff", role: "accountant" };
const never = (async () => { throw new Error("no transaction expected"); }) as never;
function client(result: unknown, seen: { sql: string; args?: unknown[] }[], options: unknown[] = []) {
  return (async (_u: string, cb: (c: unknown) => Promise<unknown>, opts?: unknown) => { options.push(opts);
    return cb({ query: async (sql: string, args?: unknown[]) => { seen.push({ sql, args }); return { rows: sql.includes("app.b091_") ? [{ result }] : [] }; } }); }) as never;
}

test("rules: three values; the default is 交給管理方，只要通知我", () => {
  assert.deepEqual([...RENEWAL_RULES], ["delegate_notify", "delegate_unless_lower", "ask_every_time"]);
  assert.equal(DEFAULT_RENEWAL_RULE, "delegate_notify");
  assert.deepEqual(parseOwnerRule({ rule: "delegate_notify", revision: 0, changedAt: null }), { rule: "delegate_notify", revision: 0, changedAt: null });
  for (const bad of [{ rule: "x", revision: 0, changedAt: null }, { rule: "delegate_notify", revision: 1, changedAt: null }, { rule: "delegate_notify", revision: 0, changedAt: "2026-11-16T00:00:00Z" }, { rule: "delegate_notify", revision: -1, changedAt: null }])
    assert.throws(() => parseOwnerRule(bad));
});

test("owner reader/writer: OFF never opens a transaction; only owner sessions; pinned org/env; exact args; READ COMMITTED writer", async () => {
  assert.deepEqual(await ownerRuleView(owner, { v3: async () => false, transaction: never }), { state: "off" });
  for (const actor of [{ ...owner, kind: "staff" as const, role: "admin" as const }, { ...owner, kind: "tenant" as const }, { ...owner, sessionId: "x" }, { ...owner, environment: "other" as never }]) {
    assert.deepEqual(await ownerRuleView(actor, { v3: async () => true, transaction: never }), { state: "forbidden" });
    assert.deepEqual(await setOwnerRule(actor, { requestId: C, rule: "ask_every_time", expectedRevision: 0 }, { v3: async () => true, transaction: never }), { ok: false, reason: "forbidden" });
  }
  const seen: { sql: string; args?: unknown[] }[] = [], opts: unknown[] = [];
  assert.deepEqual(await ownerRuleView(owner, { v3: async () => true, transaction: client({ rule: "ask_every_time", revision: 2, changedAt: "2026-11-16T01:00:00Z" }, seen, opts) }),
    { state: "ready", rule: "ask_every_time", revision: 2, changedAt: "2026-11-16T01:00:00Z" });
  assert.deepEqual(seen[2].args, [ORG, "live"]);
  assert.equal(seen[3].sql, "SELECT app.b091_owner_rule_view($1::uuid,$2::uuid,$3::text,$4::uuid) AS result");
  assert.deepEqual(await ownerRuleView(owner, { v3: async () => true, transaction: client(null, []) }), { state: "off" });
  const saves: { sql: string; args?: unknown[] }[] = [], saveOpts: unknown[] = [];
  assert.deepEqual(await setOwnerRule(owner, { requestId: C, rule: "delegate_unless_lower", expectedRevision: 1 },
    { v3: async () => true, transaction: client({ status: "saved", rule: "delegate_unless_lower", revision: 2, replayed: false }, saves, saveOpts) }),
    { ok: true, rule: "delegate_unless_lower", revision: 2, changed: true, replayed: false });
  assert.deepEqual(saveOpts, [{ isolation: "read committed" }], "the gateway re-admits after its lock waits in a fresh snapshot");
  assert.deepEqual(saves[3].args, [ORG, ORG, "live", base.sessionId, C, "delegate_unless_lower", 1]);
  for (const [result, expected] of [
    [{ status: "unchanged", rule: "ask_every_time", revision: 2, replayed: true }, { ok: true, rule: "ask_every_time", revision: 2, changed: false, replayed: true }],
    [{ status: "stale", rule: "ask_every_time", revision: 3 }, { ok: false, reason: "stale", rule: "ask_every_time", revision: 3 }],
    [{ status: "disabled" }, { ok: false, reason: "off" }], [{ status: "invalid" }, { ok: false, reason: "invalid" }],
    [{ status: "conflict" }, { ok: false, reason: "conflict" }], [{ status: "weird" }, { ok: false, reason: "failed" }]] as const)
    assert.deepEqual(await setOwnerRule(owner, { requestId: C, rule: "ask_every_time", expectedRevision: 2 }, { v3: async () => true, transaction: client(result, []) }), expected);
  // Only an unusable request id is refused before the gateway; any other bad payload is sent (as NULL where it cannot be
  // represented) so the gateway reserves the id with outcome invalid.
  assert.deepEqual(await setOwnerRule(owner, { requestId: "x", rule: "ask_every_time", expectedRevision: 0 }, { v3: async () => true, transaction: never }), { ok: false, reason: "invalid" });
  for (const [bad, rule, expected] of [[{ rule: "sometimes" }, "sometimes", 0], [{ rule: "x".repeat(65) }, null, 0], [{ expectedRevision: -1 }, "ask_every_time", null],
    [{ expectedRevision: 1.5 }, "ask_every_time", null], [{ expectedRevision: 2147483648 }, "ask_every_time", null]] as const) {
    const sent: { sql: string; args?: unknown[] }[] = [];
    assert.deepEqual(await setOwnerRule(owner, { ...({ requestId: C, rule: "ask_every_time", expectedRevision: 0 } as Record<string, unknown>), ...bad } as never, { v3: async () => true, transaction: client({ status: "invalid", replayed: false }, sent) }),
      { ok: false, reason: "invalid" }, JSON.stringify(bad));
    assert.deepEqual(sent[3].args?.slice(5), [rule, expected]);
  }
  const deny = (async () => { throw Object.assign(new Error("denied"), { cause: { code: "42501" } }); }) as never;
  assert.deepEqual(await setOwnerRule(owner, { requestId: C, rule: "ask_every_time", expectedRevision: 0 }, { v3: async () => true, transaction: deny }), { ok: false, reason: "forbidden" });
});

test("staff reader: admin/manager/accountant only; strict change-log DTO", async () => {
  for (const actor of [{ ...staff, role: "maintenance" as const }, owner, { ...staff, kind: "tenant" as const }])
    assert.deepEqual(await staffRuleChanges(actor, {}, { v3: async () => true, transaction: never }), { state: "forbidden" });
  assert.deepEqual(await staffRuleChanges(staff, { ownerContactId: "x" }, { v3: async () => true, transaction: never }), { state: "forbidden" });
  const page = { owner: { ownerContactId: C, name: "陳建宏", rule: "ask_every_time", revision: 1, changedAt: "2026-11-16T01:00:00Z" },
    changes: [{ seq: "7", ownerContactId: C, ownerName: "陳建宏", rule: "ask_every_time", previousRule: "delegate_notify", revision: 1, changedAt: "2026-11-16T01:00:00Z" }], next: null };
  const seen: { sql: string; args?: unknown[] }[] = [];
  assert.deepEqual(await staffRuleChanges(staff, { ownerContactId: C }, { v3: async () => true, transaction: client(page, seen) }), { state: "ready", ...page });
  assert.deepEqual(seen[3].args, [ORG, ORG, "live", base.sessionId, C, null, 20]);
  for (const bad of [{ ...page, changes: [{ ...page.changes[0], previousRule: "ask_every_time" }] }, { ...page, next: "0" }, { ...page, owner: { ...page.owner, rule: "x" } }])
    assert.deepEqual(await staffRuleChanges(staff, {}, { v3: async () => true, transaction: client(bad, []) }), { state: "unavailable" });
  assert.throws(() => parseStaffRuleChanges({ ...page, changes: [{ ...page.changes[0], seq: "9223372036854775808" }] }));
});

test("wiring: B-017 map; flag registered; no outbound; screens left to B-094", () => {
  const map = JSON.parse(read("src/server/b017-entry-permissions.json")) as Record<string, unknown>;
  assert.equal(map["src/server/b091-owner-rules.ts#ownerRuleView"], null);
  assert.equal(map["src/server/b091-owner-rules.ts#setOwnerRule"], null);
  assert.equal(map["src/server/b091-owner-rules.ts#staffRuleChanges"], "props.view");
  const src = read("src/server/b091-owner-rules.ts");
  assert.doesNotMatch(src, /fetch\(|sms|line-push|sendEmail|notification/i);
  assert.match(src, /Screens are B-094/);
});
