import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import { FlowError } from "./errors";
import { paymentReturnTo } from "./payment-return-to";

test("ordinary confirmation and the flag-OFF legacy page exactly preserve origin/main", () => {
  const file = "src/server/actions.ts";
  const actionSource = (text: string) => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const fn = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "actionConfirmPayment");
    assert.ok(fn);
    return fn.getText(source);
  };
  assert.equal(actionSource(readFileSync(file, "utf8")),
    actionSource(execFileSync("git", ["show", `origin/main:${file}`], { encoding: "utf8" })));
  const legacy = "src/components/legacy-payments-list.tsx";
  assert.deepEqual(readFileSync(legacy), execFileSync("git", ["show", `origin/main:${legacy}`]));
});

test("payment return path accepts only the exact local route/query contract", () => {
  for (const path of ["/m/payments", "/m/rent", "/m/payments/list", "/m/rent/list"]) {
    assert.equal(paymentReturnTo(path), path);
    for (const tab of ["all", "yours", "overdue", "future", "paid"]) {
      const value = `${path}?month=2026-11&tab=${tab}`;
      assert.equal(paymentReturnTo(value), value);
    }
  }
  for (const value of [undefined, null, 42, new Blob(), "", "//evil", "https://evil/m/payments", "/m/payments?next=",
    "/m/payments%2flist", "/m%2fpayments", "%2fm%2fpayments", "/m/payments/", "/m/payments/list/other",
    "/m/payments?month=2026-11&tab=all&next=//evil", "/m/payments?tab=all&month=2026-11",
    "/m/payments?month=2026-1&tab=all", "/m/payments?month=2026-11&tab=nope", "/m/payments#x",
    "/m/payments\\evil", "/m/rent\n", "/m/rent\r\n", "/m/rent?month=2026-11&tab=all\n"]) {
    assert.equal(paymentReturnTo(value), "/m/payments");
  }
});

// Exercise the actual action/bounce bodies without initializing unrelated DB/provider imports.
for (const [file, name, operation, permission] of [
  ["actions.ts", "actionConfirmPayment", "confirmPayment", "pay.record"],
  ["actions.ts", "actionRejectPayment", "rejectPayment", "pay.record"],
  ["auth-actions.ts", "actionReversePayment", "reversePayment", "pay.reverse"],
] as const) test(`${name}: return context on success/failure, redirect safety and existing permission fence`, async () => {
  const source = ts.createSourceFile(file, readFileSync(`src/server/${file}`, "utf8"), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) && [name, "bounce", "isRedirect"].includes(node.name?.text ?? ""));
  assert.equal(selected.length, 3);
  const code = ts.transpileModule(selected.map(node => node.getText(source)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const value of [null, "//evil", "/m/payments/list", "/m/rent?month=2026-09&tab=yours"]) {
    for (const failure of [false, true]) {
      const events: string[] = [];
      const session = { test: true };
      const exports: Record<string, (form: FormData) => Promise<void>> = {};
      const names = ["paymentReturnTo", "requireCurrentConsent", "text", "guardEffectiveSession", "getSession", operation, "redirect", "FlowError", "readProxyOwnerConfirmed"];
      const mocks = [paymentReturnTo, async () => { events.push("consent"); }, (v: unknown) => String(v ?? ""),
        async (actual: unknown, key: string) => { assert.equal(actual, session); assert.equal(key, permission); events.push("guard"); return session; },
        async () => session, async (actual: unknown, id: string) => { assert.equal(actual, session); assert.equal(id, "report"); events.push("operation"); if (failure) throw new FlowError("errors.forbidden"); },
        (url: string) => { throw Object.assign(new Error(url), { digest: "NEXT_REDIRECT" }); }, FlowError, () => false];
      new Function("exports", ...names, code)(exports, ...mocks);
      const form = new FormData(); form.set("paymentId", "report"); if (value !== null) form.set("returnTo", value);
      const dest = paymentReturnTo(value);
      const [path, query = ""] = dest.split("?");
      const params = new URLSearchParams(query); params.set("error", "errors.forbidden");
      const expected = failure ? `${path}?${params}` : dest;
      await assert.rejects(exports[name](form), (e: unknown) => e instanceof Error && e.message === expected);
      assert.deepEqual(events, ["consent", "guard", "operation"]);
    }
  }
});

