import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GENERATED_BY = "scripts/third-party-licenses.mjs";
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const copyleft = (license) => /\b(?:A?GPL|LGPL)-/i.test(license);
const lgpl = (license) => /\bLGPL-/i.test(license);
const substitute = (text, version) => text.replaceAll("{version}", version);

// SPDX standard texts, with the copyright line supplied separately:
// https://spdx.org/licenses/MIT.html
// https://spdx.org/licenses/ISC.html
const SPDX_TEMPLATES = new Map([
  ["MIT", `MIT License

Copyright (c) {holders}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation on the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`],
  ["ISC", `ISC License

Copyright (c) {holders}

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`],
]);

export function resolvePackageDir(fromDir, name) {
  if (!/^(?:@[^/]+\/)?[^/]+$/.test(name)) {
    throw new Error(`Invalid package name: ${name}`);
  }
  let current = resolve(fromDir);
  while (true) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Cannot resolve ${name} from ${fromDir}`);
}

function licenseFiles(pkgDir) {
  return readdirSync(pkgDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:licen[sc]e|copying)(?:[._-].*)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(compare);
}

function readLicenseFiles(pkgDir, files) {
  if (!files.length) throw new Error(`No licence file in ${pkgDir}`);
  const text = files.map((file) => readFileSync(join(pkgDir, file), "utf8")).join("\n\n");
  if (!text.trim()) throw new Error(`Empty licence text in ${pkgDir}`);
  return text;
}

export function readLicenseText(pkgDir) {
  return readLicenseFiles(pkgDir, licenseFiles(pkgDir));
}

function packageLicense(pkgDir, pkg, config) {
  const files = licenseFiles(pkgDir);
  if (files.length) {
    return {
      licenseText: readLicenseFiles(pkgDir, files),
      licenseTextSource: `package-file:${files.join(", ")}`,
    };
  }
  const template = SPDX_TEMPLATES.get(pkg.license);
  if (!template) throw new Error(`No licence file in ${pkgDir}`);
  const configured = config.copyrightHolders &&
    Object.hasOwn(config.copyrightHolders, pkg.name);
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  const value = configured ? config.copyrightHolders[pkg.name] : author;
  const holders = typeof value === "string"
    ? value.replace(/<[^>]*>/g, "").replace(/\b[^\s<>@]+@[^\s<>@]+\b/g, "").trim()
    : "";
  if (!holders) {
    throw new Error(`Missing copyright holders for ${pkg.name}`);
  }
  return {
    licenseText: template.replace("{holders}", () => holders),
    licenseTextSource: "spdx-template",
  };
}

export function npmTarballUrl(name, version) {
  const unscoped = name.split("/").at(-1);
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`;
}

