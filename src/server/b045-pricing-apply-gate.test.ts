// FILE: src/server/b045-pricing-apply-gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runSubmitPricingApply } from "./pricing-apply-actions";
import { isPricingPaidReceivedDate } from "./b045-pricing-interim-rules";

// Condola B-045 QA r2 — flag-gated public apply action + paid-received date guard.
// No DB, no network: `query` / `readSession` / `isEnabled` are injected doubles,
// and notFound()/redirect() are Next control-flow throws we catch locally.
//
// A static import of the real action module is used (tsx's cjs output does not
// support the top-level-await dynamic-import loop). We never use mock.module.

type QueryStub = typeof import("./db").query;

function asQuery(fn: object): QueryStub {
  return fn as QueryStub;
}

function errorDigest(err: unknown): string | undefined {
  if (err && typeof err === "object" && "digest" in err && typeof (err as { digest: unknown }).digest === "string") {
    return (err as { digest: string }).digest;
  }
  return undefined;
}

function validForm(): FormData {
  const form = new FormData();
  form.set("companyName", "Acme");
  form.set("phone", "0912");
  form.set("units", "8");
  form.set("plan", "standard");
  form.set("note", "hi");
  return form;
}

// ---------------------------------------------------------------------------
// A) B1 / CEO 03:45 — flag OFF, anonymous, otherwise-valid submit:
//    notFound() rejection and NO insert.
// ---------------------------------------------------------------------------
test("A/B1: flag OFF anonymous submit rejects (notFound) with no insert", async () => {
  let queryCalls = 0;
  let returned: unknown;
  let caught: unknown;
  let threw = false;
  try {
    returned = await runSubmitPricingApply(validForm(), {
      isEnabled: async () => false,
      readSession: async () => null,
      query: asQuery(async () => {
        queryCalls += 1;
        return { rows: [{ id: "x" }] };
      }),
    });
  } catch (err) {
    threw = true;
    caught = err;
  }

  assert.equal(queryCalls, 0, "OFF branch must not reach any query/insert");
  assert.ok(threw, "OFF branch must throw (notFound), not return state");
  assert.equal(returned, undefined, "OFF branch must not return an ApplyActionState");
  // notFound() carries a 404 fallback digest in this repo (same shape as
  // notification-off.integration.test.ts: "NEXT_HTTP_ERROR_FALLBACK;404").
  const offDigest = errorDigest(caught);
  if (offDigest) {
    assert.match(offDigest, /404|NOT_FOUND/i);
  }
});

// ---------------------------------------------------------------------------
// B) flag ON — anonymous valid submit: inserts once with null org/user,
//    then redirect()s (which must throw/be catchable, not hang).
// ---------------------------------------------------------------------------
test("B: flag ON anonymous valid submit inserts once (null org/user) then redirects", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let caught: unknown;
  try {
    await runSubmitPricingApply(validForm(), {
      isEnabled: async () => true,
      readSession: async () => null,
      query: asQuery(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [{ id: "x" }] };
      }),
    });
  } catch (err) {
    caught = err; // expected: redirect("/pricing/apply?done=1") -> NEXT_REDIRECT
  }

  assert.equal(calls.length, 1, "exactly one SQL entry-point call");
  assert.match(calls[0].sql, /submit_pricing_apply/);
  assert.deepEqual(calls[0].params, [null, null, "Acme", "0912", 8, "standard", "hi"]);
  const onDigest = errorDigest(caught);
  if (onDigest) {
    assert.match(onDigest, /REDIRECT/i);
  }
});

// ---------------------------------------------------------------------------
// C) flag ON — validation failure (empty companyName): returns focus state,
//    no insert.
// ---------------------------------------------------------------------------
test("C: flag ON validation failure returns field errors and does not insert", async () => {
  const form = validForm();
  form.set("companyName", "");

  let queryCalls = 0;
  let result: unknown;
  let threw = false;
  try {
    result = await runSubmitPricingApply(form, {
      isEnabled: async () => true,
      readSession: async () => null,
      query: asQuery(async () => {
        queryCalls += 1;
        return { rows: [] };
      }),
    });
  } catch {
    threw = true;
  }

  assert.equal(queryCalls, 0, "validation failure must not insert");
  assert.equal(threw, false, "validation failure returns state, does not throw");
  assert.ok(result && typeof result === "object" && "ok" in result && result.ok === false, "returns an ApplyActionState focus state");
  const focus = result as { ok: false; errors: { companyName?: true }; first: string };
  assert.equal(focus.errors.companyName, true, "empty companyName flagged");
  assert.equal(focus.first, "companyName");
});

