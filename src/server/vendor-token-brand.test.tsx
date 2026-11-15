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

type Scenario = { admission?: "enabled" | "busy" | "disabled" | "denied"; enabled?: boolean; v2?: boolean; locale?: i18n.Locale; job?: VendorJobPage | null; state?: Record<string, unknown> | null; line?: boolean };
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
    "@/server/vendor-token-brand": { vendorTokenBrand: async (value: string, shared: boolean) => {
      assert.equal(value, token); calls.push(`brand:${shared}`); return scenario.enabled ? { ...context, property: shared ? context.property : "" } : null;
    } },
    "@/server/vendor-repair": { loadVendorJob: async (value: string) => { assert.equal(value, token); calls.push("job"); return scenario.job === undefined ? job : scenario.job; } },
    "@/server/vendor-job": { resolveVendorJobState: async (value: string) => { assert.equal(value, token); calls.push("state"); return scenario.state ?? null; } },
    "@/server/brand-v2": { brandV2Enabled: () => v2 },
    "@/server/session": { requestPrefs: async () => ({ locale }) },
    "@/server/line/vendor-entry": { vendorLineEntryEnabled: async () => { calls.push("line"); return scenario.line ?? false; } },
    "@/components/notification-center-entry": notificationEntry,
    "@/components/vendor-link-details": details,
    "@/components/ticket-photos": { TicketPhotoUpload: (props: { inputTestId: string; signPath: string; confirmPath: string; extra: { token: string } }) => {
      assert.equal(props.extra.token, token);
      return <div data-testid={props.inputTestId} data-sign={props.signPath} data-confirm={props.confirmPath} id={React.useId()} />;
    } },
    "@/components/ui": { ErrorBanner: ({ error }: { error?: string }) => error ? <p role="alert">{error}</p> : null },
    "@/server/actions": { actionVendorReport: "/existing-vendor-report" },
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
  assert.deepEqual(current.calls, ["job", "brand:true", "state"]);
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
    assert.equal(source(file), execFileSync("git", ["show", `3e87c93:${file}`], { encoding: "utf8" }));
  }
});
