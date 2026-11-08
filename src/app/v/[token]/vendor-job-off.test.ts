import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const controls = readFileSync(new URL("./vendor-job-controls.tsx", import.meta.url), "utf8");

test("resolver only runs after the existing invalid-job return", () => {
  const loaded = source.indexOf("const job = await loadVendorJob(token);");
  const rejected = source.indexOf('if (!job || job.vendorLink?.capability === "invalid")');
  const resolved = source.indexOf("const vendorState = ");
  assert.ok(loaded >= 0 && rejected > loaded && resolved > rejected);
  assert.match(source.slice(rejected, resolved), /return \([\s\S]*?data-testid="vendor-closed"[\s\S]*?\n  \}/);
});

test("OFF returns no added controls and every new testid is gated on vendorState", () => {
  const start = source.indexOf("  function renderVendorJobControls() {");
  const end = source.indexOf("\n  if (job.vendorLink !== undefined)", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const guard = block.indexOf("if (vendorState === null) return null;");
  assert.ok(guard >= 0);
  const locked = block.match(/if \(vendorState\.locked\) \{([\s\S]*?)\n    \}/);
  assert.ok(locked);
  assert.match(locked[1], /return <p data-testid="vendor-pending-approval"/);
  assert.doesNotMatch(locked[1], /<form|VendorJobControls|renderReportControls|actionVendorReport|vendor-submit/);
  const open = block.indexOf("<VendorJobControls");
  assert.ok(open > block.indexOf(locked[0]) + locked[0].length);
  for (const marker of ["vendor-pending-approval", "vendor-propose", "vendor-reject", "vendor-complete"]) {
    const matches = [...source.matchAll(new RegExp(`data-testid="${marker}"`, "g"))];
    assert.equal(matches.length, 1);
    const position = matches[0].index!;
    assert.ok(position > start + guard && position < end);
    if (marker !== "vendor-pending-approval") assert.ok(position > start + open);
  }
  assert.equal((source.match(/\{renderVendorJobControls\(\)\}/g) ?? []).length, 2);
});

test("classic reporting markers and the actionVendorReport form remain", () => {
  for (const marker of ['data-testid="vendor-job"', 'data-testid="vendor-submit"', 'action={actionVendorReport}']) {
    assert.ok(source.includes(marker));
  }
  assert.match(source, /<form action=\{actionVendorReport\}[\s\S]*?name="done"[\s\S]*?name="cost"[\s\S]*?data-testid="vendor-submit"[\s\S]*?<\/form>/);
});

test("both page branches suppress legacy reports only while approval is locked", () => {
  const reportStart = source.indexOf("  function renderReportControls(");
  const reportEnd = source.indexOf("  function renderVendorJobControls()", reportStart);
  assert.ok(reportStart >= 0 && reportEnd > reportStart);
  const report = source.slice(reportStart, reportEnd);
  const branches = [...source.matchAll(/\{([^\n]*\brenderReportControls\((?:true)?\)[^\n]*)\}/g)];
  assert.equal(branches.length, 2);
  for (const branch of branches) {
    const render = new Function("vendorState", "job", "renderReportControls", `return (${branch[1]});`);
    const job = { vendorLink: { sharingApproved: true, capability: "write" } };
    let calls = 0;
    const reportControls = () => { calls++; return report; };
    const locked = render({ locked: true }, job, reportControls);
    assert.equal(locked, null);
    assert.equal(calls, 0);
    assert.doesNotMatch(String(locked), /actionVendorReport|vendor-submit/);
    for (const state of [null, { locked: false }]) {
      const visible = render(state, job, reportControls);
      assert.equal(visible, report);
      assert.match(visible, /actionVendorReport/);
      assert.match(visible, /data-testid="vendor-submit"/);
    }
    assert.equal(calls, 2);
    if (branch[1].includes("renderReportControls(true)")) {
      for (const vendorLink of [
        { sharingApproved: false, capability: "write" },
        { sharingApproved: true, capability: "read" },
      ]) {
        assert.equal(render(null, { vendorLink }, reportControls), null);
      }
      assert.equal(calls, 2);
    }
  }
});

test("forms retain the server requestId and versionId across HTTP retries", () => {
  assert.equal((source.match(/name="requestId" value=\{vendorState\.requestId\}/g) ?? []).length, 3);
  assert.equal((source.match(/name="versionId" value=\{vendorState\.versionId\}/g) ?? []).length, 3);
  assert.match(source, /<VendorJobControls key=\{vendorState\.requestId\}/);
  assert.match(controls, /const requestId = data\.get\("requestId"\)/);
  assert.match(controls, /const versionId = data\.get\("versionId"\)/);
  assert.equal((controls.match(/\{ requestId, versionId, token,/g) ?? []).length, 2);
  assert.doesNotMatch(controls, /randomUUID|name="requestId"/);
  assert.match(controls, /body: JSON\.stringify\(payload\)/);
});


test("enhanced read-only or unapproved views never resolve mutation controls", () => {
  const expression = source.match(/const vendorState = ([\s\S]*?);/);
  assert.ok(expression);
  const resolve = new Function("job", "resolveVendorJobState", "token",
    `return (${expression[1].replace("await ", "")});`);
  let calls = 0;
  const resolver = () => { calls++; return { locked: false }; };
  for (const capability of ["read_only", "invalid"]) {
    assert.equal(resolve({ vendorLink: { sharingApproved: true, capability } }, resolver, "fixture"), null);
  }
  assert.equal(resolve({ vendorLink: { sharingApproved: false, capability: "write" } }, resolver, "fixture"), null);
  assert.equal(calls, 0);
  resolve({}, resolver, "fixture");
  resolve({ vendorLink: { sharingApproved: true, capability: "write" } }, resolver, "fixture");
  assert.equal(calls, 2);
});
