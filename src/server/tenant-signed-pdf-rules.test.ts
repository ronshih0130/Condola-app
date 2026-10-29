import assert from "node:assert/strict";
import test from "node:test";
import { TENANT_SIGNED_PDF_ENABLED, tenantSignedPdfOn } from "./tenant-signed-pdf-rules";

test("tenant signed PDFs default off and require both switches", () => {
  assert.equal(TENANT_SIGNED_PDF_ENABLED, false);
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