function repositoryUrl(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return null;
  let value = raw.replace(/^git\+/, "").replace(/\.git(?=#|$)/, "");
  if (value.startsWith("github:")) value = `https://github.com/${value.slice(7)}`;
  if (value.startsWith("git://")) value = `https://${value.slice(6)}`;
  value = value.replace(/^git@github\.com:/, "https://github.com/");
  value = value.replace(/^ssh:\/\/git@/, "https://");
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = `https://github.com/${value}`;
  if (!/^https?:\/\//.test(value)) {
    throw new Error(`Unsupported repository URL: ${raw}`);
  }
  return value.replace(/^http:\/\//, "https://");
}

export function collectBrowserPackages(rootDir, config) {
  const packages = new Map();
  for (const root of config.roots) {
    const seen = new Set();
    const excluded = new Set(root.exclude ?? []);
    function visit(fromDir, name, walk) {
      if (excluded.has(name)) return;
      const directory = resolvePackageDir(fromDir, name);
      if (seen.has(directory)) return;
      seen.add(directory);
      const metadata = readJson(join(directory, "package.json"));
      if (typeof metadata.license !== "string" || !metadata.license.trim()) {
        throw new Error(`Missing licence field: ${metadata.name ?? name}`);
      }
      if (!metadata.version || metadata.name !== name) {
        throw new Error(`Invalid package metadata: ${directory}`);
      }
      let item = packages.get(directory);
      if (!item) {
        item = { directory, metadata, requiredBy: new Set() };
        packages.set(directory, item);
      }
      item.requiredBy.add(root.name);
      if (walk) {
        for (const dependency of Object.keys(metadata.dependencies ?? {}).sort(compare)) {
          visit(directory, dependency, true);
        }
      }
    }
    visit(rootDir, root.name, root.walk);
  }
  return [...packages.values()]
    .map((item) => ({ ...item, requiredBy: [...item.requiredBy].sort(compare) }))
    .sort((a, b) => compare(a.metadata.name, b.metadata.name) ||
      compare(a.metadata.version, b.metadata.version) || compare(a.directory, b.directory));
}

export async function probeEmbedded(rootDir) {
  const requireFromRoot = createRequire(join(resolve(rootDir), "package.json"));
  const heif = requireFromRoot("libheif-js/wasm-bundle");
  await heif.ready;
  const libheif = heif.heif_get_version();
  const pointer = heif._de265_get_version();
  if (!Number.isInteger(pointer) || pointer <= 0 || pointer >= heif.HEAPU8.length) {
    throw new Error("Invalid embedded decoder version pointer");
  }
  const end = heif.HEAPU8.indexOf(0, pointer);
  if (end < pointer || end - pointer > 100) {
    throw new Error("Invalid embedded decoder version string");
  }
  const libde265 = Buffer.from(heif.HEAPU8.subarray(pointer, end)).toString("utf8");
  for (const version of [libheif, libde265]) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
      throw new Error(`Invalid embedded library version: ${String(version)}`);
    }
  }
  return { libheif, libde265 };
}

function sourceReference(rootDir, reference) {
  const parts = reference.split("/");
  const name = reference.startsWith("@") ? parts.splice(0, 2).join("/") : parts.shift();
  const directory = resolvePackageDir(rootDir, name);
  return {
    path: join(directory, ...parts),
    version: readJson(join(directory, "package.json")).version,
  };
}

function publicUrl(path) {
  return `/${path.replace(/^\/+/, "")}`;
}

function verifySuppliedTexts(rootDir, config) {
  for (const [license, text] of Object.entries(config.copyleftTexts)) {
    if (!text.sha256) continue;
    const path = join(rootDir, "public", text.public);
    if (!existsSync(path) || hash(readFileSync(path)) !== text.sha256) {
      throw new Error(`${license}: missing or incorrect supplied text at ${text.public}`);
    }
  }
}

export async function buildManifest(rootDir, config) {
  verifySuppliedTexts(rootDir, config);
  const collected = collectBrowserPackages(rootDir, config);
  const entries = new Map();
  for (const item of collected) {
    const { metadata: pkg, directory, requiredBy } = item;
    const key = `${pkg.name}\0${pkg.version}`;
    if (copyleft(pkg.license) && !config.copyleftTexts[pkg.license]) {
      throw new Error(`No configured copyleft text for ${pkg.name}: ${pkg.license}`);
    }
    const vendor = config.vendored.find((entry) => entry.package === pkg.name);
    const notice = config.extraNotices.find((entry) => entry.from.startsWith(`${pkg.name}/`));
    const license = packageLicense(directory, pkg, config);
    const entry = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      licenseText: copyleft(pkg.license) ? null : license.licenseText,
      licenseTextSource: license.licenseTextSource,
      licenseUrl: copyleft(pkg.license) ? publicUrl(config.copyleftTexts[pkg.license].public) : null,
      gplUrl: lgpl(pkg.license) ? publicUrl(config.copyleftTexts["GPL-3.0"].public) : null,
      noticeUrl: notice ? publicUrl(substitute(notice.public, pkg.version)) : null,
      repository: repositoryUrl(pkg.repository),
      sourceUrl: npmTarballUrl(pkg.name, pkg.version),
      delivery: vendor ? "separate-unmodified-file" : "bundled",
      assetPath: vendor ? publicUrl(`${substitute(vendor.publicDir, pkg.version)}/${basename(vendor.file)}`) : null,
      sha256: vendor ? hash(readFileSync(join(directory, vendor.file))) : null,
      requiredBy,
    };
    const existing = entries.get(key);
    if (existing) {
      const previous = { ...existing, requiredBy: [] };
      if (JSON.stringify(previous) !== JSON.stringify({ ...entry, requiredBy: [] })) {
        throw new Error(`Conflicting metadata for ${pkg.name}@${pkg.version}`);
      }
      existing.requiredBy = [...new Set([...existing.requiredBy, ...requiredBy])].sort(compare);
    } else {
      entries.set(key, entry);
    }
  }
  if (config.embedded.length) {
    const versions = await probeEmbedded(rootDir);
    for (const embedded of config.embedded) {
      const parents = [...entries.values()].filter((entry) => entry.name === embedded.parent);
      if (!parents.length) throw new Error(`Missing embedded parent ${embedded.parent}`);
      const version = versions[embedded.probe];
      if (!version) throw new Error(`Unknown embedded probe ${embedded.probe}`);
      const text = config.copyleftTexts[embedded.license];
      if (!text) throw new Error(`Missing text for ${embedded.license}`);
      if (!text.from?.startsWith(`${embedded.parent}/`)) {
        throw new Error(`Missing package-file source for ${embedded.name}: ${embedded.license}`);
      }
      const entry = {
        name: embedded.name,
        version,
        license: embedded.license,
        licenseText: null,
        licenseTextSource: `package-file:${text.from.slice(embedded.parent.length + 1)}`,
        licenseUrl: publicUrl(text.public),
        gplUrl: lgpl(embedded.license) ? publicUrl(config.copyleftTexts["GPL-3.0"].public) : null,
        noticeUrl: parents[0].noticeUrl,
        repository: embedded.homepage,
        sourceUrl: substitute(embedded.sourceUrlTemplate, version),
        delivery: `inside:${embedded.parent}`,
        assetPath: null,
        sha256: null,
        requiredBy: [...new Set(parents.flatMap((parent) => parent.requiredBy))].sort(compare),
      };
      entries.set(`${entry.name}\0${entry.version}`, entry);
    }
  }
  return {
    generatedBy: GENERATED_BY,
    packages: [...entries.values()].sort((a, b) =>
      compare(a.name, b.name) || compare(a.version, b.version)),
  };
}

