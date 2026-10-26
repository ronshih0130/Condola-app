import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  assetModule,
  buildManifest,
  collectBrowserPackages,
  npmTarballUrl,
  readLicenseText,
  resolvePackageDir,
} from "../../scripts/third-party-licenses.mjs";
import type { BrowserConfig, Manifest } from "../../scripts/third-party-licenses.mjs";
import { LIBHEIF_ASSET } from "../generated/libheif-asset";
import { deliveryLabelKey, licenseEntries } from "./third-party-licenses";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const config = JSON.parse(read("third-party/browser-packages.json")) as BrowserConfig;
const manifest = JSON.parse(read("src/generated/third-party-licenses.json")) as Manifest;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const gplHash = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";

function packageVersion(name: string, fromDir = root): string {
  const directory = resolvePackageDir(fromDir, name);
  return (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { version: string }).version;
}

test("generated manifest and asset module are current", async () => {
  assert.deepEqual(await buildManifest(root, config), manifest);
  assert.equal(read("src/generated/libheif-asset.ts"), assetModule(manifest));
  assert.deepEqual(licenseEntries(), manifest.packages);
});

test("browser graph includes required packages and excludes server encoders and build tools", () => {
  const required = [
    "libheif-js", "heic-decode", "heic-convert", "react", "react-dom", "scheduler",
    "next", "@swc/helpers", "tslib", "pdf-lib", "@pdf-lib/fontkit",
    "@pdf-lib/standard-fonts", "@pdf-lib/upng", "pako",
  ];
  const collected = collectBrowserPackages(root, config);
  for (const name of required) {
    const resolved = collected.filter((entry) => entry.metadata.name === name);
    assert.ok(resolved.length, name);
    for (const entry of resolved) {
      assert.ok(manifest.packages.some((pkg) =>
        pkg.name === name && pkg.version === entry.metadata.version), `${name}@${entry.metadata.version}`);
    }
  }
  for (const name of ["jpeg-js", "pngjs", "postcss", "sharp", "caniuse-lite"]) {
    assert.equal(manifest.packages.some((entry) => entry.name === name), false, name);
  }
  for (const name of ["libheif-js", "heic-decode", "heic-convert", "react", "react-dom", "next", "pdf-lib"]) {
    assert.ok(manifest.packages.some((entry) =>
      entry.name === name && entry.version === packageVersion(name)), name);
  }
  const pdfDirectory = resolvePackageDir(root, "pdf-lib");
  assert.ok(manifest.packages.some((entry) =>
    entry.name === "tslib" && entry.version === packageVersion("tslib", pdfDirectory)));
  const asset = manifest.packages.find((entry) => entry.name === "libheif-js");
  assert.ok(asset);
  assert.equal(asset.license, "LGPL-3.0");
  assert.equal(asset.licenseUrl, "/third-party/LGPL-3.0.txt");
  assert.equal(asset.gplUrl, "/third-party/GPL-3.0.txt");
  assert.equal(asset.sourceUrl, `https://registry.npmjs.org/libheif-js/-/libheif-js-${asset.version}.tgz`);
  assert.equal(asset.delivery, "separate-unmodified-file");
  assert.equal(asset.version, LIBHEIF_ASSET.version);
  assert.equal(asset.assetPath, LIBHEIF_ASSET.path);
  const upstream = readFileSync(join(resolvePackageDir(root, "libheif-js"), "libheif-wasm/libheif-bundle.mjs"));
  assert.equal(asset.sha256, sha256(upstream));
  assert.equal(asset.sha256, LIBHEIF_ASSET.sha256);
  for (const name of ["libheif", "libde265"]) {
    const entry = manifest.packages.find((pkg) => pkg.name === name);
    assert.ok(entry);
    assert.equal(entry.license, "LGPL-3.0");
    assert.equal(entry.delivery, "inside:libheif-js");
    assert.match(entry.sourceUrl, /^https:\/\/github\.com\/strukturag\/[^/]+\/releases\/tag\/v/);
    assert.ok(entry.requiredBy.includes("heic-convert"));
  }
  assert.equal(manifest.packages.find((entry) => entry.name === "libheif")?.version, "1.23.5");
  assert.equal(manifest.packages.find((entry) => entry.name === "libde265")?.version, "1.0.15");
});

