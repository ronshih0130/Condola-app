import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Client } from "pg";
import { PartnerConsentScreen } from "../components/partner-consent-form";
import { PartnerConsentHistory, PartnerConsentHistoryView } from "../components/partner-consent-history";
import { partnerConsentStrings } from "../i18n/lanes/partner-consent";
import { buildStoredConsent } from "./consent";
import { requireCurrentConsent } from "./consent-gate";
import {
  partnerConsentCovered, partnerDocumentConfig, partnerDocumentIntegrity, partnerGateEnabled,
  parsePartnerDocumentConfig, selectPartnerDocuments,
} from "./partner-consent-rules";
import {
  partnerRequestMeta, readPartnerStateOn, recordPartnerConsentOn, verifiedPartnerDocuments,
  type PartnerConsentState,
} from "./partner-consent";
import { partnerTestRuntime } from "./partner-consent-test-fixture";
import { formatTaipei } from "./time";
import { noPermHref } from "./perms";
import type { Session } from "./types";

const noop = async () => {};
function staff(role: Session["role"] = "admin", state?: PartnerConsentState): Session {
  return {
    userId: "00000000-0000-4000-8000-000000000001", sessionId: "partner-unit",
    email: "person@example.com", name: "Person", kind: "staff", role,
    orgId: "00000000-0000-4000-8000-000000000003",
    liveOrgId: "00000000-0000-4000-8000-000000000002",
    environment: "sandbox", locale: "en", calendar: "gregorian", leaseId: null,
    consent: buildStoredConsent("reconsent"), partnerConsent: state,
  };
}

test("partner flag matrix: kill switch, strict overrides, missing and invalid values", () => {
  for (const override of [undefined, null, true, false, "true", "false", 0, 1, {}]) {
    for (const flag of [undefined, null, "off", "", "invalid", true, false, {}]) {
      assert.equal(partnerGateEnabled(flag, override), false);
    }
    assert.equal(partnerGateEnabled("org", override), override === true);
    assert.equal(partnerGateEnabled("on", override), override !== false);
  }
});

test("partner config schema, exact pins, optional headers and locale fallback", async () => {
  assert.equal(parsePartnerDocumentConfig(partnerDocumentConfig), partnerDocumentConfig);
  assert.throws(() => parsePartnerDocumentConfig({}));
  const duplicate = structuredClone(partnerDocumentConfig);
  duplicate.documents.privacy.push({ ...duplicate.documents.privacy[0] });
  assert.throws(() => parsePartnerDocumentConfig(duplicate));
  const selected = selectPartnerDocuments("en");
  assert.equal(selected[0].locale, partnerDocumentConfig.default_locale);
  assert.equal(selected[0].fallback, true);
  assert.equal(selected[1].locale, "en");
  assert.equal(selected[1].fallback, false);
  assert.ok(selectPartnerDocuments("unavailable").every((doc) => doc.fallback));
  for (const doc of partnerDocumentConfig.documents.partner_agreement) {
    assert.equal(partnerDocumentIntegrity(doc, readFileSync(resolve(doc.source), "utf8")), true);
  }
  const privacy = partnerDocumentConfig.documents.privacy[0];
  const text = readFileSync(resolve(privacy.source), "utf8");
  const matchesPin = createHash("sha256").update(text).digest("hex") === privacy.sha256;
  const reports: unknown[] = [];
  const verified = await verifiedPartnerDocuments("en", {
    config: partnerDocumentConfig,
    text: (entry) => readFileSync(resolve(entry.source), "utf8"),
    report: (entry) => reports.push(entry),
  });
  if (matchesPin) {
    assert.equal(partnerDocumentIntegrity(privacy, text), true);
    assert.ok(verified);
    assert.match(text, new RegExp("版本：" + privacy.version));
    assert.match(text, new RegExp("生效日期：" + privacy.effective_date));
  } else {
    assert.equal(verified, null);
    assert.deepEqual(reports, [{ doc_type: "privacy", locale: privacy.locale }]);
  }
  const fixture = partnerTestRuntime();
  const doc = fixture.config.documents.privacy[0];
  const fixtureText = await fixture.text(doc);
  assert.equal(partnerDocumentIntegrity({ ...doc, version: "changed" }, fixtureText), false);
  assert.equal(partnerDocumentIntegrity({ ...doc, effective_date: "2026-10-28" }, fixtureText), false);
});

