import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandImage } from "../components/brand";
import {
  brandV2Enabled,
  brandV2Metadata,
  BRAND_V2_ASSETS,
  BRAND_V2_THEME_COLOR,
  LEGACY_THEME_COLOR,
} from "./brand-v2";

const root = process.cwd();
const publicRoot = join(root, "public");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("only the exact true flag enables v2", () => {
  assert.equal(brandV2Enabled({}), false);
  for (const BRAND_V2 of ["false", "", "TRUE", "1"]) {
    assert.equal(brandV2Enabled({ BRAND_V2 }), false);
  }
  assert.equal(brandV2Enabled({ BRAND_V2: "true" }), true);
  const previous = process.env.BRAND_V2;
  try {
    process.env.BRAND_V2 = "true";
    assert.equal(brandV2Enabled(), true);
    process.env.BRAND_V2 = "false";
    assert.equal(brandV2Enabled(), false);
  } finally {
    if (previous === undefined) delete process.env.BRAND_V2;
    else process.env.BRAND_V2 = previous;
  }
  assert.equal(BRAND_V2_THEME_COLOR, "#14325C");
  assert.equal(LEGACY_THEME_COLOR, "#2E2622");
});

test("metadata selects v2 icons and locale OG without overriding the file manifest", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    assert.deepEqual(brandV2Metadata(locale, {}), {
      metadataBase: new URL("https://app.condola.app"),
      icons: {
        icon: [
          { url: "/brand/v2/favicon/favicon.svg", type: "image/svg+xml" },
          { url: "/brand/v2/favicon/favicon.ico" },
        ],
        apple: [{ url: "/brand/v2/favicon/apple-touch-icon.png" }],
      },
      openGraph: {
        images: [{
          url: `/brand/v2/og/og-${locale === "zh-TW" ? "zh" : "en"}-1200x630.png`,
          width: 1200,
          height: 630,
        }],
      },
    });
  }
});

test("metadataBase accepts HTTPS origins and local HTTP origins", () => {
  for (const origin of [
    "https://app.condola.app",
    "https://staging.condola.app",
    "https://staging.condola.app/",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]) {
    const metadata = brandV2Metadata("en", { CONDOLA_SITE_URL: origin });
    assert.equal(metadata.metadataBase?.href, new URL(origin).href, origin);
  }
});

test("metadataBase falls back for missing or invalid origins", () => {
  for (const value of [
    undefined,
    "",
    "not a URL",
    "/relative",
    "http://app.condola.app",
    "http://localhost.example.com",
    "ftp://localhost",
    "https://user:password@staging.condola.app",
    "https://staging.condola.app/path",
    "https://staging.condola.app?query=1",
    "https://staging.condola.app#fragment",
  ]) {
    const metadata = brandV2Metadata("en", { CONDOLA_SITE_URL: value });
    assert.equal(metadata.metadataBase?.href, "https://app.condola.app/", String(value));
  }
});

test("every declared public asset exists", () => {
  assert.equal(new Set(BRAND_V2_ASSETS).size, BRAND_V2_ASSETS.length);
  for (const asset of BRAND_V2_ASSETS) {
    assert.ok(asset.startsWith("/brand/v2/"), asset);
    assert.ok(statSync(join(publicRoot, asset.slice(1))).isFile(), asset);
  }
});

test("manifest theme and relative icons are valid", () => {
  const manifestPath = join(publicRoot, "brand/v2/favicon/site.webmanifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    theme_color: string;
    icons: { src: string }[];
  };
  assert.equal(manifest.theme_color, "#14325C");
  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.doesNotMatch(icon.src, /^(?:\/|[a-z]+:)/i);
    const iconPath = resolve(dirname(manifestPath), icon.src);
    assert.equal(dirname(iconPath), dirname(manifestPath));
    assert.ok(statSync(iconPath).isFile(), icon.src);
    assert.ok(BRAND_V2_ASSETS.some((asset) => join(publicRoot, asset.slice(1)) === iconPath));
  }
});

const mappings = {
  "--cd-primary": "#14325C",
  "--cd-primary-hover": "#0F2748",
  "--cd-primary-soft": "#E3EAF3",
  "--cd-accent": "#2F6BFF",
  "--cd-accent-soft": "#E8EFFF",
  "--cd-ink": "#1B2533",
  "--cd-ink2": "#4A5668",
  "--cd-ink3": "#687384",
  "--cd-surface": "#FFFFFF",
  "--cd-surface2": "#EEF2F6",
  "--cd-border": "#DDE3EA",
  "--cd-success": "#2A7254",
  "--cd-success-bg": "#E3F1EA",
  "--cd-warning": "#935C0F",
  "--cd-warning-bg": "#F8EEDB",
  "--cd-danger": "#B0413E",
  "--cd-danger-bg": "#F7E4E3",
  "--cd-info": "#23748A",
  "--cd-info-bg": "#E2F1F4",
};