export function assetModule(manifest) {
  const entry = manifest.packages.find((pkg) =>
    pkg.name === "libheif-js" && pkg.delivery === "separate-unmodified-file");
  if (!entry?.assetPath || !entry.sha256) throw new Error("Missing separate browser asset");
  return `export const LIBHEIF_ASSET = { version: ${JSON.stringify(entry.version)}, path: ${JSON.stringify(entry.assetPath)}, sha256: ${JSON.stringify(entry.sha256)} } as const;\n`;
}

export async function generate(rootDir, config, check = false) {
  const manifest = await buildManifest(rootDir, config);
  const outputs = new Map([
    ["src/generated/third-party-licenses.json", Buffer.from(json(manifest))],
    ["src/generated/libheif-asset.ts", Buffer.from(assetModule(manifest))],
  ]);
  for (const text of Object.values(config.copyleftTexts)) {
    if (text.from) {
      const source = sourceReference(rootDir, text.from);
      outputs.set(`public/${text.public}`, readFileSync(source.path));
    }
  }
  for (const notice of config.extraNotices) {
    const source = sourceReference(rootDir, notice.from);
    outputs.set(`public/${substitute(notice.public, source.version)}`, readFileSync(source.path));
  }
  const stale = [];
  for (const [relative, bytes] of outputs) {
    const path = join(rootDir, relative);
    const previous = existsSync(path) ? readFileSync(path) : null;
    if (!previous?.equals(bytes)) {
      stale.push(`${relative}: ${previous ? `changed (${previous.length} -> ${bytes.length} bytes)` : "missing"}`);
      if (!check) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
    }
  }

  // These files are build artifacts, including during --check.
  const activeDirectories = new Map();
  for (const vendor of config.vendored) {
    const matching = manifest.packages.filter((entry) => entry.name === vendor.package);
    for (const entry of matching) {
      const directory = resolvePackageDir(rootDir, vendor.package);
      const source = join(directory, vendor.file);
      const targetDirectory = join(rootDir, "public", substitute(vendor.publicDir, entry.version));
      const target = join(targetDirectory, basename(vendor.file));
      mkdirSync(targetDirectory, { recursive: true });
      copyFileSync(source, target);
      if (hash(readFileSync(target)) !== entry.sha256) {
        throw new Error(`Copied asset hash mismatch: ${target}`);
      }
      const parent = dirname(targetDirectory);
      if (!activeDirectories.has(parent)) activeDirectories.set(parent, new Set());
      activeDirectories.get(parent).add(basename(targetDirectory));
    }
  }
  for (const [parent, active] of activeDirectories) {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!active.has(entry.name)) rmSync(join(parent, entry.name), { recursive: true, force: true });
    }
  }
  if (check && stale.length) {
    throw new Error(`Stale third-party outputs:\n${stale.map((line) => `  ${line}`).join("\n")}\nRun npm run licenses:generate.`);
  }
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    console.error("Usage: node scripts/third-party-licenses.mjs [--check]");
    process.exitCode = 1;
    return;
  }
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const config = readJson(join(rootDir, "third-party/browser-packages.json"));
  await generate(rootDir, config, args.includes("--check"));
  console.log(args.includes("--check") ? "Third-party outputs are current." : "Third-party outputs generated.");
}

if (
  typeof import.meta.url === "string" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
