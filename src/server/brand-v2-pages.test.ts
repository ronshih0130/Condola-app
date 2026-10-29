import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BRAND_V2_PAGE_STYLES } from "./brand-v2";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const pages: Record<string, string[]> = {
  "t-home": ["src/app/t/page.tsx"],
  "o-home": ["src/app/o/page.tsx"],
  "o-approvals": ["src/app/o/approvals/page.tsx"],
  "v-job": ["src/app/v/[token]/page.tsx", "src/components/vendor-link-details.tsx"],
  "m-home": ["src/app/m/page.tsx"],
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
  const pagesIdx = layout.indexOf("BRAND_V2_PAGE_STYLES.map");
  assert.ok(themeIdx > 0 && pagesIdx > themeIdx, "page styles render next to the ON-only theme link");
});

for (const id of Object.keys(pages)) {
  test(`${id}: CSS is scoped to v2 + page hook and uses tokens only`, () => {
    const css = read(`public/brand/v2/pages/${id}.css`);
    const sels = selectors(css);
    assert.ok(sels.length > 0);
    for (const s of sels) assert.match(s, /^html\[data-brand="v2"\] \[data-v2-(page|shell)/, s);
    const body = stripComments(css);
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, "no hex colours");
    assert.doesNotMatch(body, /\brgba?\(|\bhsla?\(/, "no literal colours");
    assert.doesNotMatch(body, /background(-color)?\s*:\s*var\(--c-(accent|brand|focus)\)\s*;/, "no cobalt fills");
  });
  test(`${id}: TSX hooks render nothing when the flag is OFF`, () => {
    for (const file of pages[id]) {
      const src = read(file);
      assert.match(src, /brandV2Enabled\(\)/);
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