test("partner OFF uses one read, has no redirects or history for every staff role", async () => {
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    for (const value of [undefined, "off", "invalid", true]) {
      const statements: string[] = [];
      const client = { query: async (sql: string) => {
        statements.push(sql);
        return { rows: value === undefined ? [] : [{ value }] };
      } } as unknown as Client;
      const state = await readPartnerStateOn(client, staff(role));
      assert.deepEqual(state, { active: false, required: false, admin: false, documents: [] });
      assert.equal(statements.length, 1);
      assert.match(statements[0], /platform_settings/);
      assert.equal(await requireCurrentConsent(staff(role, state), "api"), null);
      assert.equal(await requireCurrentConsent(staff(role, state), "page", "/m/team"), null);
      assert.equal(await PartnerConsentHistory({ session: staff(role, state) }), null);
    }
    const broken = { query: async () => { throw new Error("read unavailable"); } } as unknown as Client;
    assert.equal((await readPartnerStateOn(broken, staff(role))).active, false);
  }
});

test("partner active gate uses live company, exact versions, and current active admin membership", async () => {
  const runtime = partnerTestRuntime();
  const params: unknown[][] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    params.push(values);
    if (sql.includes("platform_settings")) return { rows: [{ value: "on" }] };
    if (sql.includes("feature_flags")) return { rows: [{ override: undefined, role: "admin" }] };
    return { rows: [] };
  } } as unknown as Client;
  const state = await readPartnerStateOn(client, staff(), runtime);
  assert.equal(state.active, true);
  assert.equal(state.required, true);
  assert.equal(state.admin, true);
  assert.ok(params.slice(1).every((values) => values[0] === staff().liveOrgId));
  const docs = selectPartnerDocuments("en", runtime.config);
  const evidence = docs.map((doc) => ({ doc_type: doc.doc_type, version: doc.version }));
  assert.equal(partnerConsentCovered(docs, evidence), true);
  const bump = structuredClone(runtime.config);
  bump.documents.partner_agreement.find((doc) => doc.locale === "en")!.version = "v0.2";
  assert.equal(partnerConsentCovered(selectPartnerDocuments("en", bump), evidence), false);
  assert.equal(partnerConsentCovered(docs, evidence.slice(0, 1)), false);
});

test("partner ON rejects manager API/actions and redirects shallow and deep manager pages", async () => {
  const documents = selectPartnerDocuments("en", partnerTestRuntime().config);
  const state = { active: true, required: true, admin: true, documents };
  const session = staff("admin", state);
  for (const path of ["/m", "/m/team", "/m/leases/abc/edit"]) {
    await assert.rejects(requireCurrentConsent(session, "page", path), (error: unknown) => {
      assert.equal((error as { digest: string }).digest, "NEXT_REDIRECT;replace;/partner-consent;307;");
      return true;
    });
  }
  await assert.rejects(requireCurrentConsent(session, "action"), /NEXT_REDIRECT/);
  const response = await requireCurrentConsent(session, "api");
  assert.equal(response?.status, 403);
  assert.equal(response?.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response?.json(), { ok: false, error: "errors.consentRequired" });
  assert.equal(await requireCurrentConsent(staff("admin", { ...state, required: false }), "api"), null);
  assert.equal(await requireCurrentConsent({ ...session, kind: "owner", role: null }, "api"), null);
});

test("partner waiting UI offers only logout; acceptance has disabled button, unchecked box and fallback links", () => {
  // tsx preserves classic JSX in shared components without a React import.
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", {
    value: React, configurable: true, writable: true,
  });
  try {
  for (const locale of ["zh-TW", "en"] as const) {
    const documents = selectPartnerDocuments(locale, partnerTestRuntime().config);
    const waiting = renderToStaticMarkup(React.createElement(PartnerConsentScreen, {
      locale, documents: [], admin: false, action: noop, logout: noop,
    }));
    assert.ok(waiting.includes(partnerConsentStrings[locale].waiting));
    assert.ok(waiting.includes(partnerConsentStrings[locale].logout));
    assert.equal((waiting.match(/<button\b/g) ?? []).length, 1);
    assert.doesNotMatch(waiting, /type="checkbox"|partner-consent-submit|partnerConsentPage/);
    const admin = renderToStaticMarkup(React.createElement(PartnerConsentScreen, {
      locale, documents, admin: true, action: noop, logout: noop,
    }));
    assert.match(admin, /<button[^>]*disabled=""/);
    assert.match(admin, /type="checkbox"[^>]*name="partnerConsent"/);
    assert.doesNotMatch(admin, /\schecked(?:=|\s|>)/);
    assert.equal((admin.match(/target="_blank" rel="noopener"/g) ?? []).length, 2);
    assert.ok(admin.indexOf(partnerConsentStrings[locale].summary) < admin.indexOf("<h2>"));
    if (locale === "en") assert.ok(admin.includes(partnerConsentStrings.en.fallback));
  }
  } finally {
    if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
    else Reflect.deleteProperty(globalThis, "React");
  }
});

