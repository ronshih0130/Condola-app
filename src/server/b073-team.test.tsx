import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import { saveTeamSecurity, seatsFull, teamPermissionMatrix, teamRead, teamRowActions, teamRows, teamSeats, type TeamRowV3 } from "./b073-team";
import { FlowError } from "./errors";
import { authorizeSettingsEdit } from "./b073-owner-view";
import { readCappedJson } from "./read-capped-json";
import * as perms from "./perms";
import { crumbFor } from "./nav-v3";
import { TEAM_INVITES_ENABLED, teamInvitesAllowedForOrg } from "./team-invites";
import { brandV3TeamCopy, fill } from "../i18n/lanes/brand-v3-r5-team";
import { makeT } from "../i18n";
import { seatLead, TeamError, TeamFullPanel, TeamLoading, TeamPermissions, TeamView } from "../components/v3/m/settings/team";
import { TeamSecurityRow } from "../components/v3/m/settings/team-security-row";
import { afterSecuritySave, initialTeamSecurity, postTeamSecurity, startSecurityToggle, syncTeamSecurity } from "../components/v3/m/settings/team-security-state";
import { focusTeamOnLoad, TEAM_ADD_ID, TEAM_CLOSE_HREF, TEAM_PANEL_ID } from "../components/v3/m/settings/team-focus-state";
import type { OrgRole, Session } from "./types";

// B-073 / R5-TEAM + R5-FULL (設定 › 團隊, MGT-133 AC1, AC3–AC8). Synthetic data only; nothing outbound.
const requireHere = createRequire(import.meta.url);
const read = (p: string) => readFileSync(p, "utf8");
const BEFORE = "555ddadb76c9a53dd18e8809a1e167d5bfa3514b"; // origin/main before this slice (R5-OWNVIEW merged)
const baseline = (p: string) => execFileSync("git", ["show", `${BEFORE}:${p}`], { encoding: "utf8" });
const disabled = /\sdisabled=""|aria-disabled/;
const ORG = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-000000000002";
const staff = (role: OrgRole, locale: "zh-TW" | "en" = "zh-TW", environment: "live" | "sandbox" = "live"): Session => ({ kind: "staff", role, orgId: ORG, liveOrgId: ORG,
  userId: ME, sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic",
  email: "fixture@example.invalid", environment, locale, calendar: "gregorian", leaseId: null });
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const FUTURE = "2999-01-01T00:00:00Z", PAST = "2000-01-01T00:00:00Z";
function compile(source: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", code)((name: string) => {
    // Lauren 2b: migrated routes import the real wrapper, compiled with the same mocks (consent, session, errors).
    if (name === "@/server/flag-gate" && !(name in mocks)) return compile(read("src/server/flag-gate.ts"), mocks);
    if (name in mocks) return mocks[name];
    if (["react", "react/jsx-runtime"].includes(name)) return requireHere(name);
    throw new Error(`Unmocked dependency: ${name}`);
  }, exports);
  return exports;
}
const box = (name: string) => function Box(props: Record<string, unknown>) {
  return <div data-test={name}>{JSON.stringify(props, (_k, v) => typeof v === "function" ? undefined : React.isValidElement(v) ? "[element]" : v)}</div>;
};
const listed = [
  { member_id: "m1", invitation_id: null, name: "陳志明", email: "chen@example.invalid", role: "admin", status: "active", expires_at: null, user_id: ME },
  { member_id: "m2", invitation_id: null, name: "王怡君", email: "wang@example.invalid", role: "manager", status: "active", expires_at: null, user_id: "u2" },
  { member_id: "m3", invitation_id: null, name: "林會計", email: "lin@example.invalid", role: "accountant", status: "active", expires_at: null, user_id: "u3" },
  { member_id: "m4", invitation_id: null, name: "阿明", email: "ming@example.invalid", role: "maintenance", status: "suspended", expires_at: null, user_id: "u4" },
  { member_id: null, invitation_id: "i1", name: "chou@example.invalid", email: "chou@example.invalid", role: "manager", status: "pending", expires_at: FUTURE, user_id: null },
  { member_id: null, invitation_id: "i2", name: "old@example.invalid", email: "old@example.invalid", role: "manager", status: "pending", expires_at: PAST, user_id: null },
  { member_id: null, invitation_id: "i3", name: "gone@example.invalid", email: "gone@example.invalid", role: "manager", status: "revoked", expires_at: FUTURE, user_id: null },
];

test("MGT-133 copy: zh-TW verbatim from the approved frames (PR-018); GS-02 state lines; EN exists", () => {
  const zh = brandV3TeamCopy("zh-TW");
  assert.equal(fill(zh.leadLimit, { used: 5, limit: 5 }), "團隊人數 5／5");
  assert.equal(fill(zh.leadNoLimit, { used: 3 }), "團隊人數 3");
  assert.equal(zh.leadNote, "每位同事都算一人，不分角色。");
  assert.deepEqual([zh.add, zh.colName, zh.colRole, zh.colStatus], ["新增同事", "同事", "角色", "狀態"]);
  assert.deepEqual([zh.statusActive, zh.statusInvited, zh.statusPaused, zh.pausedSub], ["使用中", "邀請中", "暫停", "試用結束，升級後恢復"]);
  assert.deepEqual([zh.more, zh.resend, zh.perms], ["更多", "重寄邀請", "看完整權限表"]);
  assert.deepEqual([zh.securityTitle, zh.require2fa, zh.require2faSub], ["全公司的安全規則", "要求全體成員啟用兩步驟驗證", "開啟後，還沒設定的同事下次登入時要先完成。"]);
  assert.equal(zh.fullTitle, "團隊人數已滿");
  assert.equal(fill(zh.fullBody, { used: 5, limit: 5 }), "團隊人數已滿（5／5）。升級到進階方案就不限人數，或先停用一位同事。");
  assert.deepEqual([zh.plans, zh.close, zh.cancel], ["看方案", "關閉", "取消"]);
  assert.equal(zh.roleAdmin, "全部都能做，包括團隊、方案和公司設定。");
  assert.equal(zh.roleManager, "看今天和報表，處理物件、租客、租約、確認繳款、記支出、報修和訊息，可以匯出報表；不能撤回繳款、對帳、月結，也不能改團隊、方案和公司設定。");
  assert.equal(zh.roleAccountant, "看今天，確認和撤回繳款、對帳、屋主報表、記支出、月結，可以匯出報表；看得到物件和租約但不能修改，沒有報修和訊息，也看不到租客電話。");
  assert.equal(zh.roleMaintenance, "處理報修、聯絡租客；看不到收款和報表。");
  assert.deepEqual([zh.readFailed, zh.retry, zh.saveFailed], ["這裡暫時讀不到，請再試一次。", "再試一次", "沒有存成功，請再試一次。"]);
  const en = brandV3TeamCopy("en");
  assert.deepEqual(Object.keys(en), Object.keys(zh));
  for (const value of Object.values(en)) assert.doesNotMatch(value, /[一-鿿]/);
  // Every zh-TW string of the lane appears in an approved round-5 frame (brand-3.0.html, hub) — checked by hand
  // against 「設定・團隊」, 「設定・團隊・人數滿了」 and 「設定・團隊・新增同事」; the lane header cites them and PR-018.
  assert.match(read("src/i18n/lanes/brand-v3-r5-team.ts"), /MGT-133[\s\S]*設定・團隊・人數滿了[\s\S]*PR-018/);
});

