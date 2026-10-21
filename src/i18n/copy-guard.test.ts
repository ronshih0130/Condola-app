import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const FORBIDDEN = ["房東", "房客", "收款", "收租", "即將推出", "測試模式", "範例沙盒", "示範"];

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
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.test\.tsx?$|\.spec\.tsx?$/.test(entry.name)) continue;
      if (/\.(ts|tsx|json)$/.test(entry.name)) out.push(path);
    }
  };
  walk(join(root, "src"));
  return out;
}

function hitsFor(words: string[]) {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    const text = decode(read(file));
    const rel = relative(root, file);
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
  assert.match(chrome, /i_sandbox_suffix/);
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
  assert.equal(zh.i_login_invite_tail, "（前 4 戶永遠免費，可先看範例公司）");
  assert.equal(`${zh.i_login_invite_lead}${zh.i_login_signup}${zh.i_login_invite_tail}`, "還沒有帳號？免費註冊（前 4 戶永遠免費，可先看範例公司）");
  assert.equal(zh.i_nav_inbox, "繳款紀錄");
  assert.equal(zh.i_audit_ev_line_sign_in, "租客登入");
  assert.equal(zh.i_audit_rec_line, "邀請連結");
  assert.equal(zh.i_sandbox_suffix, "（範例）");
  assert.equal(zh.i_settings_plan, "方案：前 4 戶永遠免費");
  assert.equal(zh.i_outstanding, "未繳清租客");
  assert.equal(zh.i_receipt, "收據（範例檔名）");
  assert.equal(zh.i_pick_room_type, "請選擇房型");
  const dash = read(join(root, "src/app/m/page.tsx"));
  assert.match(dash, /i_outstanding/);
  assert.doesNotMatch(dash, /未收款/);
  const statements = read(join(root, "src/app/m/statements/page.tsx"));
  assert.match(statements, /i_receipt/);
  assert.doesNotMatch(statements, /示範檔名/);
  assert.match(dash, /session\.environment === "live" && data\.properties\.length === 0/);
  assert.match(dash, /data-testid="dash-first-property"/);
  assert.match(dash, /i_dash_step1/);
  assert.match(dash, /i_dash_step2/);
  assert.match(dash, /i_dash_step3/);
  assert.match(dash, /<p className="small">\s*<a href="\/api\/env\?set=sandbox&next=\/m" data-testid="dash-sample">/);
  assert.doesNotMatch(dash, /className="btn"[^"]*" data-testid="dash-sample"/);
  const settings = read(join(root, "src/app/m/settings/page.tsx"));
  assert.match(settings, /data-testid="settings-plan"/);
  assert.match(settings, /i_settings_plan/);
  assert.doesNotMatch(settings, /i_price_upgrade/);
  const login = read(join(root, "src/app/login/page.tsx"));
  assert.match(login, /href="\/signup" data-testid="login-signup"/);
  assert.doesNotMatch(login, /先在測試模式試用全部功能/);
  const banner = read(join(root, "src/components/env-mode.tsx"));
  assert.doesNotMatch(banner, /🧪|測試模式|示範/);
  assert.match(banner, /i_sandbox_banner/);
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
    "i_login_invite_tail",
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
