import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { enterKeyAction, shouldIgnoreEnter } from "./enter-key";

test("Enter cancels text fields and submit buttons, and activates ordinary buttons", () => {
  assert.equal(enterKeyAction("input", "text"), "prevent");
  assert.equal(enterKeyAction("INPUT", "text"), "prevent");
  assert.equal(enterKeyAction("input", "radio"), "prevent");
  assert.equal(enterKeyAction("input", "checkbox"), "allow");
  assert.equal(enterKeyAction("select", ""), "prevent");
  assert.equal(enterKeyAction("textarea", ""), "allow");
  assert.equal(enterKeyAction("a", ""), "allow");
  assert.equal(enterKeyAction("button", "button"), "allow");
  assert.equal(enterKeyAction("button", "BUTTON"), "allow");
  assert.equal(enterKeyAction("button", "submit"), "prevent");
  assert.equal(enterKeyAction("button", ""), "prevent");
  assert.equal(enterKeyAction("button", null), "prevent");
  assert.equal(shouldIgnoreEnter({ key: "a" }), true);
  assert.equal(shouldIgnoreEnter({ key: "Enter", isComposing: true }), true);
  assert.equal(shouldIgnoreEnter({ key: "Enter", keyCode: 229 }), true);
  assert.equal(shouldIgnoreEnter({ key: "Enter", isComposing: false, keyCode: 13 }), false);
});

test("wizard forms use the Enter split and still guard the create button", () => {
  const lease = readFileSync(new URL("./lease-wizard.tsx", import.meta.url), "utf8");
  const property = readFileSync(new URL("./property-wizard.tsx", import.meta.url), "utf8");
  const firm = readFileSync(new URL("./firm-steps.tsx", import.meta.url), "utf8");
  const guard = readFileSync(new URL("./form-enter.tsx", import.meta.url), "utf8");
  for (const source of [lease, property, firm]) {
    assert.match(source, /onKeyDownCapture=\{blockImplicitEnter\}/);
    assert.match(source, /<ImplicitSubmitSink \/>/);
    assert.equal(source.includes("房東"), false);
  }
  assert.match(guard, /data-implicit-submit/);
  assert.match(guard, /shouldIgnoreEnter/);
  assert.match(guard, /isComposing/);
  assert.match(guard, /keyCode/);
  assert.match(guard, /closest\("a"\)/);
  assert.match(guard, /enterKeyAction\("button", button\.type\)/);
  assert.match(lease, /claimFormSubmit\(submitGuard\)/);
  assert.match(lease, /tenantMode === "existing" && pickedId === ""/);
  assert.match(lease, /submitter\.dataset\.testid !== "submit-lease"/);
  assert.match(lease, /disabled=\{blocked \|\| pending \|\| !submitReady\}/);
  assert.match(property, /submitter\.dataset\.testid !== "submit-property"/);
  assert.match(property, /disabled=\{blocked \|\| !submitReady\}/);
  assert.match(firm, /submitter\.dataset\.testid !== "firm-submit"/);
  const chrome = readFileSync(new URL("./chrome.tsx", import.meta.url), "utf8");
  assert.equal(chrome.includes("list-search"), false);
  assert.equal(chrome.includes("ListSearch"), false);
});
