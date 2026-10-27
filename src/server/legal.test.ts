import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { legalTitle, renderLegalMarkdown } from "./legal";

const root = new URL("../../", import.meta.url);

const SHA256 = {
  terms: "6e3e21efe05686751b88bd36ce21c46c50c0a939562d706c95e36bb458d0c7d9",
  privacy: "aa9e46305c843f34582fb169c1190743cf2309048338f77d90de631b570f4cf6",
  refund: "14ae40e0b97d2e74b07dfe973176be4823af987f233cbe1a520f337d7aa1253d",
} as const;

function read(path: string) {
  return readFileSync(new URL(path, root));
}

function sha256(path: string) {
  return createHash("sha256").update(read(path)).digest("hex");
}

function stripMarkers(value: string) {
  return value.replace(/\*\*([^*]+)\*\*/g, "$1");
}

function pieces(markdown: string) {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("|")) {
      const cells = trimmed
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      for (const cell of cells) out.push(stripMarkers(cell));
      continue;
    }
    out.push(stripMarkers(trimmed.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "")));
  }
  return out;
}

function textOf(html: string) {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

test("committed legal markdown matches the v1 files", () => {
  for (const name of ["terms", "privacy", "refund"] as const) {
    assert.equal(sha256(`content/legal/${name}.md`), SHA256[name], name);
  }
});

test("legal pages render the markdown verbatim in zh-TW", () => {
  for (const name of ["terms", "privacy", "refund"] as const) {
    const markdown = read(`content/legal/${name}.md`).toString("utf8");
    const html = renderLegalMarkdown(markdown);
    assert.match(html, /<h1>/);
    assert.equal(html.includes("<script"), false);
    const text = textOf(html);
    assert.equal(text.includes(legalTitle(markdown)), true, name);
    for (const piece of pieces(markdown)) {
      assert.equal(text.includes(piece), true, `${name}: ${piece.slice(0, 40)}`);
    }
  }
  const privacy = renderLegalMarkdown(read("content/legal/privacy.md").toString("utf8"));
  assert.match(privacy, /<table>/);
  assert.match(privacy, /<strong>/);
  const document = read("src/components/legal-document.tsx").toString("utf8");
  assert.match(document, /lang="zh-Hant-TW"/);
  assert.match(document, /data-testid="legal-doc"/);
});

test("legal markdown escapes raw html", () => {
  const html = renderLegalMarkdown("Hello <script>alert(1)</script>");
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
});

test("the site footer links to the three legal pages", () => {
  const layout = read("src/app/layout.tsx").toString("utf8");
  assert.match(layout, /data-testid="site-footer"/);
  assert.match(layout, /href="\/terms"/);
  assert.match(layout, /href="\/privacy"/);
  assert.match(layout, /href="\/refund"/);
  assert.match(layout, /i_legal_terms/);
  assert.match(layout, /i_legal_privacy/);
  assert.match(layout, /i_legal_refund/);
  const zh = JSON.parse(read("src/i18n/zh-TW.json").toString("utf8")) as Record<string, string>;
  const en = JSON.parse(read("src/i18n/en.json").toString("utf8")) as Record<string, string>;
  assert.equal(zh.i_legal_terms, "服務條款");
  assert.equal(zh.i_legal_privacy, "隱私權政策");
  assert.equal(zh.i_legal_refund, "退款說明");
  assert.equal(en.i_legal_terms, "Terms");
  assert.equal(en.i_legal_privacy, "Privacy");
  assert.equal(en.i_legal_refund, "Refunds");
  for (const name of ["terms", "privacy", "refund"] as const) {
    const page = read(`src/app/${name}/page.tsx`).toString("utf8");
    assert.match(page, new RegExp(`content/legal/${name}\\.md`));
  }
});
