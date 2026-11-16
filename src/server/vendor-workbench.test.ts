import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as format from "./format";
import * as rules from "./vendor-repair-rules";
import * as paths from "../lib/vendor-workbench-paths";
import type { VendorAccountHistory } from "../lib/vendor-account-types";

// B-063 reader unit tests (VEN-14-AC1, AC3, AC7, AC8): admission matrix, row mapping, amounts and the job opener.
// The DB is faked by SQL text here; the real gateways run in b063-vendor-workbench.integration.test.ts.
const requireHere = createRequire(import.meta.url);
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ORG2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB = "11111111-1111-4111-8111-111111111111", JOB2 = "22222222-2222-4222-8222-222222222222";
const TOKEN = "A".repeat(43), CREDENTIAL = "account-session-credential";
type Fake = { history?: VendorAccountHistory | Error; actor?: string | Error; consent?: boolean; flag?: boolean | null; company?: string;
  brand?: boolean; gateway?: unknown[] | Error; token?: string | null; path?: string; cookies?: Record<string, string> };
function load(fake: Fake) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("b026_account_actor")) { if (fake.actor instanceof Error) throw fake.actor; return { rows: [{ actor: fake.actor ?? "actor" }] }; }
    if (sql.includes("vendor_workbench'")) return { rows: fake.flag === null ? [] : [{ open: fake.flag ?? true, company: fake.company ?? "安居物業" }] };
    if (sql.includes("b063_vendor_workbench")) { if (fake.gateway instanceof Error) throw fake.gateway; return { rows: [{ result: fake.gateway ?? [] }] }; }
    if (sql.includes("repair_vendor_secrets")) return { rows: fake.token === null ? [] : [{ token: fake.token ?? TOKEN }] };
    throw new Error(`unexpected SQL ${sql}`);
  };
  const historyCalls: string[] = [];
  const mocks: Record<string, unknown> = {
    react: { cache: (fn: unknown) => fn },
    "next/headers": {
      cookies: async () => ({ get: (key: string) => fake.cookies?.[key] === undefined ? undefined : { value: fake.cookies[key] } }),
      headers: async () => ({ get: () => fake.path ?? "" }),
    },
    "./auth": { SESSION_COOKIE: "condola_session" }, "./org-scope": { ORG_COOKIE: "condola_org" },
    "./brand-v3": { brandV3EnabledForOrg: async (org: string) => { calls.push({ sql: "brand", params: [org] }); return fake.brand ?? true; } },
    "./consent": { readConsent: async () => ({}), consentCoversCurrent: () => fake.consent ?? true },
    "./db": { svc: async (_user: null, fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }) },
    "./format": format, "./vendor-repair-rules": rules, "../lib/vendor-workbench-paths": paths,
    "./vendor-accounts": { vendorAccountHistory: async (credential: string) => {
      historyCalls.push(credential);
      if (fake.history instanceof Error) throw fake.history;
      return fake.history ?? history();
    } },
  };
  const code = ts.transpileModule(readFileSync("src/server/vendor-workbench.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (name === "node:crypto") return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return { module: exports as Record<string, (...args: never[]) => Promise<unknown>> & Record<string, unknown>, calls, historyCalls };
}
function history(settings: { orgId: string; name: string }[] = [{ orgId: ORG, name: " 陳師傅 " }], jobs: VendorAccountHistory["jobs"] = []): VendorAccountHistory {
  return { settings: settings.map(item => ({ ...item, contactId: "contact" })), jobs };
}
const job = (jobId: string, status: string, extra: Partial<VendorAccountHistory["jobs"][number]> = {}) =>
  ({ jobId, orgId: ORG, ticketId: "ticket", status, description: " 浴室天花板滴水 ", readOnly: status === "closed" || status === "cancelled", ...extra });
const denied = Object.assign(new Error("errors.forbidden"), { cause: { code: "42501" } });

test("VEN-14-AC7: no credential, an oversized one or a rejected session is anonymous; nothing else is read", async () => {
  for (const credential of [undefined, "", "x".repeat(513)]) {
    const { module, calls } = load({});
    assert.deepEqual(await (module.vendorWorkbenchAccess as (c?: string, o?: string) => Promise<unknown>)(credential, ORG), { state: "anonymous" });
    assert.equal(calls.length, 0);
  }
  const { module, calls, historyCalls } = load({ actor: denied });
  assert.deepEqual(await (module.vendorWorkbenchAccess as (c?: string, o?: string) => Promise<unknown>)(TOKEN, ORG), { state: "anonymous" });
  assert.equal(calls.length, 1); assert.deepEqual(historyCalls, []);
  // The session is looked up by its hash, never by the raw value.
  assert.deepEqual(calls[0].params, [createHash("sha256").update(TOKEN).digest("hex")]);
  const other = load({ actor: Object.assign(new Error("lock"), { cause: { code: "55P03" } }) });
  await assert.rejects((other.module.vendorWorkbenchAccess as (c?: string, o?: string) => Promise<unknown>)(CREDENTIAL, ORG), /lock/);
});

test("VEN-14-AC8 admission matrix: consent, persona, organization choice, own flag and brand_v3 all required", async () => {
  const access = async (fake: Fake, org?: string) => (load(fake).module.vendorWorkbenchAccess as (c?: string, o?: string) => Promise<unknown>)(CREDENTIAL, org);
  const on = { state: "on", scope: { orgId: ORG, name: "陳師傅", company: "安居物業" } };
  assert.deepEqual(await access({ consent: false }, ORG), { state: "consent" });
  assert.deepEqual(await access({ history: history([]) }, ORG), { state: "other" });
  assert.deepEqual(await access({}, ORG), on);
  assert.deepEqual(await access({}, ORG.toUpperCase()), on, "cookie case does not matter");
  assert.deepEqual(await access({}), on, "one organization needs no cookie");
  assert.deepEqual(await access({}, ORG2), on, "a cookie for an organization without an account is ignored");
  assert.deepEqual(await access({}, "not-a-uuid"), on);
  const two = history([{ orgId: ORG, name: "陳師傅" }, { orgId: ORG2, name: "陳師傅二" }]);
  assert.deepEqual(await access({ history: two }), { state: "off" }, "OV-SH-ORG gap: no current organization among several");
  assert.deepEqual(await access({ history: two }, ORG2), { state: "on", scope: { orgId: ORG2, name: "陳師傅二", company: "安居物業" } });
  for (const flag of [false, null]) assert.deepEqual(await access({ flag }, ORG), { state: "off" });
  assert.deepEqual(await access({ brand: false }, ORG), { state: "off" });
  const { module, calls } = load({ flag: false });
  await (module.vendorWorkbenchAccess as (c?: string, o?: string) => Promise<unknown>)(CREDENTIAL, ORG);
  assert.ok(!calls.some(call => call.sql === "brand"), "brand is read only after the org flag");
  assert.match(calls.find(call => call.sql.includes("vendor_workbench'"))!.sql, /coalesce\(feature_flags->'vendor_workbench'='true'::jsonb,false\)/);
});

test("currentVendorWorkbench never fails open; the root brand helper only answers on /vendor-account paths", async () => {
  const failing = load({ history: new Error("down"), cookies: { condola_session: CREDENTIAL } });
  assert.deepEqual(await (failing.module.currentVendorWorkbench as () => Promise<unknown>)(), { state: "off" });
  for (const [path, expected] of [["/vendor-account", ORG], ["/vendor-account/jobs", ORG], ["/vendor-accounts", null], ["/m", null], ["/v/token", null]] as const) {
    const { module, historyCalls } = load({ path, cookies: { condola_session: CREDENTIAL, condola_org: ORG } });
    assert.equal(await (module.vendorWorkbenchBrandOrg as () => Promise<unknown>)(), expected, path);
    assert.equal(historyCalls.length, expected ? 1 : 0, `${path}: no account read off the workbench paths`);
  }
  const off = load({ path: "/vendor-account", flag: false, cookies: { condola_session: CREDENTIAL } });
  assert.equal(await (off.module.vendorWorkbenchBrandOrg as () => Promise<unknown>)(), null);
});

test("V-HOME / V-JOBS / V-RECV rows: own organization, open statuses, gateway admission, waiting amounts", () => {
  const { module } = load({});
  const rows = module.workbenchRows as unknown as (h: VendorAccountHistory, g: unknown[], org: string, locale: "zh-TW" | "en") => { jobs: unknown[]; payments: unknown[] };
  const ids = (n: number) => `${String(n).repeat(8)}-9999-4999-8999-999999999999`;
  const statuses = ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"];
  const h = history(undefined, [...statuses.map((status, i) => job(ids(i + 1), status)),
    job(JOB, "open", { orgId: ORG2 }), job(JOB2, "open", { description: null })]);
  const gateway = [...statuses.map((_, i) => ({ jobId: ids(i + 1), property: "信義路 2 樓 ", currency: "TWD ", waitingMinor: i === 5 ? "120000" : i === 6 ? "0" : null, openable: i !== 1 })),
    { jobId: JOB, property: "x", currency: "TWD", waitingMinor: "500", openable: true }];
  const out = rows(h, gateway, ORG, "zh-TW");
  assert.deepEqual(out.jobs, [
    { jobId: ids(1), property: "信義路 2 樓 ", item: "浴室天花板滴水", status: "visit", href: `/vendor-account/jobs/${ids(1)}` },
    { jobId: ids(2), property: "信義路 2 樓 ", item: "浴室天花板滴水", status: "visit", href: null },
    { jobId: ids(3), property: "信義路 2 樓 ", item: "浴室天花板滴水", status: "visit", href: `/vendor-account/jobs/${ids(3)}` },
    { jobId: ids(4), property: "信義路 2 樓 ", item: "浴室天花板滴水", status: "working", href: `/vendor-account/jobs/${ids(4)}` },
    { jobId: ids(5), property: "信義路 2 樓 ", item: "浴室天花板滴水", status: "working", href: `/vendor-account/jobs/${ids(5)}` },
  ], "resolved/closed/cancelled are not open; another organization's job and a job the gateway does not admit are dropped");
  assert.deepEqual(out.payments, [{ jobId: ids(6), property: "信義路 2 樓 ", item: "浴室天花板滴水", amount: "NT$1,200", href: `/vendor-account/jobs/${ids(6)}` }],
    "zero and missing waiting amounts are not 待收款 rows; amounts never show NT$0");
  assert.equal(JSON.stringify(rows(h, gateway, ORG, "en").payments), JSON.stringify(out.payments));
  for (const waitingMinor of ["-5", "1.5", "abc", ""]) {
    assert.deepEqual(rows(history(undefined, [job(JOB, "resolved")]), [{ jobId: JOB, property: "p", currency: "TWD", waitingMinor, openable: true }], ORG, "zh-TW").payments, []);
  }
  assert.deepEqual(rows(history(undefined, [job(JOB, "resolved")]), [{ jobId: JOB, property: "p", currency: null, waitingMinor: "100", openable: true }], ORG, "zh-TW").payments, []);
});

test("vendorWorkbenchView: one B-026 history read plus the B-063 gateway by session hash and organization; failures are an error state", async () => {
  const ok = load({ history: history(undefined, [job(JOB, "open")]), gateway: [{ jobId: JOB, property: "松仁匯 7F", currency: "TWD", waitingMinor: null, openable: true }] });
  const view = await (ok.module.vendorWorkbenchView as (c: string, o: string, l: string) => Promise<{ status: string; jobs: unknown[] }>)(CREDENTIAL, ORG, "zh-TW");
  assert.equal(view.status, "ready"); assert.equal(view.jobs.length, 1);
  const call = ok.calls.find(c => c.sql.includes("b063_vendor_workbench"))!;
  assert.equal(call.sql, "SELECT app.b063_vendor_workbench($1,$2) AS result");
  assert.deepEqual(call.params, [createHash("sha256").update(CREDENTIAL).digest("hex"), ORG]);
  assert.ok(!JSON.stringify(view).includes(CREDENTIAL));
  for (const fake of [{ history: new Error("history") }, { gateway: new Error("gateway") }, { history: denied }] as Fake[]) {
    assert.deepEqual(await (load(fake).module.vendorWorkbenchView as (c: string, o: string, l: string) => Promise<unknown>)(CREDENTIAL, ORG, "zh-TW"), { status: "error" });
  }
  const noCookie = load({ cookies: {} });
  assert.deepEqual(await (noCookie.module.currentVendorWorkbenchView as (o: string, l: string) => Promise<unknown>)(ORG, "zh-TW"), { status: "error" });
  assert.equal(noCookie.calls.length, 0);
});

test("Row 查看 opens only this account's admitted job, pinned to the open organization, never another's", async () => {
  const opened = (fake: Fake, jobId = JOB, credential: string | undefined = CREDENTIAL) => {
    const loaded = load({ history: history(undefined, [job(JOB, "open"), job(JOB2, "resolved")]),
      gateway: [{ jobId: JOB, property: "p", currency: "TWD", waitingMinor: null, openable: true }, { jobId: JOB2, property: "p", currency: "TWD", waitingMinor: null, openable: true }], ...fake });
    return { loaded, result: (loaded.module.vendorWorkbenchJobToken as (c?: string, o?: string, j?: string) => Promise<string | null>)(credential, ORG, jobId) };
  };
  const own = opened({});
  assert.equal(await own.result, TOKEN);
  const secret = own.loaded.calls.find(c => c.sql.includes("repair_vendor_secrets"))!;
  assert.match(secret.sql, /WHERE s\.job_id=\$1 AND j\.org_id=\$2/); assert.deepEqual(secret.params, [JOB, ORG]);
  assert.equal(await opened({}, JOB.toUpperCase()).result, TOKEN);
  for (const [fake, jobId, credential, why] of [
    [{}, "not-a-uuid", CREDENTIAL, "malformed id"], [{}, JOB2, CREDENTIAL, "a job with nothing open or waiting"],
    [{}, "33333333-3333-4333-8333-333333333333", CREDENTIAL, "another account's job"], [{ flag: false }, JOB, CREDENTIAL, "workbench OFF"],
    [{ brand: false }, JOB, CREDENTIAL, "brand_v3 OFF"], [{ actor: denied }, JOB, TOKEN, "a job token is not an account session"],
    [{}, JOB, "", "no session"], [{ token: null }, JOB, CREDENTIAL, "no stored link"], [{ token: "short" }, JOB, CREDENTIAL, "malformed stored link"],
    [{ gateway: [{ jobId: JOB, property: "p", currency: null, waitingMinor: null, openable: false }] }, JOB, CREDENTIAL, "gateway: not openable"],
    [{ gateway: [] }, JOB, CREDENTIAL, "gateway does not admit it"],
  ] as [Fake, string, string | undefined, string][]) {
    const { loaded, result } = opened(fake, jobId, credential);
    assert.equal(await result, null, why);
    if (why !== "no stored link" && why !== "malformed stored link") assert.ok(!loaded.calls.some(c => c.sql.includes("repair_vendor_secrets")), `${why}: no secret read`);
  }
});

test("cookieFrom reads exactly the named cookie", () => {
  const { module } = load({});
  const read = module.cookieFrom as unknown as (r: Request, n: string) => string | undefined;
  const request = new Request("http://localhost/", { headers: { cookie: "condola_session_x=bad; condola_session=good; condola_org=org" } });
  assert.equal(read(request, "condola_session"), "good"); assert.equal(read(request, "condola_org"), "org");
  assert.equal(read(new Request("http://localhost/"), "condola_session"), undefined);
});

test("session.ts keeps the account shell's no-touch, no-persona rule on every workbench route", () => {
  const session = readFileSync("src/server/session.ts", "utf8");
  assert.match(session, /if \(path === "\/vendor-account" \|\| path\.startsWith\("\/vendor-account\/"\)\) return \{ session: null, seedSample: false \};/);
});
