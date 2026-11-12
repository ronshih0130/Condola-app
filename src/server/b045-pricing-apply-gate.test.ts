// FILE: src/server/b045-pricing-apply-gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { runSubmitPricingApply } from "./pricing-apply-actions";
import type { Session } from "./types";
import { runCanAccessPricingApply } from "./pricing-interim";
import { isPricingPaidReceivedDate } from "./b045-pricing-interim-rules";

// Condola B-045 QA r2 — apply-gate access decision + paid-received date guard.
// No DB, no network: `query` / `readSession` / `canAccess` are injected doubles,
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
// A) B1 / CEO 03:45 — access denied (flag OFF), anonymous, otherwise-valid
//    submit: notFound() rejection and NO insert.
// ---------------------------------------------------------------------------
test("A/B1: flag OFF anonymous submit rejects (notFound) with no insert", async () => {
  let queryCalls = 0;
  let returned: unknown;
  let caught: unknown;
  let threw = false;
  try {
    returned = await runSubmitPricingApply(validForm(), {
      canAccess: async () => false,
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
// B) access granted (public mode) — anonymous valid submit: inserts once with
//    null org/user, then redirect()s (which must throw/be catchable, not hang).
// ---------------------------------------------------------------------------
test("B: flag ON anonymous valid submit inserts once (null org/user) then redirects", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let caught: unknown;
  try {
    await runSubmitPricingApply(validForm(), {
      canAccess: async () => true,
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
// B2) access granted (internal-only ON, allowlisted staff) — valid submit:
//     inserts once carrying the staff live org / user, then redirect()s.
// ---------------------------------------------------------------------------
test("B2: internal-only allowlisted staff valid submit inserts with org/user then redirects", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let caught: unknown;
  try {
    await runSubmitPricingApply(validForm(), {
      canAccess: async () => true,
      readSession: async () => ({ kind: "staff", liveOrgId: "org-1", userId: "user-1" }) as Session,
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
  assert.deepEqual(calls[0].params, ["org-1", "user-1", "Acme", "0912", 8, "standard", "hi"]);
  const onDigest = errorDigest(caught);
  if (onDigest) {
    assert.match(onDigest, /REDIRECT/i);
  }
});

// ---------------------------------------------------------------------------
// C) access granted — validation failure (empty companyName): returns focus
//    state, no insert.
// ---------------------------------------------------------------------------
test("C: flag ON validation failure returns field errors and does not insert", async () => {
  const form = validForm();
  form.set("companyName", "");

  let queryCalls = 0;
  let result: unknown;
  let threw = false;
  try {
    result = await runSubmitPricingApply(form, {
      canAccess: async () => true,
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
// E) runCanAccessPricingApply — the apply-gate access decision (PLT-30-AC1/AC2,
//    C3, Q-C, R11). All I/O injected: readGlobal / isOrgEnabled / readSession.
//    isOrgEnabled is a counter+impl so we can assert it is NOT called on public
//    mode or when there is no staff org (R11: never query with an empty org).
// ---------------------------------------------------------------------------

function orgEnabledSpy(impl: (orgId: string) => boolean) {
  const calls: string[] = [];
  const fn = async (orgId: string) => {
    calls.push(orgId);
    return impl(orgId);
  };
  return { fn, calls };
}

// E1 — OFF (C3 / R11): global disabled (or missing/malformed) + anonymous =>
// false, and the per-org gate is never consulted.
test("runCanAccessPricingApply: OFF + anonymous => false, isOrgEnabled not called", async () => {
  for (const global of [
    { enabled: false, allowed_org_ids: ["org"] },
    {},
    undefined,
  ]) {
    const org = orgEnabledSpy(() => true);
    const result = await runCanAccessPricingApply({
      readGlobal: async () => global,
      isOrgEnabled: org.fn,
      readSession: async () => null,
    });
    assert.equal(result, false, `OFF global ${JSON.stringify(global)} denies`);
    assert.equal(org.calls.length, 0, "OFF must not touch the per-org gate");
  }
});

// E2 — internal-only ON, anonymous (Q-C / R11 r2 hole): enabled:true with an
// allowlist (public not true) must NOT admit an anonymous caller, and must not
// call isOrgEnabled with an empty org.
test("runCanAccessPricingApply: internal-only ON + anonymous => false (r2 hole)", async () => {
  const org = orgEnabledSpy(() => true);
  const result = await runCanAccessPricingApply({
    readGlobal: async () => ({ enabled: true, allowed_org_ids: ["org"] }),
    isOrgEnabled: org.fn,
    readSession: async () => null,
  });
  assert.equal(result, false, "global enabled alone must not admit anonymous apply");
  assert.equal(org.calls.length, 0, "no staff org => isOrgEnabled must not be called");
});

// E3 — internal-only ON, allowlisted staff (PLT-30-AC1): staff live org defers
// to the per-org gate, which admits.
test("runCanAccessPricingApply: internal-only ON + allowlisted staff => true", async () => {
  const org = orgEnabledSpy((orgId) => orgId === "org");
  const result = await runCanAccessPricingApply({
    readGlobal: async () => ({ enabled: true, allowed_org_ids: ["org"] }),
    isOrgEnabled: org.fn,
    readSession: async () => ({ kind: "staff", liveOrgId: "org" }),
  });
  assert.equal(result, true, "allowlisted staff org is admitted");
  assert.deepEqual(org.calls, ["org"], "isOrgEnabled called once with the staff live org");
});

// E4 — internal-only ON, non-allowlisted staff (PLT-30-AC1 / R11): per-org gate
// denies.
test("runCanAccessPricingApply: internal-only ON + non-allowlisted staff => false", async () => {
  const org = orgEnabledSpy((orgId) => orgId === "org");
  const result = await runCanAccessPricingApply({
    readGlobal: async () => ({ enabled: true, allowed_org_ids: ["org"] }),
    isOrgEnabled: org.fn,
    readSession: async () => ({ kind: "staff", liveOrgId: "other" }),
  });
  assert.equal(result, false, "non-allowlisted staff org is denied");
  assert.deepEqual(org.calls, ["other"], "isOrgEnabled called once with the staff live org");
});

// E5 — internal-only ON, tenant/owner session (Q-C): only staff live orgs are
// eligible; tenant/owner callers never reach the per-org gate.
test("runCanAccessPricingApply: internal-only ON + tenant/owner => false, no per-org call", async () => {
  for (const session of [
    { kind: "tenant", liveOrgId: "org" },
    { kind: "owner", orgId: "org" },
  ]) {
    const org = orgEnabledSpy(() => true);
    const result = await runCanAccessPricingApply({
      readGlobal: async () => ({ enabled: true, allowed_org_ids: ["org"] }),
      isOrgEnabled: org.fn,
      readSession: async () => session,
    });
    assert.equal(result, false, `${session.kind} session is denied`);
    assert.equal(org.calls.length, 0, "non-staff session must not touch the per-org gate");
  }
});

// E6 — public mode (PLT-30-AC2 / C3): enabled:true AND public:true admits
// anonymous without reading the session or the per-org gate. Holds regardless
// of the allowlist contents.
test("runCanAccessPricingApply: public mode => true without session/per-org", async () => {
  for (const global of [
    { enabled: true, public: true, allowed_org_ids: ["org"] },
    { enabled: true, public: true, allowed_org_ids: [] },
  ]) {
    const org = orgEnabledSpy(() => false);
    const result = await runCanAccessPricingApply({
      readGlobal: async () => global,
      isOrgEnabled: org.fn,
      readSession: async () => {
        throw new Error("public mode must not read the session");
      },
    });
    assert.equal(result, true, `public mode admits anonymous: ${JSON.stringify(global)}`);
    assert.equal(org.calls.length, 0, "public mode must not touch the per-org gate");
  }
});

// E7 — kill switch (C3 / R11): public:true but enabled:false => false even for
// anonymous; the per-org gate stays untouched.
test("runCanAccessPricingApply: kill switch (enabled:false, public:true) => false", async () => {
  const org = orgEnabledSpy(() => true);
  const result = await runCanAccessPricingApply({
    readGlobal: async () => ({ enabled: false, public: true }),
    isOrgEnabled: org.fn,
    readSession: async () => null,
  });
  assert.equal(result, false, "enabled:false kill switch denies even in public shape");
  assert.equal(org.calls.length, 0, "kill switch must not touch the per-org gate");
});

// E8 — fail-closed (R11): any throw while reading the global setting => false.
test("runCanAccessPricingApply: readGlobal throws => false (fail-closed)", async () => {
  const org = orgEnabledSpy(() => true);
  const result = await runCanAccessPricingApply({
    readGlobal: async () => {
      throw new Error("boom");
    },
    isOrgEnabled: org.fn,
    readSession: async () => null,
  });
  assert.equal(result, false, "a thrown readGlobal fails closed");
  assert.equal(org.calls.length, 0, "fail-closed path must not touch the per-org gate");
});

// ---------------------------------------------------------------------------
// E9 — `public` fail-closed defaulting (CEO confirmed the field name
//      2026-11-12 05:26 PST). The `public` flag defaults to false whenever it
//      is absent, non-boolean, or the whole setting fails to parse. In every
//      one of those shapes an anonymous caller must be denied on BOTH the GET
//      (runCanAccessPricingApply) and the submit (runSubmitPricingApply) paths:
//      GET returns false without consulting the per-org gate, and the submit
//      throws notFound() with no insert and no returned state.
//
// Each case drives the real gate decision through runCanAccessPricingApply, and
// feeds that SAME decision (same readGlobal) into runSubmitPricingApply as its
// `canAccess` so the submit denial is anchored to the actual access logic.
// ---------------------------------------------------------------------------
async function assertPublicFailClosedDenies(
  readGlobal: () => Promise<unknown>,
  label: string,
) {
  // GET: anonymous access decision denies; per-org gate untouched.
  const getOrg = orgEnabledSpy(() => true);
  const access = await runCanAccessPricingApply({
    readGlobal: readGlobal as never,
    isOrgEnabled: getOrg.fn,
    readSession: async () => null,
  });
  assert.equal(access, false, `${label}: anonymous GET denied`);
  assert.equal(getOrg.calls.length, 0, `${label}: GET must not touch the per-org gate`);

  // Submit: the SAME access decision (same readGlobal) gates the submit, which
  // must throw notFound() with no insert and no returned state.
  const submitOrg = orgEnabledSpy(() => true);
  const canAccess = async () =>
    runCanAccessPricingApply({
      readGlobal: readGlobal as never,
      isOrgEnabled: submitOrg.fn,
      readSession: async () => null,
    });

  let queryCalls = 0;
  let returned: unknown;
  let caught: unknown;
  let threw = false;
  try {
    returned = await runSubmitPricingApply(validForm(), {
      canAccess,
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

  assert.equal(queryCalls, 0, `${label}: denied submit must not insert`);
  assert.ok(threw, `${label}: denied submit must throw (notFound), not return state`);
  assert.equal(returned, undefined, `${label}: denied submit must not return state`);
  assert.equal(submitOrg.calls.length, 0, `${label}: submit gate must not touch the per-org gate`);
  const digest = errorDigest(caught);
  if (digest) {
    assert.match(digest, /404|NOT_FOUND/i, `${label}: notFound() 404 digest`);
  }
}

// E9a — missing `public` field: enabled:true with an allowlist but no `public`
// key. `public` defaults to false, so even enabled:true must deny anonymous
// GET/submit (this is also the internal-only ON hole).
test("runCanAccessPricingApply/submit: missing `public` field => defaults false, denies anonymous", async () => {
  await assertPublicFailClosedDenies(
    async () => ({ enabled: true, allowed_org_ids: ["org"] }),
    "missing public",
  );
});

// E9b — non-boolean `public` value: a string/number `public` is not boolean
// true, so it defaults to false and must deny anonymous GET/submit.
test("runCanAccessPricingApply/submit: non-boolean `public` => defaults false, denies anonymous", async () => {
  for (const value of ["true", 1]) {
    await assertPublicFailClosedDenies(
      async () => ({ enabled: true, public: value, allowed_org_ids: ["org"] }),
      `non-boolean public ${JSON.stringify(value)}`,
    );
  }
});

// E9c — JSON parse failure of the stored setting: a malformed string that
// JSON.parse throws on must fail closed immediately — deny anonymous GET/submit
// and never call isOrgEnabled (already asserted inside the helper).
test("runCanAccessPricingApply/submit: setting fails JSON.parse => fail-closed, denies anonymous", async () => {
  for (const raw of ["{not json", "{enabled:true,public:true"]) {
    await assertPublicFailClosedDenies(async () => raw, `parse failure ${JSON.stringify(raw)}`);
  }
});

// ---------------------------------------------------------------------------
// OFF source-order test for the action file: in runSubmitPricingApply the
// canAccess/notFound gate must precede any deps.query / submit_pricing_apply,
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

  const canAccessIdx = fn.indexOf("deps.canAccess");
  const notFoundIdx = fn.indexOf("notFound()");
  const queryIdx = fn.indexOf("deps.query");
  const submitIdx = fn.indexOf("submit_pricing_apply");

  assert.ok(canAccessIdx >= 0, "gate checks deps.canAccess");
  assert.ok(notFoundIdx >= 0, "gate calls notFound()");
  assert.ok(queryIdx >= 0, "function reaches deps.query on the ON path");
  assert.ok(submitIdx >= 0, "function calls app.submit_pricing_apply on the ON path");

  assert.ok(canAccessIdx < queryIdx, "canAccess gate precedes deps.query");
  assert.ok(notFoundIdx < queryIdx, "notFound() precedes deps.query");
  assert.ok(canAccessIdx < submitIdx, "canAccess gate precedes submit_pricing_apply");
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
test("source: page gates on canAccessPricingApply with notFound() before any form/success JSX", () => {
  const src = readFileSync(
    new URL("../app/pricing/apply/page.tsx", import.meta.url),
    "utf8",
  );

  assert.ok(
    src.includes("canAccessPricingApply"),
    "page consults canAccessPricingApply",
  );
  assert.ok(
    !src.includes("isPricingInterimGloballyEnabled"),
    "page must not gate on the raw isPricingInterimGloballyEnabled primitive",
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
