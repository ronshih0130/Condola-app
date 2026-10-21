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
