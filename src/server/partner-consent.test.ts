import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Client } from "pg";
import { PartnerConsentFields, PartnerConsentScreen } from "../components/partner-consent-form";
import { PartnerConsentHistory, PartnerConsentHistoryView } from "../components/partner-consent-history";
import { partnerConsentStrings } from "../i18n/lanes/partner-consent";
import { partnerConsentReady } from "../lib/partner-consent-ready";
import { buildStoredConsent } from "./consent";
import { requireCurrentConsent } from "./consent-gate";
import {
  partnerConsentCovered, partnerDocumentConfig, partnerGateEnabled,
  parsePartnerDocumentConfig, selectPartnerDocuments, resolvePartnerDocument,
} from "./partner-consent-rules";
import {
  partnerRequestMeta, readPartnerStateOn, recordPartnerConsentOn, verifiedPartnerDocuments,
  type PartnerConsentState, type PartnerRuntime,
} from "./partner-consent";
import { partnerTestRuntime } from "./partner-consent-test-fixture";
import { formatTaipei } from "./time";
import { noPermHref } from "./perms";
import type { Session } from "./types";

const noop = async () => {};
const meta = { ip: "203.0.113.7", ua: "x".repeat(700) };
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
function docs(runtime = partnerTestRuntime()) {
  return selectPartnerDocuments("en", runtime.config, runtime.privacyVersion);
}
function fake(options: {
  role?: string; status?: string; billing?: boolean;
  evidence?: { doc_type: string; version: string }[];
} = {}) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes("platform_settings")) return { rows: [{ value: "on" }] };
    if (sql.includes("feature_flags")) return {
      rows: [{ override: null, role: options.status && options.status !== "active" ? null : options.role ?? "admin" }],
    };
    if (sql.includes("FROM public.org_members")) return {
      rows: options.status && options.status !== "active" ? [] : [
        { role: options.role ?? "admin", is_billing_owner: options.billing ?? false },
      ],
    };
    if (sql.includes("FROM public.profiles")) return { rows: [{ consenter: "Stored Signer" }] };
    if (sql.includes("SELECT doc_type, version")) return { rows: options.evidence ?? [] };
    return { rows: [] };
  } } as unknown as Client;
  return { client, statements };
}
function render(element: React.ReactElement) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
  try { return renderToStaticMarkup(element); }
  finally {
    if (previous) Object.defineProperty(globalThis, "React", previous);
    else Reflect.deleteProperty(globalThis, "React");
  }
}

import { PRIVACY_VERSION } from "./legal-versions";
const LATER = new Date(Date.parse(PRIVACY_VERSION) + 86_400_000).toISOString().slice(0, 10);
test("AC1 flag matrix: OFF, invalid values, strict company overrides", () => {
  for (const override of [undefined, null, true, false, "true", "false", 0, 1, {}]) {
    for (const flag of [undefined, null, "off", "", "invalid", true, false, {}]) {
      assert.equal(partnerGateEnabled(flag, override), false);
    }
    assert.equal(partnerGateEnabled("org", override), override === true);
    assert.equal(partnerGateEnabled("on", override), override !== false);
  }
});

test("AC1 OFF evaluates no documents, redirects, history or extra company reads for every staff role", async () => {
  for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
    for (const value of [undefined, "off", "invalid", true]) {
      let reads = 0;
      const client = { query: async () => {
        reads++;
        return { rows: value === undefined ? [] : [{ value }] };
      } } as unknown as Client;
      const runtime = partnerTestRuntime();
      runtime.text = () => { throw new Error("OFF must not evaluate documents"); };
      const state = await readPartnerStateOn(client, staff(role), runtime);
      assert.deepEqual(state, { active: false, required: false, admin: false, documents: [] });
      assert.equal(reads, 1);
      assert.equal(await requireCurrentConsent(staff(role, state), "api"), null);
      assert.equal(await requireCurrentConsent(staff(role, state), "page", "/m/team"), null);
      assert.equal(await PartnerConsentHistory({ session: staff(role, state) }), null);
    }
  }
});

