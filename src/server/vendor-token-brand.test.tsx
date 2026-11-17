import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as i18n from "../i18n";
import * as notificationCopy from "../i18n/lanes/notification-center";
import * as linkCopy from "../i18n/lanes/vendor-link";
import * as rules from "./vendor-repair-rules";
import { VendorTokenShell } from "../components/v3/vendor/token-shell";
import type { VendorJobPage } from "./vendor-repair";
import type { VendorTokenBrand } from "./vendor-token-brand";

const requireHere = createRequire(import.meta.url);
const source = (path: string) => readFileSync(path, "utf8");
function compile(text: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency (including any history reader): ${name}`);
  }, exports);
  return exports;
}
const token = Buffer.alloc(32, 1).toString("base64url");
const context: VendorTokenBrand = { name: "Vendor A", company: "Company A", property: "Property A", status: "assigned" };
const job: VendorJobPage = { title: "This job only", description: "Description", address: "Address A", place: "Unit A", window: "Monday", currency: "TWD", reported: false,
  issuePhotos: [{ id: "issue-photo", name: "issue.jpg" }], donePhotos: [{ id: "done-photo", name: "done.jpg" }] };
const pageSource = source("src/app/v/[token]/page.tsx");
const legacyNotificationSource = execFileSync("git", ["show", "3e87c93:src/components/notification-center-entry.tsx"], { encoding: "utf8" });
const baseline = execFileSync("git", ["show", "3e87c93:src/app/v/[token]/page.tsx"], { encoding: "utf8" });

type Scenario = { admission?: "enabled" | "busy" | "disabled" | "denied"; enabled?: boolean; v2?: boolean; locale?: i18n.Locale; job?: VendorJobPage | null; state?: Record<string, unknown> | null; line?: boolean; match?: boolean; vendorCase?: unknown };
function page(text: string, scenario: Scenario) {
  const locale = scenario.locale ?? "zh-TW";
  const v2 = scenario.v2 ?? false;
  const calls: string[] = [];
  const details = compile(source("src/components/vendor-link-details.tsx"), {
    "@/server/brand-v2": { brandV2Enabled: () => v2 }, "@/i18n/lanes/vendor-link": linkCopy,
  });
  const notificationEntry = compile(text === baseline
    ? legacyNotificationSource
    : source("src/components/notification-center-entry.tsx"), {
    "next/link": { default: ({ prefetch, ...props }: React.ComponentProps<"a"> & { prefetch?: boolean }) => {
      assert.equal(prefetch, false); return <a {...props} />;
    } },
    "@/i18n/lanes/notification-center": notificationCopy,
    "@/server/notification-center": { centerVendorAdmission: async (value: string) => {
      assert.equal(value, token); return scenario.admission ?? "disabled";
    } },
  });
  async function resolveEntries(node: React.ReactNode): Promise<React.ReactNode> {
    if (Array.isArray(node)) return Promise.all(node.map(resolveEntries));
    if (!React.isValidElement(node)) return node;
    const element = node as React.ReactElement<{ children?: React.ReactNode }>;
    if (element.type === notificationEntry.VendorNotificationCenterEntry) {
      return (notificationEntry.VendorNotificationCenterEntry as (props: unknown) => Promise<React.ReactNode>)(element.props);
    }
    if (!("children" in element.props)) return element;
    const children = await resolveEntries(element.props.children);
    return Array.isArray(children) ? React.cloneElement(element, undefined, ...children)
      : React.cloneElement(element, undefined, children);
  }
  const mocks = {
    "@/i18n": i18n, "@/i18n/lanes/vendor-link": linkCopy,
    "@/components/v3/vendor/token-shell": { VendorTokenShell },
    "@/components/v3/vendor/line-match-entry": { VendorLineMatchEntry: () => <aside data-testid="line-match-entry" /> },
    "@/server/vendor-token-brand": { vendorTokenBrand: async (value: string, shared: boolean) => {
      assert.equal(value, token); calls.push(`brand:${shared}`); return scenario.enabled ? { ...context, property: shared ? context.property : "" } : null;
    } },
    "@/server/vendor-repair": { loadVendorJob: async (value: string) => { assert.equal(value, token); calls.push("job"); return scenario.job === undefined ? job : scenario.job; } },
    "@/server/vendor-job": { resolveVendorJobState: async (value: string) => { assert.equal(value, token); calls.push("state"); return scenario.state ?? null; } },
    "@/server/brand-v2": { brandV2Enabled: () => v2 },
    "@/server/session": { requestPrefs: async () => ({ locale }) },
    "@/server/line/vendor-entry": { vendorLineEntryEnabled: async (_token: string, match = false) => { calls.push(match ? "line-match" : "line"); return match ? scenario.match ?? false : scenario.line ?? false; } },
    "@/components/notification-center-entry": notificationEntry,
    "@/components/vendor-link-details": details,
    "@/components/ticket-photos": { TicketPhotoUpload: (props: { inputTestId: string; signPath: string; confirmPath: string; extra: { token: string } }) => {
      assert.equal(props.extra.token, token);
      return <div data-testid={props.inputTestId} data-sign={props.signPath} data-confirm={props.confirmPath} id={React.useId()} />;
    } },
    "@/components/ui": { ErrorBanner: ({ error }: { error?: string }) => error ? <p role="alert">{error}</p> : null },
    "@/server/actions": { actionVendorReport: "/existing-vendor-report" },
    // B-105: the case loader answers null (vendor_job_v3 OFF) unless a scenario supplies a case.
    "@/server/b105-vendor-case": { loadVendorCase: async (value: string) => { assert.equal(value, token); calls.push("case"); return scenario.vendorCase ?? null; },
      vendorCaseStage: (value: { decision: string | null }) => value.decision === "accepted" ? "open" : "accept",
      // B-097: the 回報完工 stage flag; these scenarios have no 處理前 photo.
      vendorCaseReportReady: () => false },
    // PLT-52-AC9: the relay read; these scenarios draw none.
    "@/server/b3-vendor-case-relay": { loadVendorCaseRelay: async () => null, relayForPage: () => null },
    "@/components/v3/vendor/vendor-case": { VendorCaseView: (props: { stage: string; heading: string; company: string }) => <section data-testid="vendor-case" data-stage={props.stage}>{props.heading}|{props.company}</section> },
    "./vendor-job-controls": { VendorJobControls: ({ children }: { children: React.ReactNode }) => <section data-testid="appointment-controls">{children}</section> },
    "./vendor-line-entry": { VendorLineEntry: () => <aside data-testid="line-entry" /> },
  };
  const render = compile(text, mocks).default as (props: { params: Promise<{token: string}>; searchParams: Promise<{error?: string}> }) => Promise<React.ReactNode>;
  return { calls, async html() { return renderToStaticMarkup(await resolveEntries(await render({ params: Promise.resolve({ token }), searchParams: Promise.resolve({ error: "existing-error" }) }))); } };
}

test("OFF parity: actual page serialization is byte-identical to 3e87c93, including photo useId and all existing states", async () => {
  const states = [null, { locked: true }, { locked: false, requestId: "request", versionId: "version", currentEvent: "vendor_completion_submitted" }];
  const jobs: VendorJobPage[] = [job, { ...job, reported: true },
    ...[true, false].flatMap(sharingApproved => (["write", "read_only"] as const).map(capability => ({
      ...job, vendorLink: { capability, sharingApproved, typeFields: [{ key: "fixture", label: "Type", value: "Existing field" }] },
    }))),
  ];
  let comparisons = 0;
  for (const locale of ["zh-TW", "en"] as const) for (const v2 of [false, true]) for (const fixture of jobs) for (const state of states) for (const line of [false, true]) for (const admission of ["enabled", "busy", "disabled", "denied"] as const) {
    const scenario = { job: fixture, locale, v2, state, line, admission, enabled: false };
    assert.equal(await page(pageSource, scenario).html(), await page(baseline, scenario).html()); comparisons++;
  }
  assert.equal(comparisons, 576);
});

test("invalid / expired / revoked / unshared-invalid token response stays identical and never asks for brand", async () => {
  for (const fixture of [null, { ...job, vendorLink: { capability: "invalid" as const, sharingApproved: false, typeFields: [] } }]) {
    const current = page(pageSource, { enabled: true, job: fixture });
    assert.equal(await current.html(), await page(baseline, { job: fixture }).html());
    assert.deepEqual(current.calls, ["job"]);
  }
});

test("ON: exact token job only; existing photo, report and appointment forms survive with their original write boundaries", async () => {
  const current = page(pageSource, { enabled: true, state: { locked: false, requestId: "request", versionId: "version" } });
  const html = await current.html();
  // B101 adds a read-only match gate on the ON branch; the legacy/OFF snapshot is unchanged.
  assert.deepEqual(current.calls, ["job", "brand:true", "state", "line-match"]);
  for (const marker of ["v-token-v3", "vendor-issue-photo", "vendor-done-photo", "vendor-photo", "vendor-submit", "vendor-propose", "vendor-reject", "vendor-complete"]) assert.ok(html.includes(`data-testid="${marker}"`), marker);
  for (const path of ["/existing-vendor-report", "/api/vendor-job-response", "/api/vendor-job-completion", "/api/vendor-jobs/photos/sign", "/api/vendor-jobs/photos/confirm"]) assert.ok(html.includes(path));
  assert.match(html, /name="requestId" value="request"/); assert.match(html, /name="versionId" value="version"/);
  assert.match(html, /existing-error/);
  assert.doesNotMatch(html, /legacy-notifications|line-entry|href="\/login|Other job|History job/);
});

test("ON notification bell and tab match legacy admission and destination, including busy retry", async () => {
  for (const admission of ["enabled", "busy", "disabled", "denied"] as const) {
    for (const fixture of [job, ...[false, true].flatMap(sharingApproved =>
      (["write", "read_only"] as const).map(capability => ({ ...job, vendorLink: { capability, sharingApproved, typeFields: [] } })))]) {
      const legacy = await page(baseline, { admission, job: fixture }).html();
      const html = await page(pageSource, { admission, job: fixture, enabled: true }).html();
      const legacyHref = legacy.match(/data-testid="notification-center-entry" href="([^"]+)"/)?.[1];
      if ((!fixture.vendorLink || fixture.vendorLink.sharingApproved) && (admission === "enabled" || admission === "busy")) {
        assert.equal(legacyHref, `/v/${encodeURIComponent(token)}/notifications`);
        assert.equal(html.split(`href="${legacyHref}"`).length - 1, 2, "bell and tab use legacy href");
        assert.match(html, /class="v-token-bell"/);
        assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 2);
      } else {
        assert.equal(legacyHref, undefined);
        assert.doesNotMatch(html, /class="v-token-bell"|href="[^"]*\/notifications"/);
        assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 3);
      }
    }
  }
});

test("ON enhanced sharing and approval locks preserve all original capability restrictions", async () => {
  for (const sharingApproved of [false, true]) for (const capability of ["write", "read_only"] as const) for (const locked of [false, true]) {
    const current = page(pageSource, { enabled: true, job: { ...job, ...(sharingApproved ? {} : { title: "", address: "", description: "", window: "", issuePhotos: [], donePhotos: [] }), vendorLink: { capability, sharingApproved, typeFields: [] } }, state: { locked } });
    const html = await current.html();
    const canWrite = sharingApproved && capability === "write" && !locked;
    assert.equal(html.includes('data-testid="vendor-submit"'), canWrite);
    assert.equal(html.includes('>回報進度</a>'), canWrite);
    if (!sharingApproved) assert.doesNotMatch(html, /Property A|Address A|This job only|vendor-photo/);
    if (!sharingApproved || capability === "read_only") assert.ok(!current.calls.includes("state"));
  }
});

test("server brand reader: org comes only from bearer gateway; exact job/org/ticket joins, no list or writes", async () => {
  const sql: { query: string; params: unknown[] }[] = []; const flags: string[] = [];
  let enabled = true; let admitted = true; let disappear = false;
  const reader = compile(source("src/server/vendor-token-brand.ts"), {
    "./db": { svc: async (actor: unknown, work: (client: unknown) => unknown) => { assert.equal(actor, null); return work({ query: async (query: string, params: unknown[]) => {
      sql.push({ query, params });
      assert.ok(query.trim().startsWith("SELECT"));
      if (query.includes("AS property")) {
        assert.deepEqual(params, [rules.hashVendorToken(token), "job-a", "org-a", "ticket-a", true]);
        assert.match(query, /WHERE j.job_id = \$2 AND j.org_id = \$3 AND j.ticket_id = \$4/);
        assert.match(query, /p.org_id = t.org_id/); assert.match(query, /t.org_id = j.org_id/);
        return { rows: disappear ? [] : [context] };
      }
      assert.deepEqual(params, [rules.hashVendorToken(token)]);
      return { rows: admitted ? [{ job_id: "job-a", org_id: "org-a", ticket_id: "ticket-a" }] : [] };
    } }); } },
    "./brand-v3": { brandV3EnabledForOrg: async (org: string) => { flags.push(org); return enabled; } },
    "./vendor-repair-rules": rules,
  }).vendorTokenBrand as (token: string, shared: boolean) => Promise<VendorTokenBrand | null>;
  assert.deepEqual(await reader(token, true), context);
  assert.deepEqual(flags, ["org-a"]); assert.equal(sql.length, 2);
  enabled = false; sql.length = 0;
  assert.equal(await reader(token, true), null); assert.equal(sql.length, 1, "OFF reads no metadata");
  admitted = false; flags.length = 0;
  assert.equal(await reader(token, true), null); assert.deepEqual(flags, []);
  sql.length = 0; assert.equal(await reader("invalid", true), null); assert.equal(sql.length, 0);
  admitted = true; enabled = true; disappear = true;
  assert.equal(await reader(token, true), null, "re-admission failure does not return stale metadata");
});

test("server brand reader failure falls back to legacy without a new error or fabricated empty list", async () => {
  const reader = compile(source("src/server/vendor-token-brand.ts"), {
    "./db": { svc: async () => { throw new Error("unavailable"); } }, "./brand-v3": {}, "./vendor-repair-rules": rules,
  }).vendorTokenBrand as (token: string, shared: boolean) => Promise<unknown>;
  assert.equal(await reader(token, true), null);
});

test("estimate and document routes retain baseline bytes; this slice creates no new write path", () => {
  for (const file of ["src/app/v/[token]/notifications/page.tsx", "src/app/v/[token]/estimate/page.tsx", "src/app/v/[token]/estimate/estimate-form.tsx", "src/app/v/documents/[token]/page.tsx", "src/components/vendor-documents-panel.tsx", "src/server/vendor-repair.ts", "src/app/v/[token]/vendor-job-controls.tsx"]) {
    // B-104 (app #182, PR-024 a) replaced vendor-repair.ts's direct B-013 read with a service-only helper, and
    // Batch 3b part (a) (d6d738a) extracted loadVendorJobOn for its single-snapshot vendor read (no new write);
    // that reviewed change is its baseline. Every other file must still equal the pre-V-TOKEN source.
    const baseline = file === "src/server/vendor-repair.ts" ? "d6d738a" : "3e87c93";
    assert.equal(withoutGs32(file, source(file)), execFileSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8" }));
  }
});

/** GS-32 (vendor_docs_v3, Round 7 batch 4) adds three imports, an optional searchParams and one gated early return
 * to the document page; strip exactly those (each must match once). No write path is added: the 3.0 views post to
 * the existing B-025 actions. */
function withoutGs32(file: string, text: string) {
  if (file !== "src/app/v/documents/[token]/page.tsx") return text;
  const cut = (from: string, to: string) => {
    const start = text.indexOf(from), end = text.indexOf(to, start);
    assert.ok(start >= 0 && end > start && text.indexOf(from, start + 1) < 0, from);
    text = text.slice(0, start) + text.slice(end);
  };
  const swap = (from: string, to: string) => { assert.equal(text.split(from).length, 2, from); text = text.replace(from, to); };
  swap('import { VendorTokenShell } from "@/components/v3/vendor/token-shell";\nimport { VendorDocsV3 } from "@/components/v3/vendor/vendor-docs-v3";\nimport { vendorDocsV3Brand, vendorDocsV3Stage } from "@/server/gs32-vendor-docs";\n', "");
  swap("({ params, searchParams }: { params: Promise<{ token: string }>; searchParams?: Promise<{ paper?: string; uploaded?: string }> })",
    "({ params }: { params: Promise<{ token: string }> })");
  cut("  // GS-32 (vendor_docs_v3 + brand_v3)", "  return <VendorDocumentsPanel");
  return text;
}

// VEN-31-AC1: only the gated Brand 3 shell offers login at the job and restricted-tab sheet.
test("B101 entry appears in both approved slots only when the combined matching gate is enabled", async () => {
 const on = await page(pageSource, { enabled: true, match: true }).html();
 assert.equal((on.match(/data-testid="line-match-entry"/g) ?? []).length, 2);
 const off = await page(pageSource, { enabled: true, match: false }).html();
 assert.ok(!off.includes('data-testid="line-match-entry"'));
 const legacy = await page(pageSource, { enabled: false, match: true }).html();
 assert.ok(!legacy.includes('data-testid="line-match-entry"'));
});

// B-105 (vendor_job_v3): an admitted case replaces only the job content; bar, tabs and token limits stay.
test("B-105 case view replaces the V-TOKEN job content; no legacy report, appointment or upload forms", async () => {
  const value = { company: "Company A", closed: false, decision: null, agreedCompletionOn: null, scheduledOn: null, ownerWaitVersion: null, estimates: false, photos: [] };
  const shared = { ...job, title: "", vendorLink: { capability: "write" as const, sharingApproved: true, typeFields: [] } };
  const current = page(pageSource, { enabled: true, job: shared, state: { locked: false, requestId: "request", versionId: "version" }, vendorCase: { state: "ready", value } });
  const html = await current.html();
  assert.deepEqual(current.calls, ["job", "brand:true", "case", "line-match"], "no B-024 state read under the case view");
  assert.match(html, /data-testid="v-token-v3"/);
  assert.match(html, /data-testid="vendor-case" data-stage="accept">Property A\|Company A</);
  for (const marker of ["vendor-submit", "vendor-propose", "vendor-reject", "vendor-complete", "vendor-photo", "existing-error"]) assert.ok(!html.includes(marker), marker);
  assert.doesNotMatch(html, /v-token-warning|>回報進度</);
  assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 3, "V-TOKEN-TABS stay");
  const unavailable = await page(pageSource, { enabled: true, job: shared, vendorCase: { state: "unavailable" } }).html();
  assert.match(unavailable, /data-stage="unavailable"/);
  const legacy = page(pageSource, { enabled: true, vendorCase: { state: "ready", value } });
  assert.doesNotMatch(await legacy.html(), /vendor-case/);
  assert.ok(!legacy.calls.includes("case"), "non-enhanced links never ask for the case");
  for (const sharingApproved of [false]) {
    const unshared = page(pageSource, { enabled: true, vendorCase: { state: "ready", value }, job: { ...job, vendorLink: { capability: "write", sharingApproved, typeFields: [] } } });
    assert.doesNotMatch(await unshared.html(), /vendor-case/);
    assert.ok(!unshared.calls.includes("case"), "unshared links never ask for the case");
  }
});