test("every package provides its licence and corresponding source", () => {
  for (const entry of manifest.packages) {
    assert.ok(entry.license.trim(), entry.name);
    assert.ok(entry.sourceUrl, entry.name);
    if (/\b(?:A?GPL|LGPL)-/.test(entry.license)) {
      assert.equal(entry.licenseText, null);
      assert.ok(entry.licenseUrl, entry.name);
      if (entry.license.includes("LGPL")) assert.ok(entry.gplUrl, entry.name);
    } else {
      assert.ok(entry.licenseText?.trim(), entry.name);
    }
    assert.ok(entry.requiredBy.length, entry.name);
    assert.ok(deliveryLabelKey(entry.delivery));
  }
  assert.equal(npmTarballUrl("@pdf-lib/fontkit", "1.1.1"),
    "https://registry.npmjs.org/@pdf-lib/fontkit/-/fontkit-1.1.1.tgz");
  assert.ok(readLicenseText(resolvePackageDir(root, "react")).trim());
});

test("public copyleft texts and upstream notices retain exact bytes", () => {
  const directory = resolvePackageDir(root, "libheif-js");
  assert.deepEqual(
    readFileSync(join(root, "public/third-party/LGPL-3.0.txt")),
    readFileSync(join(directory, "LICENSE")),
  );
  assert.equal(sha256(readFileSync(join(root, "public/third-party/GPL-3.0.txt"))), gplHash);
  assert.deepEqual(
    readFileSync(join(root, `public/third-party/libheif-js/${LIBHEIF_ASSET.version}/LICENSE`)),
    readFileSync(join(directory, "libheif-wasm/LICENSE")),
  );
});

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function moduleSpecifiers(source: ts.SourceFile): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly ||
        (!clause?.name && bindings && ts.isNamedImports(bindings) &&
          bindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        imports.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function resolveLocalImport(file: string, specifier: string): string {
  const base = specifier.startsWith("@/")
    ? resolve(root, "src", specifier.slice(2))
    : resolve(dirname(file), specifier);
  const extensions = [".ts", ".tsx", ".js", ".mjs", ".json", ".css"];
  const candidates = [
    base,
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => join(base, `index${extension}`)),
  ];
  if ([".js", ".mjs"].includes(extname(base))) {
    const stem = base.slice(0, -extname(base).length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  const resolved = candidates.find((candidate) =>
    existsSync(candidate) && statSync(candidate).isFile());
  assert.ok(resolved, `${relative(root, file)} cannot resolve local import ${specifier}`);
  return resolved;
}

test("direct browser imports are covered by the manifest", () => {
  const names = new Set(manifest.packages.map((entry) => entry.name));
  const files = sourceFiles(join(root, "src")).filter((path) => {
    const first = parseSource(path).statements[0];
    return first && ts.isExpressionStatement(first) &&
      ts.isStringLiteral(first.expression) && first.expression.text === "use client";
  });
  files.push(join(root, "src/lib/heic-browser.ts"), join(root, "src/lib/pdf-render.ts"));
  const reached = new Set<string>();
  const packages = new Set<string>();
  const uncovered = new Set<string>();
  while (files.length) {
    const file = files.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    if (extname(file) === ".json") continue;
    let specifiers: string[];
    if (extname(file) === ".css") {
      specifiers = [...readFileSync(file, "utf8").matchAll(/^[ \t]*@import[ \t]+(["'])([^"'\r\n]+)\1/gm)]
        .map((match) => match[2]);
    } else {
      const source = parseSource(file);
      const first = source.statements[0];
      if (first && ts.isExpressionStatement(first) &&
        ts.isStringLiteral(first.expression) && first.expression.text === "use server") continue;
      specifiers = moduleSpecifiers(source);
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        files.push(resolveLocalImport(file, specifier));
        continue;
      }
      if (/^(?:\/|node:|https?:|data:)/.test(specifier)) continue;
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (["server-only", "client-only", "next"].includes(name)) continue;
      packages.add(name);
      if (!names.has(name)) {
        uncovered.add(`${relative(root, file).replaceAll("\\", "/")} -> ${name}`);
      }
    }
  }
  assert.ok(reached.has(join(root, "src/lib/heic-browser.ts")));
  assert.ok(packages.has("heic-decode"), "client graph must include heic-decode");
  assert.ok(packages.has("heic-convert"), "client graph must include heic-convert");
  assert.equal(uncovered.size, 0,
    `Browser imports uncovered by the manifest:\n${[...uncovered].sort().join("\n")}`);
});

test("browser conversion loads the separate asset and client aliases fail closed", () => {
  const source = read("src/lib/heic-browser.ts");
  assert.doesNotMatch(source, /(?:from\s*|import\s*\(\s*)["'](?:heic-convert\/browser|heic-decode|libheif-js)["']/);
  assert.match(source, /import\(\s*\/\*\s*webpackIgnore:\s*true\s*\*\/\s*LIBHEIF_ASSET\.path\s*\)/);
  assert.match(source, /import\("heic-decode\/lib\.js"\)/);
  assert.match(source, /import\("heic-convert\/lib\.js"\)/);
  assert.match(source, /import\("heic-convert\/formats-browser\.js"\)/);
  const clientAliases = read("next.config.ts").split("} else {")[1];
  assert.ok(clientAliases);
  assert.match(clientAliases, /"libheif-js": false/);
  assert.match(clientAliases, /"libheif-js\/wasm-bundle": false/);
});

test("licence copy exists in both locales with matching keys and safe wording", () => {
  const en = JSON.parse(read("src/i18n/en.json")) as Record<string, string>;
  const zh = JSON.parse(read("src/i18n/zh-TW.json")) as Record<string, string>;
  const keys = new Set([...Object.keys(en), ...Object.keys(zh)]
    .filter((key) => key.startsWith("i_lic_") || key === "i_legal_licenses"));
  assert.ok(keys.size > 1);
  const referenced = [
    read("src/app/licenses/page.tsx"),
    read("src/server/third-party-licenses.ts"),
    read("src/app/layout.tsx"),
  ].join("\n");
  for (const match of referenced.matchAll(/["'](i_lic_[\w]+|i_legal_licenses)["']/g)) {
    assert.ok(keys.has(match[1]), match[1]);
  }
  const banned = ["\u623f\u6771", "\u623f\u5ba2", "收款", "收租", "即將推出", "測試模式", "範例沙盒", "示範"];
  for (const key of keys) {
    assert.equal(typeof en[key], "string", key);
    assert.equal(typeof zh[key], "string", key);
    assert.ok(en[key].trim(), key);
    assert.ok(zh[key].trim(), key);
    for (const word of banned) assert.equal(zh[key].includes(word), false, key);
  }
  for (const signature of ["heif_context_alloc", "HeifDecoder", "_de265_get_version"]) {
    assert.equal(JSON.stringify(manifest).includes(signature), false);
    assert.equal(read("src/app/licenses/page.tsx").includes(signature), false);
    for (const key of keys) {
      assert.equal(en[key].includes(signature), false);
      assert.equal(zh[key].includes(signature), false);
    }
  }
});

test("footer links to licences between privacy and refunds", () => {
  const layout = read("src/app/layout.tsx");
  const footer = layout.slice(layout.indexOf("<footer"));
  assert.match(footer, /href="\/privacy"[\s\S]*href="\/licenses"[\s\S]*href="\/refund"/);
  assert.match(footer, /href="\/licenses">\{t\("i_legal_licenses"\)\}/);
});
