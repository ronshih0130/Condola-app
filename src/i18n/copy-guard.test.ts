import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

// Ron 2026-11-13 terminology decision: 「收款」 only in the manager nav name and the owner/vendor own-status strings
// (exact allowlists below); 收租 and 代收 are banned phrases everywhere; Condola is never the subject of 收款.
const FORBIDDEN = ["房東", "房客", "收款", "收租", "代收", "即將推出", "測試模式", "範例沙盒", "示範", "欠租", "本月實收"];

const PHRASES = [
  "🧪 測試模式",
  "範例沙盒",
  "這裡不會實際傳送 LINE 訊息",
  "收入是已確認的收款",
  "待確認收款",
  "以 LINE 身分驗證",
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".open-next", ".git", "coverage", "playwright-report", "test-results", ".wrangler", "out", "dist"]);

function read(path: string) {
  return readFileSync(path, "utf8");
}

function decode(source: string) {
  return source.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function sourceFiles() {
  const out: string[] = [];
  // Verbatim 內政部 contract text, including the required 「二房東」 note. Not product copy.
  const officialLease = join(root, "src", "assets", "leases") + sep;
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (path.startsWith(officialLease)) continue;
      if (/\.test\.tsx?$|\.spec\.tsx?$/.test(entry.name)) continue;
      if (/\.(ts|tsx|json)$/.test(entry.name)) out.push(path);
    }
  };
  walk(join(root, "src"));
  return out;
}

// Approved manager-area exception: one exact property in its owning lane only.
function withoutManagerAreaName(source: string, rel: string) {
  const exact = /^    money: "收款",$/gm;
  if (rel !== "src/i18n/lanes/brand-v3.ts" || [...source.matchAll(exact)].length !== 1) return source;
  return source.replace(exact, '    money: "",');
}

// PR-018 / PR-019 P52: exact approved report section names only. Do not exempt
// the containing file, the banned substring globally, or duplicate/extended values.
function withoutApprovedReportRentNames(source: string, rel: string) {
  if (rel !== "src/i18n/lanes/brand-v3-report.ts") return source;
  for (const exact of [/^    earlyRent: "預收租金",$/gm, /^    earlyRentHeading: "另外列：預收租金",$/gm]) {
    if ([...source.matchAll(exact)].length === 1) source = source.replace(exact, "");
  }
  return source;
}

// PENDING-RON PR-016 (Ron 2026-11-15 11:42 PT): exact owner/vendor own-status strings, in their own lane only.
const OWN_STATUS_LANE = "src/i18n/lanes/brand-v3-own-status.ts";
// B-063 adds two approved vendor empty-state strings (VEN-14-AC4 V-EMPTY; V-RECV empty, PR-018).
const OWN_STATUS_EXACT = ["代屋主確認收款", "收款帳戶是屋主的，你只是代他在系統裡記下「已收到」，不是代他收錢。", "已代{屋主}記下這筆收款。", "收款", "待收款", "待收款紀錄",
  "目前沒有未結案件，也沒有待收款。免下載 App，用這個網頁就行。", "還沒有待收款紀錄"];
function withoutOwnStatus(source: string, rel: string) {
  if (rel !== OWN_STATUS_LANE) return source;
  let out = source;
  for (const exact of OWN_STATUS_EXACT) out = out.split(`"${exact}"`).join('""');
  return out;
}

// GS-32 rec-type1-preview: the approved vendor-frontend-1112 primary (VEN-21-AC4, rec-preview), exact, in its own lane only.
const VENDOR_DOCS_LANE = "src/i18n/lanes/brand-v3-vendor-docs.ts";
function withoutVendorDocsIssue(source: string, rel: string) {
  if (rel !== VENDOR_DOCS_LANE) return source;
  const exact = /^    issue: "確認已全額收款並開立", close: "關閉",$/gm;
  return [...source.matchAll(exact)].length === 1 ? source.replace(exact, '    issue: "", close: "關閉",') : source;
}

function hitsFor(words: string[]) {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    const rel = relative(root, file);
    const text = withoutVendorDocsIssue(withoutApprovedReportRentNames(withoutOwnStatus(withoutManagerAreaName(decode(read(file)), rel), rel), rel), rel);
    if (file.endsWith(".json")) {
      const data = JSON.parse(text) as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
        const rendered = String(value);
        for (const word of words) {
          if (rendered.includes(word)) hits.push(`${rel} ${key}: ${word}`);
        }
      }
      continue;
    }
    text.split("\n").forEach((line, index) => {
      for (const word of words) {
        if (line.includes(word)) hits.push(`${rel}:${index + 1}: ${word}`);
      }
    });
  }
  return hits;
}