test("partner unchecked submission performs no writes; active membership and integrity are rechecked", async () => {
  const statements: string[] = [];
  let role: string | null = "manager";
  const client = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes("platform_settings")) return { rows: [{ value: "on" }] };
    if (sql.includes("feature_flags")) return { rows: [{ override: null, role }] };
    return { rows: [] };
  } } as unknown as Client;
  const meta = { ip: "203.0.113.7", ua: "a".repeat(700) };
  await assert.rejects(recordPartnerConsentOn(client, staff(), false, meta, partnerTestRuntime()));
  assert.equal(statements.length, 0);
  await assert.rejects(recordPartnerConsentOn(client, staff(), true, meta, partnerTestRuntime()));
  assert.ok(!statements.some((sql) => sql.includes("INSERT")));
  role = null;
  await assert.rejects(recordPartnerConsentOn(client, staff(), true, meta, partnerTestRuntime()));
  role = "admin";
  const reports: unknown[] = [];
  const bad = { ...partnerTestRuntime(), text: () => "changed", report: (entry: unknown) => reports.push(entry) };
  assert.equal((await readPartnerStateOn(client, staff(), bad)).active, false);
  await assert.rejects(recordPartnerConsentOn(client, staff(), true, meta, bad));
  assert.equal(reports.length, 2); // One structured report per independent evaluation.
  assert.ok(!statements.some((sql) => sql.includes("INSERT")));
  await recordPartnerConsentOn(client, staff(), true, meta, partnerTestRuntime());
  assert.equal(statements.filter((sql) => sql.includes("INSERT")).length, 1);
});

test("partner request evidence uses existing audit headers and bounds UA", () => {
  const map = new Map([["x-forwarded-for", "203.0.113.7, 10.0.0.1"], ["x-real-ip", "203.0.113.8"], ["user-agent", "x".repeat(700)]]);
  assert.deepEqual(partnerRequestMeta({ get: (key) => map.get(key) ?? null }), { ip: "203.0.113.7", ua: "x".repeat(512) });
});

test("partner settings render version, formatted time and consenter with no edit controls", () => {
  const date = "2026-10-27T12:30:00Z";
  const html = renderToStaticMarkup(React.createElement(PartnerConsentHistoryView, {
    locale: "zh-TW",
    rows: [
      { doc_type: "privacy", version: "v2", consented_at: date, consenter: "Person · person@example.com" },
      { doc_type: "partner_agreement", version: "v0.1", consented_at: date, consenter: "retained-user-id" },
    ],
  }));
  for (const text of ["合規同意紀錄", "v2", "v0.1", formatTaipei(date), "person@example.com", "retained-user-id"]) {
    assert.ok(html.includes(text));
  }
  assert.doesNotMatch(html, /<(?:form|input|button)\b/);
});