test("MGT-133-AC4 headcount: used = active members + pending invitations (seats.ts); no limit in 測試模式; full at or over the limit", () => {
  assert.equal(seatLead("zh-TW", { used: 4, limit: 5 }), "團隊人數 4／5");
  assert.equal(seatLead("zh-TW", { used: 7, limit: null }), "團隊人數 7");
  assert.equal(seatLead("en", { used: 4, limit: 5 }), "Team size 4/5");
  assert.deepEqual(teamSeats(5, 5, "live"), { used: 5, limit: 5 });
  assert.deepEqual(teamSeats(5, 5, "sandbox"), { used: 5, limit: null });
  assert.equal(seatsFull({ used: 5, limit: 5 }), true);
  assert.equal(seatsFull({ used: 6, limit: 5 }), true);
  assert.equal(seatsFull({ used: 4, limit: 5 }), false);
  assert.equal(seatsFull({ used: 99, limit: null }), false);
  // The count is today's seats.ts query (unchanged): active members + unexpired pending team invitations.
  const seats = read("src/server/seats.ts");
  assert.match(seats, /status = 'active'\) AS members,[\s\S]*kind = 'team_member' AND status = 'pending' AND expires_at > now\(\)\) AS pending/);
  assert.match(seats, /return \{ members, pending, used: members \+ pending \};/);
});

test("MGT-133-AC1/AC6 rows: 使用中／邀請中／暫停 from today's list; paused from the B-056 pause; revoked invitations left out", () => {
  const rows = teamRows(listed, { userId: ME }, new Set(["u3"]), Date.parse("2026-11-17T00:00:00Z"));
  assert.deepEqual(rows.map(row => [row.key, row.status]), [["m1", "active"], ["m2", "active"], ["m3", "paused"], ["m4", "disabled"], ["i1", "invited"], ["i2", "invited"]]);
  assert.deepEqual(rows[0], { key: "m1", memberId: "m1", invitationId: null, name: "陳志明", contact: "chen@example.invalid", role: "admin", status: "active", inviteLive: false, self: true, lastAdmin: true });
  assert.equal(rows[4].contact, null, "an invitation's name is its address: shown once");
  assert.deepEqual([rows[4].inviteLive, rows[5].inviteLive], [true, false]);
  assert.equal(teamRows([{ ...listed[1], role: "owner" }], { userId: ME }, new Set(), 0).length, 0);
  const twoAdmins = teamRows([listed[0], { ...listed[1], role: "admin" }], { userId: ME }, new Set(), 0);
  assert.deepEqual(twoAdmins.map(row => row.lastAdmin), [false, false]);
  // The pause predicate is the B-056 SQL function, read as the owning login (as resolveStaffOrg does).
  const own = read("src/server/b073-team.ts");
  assert.match(own, /WHERE m\.org_id = \$1 AND m\.status = 'active' AND app\.b056_member_paused\(m\.org_id, m\.user_id\)/);
  assert.match(own, /SELECT coalesce\(settings->>'require_2fa', 'false'\) = 'true' AS required FROM organizations WHERE id = \$1/);
});

test("MGT-133-AC8 permission: a non-admin is forbidden before any read; admin reads; any failure is unavailable", async () => {
  for (const role of ["manager", "accountant", "maintenance"] as const) {
    const trace: string[] = [];
    const deps = { list: async () => { trace.push("list"); return []; }, usage: async () => { trace.push("usage"); return { used: 0 }; },
      tier: async () => { trace.push("tier"); return "free"; }, paused: async () => { trace.push("paused"); return new Set<string>(); },
      require2fa: async () => { trace.push("2fa"); return false; } };
    assert.deepEqual(await teamRead(staff(role), deps), { state: "forbidden" }, role);
    assert.deepEqual(trace, [], role);
    assert.equal(perms.noPermHref("/m/team", staff(role)), "/m/noperm?need=team.manage", "the page itself follows the app's 403 convention");
  }
  assert.deepEqual(perms.rolesFor("team.manage"), ["admin"]);
  const ok = await teamRead(staff("admin"), { list: async () => listed, usage: async () => ({ used: 5 }), tier: async () => "standard",
    paused: async () => new Set(["u2"]), require2fa: async () => true, now: () => Date.parse("2026-11-17T00:00:00Z") });
  assert.equal(ok.state, "ready");
  if (ok.state !== "ready") return;
  assert.deepEqual([ok.seats, ok.full, ok.security], [{ used: 5, limit: 5 }, true, { required: true }]);
  assert.equal(ok.rows.find(row => row.key === "m2")?.status, "paused");
  const sandbox = await teamRead(staff("admin", "zh-TW", "sandbox"), { list: async () => [], usage: async () => ({ used: 9 }), tier: async () => "free", paused: async () => new Set<string>(), require2fa: async () => false });
  assert.deepEqual(sandbox.state === "ready" && [sandbox.seats, sandbox.full], [{ used: 9, limit: null }, false]);
  const premium = await teamRead(staff("admin"), { list: async () => [], usage: async () => ({ used: 9 }), tier: async () => "pro", paused: async () => new Set<string>(), require2fa: async () => false });
  assert.deepEqual(premium.state === "ready" && premium.seats, { used: 9, limit: null });
  for (const broken of ["list", "usage", "tier", "paused", "require2fa"] as const) {
    const deps = { list: async () => listed, usage: async () => ({ used: 1 }), tier: async () => "free", paused: async () => new Set<string>(), require2fa: async () => false,
      [broken]: async () => { throw new Error("db down"); } };
    assert.deepEqual(await teamRead(staff("admin"), deps), { state: "unavailable" }, broken);
  }
  assert.deepEqual(await teamRead(staff("admin"), { list: async () => { throw new FlowError("errors.forbidden"); } }), { state: "forbidden" });
});

