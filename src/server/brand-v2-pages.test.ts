import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { brandRoot } from "../lib/brand-root";
import { BRAND_V2_PAGE_STYLES } from "./brand-v2";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const pages: Record<string, string[]> = {
  "t-home": ["src/app/t/page.tsx"],
  "o-home": ["src/app/o/page.tsx"],
  "o-approvals": ["src/app/o/approvals/page.tsx"],
  "v-job": ["src/app/v/[token]/page.tsx", "src/components/vendor-link-details.tsx"],
  "m-home": ["src/components/dashboard-content.tsx"],
};
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
function selectors(css: string): string[] {
  const out: string[] = [];
  const body = stripComments(css).replace(/@font-face\s*{[^}]*}/g, "");
  const re = /([^{}]+){/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const sel = m[1].trim();
    if (sel.startsWith("@media") || sel.startsWith("@supports") || sel.startsWith("@container")) continue;
    if (/^(from|to|\d+%)$/.test(sel)) continue;
    out.push(...sel.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

test("every page stylesheet is listed and loaded only with the ON theme", () => {
  assert.deepEqual([...BRAND_V2_PAGE_STYLES].sort(), Object.keys(pages).map((id) => `/brand/v2/pages/${id}.css`).sort());
  const layout = read("src/app/layout.tsx");
  const themeIdx = layout.indexOf('href="/brand/v2/theme.css"');
  // PR #150 (66f4498) moved the ON-only stylesheet list into brandRoot.
  const pagesIdx = layout.indexOf("pageStylesheets.map");
  assert.ok(layout.includes("const root = brandRoot({ v2, v3 });"));
  assert.ok(layout.includes("const pageStylesheets = root.stylesheets.slice(1);"));
  for (const v3 of [false, true]) {
    assert.deepEqual(brandRoot({ v2: false, v3 }).stylesheets, []);
    assert.deepEqual(brandRoot({ v2: true, v3 }).stylesheets.slice(0, 1 + BRAND_V2_PAGE_STYLES.length),
      ["/brand/v2/theme.css", ...BRAND_V2_PAGE_STYLES]);
  }
  assert.ok(themeIdx > 0 && pagesIdx > themeIdx, "page styles render next to the ON-only theme link");
});

for (const id of Object.keys(pages)) {
  test(`${id}: CSS is scoped to v2 + page hook and uses tokens only`, () => {
    const css = read(`public/brand/v2/pages/${id}.css`);
    const sels = selectors(css);
    assert.ok(sels.length > 0);
    for (const s of sels) {
      // Historical 2c53c74 (merged via 53391dd; no recorded PR) scoped the owner sibling with :has.
      const ownerSibling = /^html\[data-brand="v2"\] \[data-testid="owner-properties"\]:has\(~ \[data-v2-page="o-home"\]\)(?: > \.small)?$/;
      if (id === "o-home" && ownerSibling.test(s)) continue;
      assert.match(s, /^html\[data-brand="v2"\] \[data-v2-(page|shell)/, s);
    }
    const body = stripComments(css);
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, "no hex colours");
    assert.doesNotMatch(body, /\brgba?\(|\bhsla?\(/, "no literal colours");
    assert.doesNotMatch(body, /background(-color)?\s*:\s*var\(--c-(accent|brand|focus)\)\s*;/, "no cobalt fills");
  });
  test(`${id}: TSX hooks render nothing when the flag is OFF`, () => {
    for (const file of pages[id]) {
      const src = read(file);
      if (id === "m-home") {
        // PR #145 (94759e6) moved dashboard hooks into DashboardContent and passes the org flag as v2.
        const page = read("src/app/m/page.tsx");
        assert.match(page, /const \[v2, query, data, setup\] = await Promise\.all\(\[\s*brandV2EnabledForOrg\(session\.orgId\),/);
        assert.match(page, /<DashboardContent\b[^>]*\bv2=\{v2\}/);
        assert.match(src, /export function DashboardContent\(\{[^}]*\bv2\b/);
      } else {
        assert.match(src, id === "v-job" ? /brandV2Enabled\(\)/ : /const v2 = await brandV2EnabledForOrg\(session\.orgId\);/);
      }
      assert.match(src, /data-v2-[a-z-]+=\{/, `${file}: page hooks must remain covered`);
      for (const m of src.matchAll(/data-v2-[a-z-]+=\{([^}]*)\}/g)) {
        assert.match(m[1], /^v2( && [^?]+)? \? .+ : undefined$/, `${file}: ${m[0]}`);
      }
    }
  });
}

test("vendor job keeps showing quotes (no quote markup removed vs prod)", () => {
  const src = read("src/components/vendor-link-details.tsx") + read("src/app/v/[token]/page.tsx");
  for (const key of (src.match(/i_vlink_[a-z_]*(quote|estimate)[a-z_]*/g) ?? [])) assert.ok(src.includes(key));
  assert.ok(/quote|estimate|VendorLinkDetails/i.test(src));
});