for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
  test(`AC2 AC3 partner ON rejects ${role} API/actions and redirects shallow and deep pages`, async () => {
    const runtime = partnerTestRuntime();
    const db = fake({ role });
    const state = await readPartnerStateOn(db.client, staff(role), runtime);
    assert.equal(state.active, true);
    assert.equal(state.required, true);
    assert.equal(state.admin, role === "admin");
    assert.ok(db.statements.slice(1).every((entry) => entry.values[0] === staff().liveOrgId));
    const session = staff(role, state);
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
    assert.equal(await requireCurrentConsent(staff(role, { ...state, required: false }), "api"), null);
    assert.equal(await requireCurrentConsent({ ...session, kind: "owner", role: null }, "api"), null);

    if (role === "manager") {
      const html = render(React.createElement(PartnerConsentScreen, {
        locale: session.locale, documents: state.documents, admin: state.admin, action: noop, logout: noop,
      }));
      assert.match(html, /data-testid="partner-consent-waiting"/);
      assert.match(html, /partner-consent-logout/);
      assert.doesNotMatch(html, /partnerConsentPage|partner-consent-submit|type="checkbox"/);
      assert.equal((html.match(/<form\b/g) ?? []).length, 1);
    }
  });
}

test("AC4 both boxes start unchecked; either unchecked keeps readiness false and server performs no writes", async () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const html = render(React.createElement(PartnerConsentScreen, {
      locale, documents: docs(), admin: true, action: noop, logout: noop,
    }));
    assert.match(html, /<button[^>]*disabled=""/);
    assert.doesNotMatch(html, /\schecked(?:=|\s|>)/);
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
    assert.match(html, /name="partnerAuthority"/);
    assert.equal((html.match(/target="_blank" rel="noopener"/g) ?? []).length, 2);
    assert.ok(html.indexOf(partnerConsentStrings[locale].summary) < html.indexOf("<h2>"));
  }
  for (const agreement of [false, true]) {
    for (const authority of [false, true]) {
      assert.equal(partnerConsentReady(agreement, authority), agreement && authority);
      const fields = render(React.createElement(PartnerConsentFields, {
        locale: "en", documents: docs(), checked: agreement, authority,
        onChange: () => {}, onAuthorityChange: () => {},
      }));
      assert.equal((fields.match(/\schecked=""/g) ?? []).length, Number(agreement) + Number(authority));
      if (agreement && authority) continue;
      const db = fake();
      await assert.rejects(recordPartnerConsentOn(db.client, staff(), agreement, authority, meta, partnerTestRuntime()));
      assert.equal(db.statements.length, 0);
    }
  }
});

test("AC4 fresh active admin membership is locked; manager, suspended, removed and invited admins cannot sign", async () => {
  for (const options of [
    { role: "manager" }, { role: "admin", status: "suspended" },
    { role: "admin", status: "removed" }, { role: "admin", status: "invited" },
  ]) {
    const db = fake(options);
    await assert.rejects(recordPartnerConsentOn(db.client, staff(), true, true, meta, partnerTestRuntime()));
    assert.ok(!db.statements.some((entry) => entry.sql.includes("INSERT")));
  }
  for (const billing of [false, true]) {
    const db = fake({ role: "admin", billing });
    await recordPartnerConsentOn(db.client, staff(), true, true, meta, partnerTestRuntime());
    assert.ok(db.statements.some((entry) => entry.sql.includes("FOR UPDATE")));
    assert.ok(db.statements.some((entry) => entry.sql.includes("FROM public.org_members") && entry.sql.includes("FOR SHARE")));
    const insert = db.statements.find((entry) => entry.sql.includes("INSERT"))!;
    assert.match(insert.sql, /authority_attested, actor_role, consenter_name/);
    assert.equal(insert.values[5], billing ? "owner" : "admin");
    assert.equal(insert.values[6], "Stored Signer");
    assert.equal(String(insert.values[4]).length, 512);
    const evidence = JSON.parse(String(insert.values[2]));
    assert.equal(evidence.length, 2);
    assert.ok(evidence.every((entry: { sha256: string }) => /^[0-9a-f]{64}$/.test(entry.sha256)));
  }
});