test("MGT-133-AC1/AC6 row actions: 重寄邀請 only where today's gate can rotate a link; paused rows cannot bypass the plan", () => {
  const rows = teamRows(listed, { userId: ME }, new Set(["u3"]), Date.parse("2026-11-17T00:00:00Z"));
  const by = (key: string) => rows.find(row => row.key === key) as TeamRowV3;
  assert.deepEqual(teamRowActions(by("i1"), { invites: "live", full: false }), { primary: "resend-link", more: ["revoke"] });
  assert.deepEqual(teamRowActions(by("i1"), { invites: "legacy", full: false }), { primary: "resend-legacy", more: ["revoke"] });
  assert.deepEqual(teamRowActions(by("i1"), { invites: "closed", full: false }), { primary: null, more: ["revoke"] });
  assert.deepEqual(teamRowActions(by("i2"), { invites: "live", full: false }), { primary: null, more: ["revoke"] }, "an expired invitation cannot be rotated");
  assert.deepEqual(teamRowActions(by("m1"), { invites: "live", full: false }), { primary: null, more: ["locked-self"] });
  assert.deepEqual(teamRowActions(by("m2"), { invites: "live", full: false }), { primary: null, more: ["role", "deactivate"] });
  assert.deepEqual(teamRowActions(by("m3"), { invites: "live", full: false }), { primary: null, more: ["deactivate"] }, "paused: no role change");
  assert.deepEqual(teamRowActions(by("m4"), { invites: "live", full: false }), { primary: null, more: ["reactivate"] });
  assert.deepEqual(teamRowActions(by("m4"), { invites: "live", full: true }), { primary: null, more: [] }, "a full team cannot reactivate");
  const lastAdmin = { ...by("m2"), role: "admin" as const, lastAdmin: true };
  assert.deepEqual(teamRowActions(lastAdmin, { invites: "live", full: false }), { primary: null, more: ["locked-last-admin"] });
});

