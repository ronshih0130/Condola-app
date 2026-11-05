import assert from "node:assert/strict";
import test from "node:test";
import type { LocalizationContext } from "./localization";
import { buildExportExplanation } from "./regional-format-helpers";

const ctx: LocalizationContext = {
  currency: "USD", minorUnit: 2, displayDecimals: 2,
  locale: "en-US", timezone: "UTC", jurisdictionCode: "US",
};

test("export explanations contain only fixed i18n keys, with no interpolated values", () => {
  const explanation = buildExportExplanation(ctx);
  assert.deepEqual(explanation, {
    currencyKey: "explain.currency.context",
    scaleKey: "explain.scale.minorUnit",
    localeKey: "explain.locale.context",
    timezoneKey: "explain.timezone.context",
    jurisdictionKey: "explain.jurisdiction.configured",
  });
  for (const key of Object.values(explanation)) {
    assert.match(key!, /^explain\.[a-zA-Z]+\.[a-zA-Z]+$/);
  }
  assert.deepEqual(buildExportExplanation({
    ...ctx, currency: "JPY", minorUnit: 0, displayDecimals: 0,
    locale: "ja-JP", timezone: "Asia/Tokyo", jurisdictionCode: "JP",
  }), explanation);
});

test("context and option extras cannot leak PII or inject export copy", () => {
  const privateValue = "Private Person private@example.test Private address";
  const input = Object.freeze({
    ...ctx, currency: privateValue, locale: privateValue,
    timezone: privateValue, jurisdictionCode: privateValue,
    name: privateValue, email: privateValue, address: privateValue,
    tenant: privateValue, owner: privateValue, orgId: privateValue,
  });
  const opts = Object.freeze({
    includeJurisdiction: true, currencyKey: privateValue,
    enforcement: privateValue, permission: privateValue, copy: privateValue,
  });
  const explanation = buildExportExplanation(input, opts);
  assert.deepEqual(explanation, buildExportExplanation(ctx));
  assert.equal(JSON.stringify(explanation).includes(privateValue), false);
  assert.deepEqual(Object.keys(explanation).sort(),
    ["currencyKey", "jurisdictionKey", "localeKey", "scaleKey", "timezoneKey"]);
});

test("null and unknown jurisdiction confer no enforcement or permission", () => {
  for (const jurisdictionCode of [null, "", " ", "UNKNOWN"]) {
    const explanation = buildExportExplanation({ ...ctx, jurisdictionCode });
    assert.equal(explanation.jurisdictionKey,
      jurisdictionCode === "UNKNOWN" ? "explain.jurisdiction.configured" : null);
    assert.equal("enforcement" in explanation, false);
    assert.equal("permission" in explanation, false);
    assert.equal("legalStatus" in explanation, false);
  }
  assert.equal(buildExportExplanation({ ...ctx, jurisdictionCode: null }, {
    includeJurisdiction: true,
  }).jurisdictionKey, null);
  assert.equal(buildExportExplanation(ctx, { includeJurisdiction: false }).jurisdictionKey, null);
});
