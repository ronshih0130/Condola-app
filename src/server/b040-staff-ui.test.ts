import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { staffInviteHeaders, type InviteScreen } from "../lib/staff-invite";
import { StaffInvitePanel } from "../components/staff-invite/panel";
import { staffInvitePath, type StaffInviteData } from "./b040-staff-ui";
import { staffCanManage } from "./unit-line-invite";
import { can } from "./perms";
import { staffInviteMutationAllowed } from "./b040-staff-ui-http";
import { FlowError } from "./errors";
import { makeT } from "../i18n";
import { staffInviteCopy } from "../i18n/staff-invite";
import { inviteQrMatrix } from "../lib/staff-invite-qr";
import type { Session } from "./types";

const unitId = "10000000-1111-4000-8000-000000000001";
const bindingId = "20000000-1111-4000-8000-000000000001";
const leaseId = "30000000-1111-4000-8000-000000000001";
const token = "A".repeat(43);
const fixture: StaffInviteData = {
  unitId, firm: "Example Firm", place: "Example property 3F", locale: "zh-TW",
  invite: { path: `/join/${token}`, expiresAt: "2030-11-23T10:00:00.000Z", fingerprint: "fixture" },
  bindings: [{ id: bindingId, name: "Test Tenant", displayName: "Test LINE", method: "line", joinedAt: "2030-11-10T09:12:00.000Z", pending: true }],
  leases: [{ id: leaseId, label: "Example lease" }],
};
const html = (screen: InviteScreen, data = fixture) => renderToStaticMarkup(React.createElement(StaffInvitePanel, { data, screen, origin: "https://staging.condola.app", opts: { bindingId, leaseId } }));

// Execute the actual TS module/page with only request/data adapters replaced.
// This keeps role × flag visibility tests free of database access.
function compiled(file: string, deps: Record<string, unknown>): Record<string, unknown> {
  const source = readFileSync(file, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const exports = {};
  const require = createRequire(resolve(file));
  new Function("require", "exports", code)((name: string) => name in deps ? deps[name] : require(name), exports);
  return exports;
}

test("MGT-51 / R-X-perm / FLAG-OFF: actual U0 rendering follows role × flag and never receives a token", async () => {
  for (const role of ["admin", "manager", "maintenance", "accountant", null] as const) for (const flag of [false, true]) {
    const session = { kind: role ? "staff" : "tenant", role, locale: "en", orgId: "fixture" } as Session;
    const service = compiled("src/server/b040-staff-ui.ts", {
      "./b017-custom-role-governance": { guardEffectiveSession: async (s: Session) => s },
      "./unit-line-invite": { staffCanManage, unitLineInviteOn: async () => flag },
      "./perms": { can },
    });
    const page = compiled("src/app/m/units/page.tsx", {
      "@/server/b040-staff-ui": { ...service, staffInviteEntries: async () => [{ rowId: unitId, unitId, bound: 1, expiresAt: fixture.invite!.expiresAt }] },
      "@/i18n/staff-invite": { staffInviteCopy }, "@/i18n": { makeT },
      "@/server/consent-gate": { requireCurrentConsent: async () => null },
      "@/server/session": { getSession: async () => session },
      "@/server/queries": { searchSpaces: async () => ({ rows: [{ id: unitId, kind: "whole_unit", property_id: unitId, property_name: "Example", floor: "3F" }], page: 1, total: 1, from: 1, to: 1 }) },
      "@/server/sandbox-data": { displaySampleName: (s: string) => s },
      "@/server/perms": { can }, "@/server/format": { moneyLabel: () => "" },
      "@/i18n/record-archive": { archiveCopy: () => ({ entry: "Archive" }) },
      "@/components/list-search": { ListPager: () => null, ListSearch: () => null, listSummary: () => "" },
      "@/components/ui": { PageHeader: () => null },
      "next/link": { __esModule: true, default: ({ children, ...props }: Record<string, unknown>) => React.createElement("a", props, children as React.ReactNode) },
    });
    const render = page.default as (props: { searchParams: Promise<object> }) => Promise<React.ReactNode>;
    const rendered = renderToStaticMarkup(await render({ searchParams: Promise.resolve({}) }));
    const allowed = flag && (role === "admin" || role === "manager");
    assert.equal(rendered.includes('data-testid="staff-invite-entry"'), allowed, `${role}/${flag}`);
    assert.equal(rendered.includes(staffInvitePath(unitId)), allowed);
    assert.ok(!rendered.includes(token));
  }
});

test("MGT-51 / B-017: denied custom invite permission hides U0 instead of breaking the units page", async () => {
  const loaded = compiled("src/server/b040-staff-ui.ts", {
    "./b017-custom-role-governance": { guardEffectiveSession: async () => { throw new FlowError("errors.forbidden"); } },
    "./errors": { FlowError }, "./unit-line-invite": { staffCanManage },
  });
  const visible = loaded.staffInviteVisible as (s: Session) => Promise<boolean>;
  assert.equal(await visible({ kind: "staff", role: "manager" } as Session), false);
});

test("MGT-39 / MGT-51: M4 status shows n/4, validity and the approved non-sending rules", () => {
  const panel = html("panel");
  assert.match(panel, /data-status[^>]*>已加入 1／4<\/span>/);
  assert.match(panel, /si-validity[^>]*>有效到 11\/23<\/span>/);
  assert.match(panel, /系統不會代你發送/);
  assert.match(panel, /租客就在旁邊/);
  assert.match(panel, /line:\/\/msg\/text\//);
  assert.match(panel, /\/join\/••••/);
  assert.match(html("panel", { ...fixture, invite: null }), /role="alert"/);
  assert.doesNotMatch(html("panel", { ...fixture, invite: null }), /產生邀請|還沒邀請|這個單位還沒有邀請/);
  assert.doesNotMatch(html("panel", { ...fixture, invite: null }), /<svg/);
});

test("MGT-52 / mockup unified-invite M4-Q: 完成 goes to M6 (joined tenants), and only the 已加入 chip shows", () => {
  const out = html("qr");
  const done = out.match(/<a[^>]*href="([^"]+)"[^>]*>完成<\/a>/);
  assert.ok(done, "完成 link present");
  assert.match(done[1], /\/invite\/tenants$/);
  assert.doesNotMatch(out, /有效到/);
  assert.doesNotMatch(out, /返回邀請面板/);
});

test("MGT-52-AC2: M4-Q at 4/4 has a grey placeholder and no scannable QR", () => {
  const full = { ...fixture, bindings: Array.from({ length: 4 }, (_, i) => ({ ...fixture.bindings[0], id: String(i) })) };
  assert.match(html("qr", full), /aria-disabled="true"/);
  assert.match(html("qr", full), /這個邀請已經滿了（4／4）/);
  assert.doesNotMatch(html("qr", full), /<svg/);
  assert.match(html("qr"), /<svg/);
});

test("MGT-39 / R-a4 / R-a6: all token surfaces have no-referrer, self-only scripts, and no href query contains the token", () => {
  assert.equal(staffInviteHeaders["Referrer-Policy"], "no-referrer");
  assert.equal(staffInviteHeaders["Cache-Control"], "no-store");
  assert.match(staffInviteHeaders["Content-Security-Policy"], /script-src 'self'/);
  for (const screen of ["panel", "qr", "print", "rotate", "tenants", "remove", "lease"] as const) {
    const doc = html(screen);
    assert.match(doc, /name="referrer" content="no-referrer"/);
    for (const [, href] of doc.matchAll(/href="([^"]+)"/g)) {
      const url = new URL(href.replaceAll("&amp;", "&"), "https://staging.condola.app");
      assert.ok(!decodeURIComponent(url.search).includes(token));
    }
    assert.deepEqual([...doc.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]), []);
  }
});