test("AC6 exact evidence versions and locale fallback; agreement pins match bundled files", async () => {
  assert.equal(parsePartnerDocumentConfig(partnerDocumentConfig), partnerDocumentConfig);
  assert.throws(() => parsePartnerDocumentConfig({}));
  const duplicate = structuredClone(partnerDocumentConfig);
  duplicate.documents.privacy.push({ ...duplicate.documents.privacy[0] });
  assert.throws(() => parsePartnerDocumentConfig(duplicate));
  const runtime = partnerTestRuntime();
  const selected = docs(runtime);
  assert.equal(selected[0].fallback, true);
  assert.equal(selected[1].locale, "en");
  assert.equal(selected[1].fallback, false);
  assert.ok(selectPartnerDocuments("unavailable", runtime.config, runtime.privacyVersion).every((doc) => doc.fallback));
  const verified = await verifiedPartnerDocuments("en", runtime);
  assert.ok(verified);
  const evidence = verified.map((doc) => ({ doc_type: doc.doc_type, version: doc.version }));
  assert.equal(partnerConsentCovered(verified, evidence), true);
  assert.equal(partnerConsentCovered(verified, evidence.slice(0, 1)), false);
  runtime.config.documents.partner_agreement.find((doc) => doc.locale === "en")!.version = "v0.2";
  assert.equal((await readPartnerStateOn(fake({ evidence }).client, staff(), runtime)).required, true);
  for (const entry of selectPartnerDocuments("zh-TW", partnerDocumentConfig).filter((doc) => doc.doc_type === "partner_agreement")) {
    assert.equal(resolvePartnerDocument(entry, readFileSync(resolve(entry.source), "utf8")).sha256, entry.sha256);
  }
});

test("D privacy minimum/header failures retain an active gate, refuse signing and hide acceptance", async () => {
  const reports: unknown[] = [];
  for (const runtime of [
    partnerTestRuntime(undefined, "2026-10-22"),
    partnerTestRuntime(`# Privacy\n- 版本：v2.1\n- 生效日期：${LATER}\n`),
    partnerTestRuntime("# Privacy\n- 生效日期：2026-10-27\n"),
    { ...partnerTestRuntime(), text: () => "changed agreement and privacy" },
  ]) {
    runtime.report = (entry) => reports.push(entry);
    const db = fake();
    const state = await readPartnerStateOn(db.client, staff(), runtime);
    assert.equal(state.active, true);
    assert.equal(state.required, true);
    assert.deepEqual(state.documents, []);
    assert.equal((await requireCurrentConsent(staff("admin", state), "api"))?.status, 403);
    const html = render(React.createElement(PartnerConsentScreen, {
      locale: "en", documents: state.documents, admin: true, action: noop, logout: noop,
    }));
    assert.ok(html.includes(partnerConsentStrings.en.unavailable));
    assert.match(html, /partner-consent-logout/);
    assert.doesNotMatch(html, /partner-consent-submit|partnerConsentPage|type="checkbox"/);
    await assert.rejects(recordPartnerConsentOn(db.client, staff(), true, true, meta, runtime));
    assert.ok(!db.statements.some((entry) => entry.sql.includes("INSERT")));
  }
  assert.ok(reports.length >= 4);
  for (const report of reports) assert.deepEqual(Object.keys(report as object).sort(), ["doc_type", "locale"]);
});

