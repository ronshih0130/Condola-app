import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { decideConfirmation } from "./b010-proxy-confirm-rules";
import { FlowError } from "./errors";
import type { confirmPayment } from "./domain";

// Execute the real writer body against a strict mocked transactional client.
function writer({ enabled = true, owner = "owner-a", collector = "owner", status = "submitted" } = {}) {
  const source = ts.createSourceFile("domain.ts", readFileSync("src/server/domain.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "confirmPayment")!;
  const code = ts.transpileModule(fn.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const events: string[] = [];
  const client = { query: async (sql: string, args?: unknown[]) => {
    events.push(sql);
    if (sql.includes("SELECT lease_id::text")) return { rows: [{ lease_id: "lease" }] };
    if (sql.includes("FOR UPDATE")) return { rows: [{ id: "payment", lease_id: "lease", status, amount_minor: "10" }] };
    if (sql.includes("app.b010_payment_collector")) return { rows: collector === "missing" ? [] : [{ collector, owner_contact_id: owner }] };
    if (sql.startsWith("UPDATE payments")) return { rows: [], rowCount: 1 };
    if (sql.includes("app.b010_record_confirmation")) {
      assert.deepEqual(args?.slice(0, 3), ["payment", collector === "owner" ? "staff_proxy" : "management", collector === "owner" ? owner : null]);
      return { rows: [] };
    }
    assert.fail(`Unexpected SQL: ${sql}`);
  } };
  const noop = async () => {};
  const mocks = {
    guardEffectiveSession: async (s: unknown) => s, assertStaff: () => {},
    tx: async (_: unknown, run: (c: typeof client) => unknown) => run(client),
    svc: async (_: unknown, run: (c: typeof client) => unknown) => run(client),
    withEffectiveAuthority: async (_c: unknown, _s: unknown, _p: unknown, run: () => unknown) => run(),
    assertCustomAuthorityOn: noop, requireOrgScope: () => "org",
    maybe: async (_: unknown, sql: string, args: unknown[]) => (await client.query(sql, args)).rows[0] ?? null,
    lockPaymentResultContext: async () => enabled, beginPaymentCenter: noop,
    lockAllocationInvoices: async () => [{ balance_minor: "100" }], decideConfirmation, FlowError,
    allocateAndLedger: async () => { events.push("ledger"); }, emitPaymentResult: noop,
    finalizePaymentCenter: noop, producePaymentResultEvent: noop,
    queueDemoNotice: async () => { events.push("legacy-notice"); },
  };
  const exports = {} as { confirmPayment: typeof confirmPayment };
  new Function("exports", ...Object.keys(mocks), code)(exports, ...Object.values(mocks));
  const session = { kind: "staff", role: "manager", orgId: "org", userId: "staff" } as Parameters<typeof confirmPayment>[0];
  return { events, run: (options: Parameters<typeof confirmPayment>[2] = {}) => exports.confirmPayment(session, "payment", options) };
}

for (const config of [{ owner: "owner-b" }, { enabled: false }, { collector: "management" }, { collector: "missing" }]) {
  test(`proxy expected owner mismatch rejects before UPDATE: ${JSON.stringify(config)}`, async () => {
    const w = writer(config);
    await assert.rejects(w.run({ proxyOwnerConfirmed: true, expectedOwnerContactId: "owner-a" }),
      (e: unknown) => e instanceof FlowError && e.key === "errors.proxyOwnerMismatch");
    assert.ok(w.events.some(e => e.includes("FOR UPDATE")));
    assert.ok(!w.events.some(e => /UPDATE payments|ledger|b010_record_confirmation|legacy-notice/.test(e)));
  });
}
test("matching displayed owner confirms and attributes the same owner", async () => {
  const w = writer();
  assert.deepEqual(await w.run({ proxyOwnerConfirmed: true, expectedOwnerContactId: "owner-a" }),
    { paymentId: "payment", status: "confirmed", outcome: "confirmed" });
  assert.equal(w.events.filter(e => e.startsWith("UPDATE payments")).length, 1);
  assert.ok(w.events.includes("ledger"));
});
test("absent expectation preserves legacy and B-010 paths", async () => {
  for (const config of [{ enabled: false }, { owner: "owner-b" }, { collector: "management" }]) {
    const w = writer(config);
    assert.equal((await w.run({ proxyOwnerConfirmed: true })).outcome, "confirmed");
    assert.ok(w.events.some(e => e.startsWith("UPDATE payments")));
    assert.equal(w.events.includes("legacy-notice"), config.enabled === false);
  }
  const w = writer();
  await assert.rejects(w.run(), (e: unknown) => e instanceof FlowError && e.key === "errors.proxyOwnerConfirmRequired");
});
test("confirmation observed under lock returns already_confirmed without another write", async () => {
  const w = writer({ status: "confirmed" });
  assert.deepEqual(await w.run({ proxyOwnerConfirmed: true, expectedOwnerContactId: "owner-a" }),
    { paymentId: "payment", status: "confirmed", outcome: "already_confirmed" });
  assert.ok(!w.events.some(e => /UPDATE payments|ledger|b010_record_confirmation/.test(e)));
});
