import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { Metadata } from "next";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthBrand, BrandImage } from "../components/brand";
import {
  brandV2Enabled,
  brandMetadata,
  brandV2Metadata,
  BRAND_V2_ASSETS,
  BRAND_V2_THEME_COLOR,
  LEGACY_THEME_COLOR,
} from "./brand-v2";

const root = process.cwd();
const publicRoot = join(root, "public");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const baseFile = (path: string) =>
  execFileSync("git", ["show", `5d8b002:${path}`], { cwd: root });
const requireFromRoot = createRequire(join(root, "package.json"));
const { BasicMeta } = requireFromRoot("next/dist/lib/metadata/generate/basic.js") as {
  BasicMeta: React.ComponentType<{ metadata: Partial<Metadata> }>;
};
const { IconsMetadata } = requireFromRoot("next/dist/lib/metadata/generate/icons.js") as {
  IconsMetadata: React.ComponentType<{ icons: Metadata["icons"] }>;
};

function metadataLinks(metadata: Partial<Metadata>) {
  const html = renderToStaticMarkup(React.createElement(
    React.Fragment,
    null,
    React.createElement(BasicMeta, { metadata: { title: null, ...metadata } }),
    React.createElement(IconsMetadata, { icons: metadata.icons }),
  ));
  return [...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => tag).join("");
}

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

test("OFF metadata preserves all four legacy links and their serialized order", () => {
  const previous = process.env.VERCEL_ENV;
  try {
    delete process.env.VERCEL_ENV;
    for (const env of [{}, { BRAND_V2: "false" }]) {
      for (const locale of ["zh-TW", "en"] as const) {
        const metadata = brandMetadata(locale, env);
        assert.deepEqual(metadata, {
          manifest: "/manifest.webmanifest",
          icons: {
            icon: [
              { url: "/favicon.ico", type: "image/x-icon", sizes: "16x16" },
              { url: "/icon.svg?e3e157dd9f40b850", type: "image/svg+xml", sizes: "any" },
            ],
            apple: [
              { url: "/apple-icon.png?9721f2c0ec0085a3", type: "image/png", sizes: "180x180" },
            ],
          },
        });
        assert.equal(
          metadataLinks(metadata),
          '<link rel="manifest" href="/manifest.webmanifest"/>'
          + '<link rel="icon" href="/favicon.ico" type="image/x-icon" sizes="16x16"/>'
          + '<link rel="icon" href="/icon.svg?e3e157dd9f40b850" type="image/svg+xml" sizes="any"/>'
          + '<link rel="apple-touch-icon" href="/apple-icon.png?9721f2c0ec0085a3" type="image/png" sizes="180x180"/>',
        );
      }
    }
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous;
  }
  const layout = read("src/app/layout.tsx");
  assert.ok(layout.includes('...brandMetadata(prefs.locale)'));
});

test("ON metadata uses only v2 icons and manifest with locale OG", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const metadata = brandMetadata(locale, { BRAND_V2: "true" });
    assert.deepEqual(metadata, {
      metadataBase: new URL("https://app.condola.app"),
      manifest: "/brand/v2/favicon/site.webmanifest",
      icons: {
        icon: [
          { url: "/brand/v2/favicon/favicon.svg", type: "image/svg+xml" },
          { url: "/brand/v2/favicon/favicon.ico?v=20261027", sizes: "16x16 32x32 48x48" },
        ],
        apple: [{ url: "/brand/v2/favicon/apple-touch-icon.png", sizes: "180x180" }],
      },
      openGraph: {
        images: [{
          url: `/brand/v2/og/og-${locale === "zh-TW" ? "zh" : "en"}-1200x630.png`,
          width: 1200,
          height: 630,
        }],
      },
    });
    const links = metadataLinks(metadata);
    assert.equal([...links.matchAll(/<link\b/g)].length, 4);
    assert.doesNotMatch(links, /href="\/(?:favicon\.ico|icon\.svg|apple-icon\.png|manifest\.webmanifest)(?:[?"])/);
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
    assert.equal(
      brandV2Metadata("en", { CONDOLA_SITE_URL: origin }).metadataBase?.href,
      new URL(origin).href,
      origin,
    );
  }
});