test("M-PROXY actionConfirmPaymentOwnerProxy: success, failures stay open, permission/consent precede the same write", async () => {
  const source = ts.createSourceFile("actions.ts", readFileSync("src/server/actions.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["actionConfirmPaymentOwnerProxy", "bounce", "isRedirect"].includes(node.name?.text ?? ""));
  const code = ts.transpileModule(selected.map(node => node.getText(source)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const failAt of [null, "consent", "guard", "write"] as const) {
    const events: string[] = [], exports: Record<string, (form: FormData) => Promise<unknown>> = {};
    const session = { role: "manager" };
    const failure = new FlowError("errors.forbidden");
    const step = (name: string) => { events.push(name); if (failAt === name) throw failure; };
    new Function("exports", "paymentReturnTo", "requireCurrentConsent", "text", "guardEffectiveSession", "getSession",
      "confirmPayment", "redirect", "FlowError", "readProxyOwnerConfirmed", "moneyProxyConfirmationState", code)(exports, paymentReturnTo,
      async () => step("consent"), (v: unknown) => String(v ?? ""),
      async (s: unknown, key: string) => { assert.equal(s, session); assert.equal(key, "pay.record"); step("guard"); return s; },
      async () => session,
      async (s: unknown, id: string, options: unknown) => { assert.equal(s, session); assert.equal(id, "report");
        assert.deepEqual(options, { proxyOwnerConfirmed: true, expectedOwnerContactId: "owner", source: "staff_ui" }); step("write"); return { outcome: "confirmed" }; },
      () => assert.fail("inline mode must not redirect"), FlowError, (value: unknown) => value === "true", async () => { step("read"); return "available"; });
    const form = new FormData(); form.set("paymentId", "report"); form.set("proxyOwnerConfirmed", "true");
    form.set("expectedOwnerContactId", "owner"); form.set("returnTo", "//untrusted");
    if (failAt) await assert.rejects(exports.actionConfirmPaymentOwnerProxy(form), error => error === failure);
    else assert.equal(await exports.actionConfirmPaymentOwnerProxy(form), "confirmed");
    assert.deepEqual(events, failAt === "consent" ? ["consent"] : failAt === "guard" ? ["consent", "guard"] : ["consent", "guard", "read", "write"]);
  }
});

test("M-PROXY missing acknowledgement or owner fails closed before preflight", async () => {
  const source = ts.createSourceFile("actions.ts", readFileSync("src/server/actions.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "actionConfirmPaymentOwnerProxy")!;
  const code = ts.transpileModule(fn.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [acknowledged, owner] of [["", "owner"], ["false", "owner"], ["true", ""]]) {
    const events: string[] = [];
    const exports: Record<string, (form: FormData) => Promise<unknown>> = {};
    const mocks = {
      requireCurrentConsent: async () => { events.push("consent"); },
      guardEffectiveSession: async () => { events.push("guard"); return {}; }, getSession: async () => ({}),
      text: (value: unknown) => String(value ?? ""), readProxyOwnerConfirmed: (value: unknown) => value === "true",
      moneyProxyConfirmationState: () => assert.fail("must not preflight"),
      confirmPayment: () => assert.fail("must not write"), FlowError,
    };
    new Function("exports", ...Object.keys(mocks), code)(exports, ...Object.values(mocks));
    const form = new FormData();
    form.set("proxyOwnerConfirmed", acknowledged); form.set("expectedOwnerContactId", owner);
    assert.equal(await exports.actionConfirmPaymentOwnerProxy(form), "proxy_unavailable");
    assert.deepEqual(events, ["consent", "guard"]);
  }
});

test("M-PROXY terminal outcomes never call the writer or redirect", async () => {
  const source = ts.createSourceFile("actions.ts", readFileSync("src/server/actions.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["actionConfirmPaymentOwnerProxy", "bounce", "isRedirect"].includes(node.name?.text ?? ""));
  const code = ts.transpileModule(selected.map(node => node.getText(source)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const state of ["proxy_unavailable", "already_confirmed"]) {
    const exports: Record<string, (form: FormData) => Promise<unknown>> = {};
    new Function("exports", "paymentReturnTo", "requireCurrentConsent", "text", "guardEffectiveSession", "getSession",
      "confirmPayment", "redirect", "FlowError", "readProxyOwnerConfirmed", "moneyProxyConfirmationState", code)(exports,
      paymentReturnTo, async () => {}, String, async (s: unknown) => s, async () => ({}),
      () => assert.fail("must not write"), () => assert.fail("must not redirect"), FlowError, () => true, async () => state);
    const form = new FormData(); form.set("paymentId", "report"); form.set("proxyOwnerConfirmed", "true"); form.set("expectedOwnerContactId", "owner");
    assert.equal(await exports.actionConfirmPaymentOwnerProxy(form), state);
  }
});

test("M-PROXY uses transactional outcomes after an available preflight, including a concurrent confirmation", async () => {
  const source = ts.createSourceFile("actions.ts", readFileSync("src/server/actions.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "actionConfirmPaymentOwnerProxy")!;
  const code = ts.transpileModule(fn.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const outcome of ["confirmed", "already_confirmed", "proxy_unavailable"] as const) {
    const events: string[] = [];
    const exports: Record<string, (form: FormData) => Promise<unknown>> = {};
    const mocks = { paymentReturnTo, requireCurrentConsent: async () => {}, text: String,
      guardEffectiveSession: async (s: unknown) => s, getSession: async () => ({}),
      moneyProxyConfirmationState: async () => { events.push("preflight"); return "available"; },
      confirmPayment: async (_s: unknown, _id: string, options: unknown) => {
        events.push("transaction");
        assert.deepEqual(options, { proxyOwnerConfirmed: true, expectedOwnerContactId: "owner-a", source: "staff_ui" });
        if (outcome === "proxy_unavailable") throw new FlowError("errors.proxyOwnerMismatch");
        return { paymentId: "report", status: "confirmed", outcome };
      }, FlowError, readProxyOwnerConfirmed: () => true, isRedirect: () => false,
      redirect: () => assert.fail("must not redirect"), bounce: () => assert.fail("must not bounce"),
    };
    new Function("exports", ...Object.keys(mocks), code)(exports, ...Object.values(mocks));
    const form = new FormData();
    form.set("paymentId", "report"); form.set("expectedOwnerContactId", "owner-a");
    assert.equal(await exports.actionConfirmPaymentOwnerProxy(form), outcome);
    assert.deepEqual(events, ["preflight", "transaction"]);
    form.set("expectedOwnerContactId", "");
    assert.equal(await exports.actionConfirmPaymentOwnerProxy(form), "proxy_unavailable");
    assert.deepEqual(events, ["preflight", "transaction"]);
  }
});