test("rendered and i18n copy omit forbidden landlord, payment, and demo words", () => {
  assert.deepEqual(hitsFor(FORBIDDEN), []);
});

test("retired sandbox and payment phrases stay out of rendered copy", () => {
  assert.deepEqual(hitsFor(PHRASES), []);
});

test("sandbox chrome uses the sample company, the amber banner, and a native switcher", () => {
  const zh = JSON.parse(read(join(root, "src/i18n/zh-TW.json"))) as Record<string, string>;
  assert.equal(zh.i_sandbox_banner, "範例環境：資料僅供練習，不會出現在正式公司");
  assert.equal(zh.i_sandbox_back, "回到正式公司");
  assert.equal(zh.i_sandbox_suffix, "（範例）");
  assert.equal(zh.i_sandbox_company, "範例公司");
  assert.equal(zh.i_report_hint.startsWith("收入是已確認的繳款"), true);
  const chrome = read(join(root, "src/components/chrome.tsx"));
  assert.doesNotMatch(chrome, /demo-badge|i_demo_only|示範/);
  assert.match(chrome, /<details className="org-switch">/);
  assert.match(chrome, /<summary className="org-toggle" data-testid="org-switch">/);
  assert.match(chrome, /data-testid="org-pick-sandbox"/);
  assert.match(chrome, /sandbox \? t\("i_sandbox_company"\) : firm/);
  assert.doesNotMatch(chrome, /i_sandbox_suffix/);
  assert.doesNotMatch(chrome, /EnvSwitch|env-switch|useState/);
  const layout = read(join(root, "src/app/layout.tsx"));
  assert.doesNotMatch(layout, /EnvSwitch|env-switch/);
  const banner = read(join(root, "src/components/env-mode.tsx"));
  assert.match(banner, /i_sandbox_banner/);
  assert.match(banner, /i_sandbox_back/);
  assert.doesNotMatch(banner, /function EnvSwitch|env-switch/);
});

test("login, an empty live company, the sidebar, and audit use the live-company wording", () => {
  const zh = JSON.parse(read(join(root, "src/i18n/zh-TW.json"))) as Record<string, string>;
  assert.equal(zh.i_dash_first, "新增第一個物件");
  assert.equal(zh.i_dash_sample, "先看看範例公司");
  assert.equal(zh.i_login_invite_lead, "還沒有帳號？");
  assert.equal(zh.i_login_signup, "免費註冊");
  assert.equal(zh.i_login_invite_tail, undefined);
  assert.equal(zh.i_login_invite, "還沒有帳號？免費註冊");
  assert.equal(`${zh.i_login_invite_lead}${zh.i_login_signup}`, "還沒有帳號？免費註冊");
  const en = JSON.parse(read(join(root, "src/i18n/en.json"))) as Record<string, string>;
  assert.equal(en.i_login_invite_tail, undefined);
  assert.equal(en.i_login_invite, "No account yet? Sign up free");
  assert.equal(zh.i_nav_inbox, "待確認繳款");
  assert.equal(zh.i_audit_ev_line_sign_in, "租客登入");
  assert.equal(zh.i_audit_rec_line, "邀請連結");
  assert.equal(zh.i_sandbox_suffix, "（範例）");
  assert.equal(zh.i_settings_plan, "方案：免費方案依官網公告・設計夥伴合作期間免費");
  assert.equal(zh.i_outstanding, "未繳清租客");
  assert.equal(zh.i_receipt, "收據（範例檔名）");
  assert.equal(zh.i_pick_room_type, "請選擇房型");
  const dash = read(join(root, "src/components/dashboard-content.tsx"));
  assert.match(dash, /i_outstanding/);
  assert.doesNotMatch(dash, /未收款/);
  const statements = read(join(root, "src/app/m/statements/page.tsx"));
  assert.match(statements, /i_receipt/);
  assert.doesNotMatch(statements, /示範檔名/);
  assert.match(dash, /!setup\.hasUnits/);
  assert.match(dash, /<EmptyState id="DASH"/);
  assert.doesNotMatch(dash, /i_dash_step[123]|i_empty/);
  const emptyActions = read(join(root, "src/lib/empty-cta.ts"));
  assert.match(emptyActions, /es_DASH_sample/);
  assert.match(emptyActions, /\/api\/env\?set=sandbox&next=\/m/);
  const settings = read(join(root, "src/app/m/settings/page.tsx"));
  assert.match(settings, /data-testid="settings-plan"/);
  assert.match(settings, /i_settings_plan/);
  assert.doesNotMatch(settings, /i_price_upgrade/);
  const login = read(join(root, "src/app/login/page.tsx"));
  assert.match(login, /href="\/signup" data-testid="login-signup"/);
  assert.doesNotMatch(login, /先在測試模式試用全部功能/);
  const banner = read(join(root, "src/components/env-mode.tsx"));
  assert.doesNotMatch(banner, /🧪|測試模式|示範/);
  assert.doesNotMatch(banner, /GoLiveForm|actionGoLive|i_golive_|開始正式使用/);
  assert.match(banner, /i_sandbox_banner/);
  assert.equal("i_golive_start" in zh, false);
  assert.equal("i_admin_pause" in zh, false);
  assert.equal(zh.i_audit_ev_go_live, "開始正式使用");
  const audit = read(join(root, "src/app/m/audit/page.tsx"));
  assert.match(audit, /event !== "go_live"/);
  assert.doesNotMatch(audit, /line_sign_in|line_account_links/);
  const signIn = read(join(root, "src/server/auth-actions.ts"));
  assert.match(signIn, /clearStoredEnvChoice\(jar\)/);
  const surfaces = [
    "src/app/m/account/page.tsx",
    "src/app/m/settings/page.tsx",
    "src/app/m/audit/page.tsx",
    "src/components/audit-log.tsx",
    "src/components/env-mode.tsx",
    "src/components/chrome.tsx",
  ];
  const renderedKeys = [
    "i_footer",
    "i_login_footer",
    "i_price_footer",
    "i_nav_inbox",
    "i_audit_ev_line_sign_in",
    "i_audit_rec_line",
    "i_dash_first",
    "i_dash_sample",
    "i_login_invite",
    "i_login_invite_lead",
    "i_login_signup",
    "i_sandbox_banner",
    "i_sandbox_suffix",
    "i_sandbox_plan",
    "i_rules_note",
  ];
  for (const rel of surfaces) {
    const text = read(join(root, rel)).split("LINE @644odqoe").join("");
    assert.equal(text.includes("LINE"), false, rel);
    assert.equal(text.includes("待確認收款"), false, rel);
    assert.equal(text.includes("🧪 測試模式"), false, rel);
  }
  for (const key of renderedKeys) {
    const stripped = String(zh[key]).split("LINE @644odqoe").join("");
    assert.equal(stripped.includes("LINE"), false, key);
    assert.equal(stripped.includes("待確認收款"), false, key);
    assert.equal(stripped.includes("示範"), false, key);
    assert.equal(stripped.includes("測試模式"), false, key);
  }
});