test("MGT-133 staff-invite delivery gate: OFF by default; 重寄邀請 never mails (same rotation as B-040)", () => {
  assert.equal(TEAM_INVITES_ENABLED, false);
  const saved = process.env.TEAM_INVITES_ORG_ALLOWLIST;
  delete process.env.TEAM_INVITES_ORG_ALLOWLIST;
  try { assert.equal(teamInvitesAllowedForOrg(ORG), false); } finally { if (saved !== undefined) process.env.TEAM_INVITES_ORG_ALLOWLIST = saved; }
  // The v3 branch gets the B-040 page's own gate values (no second gate), and maps them to live / legacy / closed.
  const page = read("src/app/m/team/page.tsx");
  assert.ok(page.indexOf("const legacyInvitesOpen") < page.indexOf("brandV3EnabledForOrg(session.orgId)"));
  assert.match(page, /const invites = invitesOpen \? "live" : legacyInvitesOpen \? "legacy" : "closed";/);
  const actions = read("src/components/v3/m/settings/team-actions.tsx");
  assert.match(actions, /<TeamInviteLinkButton invitationId=\{row\.invitationId\} label=\{c\.resend\} buttonClassName="btn txt" \/>/);
  assert.match(actions, /<form action=\{actionResendInvite\}>/);
  assert.doesNotMatch(actions + read("src/components/v3/m/settings/team-invite.tsx") + read("src/server/b073-team.ts"), /sendMail|sendSms|line\/push|fetch\(/);
  // Both paths keep their server-side gates (unchanged): the link action and resendInvite assert the allowlist.
  const auth = read("src/server/auth.ts"), authActions = read("src/server/auth-actions.ts");
  assert.match(authActions.slice(authActions.indexOf("export async function actionIssueTeamInviteLink")), /!teamInvitesAllowedForOrg\(session\.orgId\)/);
  assert.match(authActions.slice(authActions.indexOf("export async function actionResendInvite")), /assertTeamInvitesAllowed\(session\.orgId\)/);
  const resend = auth.slice(auth.indexOf("export async function resendInvite"), auth.indexOf("export async function revokeInvite"));
  assert.match(resend, /assertTeamInvitesAllowed\(session\.orgId\)/); assert.doesNotMatch(resend, /sendMail/);
  // The shared link button is unchanged when the new props are absent.
  const button = read("src/components/team-invite-link-button.tsx");
  assert.match(button, /buttonClassName = "btn sm"/); assert.match(button, /\{label \?\? t\("i_team_invite_copy"\)\}/);
});

test("MGT-133-AC3 matrix: generated from perms.ts, read only, collapsed by default; descriptions pinned to the matrix", () => {
  const matrix = teamPermissionMatrix();
  assert.deepEqual(matrix.map(row => row.key), perms.PERMS.map(([key]) => key));
  for (const [key, , roles] of perms.PERMS) {
    const row = matrix.find(item => item.key === key)!;
    for (const role of perms.ROLE_KEYS) assert.equal(row.roles[role], (roles as readonly string[]).includes(role), `${key} ${role}`);
  }
  // The four approved descriptions (R5-ADD, PR-018) were written from this exact matrix. If perms.ts changes,
  // this fails: update the descriptions (P52, Ron) together with the fingerprint.
  const grants = Object.fromEntries(perms.ROLE_KEYS.map(role => [role, perms.PERMS.filter(([, , roles]) => (roles as readonly string[]).includes(role)).map(([key]) => key)]));
  assert.deepEqual(grants.maintenance, ["tenants.contact", "tickets.update"]);
  assert.deepEqual(grants.manager, ["dash.view", "props.view", "props.edit", "leases.edit", "tenants.contact", "pay.record", "stmt.view", "exp.add", "tickets.update", "messages.send", "reports.export"]);
  assert.deepEqual(grants.accountant, ["dash.view", "props.view", "pay.record", "pay.reverse", "bank.reconcile", "stmt.view", "stmt.generate", "exp.add", "month.close", "reports.export"]);
  assert.equal(grants.admin.length, perms.PERMS.length);
  assert.equal(createHash("sha256").update(JSON.stringify(perms.PERMS)).digest("hex").slice(0, 16), "7a724156aacfcd04");
  const closed = renderToStaticMarkup(<TeamPermissions locale="zh-TW" />);
  assert.match(closed, /^<details class="v3-team-perms" id="v3-team-perms" data-testid="team-perms"><summary class="btn txt">看完整權限表<\/summary>/);
  assert.doesNotMatch(closed, /<details[^>]* open/);
  assert.doesNotMatch(closed, /<input|<button|<form|<select/, "read only");
  const t = makeT("zh-TW");
  for (const [key, label] of perms.PERMS) assert.ok(closed.includes(`<tr data-perm="${key}"><th scope="row">${t(label)}</th>`), key);
  assert.equal((closed.match(/<td>✓<\/td>/g) ?? []).length, perms.PERMS.reduce((n, [, , roles]) => n + roles.length, 0));
  for (const s of ["管理員", "經理", "會計", "維修", brandV3TeamCopy("zh-TW").roleAccountant]) assert.ok(text(closed).includes(s), s);
  assert.match(renderToStaticMarkup(<TeamPermissions locale="zh-TW" open />), /<details class="v3-team-perms" id="v3-team-perms" open=""/);
});

const ready = teamRows(listed, { userId: ME }, new Set(["u3"]), Date.parse("2026-11-17T00:00:00Z"));
const view = (props: Partial<React.ComponentProps<typeof TeamView>> = {}) => renderToStaticMarkup(<TeamView locale="zh-TW" rows={ready} seats={{ used: 4, limit: 5 }} panel="none"
  rowActions={row => <i data-actions={row.key} />} security={<TeamSecurityRow locale="zh-TW" required={false} />} {...props} />);

test("MGT-133-AC8 states: loading has skeletons and no count; read failure has the GS-02 line and 「再試一次」", () => {
  const loading = renderToStaticMarkup(<TeamLoading locale="zh-TW" />);
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(text(loading), /\d|團隊人數/, "no count");
  assert.doesNotMatch(loading, /<a |<button|<table/);
  assert.ok((loading.match(/v3-team-skeleton/g) ?? []).length >= 5);
  const error = renderToStaticMarkup(<TeamError locale="zh-TW" />);
  assert.match(error, /role="alert"><p>這裡暫時讀不到，請再試一次。<\/p><a class="btn" href="\/m\/team">再試一次<\/a>/);
  assert.doesNotMatch(text(error), /\d|團隊人數|新增同事/);
});

test("MGT-133-AC1/AC4/AC6/AC7 page: lead + note + solid 「新增同事」 link; rows with chips; paused sub-line; security card", () => {
  const html = view();
  const t = text(html);
  assert.match(html, /<h1>團隊人數 4／5<\/h1><p>每位同事都算一人，不分角色。<\/p>/);
  assert.match(html, /<a class="btn pri" href="\/m\/team\?add=1#v3-team-panel" id="v3-team-add" data-testid="team-add">新增同事<\/a>/);
  assert.equal((html.match(/btn pri/g) ?? []).length, 1, "one solid button");
  assert.doesNotMatch(html, disabled);
  assert.match(html, /<th scope="col">同事<\/th><th scope="col">角色<\/th><th scope="col">狀態<\/th>/);
  assert.match(html, /<tr data-status="active"><td><b>陳志明<\/b><span class="v3-team-sub">chen@example.invalid<\/span><\/td><td>管理員<\/td><td><span class="chip ok">使用中<\/span><\/td>/);
  assert.match(html, /<tr data-status="paused"><td><b>林會計<\/b>[^]*?<span class="chip warn">暫停<\/span><span class="v3-team-sub">試用結束，升級後恢復<\/span>/);
  assert.match(html, /<tr data-status="invited"><td><b>chou@example.invalid<\/b><\/td><td>經理<\/td><td><span class="chip info">邀請中<\/span>/);
  assert.match(html, /<tr data-status="disabled">[^]*?<span class="chip">已停用<\/span>/);
  assert.equal((html.match(/data-actions=/g) ?? []).length, ready.length);
  assert.ok(t.includes("全公司的安全規則") && t.includes("要求全體成員啟用兩步驟驗證") && t.includes("開啟後，還沒設定的同事下次登入時要先完成。"));
  assert.match(html, /role="switch" class="v3-team-switch" aria-checked="false"/);
  assert.ok(t.includes("看完整權限表"));
  assert.doesNotMatch(t, /團隊人數已滿|看方案/);
  // No security card without settings.edit; no limit → 「團隊人數 {used}」.
  const noCard = view({ security: null, seats: { used: 3, limit: null } });
  assert.doesNotMatch(noCard, /全公司的安全規則|role="switch"/);
  assert.match(noCard, /<h1>團隊人數 3<\/h1>/);
  assert.match(renderToStaticMarkup(<TeamView locale="en" rows={ready} seats={{ used: 1, limit: 1 }} panel="none" rowActions={() => null} />), /Team size 1\/1/);
});

test("MGT-133-AC5 full vs room: at the limit 「新增同事」 opens R5-FULL (nothing invited); with room it opens the existing invite flow", () => {
  const full = view({ seats: { used: 5, limit: 5 }, panel: "full", invite: <form data-invite="1" /> });
  assert.match(full, /<h2 id="v3-team-full-title">團隊人數已滿<\/h2><p>團隊人數已滿（5／5）。升級到進階方案就不限人數，或先停用一位同事。<\/p>/);
  assert.match(full, /<a class="btn" href="\/m\/settings">看方案<\/a><a class="btn txt" href="\/m\/team#v3-team-add">關閉<\/a>/);
  assert.match(full, /<section class="v3-team-card v3-team-panel" id="v3-team-panel" tabindex="-1" aria-labelledby="v3-team-full-title"/);
  assert.match(full, /<a class="btn pri" href="\/m\/team\?add=1#v3-team-panel" id="v3-team-add" data-testid="team-add">新增同事<\/a>/, "still a live button");
  assert.doesNotMatch(full, /data-invite|全公司的安全規則/); assert.doesNotMatch(full, disabled);
  assert.doesNotMatch(view({ seats: { used: 5, limit: 5 }, panel: "full", plans: false }), /看方案/);
  const add = view({ panel: "add", invite: <form data-invite="1" /> });
  assert.match(add, /<section class="v3-team-panel" id="v3-team-panel" tabindex="-1" aria-label="新增同事" data-testid="team-invite"><form data-invite="1"><\/form><a class="btn txt" href="\/m\/team#v3-team-add">取消<\/a><\/section>/);
  assert.match(add, /<a class="btn" href="\/m\/team\?add=1#v3-team-panel" id="v3-team-add" data-testid="team-add">新增同事<\/a>/, "outline while the form's own submit is the solid one");
  assert.doesNotMatch(add, /團隊人數已滿/);
  assert.match(renderToStaticMarkup(<TeamFullPanel locale="en" seats={{ used: 1, limit: 1 }} />), /Your team is full \(1\/1\)\./);
});

test("R5-FULL / invite panel focus: an open panel takes focus; 「關閉」/「取消」 return focus to 「新增同事」", () => {
  const made = (ids: string[]) => {
    const focused: string[] = [];
    return { focused, doc: { getElementById: (id: string) => ids.includes(id) ? { focus: () => { focused.push(id); } } : null } };
  };
  const open = made([TEAM_PANEL_ID, TEAM_ADD_ID]);
  assert.equal(focusTeamOnLoad(open.doc, ""), TEAM_PANEL_ID); assert.deepEqual(open.focused, [TEAM_PANEL_ID]);
  const back = made([TEAM_ADD_ID]);
  assert.equal(focusTeamOnLoad(back.doc, "#v3-team-add"), TEAM_ADD_ID); assert.deepEqual(back.focused, [TEAM_ADD_ID]);
  const plain = made([TEAM_ADD_ID]);
  assert.equal(focusTeamOnLoad(plain.doc, ""), null); assert.deepEqual(plain.focused, [], "a plain visit does not move focus");
  assert.equal(focusTeamOnLoad(made([]).doc, "#v3-team-add"), null);
  assert.equal(TEAM_CLOSE_HREF, "/m/team#v3-team-add");
  // The effect runs on the client for every panel state; the client file imports only the pure module.
  const client = read("src/components/v3/m/settings/team-focus.tsx");
  assert.match(client, /^"use client";/);
  assert.match(client, /useEffect\(\(\) => \{ focusTeamOnLoad\(document, window\.location\.hash\); \}, \[panel\]\);/);
  assert.doesNotMatch(client, /b073-team|from "\.\/team"/);
  assert.match(read("src/components/v3/m/settings/team.tsx"), /<TeamFocus panel=\{panel\} \/>/);
  assert.match(read("public/brand/v3/settings-team.css"), /\.v3-team-panel:focus-visible\{ outline:2px solid var\(--c-focus\)/);
});

const sectionSource = read("src/components/v3/m/settings/team-page.tsx");
async function renderSection(read: Awaited<ReturnType<typeof teamRead>>, query: Record<string, string>, invites: "live" | "legacy" | "closed" = "live", gate: { redirectTo: string | null } | "throws" = { redirectTo: null }) {
  const calls: string[] = [];
  const Section = compile(sectionSource, {
    "@/i18n": { makeT },
    "@/components/ui": { ErrorBanner: box("error") },
    "@/server/demo": { demoModeEnabled: () => false },
    "@/server/billing": { FREE_UNITS: 5 },
    "@/server/upgrade-gate": { upgradeGate: async () => { calls.push("gate"); if (gate === "throws") throw new Error("partner controls down"); return gate; } },
    "@/server/b073-team": { teamRead: async () => read, teamRowActions },
    "./team": requireHere("../components/v3/m/settings/team"),
    "./team-actions": { TeamRowActionsCell: box("actions") },
    "./team-invite": { TeamInviteFlow: box("invite-flow") },
    "./team-security-switch": { TeamSecuritySwitch: box("security") },
    // B-059 (GS-24): the 「負責的單位」 link flag; OFF here (its own test is b059-maint-unit-assign.test.tsx).
    "@/server/b059-maint-unit-assign": { maintUnitAssignEnabledForOrg: async () => false },
    "./assign": { assignEditHref: (id: string) => `/m/assign/${id}` },
  }).TeamV3Section as (p: unknown) => Promise<React.ReactElement | null>;
  const element = await Section({ session: staff("admin"), invites, query });
  return { html: element ? renderToStaticMarkup(element) : "", calls };
}
test("MGT-133-AC5 section: the server decides full vs invite from the same seat count; perms=1 opens the matrix", async () => {
  const data = { state: "ready" as const, rows: ready, seats: { used: 5, limit: 5 }, full: true, security: { required: true } };
  const full = await renderSection(data, { add: "1" });
  assert.match(full.html, /團隊人數已滿（5／5）/); assert.doesNotMatch(full.html, /invite-flow/); assert.deepEqual(full.calls, ["gate"]);
  assert.doesNotMatch((await renderSection(data, { add: "1" }, "live", { redirectTo: "/m" })).html, /看方案/, "confirmed partner restriction kept");
  // A failed lookup is not "pricing hidden": the read error with 「再試一次」, no panel without 「看方案」.
  const failed = await renderSection(data, { add: "1" }, "live", "throws");
  assert.match(failed.html, /這裡暫時讀不到，請再試一次。[^]*<a class="btn" href="\/m\/team">再試一次<\/a>/);
  assert.doesNotMatch(failed.html, /團隊人數已滿|data-testid="team-list"/);
  const room = await renderSection({ ...data, seats: { used: 4, limit: 5 }, full: false }, { add: "1" }, "legacy");
  assert.match(room.html, /data-test="invite-flow">\{&quot;locale&quot;:&quot;zh-TW&quot;,&quot;invites&quot;:&quot;legacy&quot;\}/);
  assert.doesNotMatch(room.html, /團隊人數已滿/); assert.deepEqual(room.calls, []);
  const plain = await renderSection(data, {});
  assert.doesNotMatch(plain.html, /invite-flow|團隊人數已滿/);
  assert.match(plain.html, /data-test="security">\{&quot;locale&quot;:&quot;zh-TW&quot;,&quot;required&quot;:true\}/);
  assert.match(plain.html, /<details class="v3-team-perms" id="v3-team-perms" data-testid="team-perms">/);
  assert.match((await renderSection(data, { perms: "1" })).html, /<details class="v3-team-perms" id="v3-team-perms" open=""/);
  // Row actions follow teamRowActions with this request's gate and seat state.
  assert.match(plain.html, /&quot;primary&quot;:&quot;resend-link&quot;/);
  assert.match((await renderSection(data, {}, "closed")).html, /&quot;actions&quot;:\{&quot;primary&quot;:null,&quot;more&quot;:\[&quot;revoke&quot;\]\}/);
  assert.match((await renderSection({ state: "unavailable" }, {})).html, /這裡暫時讀不到，請再試一次。/);
  assert.equal((await renderSection({ state: "forbidden" }, { add: "1" })).html, "");
});

test("R5-TEAM row-action cell and invite flow: text actions, today's server actions, never a disabled button", () => {
  const cell = compile(read("src/components/v3/m/settings/team-actions.tsx"), {
    "@/i18n": { makeT }, "@/i18n/lanes/brand-v3-r5-team": { brandV3TeamCopy },
    "@/components/confirm-deactivate": { ConfirmDeactivate: box("deactivate") },
    "@/components/team-invite-link-button": { TeamInviteLinkButton: box("link-button") },
    "@/server/auth-actions": { actionMemberActive: "actionMemberActive", actionMemberRole: "actionMemberRole", actionResendInvite: "actionResendInvite", actionRevokeInvite: "actionRevokeInvite" },
    "@/server/perms": perms,
    "@/i18n/lanes/brand-v3-assign": requireHere("../i18n/lanes/brand-v3-assign"), "next/link": { __esModule: true, default: "a" },
  }).TeamRowActionsCell as React.FC<{ locale: "zh-TW"; row: TeamRowV3; actions: ReturnType<typeof teamRowActions> }>;
  const by = (key: string) => ready.find(row => row.key === key)!;
  const link = renderToStaticMarkup(React.createElement(cell, { locale: "zh-TW", row: by("i1"), actions: { primary: "resend-link", more: ["revoke"] } }));
  assert.match(link, /data-test="link-button">\{&quot;invitationId&quot;:&quot;i1&quot;,&quot;label&quot;:&quot;重寄邀請&quot;,&quot;buttonClassName&quot;:&quot;btn txt&quot;\}/);
  assert.match(link, /<details class="v3-team-more"><summary class="btn txt">更多<\/summary>[^]*<button class="btn sm danger" type="submit">撤銷<\/button>/);
  const legacy = renderToStaticMarkup(React.createElement(cell, { locale: "zh-TW", row: by("i1"), actions: { primary: "resend-legacy", more: [] } }));
  assert.match(legacy, /<input type="hidden" name="invitationId" value="i1"\/><button class="btn txt" type="submit">重寄邀請<\/button>/);
  assert.doesNotMatch(legacy, /<details/);
  const member = renderToStaticMarkup(React.createElement(cell, { locale: "zh-TW", row: by("m2"), actions: { primary: null, more: ["role", "deactivate"] } }));
  assert.match(member, /<input type="hidden" name="memberId" value="m2"\/><select class="inp" name="role" aria-label="[^"]+">/);
  assert.match(member, /data-test="deactivate">\{&quot;memberId&quot;:&quot;m2&quot;/);
  const self = renderToStaticMarkup(React.createElement(cell, { locale: "zh-TW", row: by("m1"), actions: { primary: null, more: ["locked-self"] } }));
  assert.ok(text(self).includes(makeT("zh-TW")("i_own_role")));
  const back = renderToStaticMarkup(React.createElement(cell, { locale: "zh-TW", row: by("m4"), actions: { primary: null, more: ["reactivate"] } }));
  assert.match(back, /<input type="hidden" name="active" value="1"\/><button class="btn sm" type="submit">重新啟用<\/button>/);
  assert.equal(renderToStaticMarkup(React.createElement(cell, { locale: "zh-TW", row: by("m4"), actions: { primary: null, more: [] } })), '<div class="v3-team-actions"></div>');
  for (const html of [link, legacy, member, self, back]) assert.doesNotMatch(html, disabled);

  const Flow = compile(read("src/components/v3/m/settings/team-invite.tsx"), {
    "@/i18n": { makeT }, "@/components/team-invite-form": { TeamInviteForm: box("live-form") }, "@/server/auth-actions": { actionInvite: "actionInvite" },
  }).TeamInviteFlow as React.FC<{ locale: "zh-TW"; invites: "live" | "legacy" | "closed" }>;
  assert.match(renderToStaticMarkup(<Flow locale="zh-TW" invites="live" />), /data-test="live-form"/);
  const legacyForm = renderToStaticMarkup(<Flow locale="zh-TW" invites="legacy" />);
  assert.match(legacyForm, /<input class="inp" id="v3-team-invite-email" type="email"[^>]*name="email"\/>/); assert.match(legacyForm, /<button class="btn pri" type="submit">/);
  const closed = renderToStaticMarkup(<Flow locale="zh-TW" invites="closed" />);
  assert.equal(closed, `<div class="card pad" data-testid="team-invite-closed"><p>${makeT("zh-TW")("i_team_invites_soon")}</p></div>`);
});

test("MGT-133-AC7 2FA switch: existing setRequireMfa behaviour; one save at a time; failure returns the saved value", async () => {
  const start = initialTeamSecurity(false);
  const saving = startSecurityToggle(start)!;
  assert.deepEqual(saving, { saved: false, shown: true, saving: true, error: false });
  assert.equal(startSecurityToggle(saving), null);
  const busy = renderToStaticMarkup(<TeamSecurityRow locale="zh-TW" required={saving.shown} saving />);
  assert.match(busy, /aria-checked="true"[^>]*aria-disabled="true"/);
  for (const outcome of [{ ok: false as const, status: 403 }, { ok: false as const, status: 500 }, "threw" as const]) {
    const failed = afterSecuritySave(saving, outcome);
    assert.deepEqual(failed, { saved: false, shown: false, saving: false, error: true });
    assert.match(renderToStaticMarkup(<TeamSecurityRow locale="zh-TW" required={failed.shown} error />), /role="alert">沒有存成功，請再試一次。</);
  }
  assert.deepEqual(afterSecuritySave(saving, { ok: true, required: true }), initialTeamSecurity(true));
  assert.equal(syncTeamSecurity(saving, false), saving);
  assert.deepEqual(syncTeamSecurity(initialTeamSecurity(true), false), initialTeamSecurity(false));
  const calls: [string, RequestInit][] = [];
  const fake = (status: number, body: unknown = null) => (async (url: string, init: RequestInit) => { calls.push([url, init]);
    return new Response(body === null ? null : JSON.stringify(body), { status }); }) as unknown as typeof fetch;
  assert.deepEqual(await postTeamSecurity(true, fake(200, { required: true })), { ok: true, required: true });
  assert.equal(calls[0][0], "/api/team-security"); assert.equal(calls[0][1].body, JSON.stringify({ required: true }));
  for (const status of [400, 401, 403, 415, 500]) assert.deepEqual(await postTeamSecurity(false, fake(status)), { ok: false, status });
  assert.deepEqual(await postTeamSecurity(false, fake(200, { required: "yes" })), { ok: false, status: 200 });
  assert.equal(await postTeamSecurity(false, (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch), "threw");
  const client = read("src/components/v3/m/settings/team-security-switch.tsx");
  assert.match(client, /^"use client";/);
  assert.doesNotMatch(client, /from "\.\/team"|b073-team|redirect\(|"use server"/, "the client bundle imports no server module");
  // Server: settings.edit first (whatever the body), then brand_v3 (OFF → 404), then the body; the existing
  // setRequireMfa is the writer.
  const on = async () => true;
  for (const role of ["manager", "accountant", "maintenance"] as const)
    for (const input of [{ required: true }, null, {}, { required: "on" }, undefined, "{"]) {
      const trace: string[] = [];
      assert.deepEqual(await saveTeamSecurity(staff(role), input, { v3: async () => { trace.push("v3"); return true; }, write: async () => { trace.push("write"); }, read: async () => { trace.push("read"); return true; } }), { ok: false, status: 403 }, `${role} ${JSON.stringify(input)}`);
      assert.deepEqual(trace, []);
    }
  const offTrace: string[] = [];
  assert.deepEqual(await saveTeamSecurity(staff("admin"), { required: true }, { v3: async () => false, write: async () => { offTrace.push("write"); }, read: async () => { offTrace.push("read"); return true; } }), { ok: false, status: 404 });
  assert.deepEqual(await saveTeamSecurity(staff("admin"), { required: "on" }, { v3: async () => false }), { ok: false, status: 404 }, "OFF before the body");
  assert.deepEqual(offTrace, []);
  const failTrace: string[] = [];
  assert.deepEqual(await saveTeamSecurity(staff("admin"), { required: true }, { v3: async () => { throw new Error("flag read failed"); }, write: async () => { failTrace.push("write"); } }), { ok: false, status: 500 });
  assert.deepEqual(failTrace, [], "a failed flag read writes nothing");
  for (const input of [null, {}, { required: "on" }, { required: true, extra: 1 }, [true], "true", undefined]) {
    assert.deepEqual(await saveTeamSecurity(staff("admin"), input, { v3: on, write: async () => { throw new Error("must not write"); } }), { ok: false, status: 400 });
  }
  const writes: boolean[] = [];
  assert.deepEqual(await saveTeamSecurity(staff("admin"), { required: true }, { v3: on, write: async (_s, v) => { writes.push(v); }, read: async () => true }), { ok: true, required: true });
  assert.deepEqual(writes, [true]);
  assert.deepEqual(await saveTeamSecurity(staff("admin"), { required: false }, { v3: on, write: async () => { throw new Error("db down"); } }), { ok: false, status: 500 });
  assert.deepEqual(await saveTeamSecurity(staff("admin"), { required: false }, { v3: on, write: async () => { throw new FlowError("errors.forbidden"); } }), { ok: false, status: 403 });
  // The default flag reader is the fail-loud brand_v3 reader for the session's organization.
  assert.match(read("src/server/b073-team.ts"), /\(await import\("\.\/brand-v3"\)\)\.brandV3ReadForOrg\(orgId\)\)\)\(session\.orgId\);\n    if \(!v3\) return \{ ok: false, status: 404 \};/);
  assert.match(read("src/server/b073-team.ts"), /\(deps\.write \?\? \(await import\("\.\/auth"\)\)\.setRequireMfa\)\(session, value\.required\)/);
});

test("MGT-133-AC8 route: same-origin JSON only; non-admin → HTTP 403; bad body 400; admin 200 with the stored value", async () => {
  const source = read("src/app/api/team-security/route.ts");
  const trace: unknown[] = [];
  let session: Session | null = staff("admin");
  let v3 = true;
  const real = (s: Session, input: unknown) => saveTeamSecurity(s, input, { v3: async () => v3, write: async () => { trace.push("write"); }, read: async () => true });
  let save: (s: Session, input: unknown) => Promise<unknown> = real;
  const route = compile(source, {
    "@/server/consent-gate": { requireCurrentConsent: async (_s: Session, mode: string) => { trace.push(`consent:${mode}`); return null; } },
    "@/server/session": { readSession: async () => { trace.push("session"); return session; } },
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => { trace.push("flag"); return v3; } },
    "@/server/b073-owner-view": { authorizeSettingsEdit: (s: Session) => { trace.push("permission"); return authorizeSettingsEdit(s); } },
    "@/server/b073-team": { saveTeamSecurity: (s: Session, input: unknown) => save(s, input) },
    "@/server/read-capped-json": { readCappedJson: (r: Request) => { trace.push("body"); return readCappedJson(r); } },
    "@/server/errors": { logServerError: () => { trace.push("logged"); } },
  }).POST as (r: Request) => Promise<Response>;
  const post = (body: unknown, init: { origin?: string | null; type?: string } = {}) => route(new Request("http://localhost/api/team-security", { method: "POST",
    headers: { ...(init.origin === null ? {} : { Origin: init.origin ?? "http://localhost" }), "Content-Type": init.type ?? "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body) }));
  for (const origin of ["http://evil.example", null]) {
    trace.length = 0; assert.equal((await post({ required: true }, { origin })).status, 403); assert.deepEqual(trace, ["consent:api", "session"]);
  }
  assert.equal((await post({ required: true }, { type: "text/plain" })).status, 415);
  for (const role of ["manager", "accountant", "maintenance"] as const) {
    trace.length = 0; session = staff(role); const res = await post({ required: true });
    assert.equal(res.status, 403, role); assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(trace, ["consent:api", "session", "flag", "permission"]);
    // A malformed body from a non-admin is still 403 (authorization before validation).
    for (const body of ["{", "null", JSON.stringify({ required: 1 })]) assert.equal((await post(body)).status, 403, `${role} ${body}`);
  }
  session = staff("admin");
  for (const body of ["{", "null", JSON.stringify({ required: 1 })]) assert.equal((await post(body)).status, 400, body);
  // brand_v3 OFF for the session's organization: 404 and nothing written.
  v3 = false; trace.length = 0;
  assert.equal((await post({ required: true })).status, 404); assert.deepEqual(trace, ["consent:api", "session", "flag"]);
  v3 = true;
  save = async (_s, input) => { (trace as unknown[]).push(input); return { ok: true, required: true }; };
  trace.length = 0;
  const ok = await post({ required: true });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { required: true });
  assert.deepEqual(trace, ["consent:api", "session", "flag", "permission", "body", { required: true }]);
  save = async () => { throw new Error("boom"); }; trace.length = 0;
  assert.equal((await post({ required: true })).status, 500); assert.ok(trace.includes("logged"));
  session = null; assert.equal((await post({ required: true })).status, 401);
  const entries = JSON.parse(read("src/server/b017-entry-permissions.json"));
  assert.equal(entries["src/app/api/team-security/route.ts#POST"], "settings.edit");
  assert.equal(entries["src/server/b073-team.ts#teamRead"], "team.manage");
  assert.equal(entries["src/server/b073-team.ts#saveTeamSecurity"], "settings.edit");
});

// ---- Pages: flag OFF byte-for-byte; ON branch; /m/roles opens 團隊. ----
function teamMocks(v3: boolean, trace: string[], session: Session) {
  return {
    "@/server/brand-v3": { brandV3EnabledForOrg: async () => { trace.push("flag"); return v3; } },
    "@/components/v3/m/settings/team": { TeamLoading: box("team-loading") },
    "@/components/v3/m/settings/team-page": { TeamV3Section: box("team-section") },
    "@/server/b017-custom-role-governance": { guardEffectiveSession: async (s: Session, key: string) => { trace.push(`guard:${key}`); return s; } },
    "@/server/consent-gate": { requireCurrentConsent: async () => { trace.push("consent"); return null; } },
    "@/i18n": { makeT: () => (key: string, values?: Record<string, unknown>) => values ? `${key}${JSON.stringify(values)}` : key },
    "@/components/ui": { ErrorBanner: box("error"), PageHeader: box("header") },
    "@/components/confirm-deactivate": { ConfirmDeactivate: box("deactivate") },
    "@/components/team-invite-form": { TeamInviteForm: box("invite-form") },
    "@/components/team-invite-link-button": { TeamInviteLinkButton: box("link-button") },
    "@/server/auth-actions": { actionInvite: "actionInvite", actionMemberActive: "actionMemberActive", actionMemberRole: "actionMemberRole", actionResendInvite: "actionResendInvite", actionRevokeInvite: "actionRevokeInvite" },
    "@/server/time": { formatTaipei: (v: string) => `t:${v}`, formatTaipeiDate: (v: string) => `d:${v}` },
    "@/server/auth": { mfaStatus: async () => { trace.push("mfa"); return { enabled: false, required: true }; } },
    "@/server/demo": { demoModeEnabled: () => true },
    "@/server/billing": { seatLimit: (tier: string) => tier === "standard" ? 5 : null },
    "@/server/queries": { listTeam: async () => { trace.push("list"); return listed.map(row => ({ ...row, mfa: false, last_sign_in: null })); } },
    "@/server/seats": { commercialTier: async () => { trace.push("tier"); return "standard"; }, seatUsage: async () => { trace.push("usage"); return { members: 4, pending: 1, used: 5 }; } },
    "@/server/session": { getSession: async () => session },
    "@/server/team-invites": { teamInvitesAllowedForOrg: () => true },
    "@/server/perms": perms,
    "@/server/auth-actions#roles": null,
    "next/navigation": { redirect: (to: string) => { trace.push(`redirect:${to}`); throw Object.assign(new Error("NEXT_REDIRECT"), { to }); } },
  };
}
async function renderTeam(source: string, v3: boolean, session: Session, query: Record<string, string> = {}) {
  const trace: string[] = [];
  const mocks: Record<string, unknown> = teamMocks(v3, trace, session);
  mocks["@/server/auth"] = { ...(mocks["@/server/auth"] as object), ownerPrivacy: async () => { trace.push("privacy"); return { showName: true, showPhone: false, name: "x" }; } };
  mocks["@/server/auth-actions"] = { ...(mocks["@/server/auth-actions"] as object), actionOwnerPrivacy: "actionOwnerPrivacy" };
  const page = compile(source, mocks).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactElement>;
  try {
    return { html: renderToStaticMarkup(await page({ searchParams: Promise.resolve(query) })), trace: trace.filter(step => step !== "flag") };
  } catch (error) {
    return { html: `redirect:${(error as { to?: string }).to}`, trace: trace.filter(step => step !== "flag") };
  }
}
const sessions = [staff("admin"), staff("admin", "en"), staff("admin", "zh-TW", "sandbox")];
const queries: Record<string, string>[] = [{}, { error: "errors.forbidden" }, { token: "tok", invited: "1" }, { add: "1", perms: "1" }];

test("MGT-133 flag OFF: /m/team and /m/roles render byte-for-byte as before, same reads in the same order", async () => {
  for (const file of ["src/app/m/team/page.tsx", "src/app/m/roles/page.tsx"])
    for (const session of sessions) for (const query of queries) {
      const now = await renderTeam(read(file), false, session, query), before = await renderTeam(baseline(file), false, session, query);
      assert.deepEqual(now, before, `${file} ${session.locale} ${session.environment} ${JSON.stringify(query)}`);
    }
  const off = (await renderTeam(read("src/app/m/team/page.tsx"), false, staff("admin"))).html;
  assert.match(off, /data-testid="team-table"/); assert.match(off, /data-testid="seat-meter"/);
  assert.doesNotMatch(off, /settings-team\.css|team-section/);
});

test("MGT-133 flag ON: /m/team renders only the R5-TEAM section with its own stylesheet and today's invite gate; /m/roles opens 團隊", async () => {
  const on = await renderTeam(read("src/app/m/team/page.tsx"), true, staff("admin"), { add: "1" });
  assert.match(on.html, /^<link rel="stylesheet" href="\/brand\/v3\/settings-team\.css"\/>/);
  assert.match(on.html, /data-test="team-section">\{&quot;session&quot;:\{[^]*&quot;invites&quot;:&quot;live&quot;,&quot;query&quot;:\{&quot;add&quot;:&quot;1&quot;\}\}/);
  assert.doesNotMatch(on.html, /team-table|seat-meter|invite-form|link-button/);
  assert.deepEqual(on.trace, ["consent", "guard:team.manage"], "no B-040 reads before the v3 section");
  assert.match((await renderTeam(read("src/app/m/team/page.tsx"), true, staff("admin", "zh-TW", "sandbox"))).html, /&quot;invites&quot;:&quot;legacy&quot;/);
  // The old 角色權限 route: an admin lands on 團隊 with the table open, before any privacy read.
  const roles = await renderTeam(read("src/app/m/roles/page.tsx"), true, staff("admin"));
  assert.equal(roles.html, "redirect:/m/team?perms=1#v3-team-perms");
  assert.ok(!roles.trace.includes("privacy"));
  // A custom role that may open settings but not 團隊 keeps today's read-only table (B-017 custom roles untouched).
  const custom = staff("admin");
  custom.customRole = { orgId: custom.orgId, userId: custom.userId, sessionId: custom.sessionId, nativeRole: "admin", keys: ["settings.edit"], photos: false, audit: false };
  const kept = await renderTeam(read("src/app/m/roles/page.tsx"), true, custom);
  assert.match(kept.html, /data-testid="perm-matrix"/); assert.doesNotMatch(kept.html, /privacy-name/);
  // Only this page links the stylesheet.
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const linking = walk("src").filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f) && read(f).includes("settings-team.css"));
  assert.deepEqual(linking, ["src/app/m/team/page.tsx"]);
  // The frame crumb: 「設定 › 團隊」 (brand_v3 navigation only; flag-OFF MANAGER_NAV keeps 團隊成員).
  assert.deepEqual(crumbFor("/m/team", staff("admin")), ["設定", "團隊"]);
  assert.match(read("src/server/perms.ts"), /\{ href: "\/m\/team", key: "i_nav_team", perm: "team\.manage" \}/);
});

test("R5-TEAM CSS: v3-scoped, tokens only, ≥44px targets, white focus ring on the solid button", () => {
  const css = read("public/brand/v3/settings-team.css");
  postcss.parse(css).walkRules(rule => {
    if (rule.parent?.type === "atrule" && (rule.parent as postcss.AtRule).name === "keyframes") return;
    for (const s of rule.selectors) assert.ok(s.startsWith('html[data-brand="v2"][data-brand-v3] .v3-team'), s);
  });
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/i);
  assert.match(css, /\.v3-team \.btn\{[^}]*min-height:44px; min-width:44px/);
  assert.match(css, /\.v3-team-switch\{[^}]*min-width:44px; min-height:44px/);
  assert.match(css, /\.v3-team \.btn\.pri:focus-visible\{ outline:2px solid var\(--c-on-primary\)/);
});
