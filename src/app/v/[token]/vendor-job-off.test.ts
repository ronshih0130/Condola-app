import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const controls = readFileSync(new URL("./vendor-job-controls.tsx", import.meta.url), "utf8");

test("resolver only runs after the existing invalid-job return", () => {
  const loaded = source.indexOf("const job = await loadVendorJob(token);");
  const rejected = source.indexOf('if (!job || job.vendorLink?.capability === "invalid")');
  const resolved = source.indexOf("const vendorState = await resolveVendorJobState(token);");
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
  assert.doesNotMatch(locked[1], /<form|VendorJobControls/);
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

test("forms retain the server requestId across HTTP retries", () => {
  assert.equal((source.match(/name="requestId" value=\{vendorState\.requestId\}/g) ?? []).length, 3);
  assert.match(source, /<VendorJobControls key=\{vendorState\.requestId\}/);
  assert.match(controls, /const requestId = data\.get\("requestId"\)/);
  assert.doesNotMatch(controls, /randomUUID|name="requestId"/);
  assert.match(controls, /body: JSON\.stringify\(payload\)/);
});