test("partner all new UI copy avoids prohibited terms and uses company terminology", () => {
  const banned = ["收租", "收款", "欠租", "已收", "入帳", "代收", "轉付", "金流", "統一編號", "含稅", "本公司", "事務所", "示範", "測試模式", "沙盒", "已驗證", "保證有效", "保證可報帳", "房東", "測試"];
  for (const [locale, copy] of Object.entries(partnerConsentStrings)) {
    for (const [key, text] of Object.entries(copy)) {
      for (const word of banned) assert.equal(text.includes(word), false, `${locale}.${key}: ${word}`);
    }
  }
  assert.ok(partnerConsentStrings["zh-TW"].checkbox.includes("公司"));
  assert.ok(partnerConsentStrings.en.checkbox.includes("company"));
  for (const file of [
    "../components/partner-consent-form.tsx", "../components/partner-consent-history.tsx",
    "../app/partner-consent/page.tsx", "../app/partner-agreement/page.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const word of banned) assert.equal(source.includes(word), false, `${file}: ${word}`);
    assert.doesNotMatch(source, /房客|landlord/i);
  }
});

test("partner entrypoint wiring keeps personal consent first, manager permissions and signup enforcement", () => {
  const gate = readFileSync(new URL("./consent-gate.ts", import.meta.url), "utf8");
  assert.match(gate, /consentCoversCurrent\(current\.consent \?\? null\).*requirePartnerConsent\(current, mode\)/);
  const session = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
  assert.ok(session.indexOf("await readPartnerStateOn") < session.indexOf("await correctRetiredSampleAddresses"));
  assert.match(session, /!session\.partnerConsent\?\.required/);
  const root = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(root, /partnerConsent/);
  assert.match(root, /await sandboxChrome\(session\)/);
  assert.match(root, /session\.name/);
  assert.match(root, /<EnvBanner/);
  const layout = readFileSync(new URL("../app/m/layout.tsx", import.meta.url), "utf8");
  assert.ok(layout.indexOf("await requireCurrentConsent") < layout.indexOf("await loadManagerChrome"));
  assert.ok(layout.includes("const denied = noPermHref(path, session.role);"));
  assert.doesNotMatch(layout, /consentSettings|partnerConsentCopy/);
  for (const role of ["manager", "accountant", "maintenance"] as const) {
    assert.equal(noPermHref("/m/settings", role), "/m/noperm?need=settings.edit");
  }
  assert.equal(noPermHref("/m/settings", "admin"), null);
  const settings = readFileSync(new URL("../app/m/settings/page.tsx", import.meta.url), "utf8");
  assert.match(settings, /<PartnerConsentHistory session=\{session\}/);
  const signup = readFileSync(new URL("./signup.ts", import.meta.url), "utf8");
  const create = signup.slice(signup.indexOf("export async function createFirm"));
  const partnerRead = create.indexOf("await signupPartnerDocuments");
  assert.ok(partnerRead > create.indexOf("await passConsentGate"));
  assert.ok(partnerRead > create.indexOf('if (!kind || !contactName)'));
  assert.ok(partnerRead > create.indexOf("if (!firmName)"));
  assert.ok(partnerRead > create.indexOf("const callingCode"));
  assert.ok(create.indexOf("input.partnerConsent !== true") < create.indexOf("INSERT INTO organizations"));
  assert.ok(create.indexOf("await insertSignupPartnerConsentOn") < create.indexOf('await client.query("COMMIT")'));
  const form = readFileSync(new URL("../components/firm-steps.tsx", import.meta.url), "utf8");
  assert.match(form, /partnerDocuments\?\.length && data\.get\("partnerConsent"\) !== "on"/);
  assert.match(form, /Boolean\(partnerDocuments\?\.length\) && !partnerChecked/);
  assert.ok(form.includes("disabled={!submitReady}"));
});

test("partner state read failures are logged and return OFF without rejecting", async () => {
  const originalError = console.error;
  const messages: string[] = [];
  console.error = (message?: unknown) => { messages.push(String(message)); };
  try {
    for (const failAt of [1, 2, 3]) {
      let reads = 0;
      const client = { query: async () => {
        reads += 1;
        if (reads === failAt) throw new Error("unavailable");
        if (reads === 1) return { rows: [{ value: "on" }] };
        if (reads === 2) return { rows: [{ override: null, role: "admin" }] };
        return { rows: [] };
      } } as unknown as Client;
      assert.deepEqual(await readPartnerStateOn(client, staff(), partnerTestRuntime()), {
        active: false, required: false, admin: false, documents: [],
      });
      assert.equal(reads, failAt);
    }
    assert.equal(messages.length, 3);
    assert.deepEqual(messages.map((message) => JSON.parse(message)), [
      { event: "partner_consent_read_failed", stage: "flag", fallback: "off" },
      { event: "partner_consent_read_failed", stage: "state", fallback: "off" },
      { event: "partner_consent_read_failed", stage: "state", fallback: "off" },
    ]);
  } finally {
    console.error = originalError;
  }
});