test("MGT-42 / R-b1 / R-b6: M7 never pre-ticks even matching names or previously linked tenants", () => {
  const data = { ...fixture, bindings: [...fixture.bindings, { ...fixture.bindings[0], id: "other", pending: false }] };
  const doc = html("lease", data);
  assert.equal(doc.match(/type="checkbox"/g)?.length, 1);
  assert.doesNotMatch(doc, /\bchecked(?:=|\s|>)/);
  assert.match(doc, /不會自動對上租約當事人/);
  assert.match(doc, /先略過，稍後再選/);
  assert.match(doc, /name="bindingIds"/);
});

test("MGT-39 / MGT-41: print steps, escaping of names, and joined times use approved bilingual copy", () => {
  const unsafe = { ...fixture, firm: '<script>alert("x")</script>', bindings: [{ ...fixture.bindings[0], name: '<img src=x onerror="x">' }] };
  assert.match(html("print", unsafe), /&lt;script&gt;/);
  assert.doesNotMatch(html("tenants", unsafe), /<img/);
  assert.equal(html("print").match(/<li>/g)?.length, 3);
  assert.match(html("tenants"), /LINE 名稱：Test LINE/);
  assert.match(html("tenants", { ...fixture, bindings: [] }), /還沒有租客加入/);
  for (const screen of ["panel", "qr", "print", "rotate", "tenants", "remove", "lease"] as const) {
    assert.doesNotMatch(html(screen, { ...fixture, locale: "en" }), /[\u3400-\u9fff]/);
  }
});

test("MGT-39: local QR vector independently decoded by macOS CoreImage; capacity fails closed", () => {
  const matrix = inviteQrMatrix(`https://staging.condola.app/join/${token}`);
  assert.equal(matrix.length, 41);
  assert.equal(createHash("sha256").update(JSON.stringify(matrix)).digest("hex"), "db9f48539fee38f31d7622565e39bc321b3010b897ccaead987c1edba9229984");
  assert.throws(() => inviteQrMatrix("x".repeat(135)), /capacity/);
});