test("metadataBase falls back for missing or invalid origins", () => {
  for (const value of [
    undefined, "", "not a URL", "/relative", "http://app.condola.app",
    "http://localhost.example.com", "ftp://localhost",
    "https://user:password@staging.condola.app",
    "https://staging.condola.app/path",
    "https://staging.condola.app?query=1",
    "https://staging.condola.app#fragment",
  ]) {
    assert.equal(
      brandV2Metadata("en", { CONDOLA_SITE_URL: value }).metadataBase?.href,
      "https://app.condola.app/",
      String(value),
    );
  }
});

test("static legacy manifest preserves the expected object and exact JSON bytes", () => {
  const expected = {
    name: "Condola",
    short_name: "Condola",
    start_url: "/",
    display: "standalone",
    background_color: "#F7F1EA",
    theme_color: "#2E2622",
    icons: [
      { src: "/icons/condola_app_icon_192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/condola_app_icon_512.png", sizes: "512x512", type: "image/png" },
    ],
  };
  const body = read("public/manifest.webmanifest");
  assert.deepEqual(JSON.parse(body), expected);
  assert.equal(body, JSON.stringify(expected));
  assert.equal(existsSync(join(root, "src/app/manifest.webmanifest/route.ts")), false);
  assert.equal(existsSync(join(root, "src/server/legacy-manifest.ts")), false);
});

test("legacy binaries are unchanged public assets with no metadata file conventions", () => {
  for (const file of ["favicon.ico", "icon.svg", "apple-icon.png"]) {
    assert.equal(existsSync(join(root, "src/app", file)), false, file);
    assert.ok(statSync(join(publicRoot, file)).isFile(), file);
    assert.deepEqual(readFileSync(join(publicRoot, file)), baseFile(`src/app/${file}`), file);
  }
  assert.equal(existsSync(join(root, "src/app/manifest.ts")), false);
});

test("legacy immutable icon URLs stay consistent with pinned asset bytes", () => {
  for (const [file, expected] of [
    ["icon.svg", "03839603e2d6cbb1fb6ca4549a30c73ca978223fa53b0c88688de943484b84d9"],
    ["apple-icon.png", "52cb58062f9a28939c253e1d3d630560d7d749abb462cb515f4f82a9275c9a15"],
  ] as const) {
    const actual = createHash("sha256")
      .update(readFileSync(join(publicRoot, file)))
      .digest("hex");
    assert.equal(
      actual,
      expected,
      `${file} bytes changed: change the query string in brandMetadata before updating this SHA-256 pin.`,
    );
  }
});

test("static asset headers preserve legacy icon caching for exactly two paths", () => {
  const lines = read("public/_headers")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  assert.deepEqual(lines, [
    "/icon.svg",
    "  Cache-Control: public, immutable, no-transform, max-age=31536000",
    "/apple-icon.png",
    "  Cache-Control: public, immutable, no-transform, max-age=31536000",
  ]);
});

test("every declared public asset exists", () => {
  assert.equal(new Set(BRAND_V2_ASSETS).size, BRAND_V2_ASSETS.length);
  for (const asset of BRAND_V2_ASSETS) {
    assert.ok(asset.startsWith("/brand/v2/"), asset);
    assert.ok(statSync(join(publicRoot, asset.slice(1))).isFile(), asset);
    assert.ok(statSync(join(publicRoot, asset.slice(1))).size > 0, asset);
  }
});

