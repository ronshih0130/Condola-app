import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyAllowlist,
  findHits,
  formatHit,
  readTerms,
  scanSources,
  sourceFiles,
  stripComments,
  TERMS_PATH,
} from "./check-banned-terms.mjs";

const checker = fileURLToPath(new URL("./check-banned-terms.mjs", import.meta.url));

function terms() {
  return readTerms(TERMS_PATH);
}

function words(text, options) {
  return findHits(text, terms(), "fixture", options).map((hit) => hit.term);
}

test("the Product Marketing file is the list the checker loads", () => {
  const loaded = terms();
  assert.deepEqual(loaded.banned, ["入帳", "收租", "收款", "欠租", "已收", "代收", "示範", "測試模式", "沙盒", "房東"]);
  assert.deepEqual(loaded.allow, ["一起成為完美房東", "自動計入帳單", "加入帳單", "匯入帳戶末五碼", "登入帳號", "款項到帳"]);
  assert.equal(loaded.allow.includes("款項入帳"), false);
  assert.equal(TERMS_PATH.endsWith("config/banned_terms.md"), true);
  assert.deepEqual(words("款項入帳"), ["入帳"]);
  assert.deepEqual(words("款項到帳"), []);
});

test("allowlisted phrases are removed before banned terms are searched", () => {
  const list = terms();
  assert.equal(words("自動計入帳單").length, 0);
  assert.equal(words("請加入帳單").length, 0);
  assert.equal(words("匯入帳戶末五碼 88921").length, 0);
  assert.equal(words("登入帳號").length, 0);
  assert.equal(words("確認款項到帳後開通").length, 0);
  assert.equal(words("一起成為完美房東").length, 0);
  assert.equal(words("標語：一起成為完美房東。").length, 0);
  assert.deepEqual(applyAllowlist("自動計入帳單", list.allow).includes("入帳"), false);
});

test("a banned term still fails when it only sits inside a look-alike that is not allowlisted", () => {
  assert.deepEqual(words("已收到"), ["已收"]);
  assert.deepEqual(words("匯入帳戶"), ["入帳"]);
  assert.deepEqual(words("計入帳單"), ["入帳"]);
  assert.deepEqual(words("不代收或保管租金"), ["代收"]);
  assert.deepEqual(words("積欠租賃"), ["欠租"]);
  assert.deepEqual(words("完美房東"), ["房東"]);
  assert.deepEqual(words("二房東"), ["房東"]);
  for (const term of ["入帳", "收租", "收款", "欠租", "已收", "代收", "示範", "測試模式", "沙盒", "房東"]) {
    assert.deepEqual(words(`字${term}字`), [term], term);
  }
});

test("房東 is allowed only inside the exact slogan", () => {
  assert.deepEqual(words("一起成為完美房東和別的房東"), ["房東"]);
  assert.deepEqual(words("「一起成為完美房東」"), []);
  assert.deepEqual(words("一起成為完美房東一起成為完美房東"), []);
});

test("hits keep file and line, including escapes and html outside scripts", () => {
  const list = terms();
  const hits = findHits("ok\n已收到您的簽署\n", list, "src/i18n/zh-TW.json");
  assert.deepEqual(hits.map(formatHit), ["src/i18n/zh-TW.json:2: 已收"]);
  assert.deepEqual(words("\\u5df2\\u6536"), ["已收"]);
  assert.deepEqual(words("&#20195;&#25910;", { html: true }), ["代收"]);
  const html = "<p>登入帳號</p>\n<script>var x = '沙盒'</script>\n<p>示範</p>";
  assert.deepEqual(findHits(html, list, "/login", { html: true }).map(formatHit), ["/login:3: 示範"]);
});

test("comments are ignored and template strings are not", () => {
  const source = "const note = `收款`;\n// 房東\n/* 沙盒 */\nexport const label = \"測試模式\";\n";
  assert.equal(stripComments(source).includes("房東"), false);
  assert.deepEqual(
    findHits(source, terms(), "src/server/mail-copy.ts", { code: true }).map((hit) => hit.term),
    ["收款", "測試模式"],
  );
});

test("the cli fails a rendered page and passes an allowlisted one", () => {
  const dir = mkdtempSync(join(tmpdir(), "banned-"));
  const bad = join(dir, "bad.html");
  const good = join(dir, "good.html");
  writeFileSync(bad, "<p>這是收款</p>\n");
  writeFileSync(good, "<p>一起成為完美房東</p><p>登入帳號</p>\n");
  assert.throws(() => execFileSync(process.execPath, [checker, "--label", "/bad", "--html", bad], { encoding: "utf8" }));
  let stdout = "";
  try {
    execFileSync(process.execPath, [checker, "--label", "/bad", "--html", bad], { encoding: "utf8" });
  } catch (error) {
    stdout = error.stdout;
    assert.equal(error.status, 1);
  }
  assert.match(stdout, /\/bad:1: 收款/);
  const clean = execFileSync(process.execPath, [checker, "--html", good, "--label", "/"], { encoding: "utf8" });
  assert.equal(clean, "");
});

test("user-facing sources are the i18n catalogs, jsx, and mail or LINE templates", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = sourceFiles(root).map((file) => relative(root, file).split(sep).join("/"));
  assert.equal(files.includes("src/i18n/zh-TW.json"), true);
  assert.equal(files.includes("src/i18n/en.json"), true);
  assert.equal(files.includes("src/server/mail-copy.ts"), true);
  assert.equal(files.includes("src/line-copy.ts"), true);
  assert.equal(files.some((file) => file.includes(".test.")), false);
  assert.equal(files.some((file) => file.startsWith("src/assets/")), false);
  const hits = scanSources(root, terms());
  for (const hit of hits) {
    assert.match(hit.file, /^(src\/i18n\/.+\.json|src\/app\/.+\.tsx|src\/components\/.+\.tsx|src\/server\/mail-copy\.ts|src\/line-copy\.ts)$/);
  }
});
