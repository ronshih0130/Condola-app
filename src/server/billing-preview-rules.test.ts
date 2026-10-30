import assert from "node:assert/strict";
import test from "node:test";
import { billingPreviewsOn } from "./billing-preview-rules";
test("billing preview requires exact global enabled, org allowlist and boolean opt-in", () => {
  const global = { enabled:true, allowed_org_ids:["org"] }, flags = { billing_previews:true };
  assert.equal(billingPreviewsOn(global, flags, "org"),true);
  for (const value of [null,{}, {enabled:"true",allowed_org_ids:["org"]}, {enabled:true,allowed_org_ids:"org"}, {enabled:true,allowed_org_ids:["other"]}]) assert.equal(billingPreviewsOn(value,flags,"org"),false);
  for (const value of [null,{}, {billing_previews:"true"}, {billing_previews:1}, {billing_previews:false}]) assert.equal(billingPreviewsOn(global,value,"org"),false);
});