test("theme is scoped, has exact approved mappings and excludes deferred properties", () => {
  const css = read("public/brand/v2/theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /@font-face|@import|url\(\s*["']?https?:/i);
  assert.doesNotMatch(css, /@/);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 0);
  assert.equal(css.replace(/[^{}]+\{[^{}]*\}/g, "").trim(), "");
  const declarations = new Map<string, string>();
  for (const [, selectors, body] of rules) {
    for (const selector of selectors.split(",")) {
      assert.ok(selector.trim().startsWith('html[data-brand="v2"]'), selector);
    }
    for (const declaration of body.split(";").filter((part) => part.trim())) {
      const colon = declaration.indexOf(":");
      assert.ok(colon > 0, declaration);
      const name = declaration.slice(0, colon).trim();
      assert.ok(name.startsWith("--"), name);
      assert.ok(!declarations.has(name), `duplicate ${name}`);
      declarations.set(name, declaration.slice(colon + 1).trim());
    }
  }
  for (const [name, value] of Object.entries(mappings)) {
    assert.equal(declarations.get(name), value, name);
  }
  const existingTokens = read("src/app/tokens.css");
  for (const [size, value] of [["sm", "6px"], ["md", "10px"], ["lg", "14px"]]) {
    const name = `--cd-radius-${size}`;
    assert.equal(
      declarations.get(name),
      new RegExp(`${name}\\s*:`).test(existingTokens) ? value : undefined,
      name,
    );
  }
  for (const name of declarations.keys()) {
    assert.doesNotMatch(name, /^--cd-(?:topbar(?:-|$)|focus(?:-|$)|primary-pressed$|cream$|border-strong$)/);
    if (name.startsWith("--cd-")) {
      assert.ok(name in mappings || /^--cd-radius-(sm|md|lg)$/.test(name), name);
    }
  }
});

test("BrandImage preserves defaults and selects both v2 header variants", () => {
  for (const variant of ["horizontalDark", "symbolSmall"] as const) {
    const props = { variant, alt: "" };
    const original = renderToStaticMarkup(React.createElement(BrandImage, props));
    const explicitOff = renderToStaticMarkup(React.createElement(BrandImage, { ...props, v2: false }));
    const enabled = renderToStaticMarkup(React.createElement(BrandImage, { ...props, v2: true }));
    assert.equal(original, explicitOff);
    assert.doesNotMatch(original, /\/brand\/v2\//);
    assert.ok(original.includes(
      variant === "horizontalDark"
        ? "/brand/condola_lockup_horizontal_dark.svg"
        : "/brand/condola_symbol_small.svg",
    ));
    assert.ok(enabled.includes(
      variant === "horizontalDark"
        ? "/brand/v2/logo/lockup_en_dark.svg"
        : "/brand/v2/logo/symbol_dark.svg",
    ));
    assert.doesNotMatch(enabled, /\/brand\/condola_/);
    const images = [...enabled.matchAll(/<img\b[^>]*>/g)];
    assert.equal(images.length, 1);
    assert.match(images[0][0], /alt=""/);
    assert.match(images[0][0], /height="24"/);
  }

  const chrome = read("src/components/chrome.tsx");
  assert.ok(chrome.includes('export function BrandLink({ v2 }: { v2?: boolean } = {})'));
  for (const [variant, className] of [
    ["horizontalDark", "brand-lockup"],
    ["symbolSmall", "brand-symbol"],
  ]) {
    assert.ok(chrome.includes(
      `<BrandImage variant="${variant}" alt="" className="${className}" {...(v2 ? { v2: true } : {})} />`,
    ), `BrandLink forwards v2 to ${variant}`);
  }
});

test("new text files and supplied SVGs contain no banned terms", () => {
  const banned = [
    "\u6536\u79df", "\u6536\u6b3e", "\u6b20\u79df", "\u5df2\u6536",
    "\u5165\u5e33", "\u623f\u6771", "\u4ee3\u6536", "\u8f49\u4ed8",
    "\u7d71\u4e00\u7de8\u865f", "\u542b\u7a05", "\u672c\u516c\u53f8", "\u4e8b\u52d9\u6240",
  ];
  const files = [
    "src/server/brand-v2.ts",
    "src/server/brand-v2.test.ts",
    "scripts/brand-v2-ci.sh",
    "public/brand/v2/theme.css",
    "public/brand/v2/favicon/site.webmanifest",
    "public/brand/v2/favicon/favicon.svg",
    "public/brand/v2/logo/lockup_en_dark.svg",
    "public/brand/v2/logo/symbol_dark.svg",
  ];
  for (const file of files) {
    const text = read(file);
    for (const term of banned) assert.ok(!text.includes(term), `${file}: forbidden term`);
  }
});