test("v2 manifest uses approved values and unchanged relative icons", () => {
  const path = "public/brand/v2/favicon/site.webmanifest";
  const manifestPath = join(root, path);
  const manifest = JSON.parse(read(path));
  const previous = JSON.parse(execFileSync("git", ["show", `a3c96c2:${path}`], {
    cwd: root, encoding: "utf8",
  }));
  assert.equal(manifest.name, "Condola 租多啦");
  assert.equal(manifest.short_name, "Condola");
  assert.equal(manifest.theme_color, "#14325C");
  assert.equal(manifest.background_color, "#F4F6F8");
  assert.deepEqual(manifest.icons, previous.icons);
  for (const icon of manifest.icons as { src: string }[]) {
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
  "--cd-primary-pressed": "var(--c-primary-pressed)",
  "--cd-primary-soft": "#E3EAF3",
  "--cd-accent": "#2F6BFF",
  "--cd-accent-soft": "#E8EFFF",
  "--cd-ink": "#1B2533",
  "--cd-ink2": "#4A5668",
  "--cd-ink3": "#687384",
  "--cd-surface": "#FFFFFF",
  "--cd-surface2": "#EEF2F6",
  "--cd-border": "#DDE3EA",
  "--cd-border-strong": "var(--c-border-strong)",
  "--cd-cream": "var(--c-bg)",
  "--cd-focus": "var(--c-focus)",
  "--cd-topbar": "#FFFFFF",
  "--cd-topbar-2": "var(--c-surface-2)",
  "--cd-topbar-3": "var(--c-surface-2)",
  "--cd-topbar-4": "var(--c-divider)",
  "--cd-success": "#2A7254",
  "--cd-success-bg": "#E3F1EA",
  "--cd-warning": "#935C0F",
  "--cd-warning-bg": "#F8EEDB",
  "--cd-danger": "#B0413E",
  "--cd-danger-bg": "#F7E4E3",
  "--cd-info": "#23748A",
  "--cd-info-bg": "#E2F1F4",
};

test("theme has approved mappings, scoped selectors and local Latin font faces", () => {
  const css = read("public/brand/v2/theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /@import|https?:|url\(\s*["']?(?:\/\/|data:)/i);
  const faces = [...css.matchAll(/@font-face\s*\{([^{}]*)\}/g)];
  assert.equal(faces.length, 2);
  for (const [index, family, file, weight] of [
    [0, "Inter", "Inter-latin-wght.woff2", "100 900"],
    [1, "Plus Jakarta Sans", "PlusJakartaSans-latin-wght.woff2", "200 800"],
  ] as const) {
    const body = faces[index][1];
    assert.ok(body.includes(`font-family: "${family}";`));
    assert.ok(body.includes(`font-weight: ${weight};`));
    assert.match(body, /font-display:\s*swap;/);
    assert.match(body, /unicode-range:\s*U\+0000-00FF/i);
    assert.ok(body.includes(`url("/brand/v2/fonts/${file}")`));
  }
  // Validate the supported media wrapper, then inspect every nested selector too.
  const withoutFaces = css.replace(/@font-face\s*\{[^{}]*\}/g, "");
  const mediaHeaders = [...withoutFaces.matchAll(/@media[^{]*\{/g)];
  assert.equal(mediaHeaders.length, 1);
  assert.equal(mediaHeaders[0][0], "@media (min-width: 640px) {");
  const styles = withoutFaces.replace(
    /@media \(min-width: 640px\)\s*\{((?:\s*[^{}]+\{[^{}]*\})+\s*)\}/g,
    "$1",
  );
  assert.doesNotMatch(styles, /@/);
  assert.equal(styles.replace(/[^{}]+\{[^{}]*\}/g, "").trim(), "");
  for (const [, selectors] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of selectors.split(",")) {
      assert.ok(selector.trim().startsWith('html[data-brand="v2"]'), selector);
    }
  }
  const rootBody = styles.match(/html\[data-brand="v2"\]\s*\{([^{}]*)\}/)?.[1];
  assert.ok(rootBody);
  const declarations = new Map(rootBody.split(";").filter((part) => part.trim()).map((part) => {
    const colon = part.indexOf(":");
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
  for (const [name, value] of Object.entries({
    ...mappings,
    "--c-primary-pressed": "#0B1F3A",
    "--c-border-strong": "#7F8B9C",
    "--c-focus": "#2F6BFF",
    "--font": "var(--font-sans)",
  })) {
    assert.equal(declarations.get(name), value, name);
  }
  assert.match(styles, /header\.top\s*\{[^}]*border-bottom:\s*1px solid var\(--c-divider\)/);
  assert.match(styles, /header\.top\s*\{[^}]*color:\s*var\(--c-text\)/);
  assert.ok(styles.includes("font-feature-settings: \"tnum\" 1;"));
});

test("v2 header and portal lockups use 28px geometry and keep the legacy narrow-screen symbol switch", () => {
  const css = read("public/brand/v2/theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const lockup = css.match(/html\[data-brand="v2"\] header\.top \.brand-lockup\s*\{([^{}]*)\}/);
  assert.ok(lockup);
  assert.match(lockup[1], /height:\s*28px\s*;/);
  assert.match(lockup[1], /width:\s*auto\s*;/);
  assert.match(lockup[1], /max-width:\s*100%\s*;/);
  assert.doesNotMatch(lockup[1], /display\s*:/);
  assert.doesNotMatch(css, /header\.top \.brand-symbol\s*\{/);
  const portal = css.match(/html\[data-brand="v2"\] \.portal-brand img\s*\{([^{}]*)\}/);
  assert.ok(portal);
  assert.match(portal[1], /height:\s*28px\s*;/);
  assert.match(portal[1], /width:\s*auto\s*;/);
});

test("v2 focus rings use approved geometry and white rings on consent", () => {
  const css = read("public/brand/v2/theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selectors, body]) => ({
      selectors: selectors.split(",").map((selector) => selector.trim()),
      body,
    }))
    .filter((rule) => rule.selectors.some((selector) =>
      selector.startsWith('html[data-brand="v2"]'),
    ));

  for (const rule of rules) {
    assert.doesNotMatch(rule.body, /(?:^|;)\s*outline-offset\s*:\s*-/i);
  }
  assert.match(css, /--cd-focus-ring: 0 0 0 2px #fff, 0 0 0 4px var\(--c-focus\);/);

  const assertRing = (selector: string, outline: string) => {
    const matches = rules.filter((rule) => rule.selectors.includes(selector));
    assert.equal(matches.length, 1, selector);
    const declarations = new Map(
      matches[0].body.split(";").filter((part) => part.trim()).map((part) => {
        const colon = part.indexOf(":");
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
      }),
    );
    assert.equal(declarations.get("outline"), outline, selector);
    assert.equal(declarations.get("outline-offset"), "2px", selector);
    assert.equal(declarations.get("box-shadow"), "none", selector);
    return rules.indexOf(matches[0]);
  };

  const genericIndices = [
    "header.top :focus-visible",
    ".seg:focus-visible",
    ".seg button:focus-visible",
    ".seg a:focus-visible",
    ".seg .on:focus-visible",
    ".btn:focus-visible",
    ".btn.pri:focus-visible",
  ].map((selector) => assertRing(
    `html[data-brand="v2"] ${selector}`,
    "2px solid var(--c-focus)",
  ));

  for (const selector of [
    ".consent :focus-visible",
    ".consent .btn:focus-visible",
  ]) {
    const index = assertRing(`html[data-brand="v2"] ${selector}`, "2px solid #fff");
    assert.ok(genericIndices.every((genericIndex) => genericIndex < index), selector);
  }
});

test("only Inter is preloaded inside the ON head", () => {
  const layout = read("src/app/layout.tsx");
  const heads = [...layout.matchAll(/<head>([\s\S]*?)<\/head>/g)];
  assert.equal(heads.length, 1);
  const onHead = heads[0]?.[1];
  assert.ok(onHead);
  assert.equal([...onHead.matchAll(/rel="preload"/g)].length, 1);
  assert.match(onHead, /as="font"/);
  assert.match(onHead, /type="font\/woff2"/);
  assert.match(onHead, /crossOrigin="anonymous"/);
  assert.match(onHead, /href="\/brand\/v2\/fonts\/Inter-latin-wght\.woff2"/);
  assert.doesNotMatch(onHead, /PlusJakartaSans/);
  assert.match(onHead, /href="\/brand\/v2\/theme\.css"/);
});

test("OFF layout returns only the legacy html wrapper and shared body", () => {
  const layout = read("src/app/layout.tsx");
  assert.match(
    layout,
    /if\s*\(!v2\)\s*\{\s*return\s+<html lang=\{prefs\.locale === "zh-TW" \? "zh-Hant-TW" : "en"\}>\{body\}<\/html>;\s*\}/,
  );
});

test("BrandImage preserves defaults and selects both color header variants", () => {
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
        ? "/brand/v2/logo/lockup_en_color.svg"
        : "/brand/v2/logo/symbol_color.svg",
    ));
    assert.doesNotMatch(enabled, /\/brand\/condola_|\/brand\/v2\/logo\/\w+_dark\.svg/);
    const images = [...enabled.matchAll(/<img\b[^>]*>/g)];
    assert.equal(images.length, 1);
    assert.match(images[0][0], /alt=""/);
    assert.ok(images[0][0].includes(`height="${variant === "horizontalDark" ? 28 : 24}"`));
  }
  const chrome = read("src/components/chrome.tsx");
  assert.ok(chrome.includes('export function BrandLink({ v2 }: { v2?: boolean } = {})'));
  assert.ok(chrome.includes("const locale = useLocale();"));
  for (const [variant, className] of [
    ["horizontalDark", "brand-lockup"],
    ["symbolSmall", "brand-symbol"],
  ]) {
    assert.ok(chrome.includes(
      `<BrandImage variant="${variant}" alt="" className="${className}" {...(v2 ? { v2: true, locale } : {})} />`,
    ));
  }
});

test("BrandImage horizontal variants select locale lockups and preserve exact legacy markup", () => {
  for (const variant of ["horizontal", "horizontalDark"] as const) {
    const legacy = variant === "horizontal"
      ? "/brand/condola_lockup_horizontal.svg"
      : "/brand/condola_lockup_horizontal_dark.svg";
    const expected =
      `<link rel="preload" as="image" href="${legacy}"/>`
      + `<img class="test-logo" src="${legacy}" alt="Condola"/>`;
    for (const locale of ["zh-TW", "en"] as const) {
      const props = { variant, alt: "Condola", className: "test-logo", locale };
      for (const offProps of [props, { ...props, v2: false }]) {
        const html = renderToStaticMarkup(React.createElement(BrandImage, offProps));
        assert.equal(html, expected);
        assert.doesNotMatch(html, /\/brand\/v2\//);
      }
      const html = renderToStaticMarkup(React.createElement(BrandImage, { ...props, v2: true }));
      const asset = locale === "zh-TW" ? "lockup_zh_color.svg" : "lockup_en_color.svg";
      assert.ok(html.includes(`/brand/v2/logo/${asset}`));
      const images = [...html.matchAll(/<img\b[^>]*>/g)];
      assert.equal(images.length, 1);
      assert.match(images[0][0], /height="28"/);
      assert.ok(images[0][0].includes(`width="${locale === "zh-TW" ? 89 : 112}"`));
      assert.doesNotMatch(html, /\/brand\/condola_/);
    }
  }
});

test("owner, tenant header, and statement logos forward the optional v2 flag", () => {
  const ownerLayout = read("src/app/o/layout.tsx");
  assert.ok(ownerLayout.includes('import { brandV2Enabled } from "@/server/brand-v2";'));
  assert.ok(ownerLayout.includes(
    '<OwnerNav properties={properties} {...(brandV2Enabled() ? { v2: true } : {})}>{children}</OwnerNav>',
  ));
  const ownerNav = read("src/components/owner-nav.tsx");
  assert.ok(ownerNav.includes("v2?: boolean;"));
  assert.ok(ownerNav.includes("const locale = useLocale();"));
  assert.ok(ownerNav.includes(
    '<BrandImage variant="horizontal" alt={t("i_brand")} {...(v2 ? { v2: true, locale } : {})} />',
  ));
  const tenantLayout = read("src/app/t/layout.tsx");
  assert.ok(tenantLayout.includes(
    '<BrandImage variant="symbolSmall" alt="" className="brand-symbol" {...(brandV2Enabled() ? { v2: true } : {})} />',
  ));
  const statement = read("src/components/statement-document.tsx");
  assert.ok(statement.includes("v2?: boolean;"));
  assert.ok(statement.includes(
    '<BrandImage variant="horizontal" alt={t("i_brand")} className="statement-logo" {...(v2 ? { v2: true, locale } : {})} />',
  ));
});

test("BrandImage stacked OFF preserves exact legacy markup and ON uses v2", () => {
  for (const className of [undefined, "welcome-logo"]) {
    const props = { variant: "stacked" as const, alt: "Condola 租多啦", className };
    const expected =
      '<link rel="preload" as="image" href="/brand/condola_lockup_stacked.svg"/>'
      + `<img${className ? ` class="${className}"` : ""} src="/brand/condola_lockup_stacked.svg" alt="Condola 租多啦"/>`;
    for (const offProps of [props, { ...props, v2: false }]) {
      assert.equal(renderToStaticMarkup(React.createElement(BrandImage, offProps)), expected);
    }
    assert.equal(
      renderToStaticMarkup(React.createElement(BrandImage, { ...props, v2: true })),
      '<link rel="preload" as="image" href="/brand/v2/logo/lockup_stacked_color.svg"/>'
      + `<img class="${className ? `${className} ` : ""}stacked-v2" src="/brand/v2/logo/lockup_stacked_color.svg" alt="Condola 租多啦" width="200" height="148"/>`,
    );
  }
});

test("tenant welcome passes the server flag through an ON-only spread", () => {
  const layout = read("src/app/t/layout.tsx");
  assert.ok(layout.includes('import { brandV2Enabled } from "@/server/brand-v2";'));
  assert.doesNotMatch(layout, /^\s*["']use client["']/);
  assert.match(
    layout,
    /\{path === "\/t" \? \(\s*<div className="liff-welcome">\s*<BrandImage variant="stacked" alt=\{t\("i_brand"\)\} \{\.\.\.\(brandV2Enabled\(\) \? \{ v2: true \} : \{\}\)\} \/>\s*<\/div>/,
  );
});

test("tenant welcome geometry is scoped to v2 at both sizes", () => {
  const css = read("public/brand/v2/theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const media = css.match(
    /@media \(min-width: 640px\)\s*\{((?:\s*[^{}]+\{[^{}]*\})+\s*)\}/,
  );
  assert.ok(media);
  const mobile = css.replace(media[0], "");
  const assertGeometry = (rules: string, width: number, padding: number) => {
    const wrapper = rules.match(/html\[data-brand="v2"\] \.liff-welcome\s*\{([^{}]*)\}/);
    const image = rules.match(/html\[data-brand="v2"\] \.liff-welcome img\.stacked-v2\s*\{([^{}]*)\}/);
    assert.ok(wrapper);
    assert.ok(image);
    assert.match(wrapper[1], new RegExp(`padding:\\s*${padding}px 0\\s*;`));
    assert.match(image[1], new RegExp(`width:\\s*${width}px\\s*;`));
    assert.match(image[1], /height:\s*auto\s*;/);
    assert.ok(padding >= width * 140 / 405 / 2);
  };
  assertGeometry(mobile, 160, 28);
  assertGeometry(media[1], 200, 35);
  for (const [, selectors] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of selectors.split(",")) {
      if (selector.includes(".liff-welcome")) {
        assert.ok(selector.trim().startsWith('html[data-brand="v2"]'), selector);
      }
    }
  }
});

test("v2 stacked dark asset has no file or active reference until a navy placement exists", () => {
  const filename = ["lockup", "stacked", "dark"].join("_") + ".svg";
  assert.equal(existsSync(join(publicRoot, "brand/v2/logo", filename)), false);
  assert.ok(BRAND_V2_ASSETS.every((asset) => !asset.includes(filename)));
  const approvedComment =
    "// R&D 02:09: use " + filename
    + " on navy surfaces; no current placement is navy (see e2e brand-v2 probe)";
  assert.ok(read("src/components/brand.tsx").includes(approvedComment));
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        assert.notEqual(entry.name, filename, path);
        if (/\.(?:[cm]?[jt]sx?|css|svg|json|webmanifest|html|txt)$/.test(entry.name)) {
          const source = readFileSync(path, "utf8");
          const active = path === join(root, "src/components/brand.tsx")
            ? source.replace(approvedComment, "")
            : source;
          assert.ok(!active.includes("brand/v2/logo/" + filename), path);
          assert.ok(!/(^|[^a-z_])lockup_stacked_dark\.svg/.test(active), path);
        }
      }
    }
  };
  walk(join(root, "src"));
  walk(publicRoot);
});

test("AuthBrand OFF preserves the exact legacy serialization", () => {
  const expected =
    '<link rel="preload" as="image" href="/brand/condola_lockup_stacked.svg"/>'
    + '<div class="auth-brand"><img src="/brand/condola_lockup_stacked.svg" alt="Condola 租多啦"/></div>';
  for (const props of [
    { name: "Condola 租多啦" },
    { name: "Condola 租多啦", v2: false },
  ]) {
    assert.equal(renderToStaticMarkup(React.createElement(AuthBrand, props)), expected);
  }
});

test("AuthBrand ON uses the bilingual color lockup with intrinsic dimensions", () => {
  const html = renderToStaticMarkup(React.createElement(AuthBrand, {
    name: "Condola 租多啦",
    v2: true,
  }));
  const images = [...html.matchAll(/<img\b[^>]*>/g)];
  assert.equal(images.length, 1);
  assert.equal(
    images[0][0],
    '<img class="auth-brand-v2" src="/brand/v2/logo/lockup_stacked_color.svg" alt="Condola 租多啦" width="200" height="148"/>',
  );
  assert.ok(Math.abs(148 - 200 * 300.68 / 405) < 0.5);
  assert.doesNotMatch(html, /\/brand\/condola_lockup_stacked\.svg/);
  assert.doesNotMatch(read("src/components/brand.tsx"), /process\.env/);
});

test("stacked color asset is byte-identical to the approved R&D source", () => {
  const asset = "/brand/v2/logo/lockup_stacked_color.svg";
  assert.ok(BRAND_V2_ASSETS.some((entry) => entry === asset));
  assert.ok(existsSync(join(publicRoot, asset.slice(1))));
  assert.equal(
    createHash("sha256").update(readFileSync(join(publicRoot, asset.slice(1)))).digest("hex"),
    "8f73eaf9fe22b23e87a69714067be12600271b5fc354d2de1bf52985ef469c71",
    "The digest must match the R&D-approved asset",
  );
  assert.match(readFileSync(join(publicRoot, asset.slice(1)), "utf8"), /viewBox="0 0 405 300\.68"/);
});

test("auth logo widths and clear space are scoped to v2 at both sizes", () => {
  const css = read("public/brand/v2/theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const media = css.match(
    /@media \(min-width: 640px\)\s*\{((?:\s*[^{}]+\{[^{}]*\})+\s*)\}/,
  );
  assert.ok(media);
  const mobile = css.replace(media[0], "");
  const assertGeometry = (rules: string, width: number, margin: number) => {
    const wrapper = rules.match(/html\[data-brand="v2"\] \.auth-brand\s*\{([^{}]*)\}/);
    const image = rules.match(/html\[data-brand="v2"\] \.auth-brand img\.auth-brand-v2\s*\{([^{}]*)\}/);
    assert.ok(wrapper);
    assert.ok(image);
    assert.match(wrapper[1], new RegExp(`margin:\\s*${margin}px 0\\s*;`));
    assert.match(image[1], new RegExp(`width:\\s*${width}px\\s*;`));
    assert.match(image[1], /height:\s*auto\s*;/);
    assert.ok(margin >= width * 140 / 405 / 2);
  };
  assertGeometry(mobile, 160, 28);
  assertGeometry(media[1], 200, 35);
});

test("every server auth page passes the flag and join omits the OFF client prop", () => {
  const pages: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "page.tsx") pages.push(path);
    }
  };
  walk(join(root, "src/app"));
  let usages = 0;
  for (const path of pages) {
    const source = readFileSync(path, "utf8");
    const tags = [...source.matchAll(/<AuthBrand\b[^>]*\/>/g)];
    if (!tags.length) continue;
    assert.ok(source.includes('import { brandV2Enabled } from "@/server/brand-v2";'), path);
    assert.doesNotMatch(source, /^\s*["']use client["']/);
    for (const [tag] of tags) {
      usages++;
      assert.match(tag, /\bv2=\{brandV2Enabled\(\)\}/, path);
    }
  }
  assert.equal(usages, 13, "update when auth pages change");
  const joinPage = read("src/app/join/page.tsx");
  assert.ok(joinPage.includes(
    '<TeamJoin {...(brandV2Enabled() ? { brandV2: true } : {})} />',
  ));
  assert.doesNotMatch(joinPage, /brandV2=\{/);
  const teamJoin = read("src/components/team-join.tsx");
  assert.ok(teamJoin.includes('<AuthBrand name={t("i_brand")} v2={brandV2} />'));
  assert.doesNotMatch(teamJoin, /process\.env|import.*@\/server\/brand-v2/);
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
    "public/manifest.webmanifest",
    "src/app/layout.tsx",
    "src/components/brand.tsx",
    "scripts/brand-v2-ci.sh",
    ...BRAND_V2_ASSETS.filter((asset) => /\.(?:css|svg|webmanifest|txt)$/.test(asset))
      .map((asset) => `public${asset}`),
    "public/brand/v2/logo/lockup_en_dark.svg",
    "public/brand/v2/logo/symbol_dark.svg",
    "public/icon.svg",
  ];
  for (const file of new Set(files)) {
    const text = read(file);
    for (const term of banned) assert.ok(!text.includes(term), `${file}: forbidden term`);
  }
});
