import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { continueInLine } from "../app/v/[token]/continue-in-line";
import { VendorLineMatchEntry } from "../components/v3/vendor/line-match-entry";
import { vendorLineMatchCopy as copy } from "../i18n/lanes/vendor-line-match";

const script = readFileSync("public/line-bootstrap.js", "utf8");
test("VEN-31-AC1: explicit match intent keeps token in POST bodies and uses existing B035 entry", async () => {
 const calls: { path: string; input: Record<string, string> }[] = [], next: string[] = [];
 const flow = "f".repeat(43);
 const ok = await continueInLine("private-job-token", { navigate: v => next.push(v), fetch: async (path, init) => {
  assert.equal(init.referrerPolicy, "no-referrer"); assert.equal(init.credentials, "same-origin");
  calls.push({ path, input: JSON.parse(String(init.body)) });
  return { ok: true, json: async () => path === "/v/liff" ? { csrf: "proof" } : { liffUrl: `/v/liff?flow=${flow}` } };
 } }, true);
 assert.equal(ok, true); assert.deepEqual(next, [`/v/liff?flow=${flow}`]);
 assert.deepEqual(calls, [{ path: "/v/liff", input: { jobToken: "private-job-token" } },
  { path: "/api/line/flows", input: { purpose: "login", persona: "vendor", jobToken: "private-job-token", csrf: "proof", vendorMatch: "true" } }]);
 const html = renderToStaticMarkup(<VendorLineMatchEntry token="private-job-token" />);
 assert.ok(html.includes(copy.entry)); assert.ok(!html.includes("private-job-token"));
});
for (const present of [true, false]) test(`VEN-31-AC2: OAuth state/nonce/PKCE path required with SDK present=${present}`, async () => {
 const next: string[] = [], posts: Record<string, string>[] = [];
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ vendorMatch: true, persona: "vendor", flow: present ? "opaque" : null, orgId: "org", csrf: "proof" }) }) },
  window: { liff: { init: () => { throw new Error("Bare SDK token must not bind"); } } },
  location: { assign: (v: string) => next.push(v) },
  fetch: async (_path: string, init: RequestInit) => { posts.push(JSON.parse(String(init.body))); return { ok: true, json: async () => ({ flow: "opaque" }) }; },
 });
 assert.deepEqual(next, ["/api/line/login/start?flow=opaque"]);
 assert.deepEqual(posts, present ? [] : [{ purpose: "login", persona: "vendor", orgId: "org", vendorMatch: "true", csrf: "proof" }]);
});
test("VEN-15-AC4: browser removal is server-confirmed, busy-safe, text-only and announces the approved toast", async () => {
 const row = { dataset: { job: "job-a" }, querySelector: () => ({ textContent: "<img onerror=bad>" }), remove: () => { removed = true; } };
 let removed = false, release!: () => void, calls = 0;
 const toast = { dataset: { template: copy.removed }, textContent: "" };
 const button = { dataset: { remove: "job-a" }, disabled: false, onclick: undefined as undefined | (() => Promise<void>) };
 const nodes: Record<string, unknown> = { "match-bootstrap": { textContent: '{"csrf":"proof"}' }, "match-review": { hidden: false }, "match-error": { hidden: true }, "match-toast": toast, "match-confirm": {}, "match-retry": {} };
 runInNewContext(readFileSync("public/vendor-line-match.js", "utf8"), {
  document: { getElementById: (id: string) => nodes[id], querySelector: () => row,
   querySelectorAll: (selector: string) => selector === "[data-job]" ? [row] : [button] },
  fetch: async (path: string, init: RequestInit) => { calls++; assert.equal(path, "/v/link"); assert.deepEqual(JSON.parse(String(init.body)), { action: "remove", csrf: "proof", jobId: "job-a" });
   await new Promise<void>(r => { release = r; }); return { ok: true, json: async () => ({ jobs: [] }) }; },
 });
 const first = button.onclick!(); await button.onclick!(); assert.equal(calls, 1); assert.equal(removed, false);
 release(); await first; assert.equal(removed, true); assert.equal(toast.textContent, copy.removed.replace("{工單}", "<img onerror=bad>"));
});
test("VEN-31 migration: private gateways, explicit provenance, no opt-in or flag writes; legacy invite sync preserved", () => {
 const sql = readFileSync("supabase/migrations/20261115180000_b101_vendor_line_match.sql", "utf8");
 assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|ALL).* ON (?:TABLE )?app\./);
 assert.doesNotMatch(sql, /(?:UPDATE|INSERT INTO) public\.(?:platform_settings|notifications|deliveries)/);
 assert.match(sql, /notification_opt_in,is_friend\)\s+VALUES\([^;]+false,false/);
 for (const name of ["b026_account_candidates", "b026_link_vendor_job"]) {
  const old = readFileSync("supabase/migrations/20261106220000_b026_vendor_accounts.sql", "utf8");
  const extract = (s: string) => new RegExp(`CREATE (?:OR REPLACE )?FUNCTION app.${name}\\([\\s\\S]*?END \\$\\$;`).exec(s)![0];
  const restored = extract(sql).replace("CREATE OR REPLACE", "CREATE").replace("a.line_identity_id IS NULL AND ", "").replace(" AND a.line_identity_id IS NULL", "");
  assert.equal(restored, extract(old), "B026 invite branch is otherwise byte-identical");
 }
});

test("VEN-31-AC4: failed removal hides the list and exposes the approved recovery state", async () => {
 const button = { dataset: { remove: "job-a" }, disabled: false, onclick: undefined as undefined | (() => Promise<void>) };
 const review = { hidden: false }, error = { hidden: true };
 const nodes: Record<string, unknown> = { "match-bootstrap": { textContent: '{"csrf":"proof"}' }, "match-review": review, "match-error": error, "match-confirm": {}, "match-retry": {} };
 runInNewContext(readFileSync("public/vendor-line-match.js", "utf8"), {
  document: { getElementById: (id: string) => nodes[id], querySelectorAll: () => [button] },
  fetch: async () => ({ ok: false }),
 });
 await button.onclick!(); assert.equal(review.hidden, true); assert.equal(error.hidden, false); assert.equal(button.disabled, false);
});
