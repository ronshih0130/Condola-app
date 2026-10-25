import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bannedCopyHits } from "./copy-check";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".open-next", ".git", "coverage", "playwright-report", "test-results", ".wrangler", "out", "dist"]);

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...files(path));
      continue;
    }
    if (path.startsWith(join(root, "src", "assets", "leases") + sep)) continue;
    if (/\.test\.tsx?$|\.spec\.tsx?$/.test(entry.name)) continue;
    if (/\.(ts|tsx|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("zh-TW UI copy omits banned payment and landlord words", () => {
  const hits: string[] = [];
  for (const file of files(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    const rel = relative(root, file);
    if (file.endsWith(".json")) {
      const data = JSON.parse(text) as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
        const found = bannedCopyHits(String(value));
        if (found.length) hits.push(`${rel} ${key}: ${found.join(",")}`);
      }
      continue;
    }
    text.split("\n").forEach((line, index) => {
      const found = bannedCopyHits(line);
      if (found.length) hits.push(`${rel}:${index + 1}: ${found.join(",")}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("the allowlist keeps permitted phrases and still flags the banned words around them", () => {
  assert.deepEqual(bannedCopyHits("已收到管理方邀請"), []);
  assert.deepEqual(bannedCopyHits("自動計入帳單"), []);
  assert.deepEqual(bannedCopyHits("一起成為完美房東"), []);
  assert.deepEqual(bannedCopyHits("不開立統一發票"), []);
  assert.deepEqual(bannedCopyHits("登入帳號"), []);
  assert.deepEqual(bannedCopyHits("匯入帳戶末五碼"), []);
  assert.deepEqual(bannedCopyHits("加入帳單"), []);
  assert.deepEqual(bannedCopyHits("已收到以後仍寫房東"), ["房東"]);
  assert.deepEqual(bannedCopyHits("租客已驗證"), ["已驗證"]);
  assert.deepEqual(bannedCopyHits("本公司代收"), ["代收", "本公司"]);
});