test("D same privacy header accepts v4.2-style body changes with fresh signing hash; canonical bump requires consent", async () => {
  const first = partnerTestRuntime();
  const second = partnerTestRuntime(`# Privacy\n- 版本：v2.1\n- 生效日期：${PRIVACY_VERSION}\n\nHosting backups follow the provider's backup process.\n`);
  const before = (await verifiedPartnerDocuments("en", first))!;
  const after = (await verifiedPartnerDocuments("en", second))!;
  assert.equal(after[0].version, `v2.1@${PRIVACY_VERSION}`);
  assert.equal(before[0].version, after[0].version);
  assert.notEqual(before[0].sha256, after[0].sha256);
  assert.equal(after[0].sha256, createHash("sha256").update(await second.text(after[0])).digest("hex"));
  const evidence = before.map((doc) => ({ doc_type: doc.doc_type, version: doc.version }));
  const state = await readPartnerStateOn(fake({ evidence }).client, staff(), second);
  assert.equal(state.active, true);
  assert.equal(state.required, false);
  const badAgreement: PartnerRuntime = {
    ...second,
    text: (entry) => entry.source.includes("partner-agreement") ? "tampered" : second.text(entry),
  };
  const covered = await readPartnerStateOn(fake({ evidence }).client, staff(), badAgreement);
  assert.equal(covered.active, true);
  assert.equal(covered.required, false);
  assert.deepEqual(covered.documents, []);
  const bumped = partnerTestRuntime(`# Privacy\n- 版本：v2.2\n- 生效日期：${LATER}\n`, LATER);
  assert.equal((await readPartnerStateOn(fake({ evidence }).client, staff(), bumped)).required, true);
  // v2 consent (2026-10-27) does not cover v2.1: design partners must accept v2.1.
  const v2Evidence = evidence.map((doc) => doc.doc_type === "privacy" ? { ...doc, version: "v2@2026-10-27" } : doc);
  assert.equal((await readPartnerStateOn(fake({ evidence: v2Evidence }).client, staff(), second)).required, true);
});

test("D check script fails specifically for minimum, header and agreement hash; body-only privacy change passes", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "partner-consent-check-"));
  function write(path: string, text: string) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  const runtime = partnerTestRuntime();
  const script = resolve("scripts/partner-consent-check.mjs");
  function run() {
    return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  }
  try {
    write("config/partner-consent-documents.json", JSON.stringify(runtime.config));
    for (const entries of Object.values(runtime.config.documents)) {
      for (const entry of entries) write(entry.source, await runtime.text(entry));
    }
    write("src/server/legal-versions.ts", 'export const PRIVACY_VERSION = "2026-10-22";\n');
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`privacy/zh-TW: PRIVACY_VERSION 2026-10-22 < min ${PRIVACY_VERSION}`));
    write("src/server/legal-versions.ts", `export const PRIVACY_VERSION = "${PRIVACY_VERSION}";\n`);
    assert.equal(run().status, 0);
    write(runtime.config.documents.privacy[0].source, `# Privacy\n- 版本：v2.1\n- 生效日期：${LATER}\n`);
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`生效日期 header must equal PRIVACY_VERSION ${PRIVACY_VERSION}`));
    write(runtime.config.documents.privacy[0].source, `# Privacy\n- 版本：v2.1\n- 生效日期：${PRIVACY_VERSION}\n\nRevised backup clause.\n`);
    assert.equal(run().status, 0);
    write(runtime.config.documents.partner_agreement[0].source, "tampered");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /partner_agreement\/zh-TW: sha256 expected=[0-9a-f]{64} actual=[0-9a-f]{64}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC7 settings renders immutable consenter snapshot, versions and Taipei time without controls", () => {
  const date = "2026-10-27T12:30:00Z";
  const html = render(React.createElement(PartnerConsentHistoryView, {
    locale: "zh-TW", rows: [
      { doc_type: "privacy", version: "v2@2026-10-27", consented_at: date, consenter: "Stored Signer" },
      { doc_type: "partner_agreement", version: "v0.1", consented_at: date, consenter: "retained-user-id" },
    ],
  }));
  for (const text of ["合規同意紀錄", "v2@2026-10-27", "v0.1", formatTaipei(date), "Stored Signer", "retained-user-id"]) {
    assert.ok(html.includes(text));
  }
  assert.doesNotMatch(html, /<(?:form|input|button)\b/);
  const history = readFileSync(new URL("./partner-consent.ts", import.meta.url), "utf8");
  assert.match(history, /coalesce\(c\.consenter_name,/);
});