test("tenant pages drop the LINE demo sentence and never say 示範, 測試模式, or 即將推出", () => {
  const zh = JSON.parse(read(join(root, "src/i18n/zh-TW.json"))) as Record<string, string>;
  const en = JSON.parse(read(join(root, "src/i18n/en.json"))) as Record<string, string>;
  const banned = ["示範", "測試模式", "即將推出", "LINE 登入與推播"];
  const tenantDir = join(root, "src/app/t");
  const files = readdirSync(tenantDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => join(entry.parentPath ?? tenantDir, entry.name));
  assert.ok(files.some((file) => file.endsWith(`${join("t", "layout.tsx")}`)));
  const keys = new Set<string>();
  for (const file of files) {
    const text = read(file);
    for (const word of banned) assert.equal(text.includes(word), false, `${file} ${word}`);
    assert.doesNotMatch(text, /i_line_stub|line-stub|showDemoLineCopy/);
    assert.equal(text.includes("@644odqoe"), false, file);
    assert.equal(text.includes("LINE_SUPPORT_CONTACT"), false, file);
    for (const match of text.matchAll(/from\s+"(@\/[^"]+|\.\.?\/[^"]+)"/g)) {
      const spec = match[1];
      const base = spec.startsWith("@/") ? join(root, "src", spec.slice(2)) : join(dirname(file), spec);
      const imported = [".tsx", ".ts", "/index.tsx", "/index.ts"].map((suffix) => base + suffix).find((path) => existsSync(path));
      if (!imported) continue;
      const source = read(imported);
      assert.equal(source.includes("@644odqoe"), false, imported);
      assert.equal(source.includes("LINE_SUPPORT_CONTACT"), false, imported);
    }
    for (const match of text.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.has("i_rich_pay"));
  assert.ok(keys.has("i_pay_direct"));
  for (const key of keys) {
    for (const catalog of [zh, en]) {
      const value = catalog[key];
      assert.equal(typeof value, "string", key);
      for (const word of banned) assert.equal(value.includes(word), false, `${key} ${word}`);
      assert.equal(value.includes("@644odqoe"), false, key);
    }
  }
  for (const catalog of [zh, en]) {
    assert.equal("i_line_stub" in catalog, false);
    for (const value of Object.values(catalog)) {
      assert.equal(String(value).includes("LINE 登入與推播"), false);
    }
  }
});

test("the build stamps a short git SHA into the staff footer and /api/version", () => {
  const config = read(join(root, "next.config.ts"));
  assert.match(config, /NEXT_PUBLIC_BUILD_SHA/);
  assert.match(config, /git rev-parse --short=7 HEAD/);
  const layout = read(join(root, "src/app/m/layout.tsx"));
  assert.match(layout, /data-testid="build-sha"/);
  assert.match(layout, /BUILD_SHA/);
  const route = read(join(root, "src/app/api/version/route.ts"));
  assert.match(route, /sha: BUILD_SHA/);
});


test("PLT-49-AC4: only the exact single manager navigation area value is exempt", () => {
  const lane = "src/i18n/lanes/brand-v3.ts";
  const allowed = '    money: "收款",';
  assert.equal(withoutManagerAreaName(allowed, lane).includes("收款"), false);
  for (const source of [allowed + "\n" + allowed, '    other: "收款",', '    money: "待收款",', '    money: "收款紀錄",', allowed + ' // 收款', 'const text = "收款";']) {
    assert.equal(withoutManagerAreaName(source, lane).includes("收款"), true, source);
  }
  assert.equal(withoutManagerAreaName(allowed, "src/i18n/zh-TW.json").includes("收款"), true);
  const source = read(join(root, lane));
  assert.equal([...source.matchAll(/收款/g)].length, 1);
  assert.equal(withoutManagerAreaName(source, lane).includes("收款"), false);
  assert.deepEqual(hitsFor(FORBIDDEN), []);
});

test("PR-019: only exact approved early-rent names in the report lane are exempt", () => {
  const lane = "src/i18n/lanes/brand-v3-report.ts";
  for (const allowed of ['    earlyRent: "預收租金",', '    earlyRentHeading: "另外列：預收租金",']) {
    assert.equal(withoutApprovedReportRentNames(allowed, lane).includes("收租"), false);
    for (const source of [allowed + "\n" + allowed, allowed + " // 收租", allowed.replace("預收租金", "預收租金紀錄"),
      allowed.replace("earlyRent", "other"), 'const text = "收租";', allowed + '\n    other: "收租",']) {
      assert.equal(withoutApprovedReportRentNames(source, lane).includes("收租"), true, source);
    }
    assert.equal(withoutApprovedReportRentNames(allowed, "src/i18n/lanes/brand-v3.ts").includes("收租"), true);
  }
  assert.deepEqual(hitsFor(FORBIDDEN), []);
});

test("PR-016: the owner/vendor own-status lane holds exactly the approved 「收款」 strings, each once, and nothing else with 收款", () => {
  const source = read(join(root, OWN_STATUS_LANE));
  for (const exact of OWN_STATUS_EXACT) assert.equal(source.split(`"${exact}"`).length - 1, 1, exact);
  const stripped = withoutOwnStatus(decode(source), OWN_STATUS_LANE).replace(/^\s*\/\/.*$/gm, "");
  assert.equal(stripped.includes("收款"), false, "only the exact approved literals may contain 收款");
  // The exemption is file-scoped: the same literal elsewhere is still a hit.
  assert.equal(withoutOwnStatus('"代屋主確認收款"', "src/i18n/lanes/brand-v3.ts").includes("收款"), true);
});


test("GS-32 exemption covers exactly one approved line in the vendor-docs lane", () => {
  const lane = read(join(root, VENDOR_DOCS_LANE));
  assert.equal(withoutVendorDocsIssue(lane, VENDOR_DOCS_LANE).includes("收款"), false);
  assert.equal(withoutVendorDocsIssue('    issue: "確認已全額收款並開立", close: "關閉",', "src/i18n/lanes/brand-v3.ts").includes("收款"), true);
  assert.equal(withoutVendorDocsIssue('    other: "確認已全額收款並開立",', VENDOR_DOCS_LANE).includes("收款"), true);
});

test("terminology: Condola / 租多啦 is never the subject of 收款, 收租 or 代收 — in any source file, allowlisted lanes included", () => {
  const subject = /(Condola|租多啦)[^"'`\n]{0,40}(收款|收租|代收)/;
  const hits = sourceFiles().filter(file => subject.test(decode(read(file)))).map(file => relative(root, file));
  assert.deepEqual(hits, []);
  // The rule catches the phrasing it exists for.
  for (const bad of ["租多啦幫你收款", "Condola 代收租金", "由 Condola 收租"]) assert.match(bad, subject);
  for (const ok of ["租多啦・廠商", "收款帳戶是屋主的"]) assert.doesNotMatch(ok, subject);
});
