import assert from "node:assert/strict";
import test from "node:test";
import { TENANT_SIGNED_PDF_ENABLED, tenantSignedPdfGloballyEnabled, tenantSignedPdfOn } from "./tenant-signed-pdf-rules";

test("deployment switch defaults off and still requires the org flag", () => {
  assert.equal(tenantSignedPdfGloballyEnabled(undefined), false);
  assert.equal(tenantSignedPdfGloballyEnabled("true"), true);
  assert.equal(tenantSignedPdfGloballyEnabled("TRUE"), false);
  assert.equal(TENANT_SIGNED_PDF_ENABLED, tenantSignedPdfGloballyEnabled());
  assert.equal(tenantSignedPdfOn(false, {}), false);
  assert.equal(tenantSignedPdfOn(false, { tenant_signed_pdf: true }), false);
  assert.equal(tenantSignedPdfOn(true, { tenant_signed_pdf: true }), true);
});

test("only the explicit JSON boolean true enables tenant signed PDFs", () => {
  for (const flags of [
    undefined,
    null,
    false,
    "true",
    [],
    {},
    { tenant_signed_pdf: false },
    { tenant_signed_pdf: "true" },
    { tenant_signed_pdf: 1 },
  ]) {
    assert.equal(tenantSignedPdfOn(true, flags), false);
  }
});