test("AC8 new UI copy avoids prohibited terms and uses company terminology", () => {
  const banned = ["收租", "收款", "欠租", "已收", "入帳", "代收", "轉付", "金流", "統一編號", "含稅", "本公司", "事務所", "示範", "測試模式", "沙盒", "已驗證", "保證有效", "保證可報帳", "房東", "測試"];
  for (const [locale, copy] of Object.entries(partnerConsentStrings)) {
    for (const [key, text] of Object.entries(copy)) {
      for (const word of banned) assert.equal(text.includes(word), false, `${locale}.${key}: ${word}`);
    }
  }
  assert.equal(partnerConsentStrings["zh-TW"].waiting, "等待公司管理員同意");
  assert.equal(partnerConsentStrings["zh-TW"].authority, "本人有權代表公司同意");
  for (const file of [
    "../components/partner-consent-form.tsx", "../components/partner-consent-history.tsx",
    "../app/partner-consent/page.tsx", "../app/partner-agreement/page.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const word of banned) assert.equal(source.includes(word), false, `${file}: ${word}`);
    assert.doesNotMatch(source, /房客|landlord/i);
  }
});

test("AC4 AC5 request evidence and entrypoint wiring preserve permissions and enforce both attestations", () => {
  const headers = new Map([["x-forwarded-for", "203.0.113.7, 10.0.0.1"], ["user-agent", "x".repeat(700)]]);
  assert.deepEqual(partnerRequestMeta({ get: (key) => headers.get(key) ?? null }), {
    ip: "203.0.113.7", ua: "x".repeat(512),
  });
  const gate = readFileSync(new URL("./consent-gate.ts", import.meta.url), "utf8");
  assert.match(gate, /consentCoversCurrent\(current\.consent \?\? null\).*requirePartnerConsent\(current, mode\)/);
  const session = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
  assert.ok(session.indexOf("await readPartnerStateOn") < session.indexOf("await correctRetiredSampleAddresses"));
  const root = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(root, /partnerConsent/);
  const layout = readFileSync(new URL("../app/m/layout.tsx", import.meta.url), "utf8");
  assert.ok(layout.indexOf("await requireCurrentConsent") < layout.indexOf("await loadManagerChrome"));
  for (const role of ["manager", "accountant", "maintenance"] as const) {
    assert.equal(noPermHref("/m/settings", role), "/m/noperm?need=settings.edit");
  }
  assert.equal(noPermHref("/m/settings", "admin"), null);
  const signup = readFileSync(new URL("./signup.ts", import.meta.url), "utf8");
  const create = signup.slice(signup.indexOf("export async function createFirm"));
  assert.ok(create.indexOf("await passConsentGate") < create.indexOf("input.partnerAuthority !== true"));
  assert.ok(create.indexOf("input.partnerAuthority !== true") < create.indexOf('await client.query("BEGIN")'));
  assert.ok(create.indexOf("await insertSignupPartnerConsentOn") > create.indexOf("INSERT INTO org_members"));
  assert.ok(create.indexOf("await insertSignupPartnerConsentOn") < create.indexOf('await client.query("COMMIT")'));
  const actions = readFileSync(new URL("./signup-actions.ts", import.meta.url), "utf8");
  const submit = readFileSync(new URL("./partner-consent-submit.ts", import.meta.url), "utf8");
  for (const source of [actions, submit]) assert.match(source, /get\("partnerAuthority"\) === "on"/);
  const form = readFileSync(new URL("../components/firm-steps.tsx", import.meta.url), "utf8");
  assert.match(form, /partnerConsentReady\(partnerChecked, partnerAuthority\)/);
  assert.match(form, /data\.get\("partnerAuthority"\) !== "on"/);
  assert.ok(form.includes("disabled={!submitReady}"));
});