// ---------------------------------------------------------------------------
// D) L4 — isPricingPaidReceivedDate strict YYYY-MM-DD calendar validation.
// ---------------------------------------------------------------------------
test("D: isPricingPaidReceivedDate accepts real calendar dates", () => {
  for (const good of ["2026-02-28", "2024-02-29", "2026-01-31"]) {
    assert.equal(isPricingPaidReceivedDate(good), true, `expected true: ${good}`);
  }
});

test("D: isPricingPaidReceivedDate rejects empty / impossible / loose dates", () => {
  for (const bad of [
    "",
    "2026-02-31",
    "2026-13-01",
    "2026-04-31",
    "2026-02-31 ",
    "31/02/2026",
    "2026-2-1",
    "2025-02-29",
  ]) {
    assert.equal(
      isPricingPaidReceivedDate(bad),
      false,
      `expected false: ${JSON.stringify(bad)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// OFF source-order test for the action file: in runSubmitPricingApply the
// isEnabled/notFound gate must precede any deps.query / submit_pricing_apply,
// and the OFF branch performs no insert. Runs regardless of import success.
// ---------------------------------------------------------------------------
test("source: OFF gate precedes any query/insert in runSubmitPricingApply", () => {
  const src = readFileSync(
    new URL("./pricing-apply-actions.ts", import.meta.url),
    "utf8",
  );

  const start = src.indexOf("export async function runSubmitPricingApply");
  assert.ok(start >= 0, "runSubmitPricingApply found");
  const after = src.indexOf("export type PricingApplyRequest", start);
  const fn = src.slice(start, after === -1 ? undefined : after);

  const isEnabledIdx = fn.indexOf("deps.isEnabled");
  const notFoundIdx = fn.indexOf("notFound()");
  const queryIdx = fn.indexOf("deps.query");
  const submitIdx = fn.indexOf("submit_pricing_apply");

  assert.ok(isEnabledIdx >= 0, "gate checks deps.isEnabled");
  assert.ok(notFoundIdx >= 0, "gate calls notFound()");
  assert.ok(queryIdx >= 0, "function reaches deps.query on the ON path");
  assert.ok(submitIdx >= 0, "function calls app.submit_pricing_apply on the ON path");

  assert.ok(isEnabledIdx < queryIdx, "isEnabled gate precedes deps.query");
  assert.ok(notFoundIdx < queryIdx, "notFound() precedes deps.query");
  assert.ok(isEnabledIdx < submitIdx, "isEnabled gate precedes submit_pricing_apply");
  assert.ok(notFoundIdx < submitIdx, "notFound() precedes submit_pricing_apply");

  // Insert lands only through the SQL function, never a raw SQL INSERT. The
  // comments legitimately mention the word "insert", so match a real
  // `INSERT INTO ...` statement rather than the bare word.
  assert.ok(
    !/\binsert\s+into\b/i.test(fn),
    "no raw INSERT INTO in runSubmitPricingApply",
  );
});

// ---------------------------------------------------------------------------
// E) OFF render source test for the page: flag OFF => notFound() before any
//    form/success JSX; no redirect().
// ---------------------------------------------------------------------------
test("source: page gates on the flag with notFound() before any form/success JSX", () => {
  const src = readFileSync(
    new URL("../app/pricing/apply/page.tsx", import.meta.url),
    "utf8",
  );

  assert.ok(
    src.includes("isPricingInterimGloballyEnabled"),
    "page consults isPricingInterimGloballyEnabled",
  );
  assert.ok(src.includes("notFound"), "page imports/uses notFound");

  const exportIdx = src.indexOf("export default async function");
  assert.ok(exportIdx >= 0, "default export found");
  const body = src.slice(exportIdx);

  const notFoundIdx = body.indexOf("notFound()");
  const formIdx = body.indexOf("PricingApplyForm");
  const successIdx = body.indexOf("apply-success");

  assert.ok(notFoundIdx >= 0, "default export calls notFound()");
  assert.ok(formIdx >= 0, "default export renders PricingApplyForm");
  assert.ok(successIdx >= 0, "default export renders apply-success branch");

  assert.ok(notFoundIdx < formIdx, "notFound() precedes PricingApplyForm JSX");
  assert.ok(notFoundIdx < successIdx, "notFound() precedes apply-success JSX");

  // Fail-closed via a real 404, never a redirect() import or call.
  // Do not match the word "redirect" in comments (the page comment says "NOT a redirect").
  assert.doesNotMatch(src, /import\s*\{[^}]*\bredirect\b/, "page must not import redirect");
  assert.doesNotMatch(src, /\bredirect\s*\(/, "page must not call redirect()");
});