test("MGT-39 / R-a4: no-referrer native forms need same-origin document Fetch Metadata; cross-site and forged Host fail closed", () => {
  const url = "https://staging.condola.app/m/units/fixture/invite";
  const base = { origin: "null", host: "staging.condola.app", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  const request = (headers: Record<string, string>) => new Request(url, { method: "POST", headers });
  assert.equal(staffInviteMutationAllowed(request(base)), true);
  assert.equal(staffInviteMutationAllowed(request({ origin: "https://staging.condola.app", host: base.host })), true);
  for (const change of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-mode": "cors" }, { "sec-fetch-dest": "iframe" }, { origin: "https://untrusted.invalid" }, { host: "untrusted.invalid" }]) {
    assert.equal(staffInviteMutationAllowed(request({ ...base, ...change })), false);
  }
  assert.equal(staffInviteMutationAllowed(request({ origin: "null", host: base.host })), false);
  assert.equal(staffInviteMutationAllowed(request({ host: base.host })), false);
});

test("M4 opening issues once, reuses the live secret, handles concurrent issuance, and never rotates", async () => {
  for (const mode of ["missing", "existing", "concurrent", "failure"] as const) {
    let live = mode === "existing", issued = 0;
    const session = { kind: "staff", role: "admin", userId: "fixture", orgId: "fixture", locale: "zh-TW" } as Session;
    const invite = { token, path: `/join/${token}`, expires_at: new Date(fixture.invite!.expiresAt) };
    const service = compiled("src/server/b040-staff-ui.ts", {
      "./b017-custom-role-governance": { guardEffectiveSession: async (s: Session) => s, withEffectiveAuthority: async (_c: unknown, _s: unknown, _p: unknown, fn: () => unknown) => fn() },
      "./db": { tx: async (_user: string, fn: (c: object) => unknown) => fn({}) },
      "./record-archive-admission": { archiveAncestry: async () => ({ propertyId: "property", unitId }) },
      "./queries": { propertyDetail: async () => ({ property: { name: "Example" }, wholes: [{ id: unitId, label: "3F" }] }) },
      "./id-docs": { loadFirmNoticeContact: async () => ({ name: "Example" }) },
      "./unit-line-invite": {
        staffCanManage, unitLineInviteOn: async () => true,
        currentInvite: async () => live ? invite : null, listBindings: async () => [], hashInviteToken: () => "fingerprint",
        issueInvite: async () => { issued++; if (mode !== "failure") live = true; if (["failure", "concurrent"].includes(mode)) throw new Error("synthetic issuer failure"); },
        rotateInvite: async () => { assert.fail("opening must never rotate"); },
      },
    });
    const load = service.staffInvitePage as (s: Session, id: string, view: string[]) => Promise<{ data: StaffInviteData }>;
    if (mode === "failure") { await assert.rejects(() => load(session, unitId, [])); continue; }
    assert.equal((await load(session, unitId, [])).data.invite?.path, `/join/${token}`);
    assert.equal((await load(session, unitId, [])).data.invite?.path, `/join/${token}`);
    assert.equal(issued, mode === "existing" ? 0 : 1);
  }
});

test("React page uses the guarded loader and generic issuance error inside the manager layout", async () => {
  const session = { kind: "staff", role: "admin", locale: "zh-TW" } as Session;
  let consent = false;
  const deps = {
    "@/components/staff-invite/panel": { StaffInvitePanel }, "@/components/staff-invite/panel.css": {},
    "@/i18n/staff-invite": { staffInviteCopy }, "@/server/errors": { FlowError },
    "@/server/session": { getSession: async () => session },
    "@/server/consent-gate": { requireCurrentConsent: async () => { consent = true; } },
    "next/navigation": { notFound: () => { throw new Error("not-found"); } },
    "next/headers": { headers: async () => new Headers({ host: "localhost" }) },
    "@/server/portal-invite": { portalInviteOrigin: () => "http://localhost" },
  };
  for (const fail of [false, true]) {
    consent = false;
    const page = compiled("src/app/m/units/[unitId]/invite/[[...view]]/page.tsx", {
      ...deps, "@/server/b040-staff-ui": { staffInvitePage: async () => { assert.ok(consent); if (fail) throw new Error("private failure"); return { data: fixture, screen: "panel" }; } },
    });
    const render = page.default as (p: { params: Promise<object> }) => Promise<React.ReactNode>;
    const result = renderToStaticMarkup(await render({ params: Promise.resolve({ unitId }) }));
    assert.match(result, /name="referrer" content="no-referrer"/);
    assert.equal(result.includes("private failure"), false);
    assert.match(result, fail ? /role="alert"/ : /data-screen="panel"/);
  }
  const config = compiled("next.config.ts", {}).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
  const rule = (await config.headers()).find(r => r.source === "/m/units/:unitId/invite/:path*");
  assert.equal(rule?.headers.find(h => h.key === "Referrer-Policy")?.value, "no-referrer");
});

test("M6/M7 preserve the server-formatted joined time across browser locale/ICU differences", () => {
  const data = { ...fixture, bindings: [{ ...fixture.bindings[0], joinedAtLabel: "11/10\u200909:12" }] };
  for (const screen of ["tenants", "lease"] as const) {
    assert.ok(html(screen, data).includes("11/10\u200909:12"));
    assert.ok(!html(screen, data).includes(data.bindings[0].joinedAt));
  }
});
