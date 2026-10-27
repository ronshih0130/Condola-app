import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BUILD_INPUTS, buildReadme, extractionHeader, holdersFromNotices,
} from "./extract-upstream-notices.mjs";

const GENERATED_BY = "scripts/third-party-licenses.mjs";
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const copyleft = (license) => /\b(?:A?GPL|LGPL)-/i.test(license);
const lgpl = (license) => /\bLGPL-/i.test(license);
const substitute = (text, version) => text.replaceAll("{version}", version);

const SPDX_TEMPLATES = new Map([
  ["MIT", `MIT License

Copyright (c) {holders}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`],
  ["ISC", `ISC License

Copyright (c) {holders}

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`],
]);

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function resolvePackageDir(fromDir, name) {
  if (!/^(?:@[^/]+\/)?[^/]+$/.test(name)) throw new Error(`Invalid package name: ${name}`);
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
    .map((entry) => entry.name).sort(compare);
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
  const configured = config.copyrightHolders && Object.hasOwn(config.copyrightHolders, pkg.name);
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  const value = configured ? config.copyrightHolders[pkg.name] : author;
  const holders = typeof value === "string"
    ? value.replace(/<[^>]*>/g, "").replace(/\b[^\s<>@]+@[^\s<>@]+\b/g, "").trim()
    : "";
  if (!holders) throw new Error(`Missing copyright holders for ${pkg.name}`);
  return {
    licenseText: template.replace("{holders}", () => holders),
    licenseTextSource: "spdx-template",
  };
}

export function npmTarballUrl(name, version) {
  return `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
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
  if (!/^https?:\/\//.test(value)) throw new Error(`Unsupported repository URL: ${raw}`);
  return value.replace(/^http:\/\//, "https://");
}

function validateLibheifVersions(rootDir, collected) {
  const versions = new Set(collected.filter((item) => item.metadata.name === "libheif-js")
    .map((item) => item.metadata.version));
  const lock = readJson(join(rootDir, "package-lock.json"));
  for (const [path, item] of Object.entries(lock.packages ?? {})) {
    if (/(?:^|\/)node_modules\/libheif-js$/.test(path)) {
      if (typeof item.version !== "string") {
        throw new Error(`Missing libheif-js version in package-lock.json: ${path}`);
      }
      versions.add(item.version);
    }
  }
  if (versions.size !== 1) {
    throw new Error(`Exactly one libheif-js version is supported; found: ${[...versions].sort(compare).join(", ") || "(none)"}`);
  }
  return lock;
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
  const collected = [...packages.values()]
    .map((item) => ({ ...item, requiredBy: [...item.requiredBy].sort(compare) }))
    .sort((a, b) => compare(a.metadata.name, b.metadata.name) ||
      compare(a.metadata.version, b.metadata.version) || compare(a.directory, b.directory));
  validateLibheifVersions(rootDir, collected);
  return collected;
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

/** Verify literal embedded wasm without executing the bundle. No network access. */
export function verifyDecoderProvenance(bytes, provenance) {
  for (const field of ["prebuiltSha256", "prebuiltWasmSha256", "shippedBundleSha256"]) {
    if (!/^[a-f0-9]{64}$/.test(provenance[field] ?? "")) {
      throw new Error(`Decoder provenance: invalid ${field}`);
    }
  }
  if (!Number.isSafeInteger(provenance.prebuiltWasmBytes) || provenance.prebuiltWasmBytes <= 0) {
    throw new Error("Decoder provenance: invalid prebuiltWasmBytes");
  }
  const bundle = Buffer.from(bytes);
  const shippedBundleSha256 = hash(bundle);
  if (shippedBundleSha256 !== provenance.shippedBundleSha256) {
    throw new Error(`Decoder bundle SHA-256 mismatch: expected ${provenance.shippedBundleSha256}, got ${shippedBundleSha256}`);
  }
  const candidates = [];
  for (const match of bundle.toString("utf8").matchAll(/["']([A-Za-z0-9+/]{64,}={0,2})["']/g)) {
    const wasm = Buffer.from(match[1], "base64");
    if (wasm.toString("base64") !== match[1]) continue;
    if (wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) candidates.push(wasm);
  }
  if (candidates.length !== 1) {
    throw new Error(`Decoder bundle: expected exactly one base64 wasm literal with \\0asm magic; found ${candidates.length}`);
  }
  const wasm = candidates[0];
  const embeddedWasmSha256 = hash(wasm);
  if (wasm.length !== provenance.prebuiltWasmBytes) {
    throw new Error(`Embedded wasm length mismatch: expected ${provenance.prebuiltWasmBytes}, got ${wasm.length}`);
  }
  if (embeddedWasmSha256 !== provenance.prebuiltWasmSha256) {
    throw new Error(`Embedded wasm SHA-256 mismatch: expected ${provenance.prebuiltWasmSha256}, got ${embeddedWasmSha256}`);
  }
  return { shippedBundleSha256, embeddedWasmSha256, embeddedWasmBytes: wasm.length };
}

function sourceReference(rootDir, reference) {
  const parts = reference.split("/");
  const name = reference.startsWith("@") ? parts.splice(0, 2).join("/") : parts.shift();
  const directory = resolvePackageDir(rootDir, name);
  return { path: join(directory, ...parts), version: readJson(join(directory, "package.json")).version };
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

function upstreamPath(name, config) {
  const pin = config.upstreamSources[name];
  if (!pin) throw new Error(`Missing upstream source pin: ${name}`);
  return `${name}-${pin.version}`;
}

function walkFiles(directory, prefix = "") {
  if (!existsSync(directory)) {
    throw new Error(`Missing upstream directory: ${directory}; rerun licenses:extract-upstream.`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => compare(a.name, b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walkFiles(path, relative);
      if (!entry.isFile()) throw new Error(`Unsupported upstream filesystem entry: ${path}`);
      return [relative];
    });
}

function upstreamData(rootDir, config) {
  const base = join(rootDir, "third-party/upstream");
  const files = walkFiles(base);
  const bytes = new Map(files.map((file) => [file, readFileSync(join(base, file))]));
  const required = (path) => {
    const value = bytes.get(path);
    if (!value?.length) {
      throw new Error(`Missing or empty third-party/upstream/${path}; rerun licenses:extract-upstream.`);
    }
    return value;
  };
  const libraries = new Map();
  for (const name of ["libheif", "libde265"]) {
    const prefix = upstreamPath(name, config);
    const pin = config.upstreamSources[name];
    const sourceNotices = required(`${prefix}/SOURCE-NOTICES.txt`);
    const noticesText = sourceNotices.toString("utf8");
    const holdersBytes = required(`${prefix}/COPYRIGHT-HOLDERS.txt`);
    if (
      noticesText.split("\n")[0] !== extractionHeader(pin) ||
      !/^Files scanned: \d+; files with no notice block: \d+\.$/m.test(noticesText) ||
      !noticesText.includes("\nSource paths:\n") ||
      !holdersBytes.equals(Buffer.from(holdersFromNotices(noticesText)))
    ) {
      throw new Error(`Stale notice extraction for ${name}; rerun licenses:extract-upstream.`);
    }
    const holders = [...new Set(noticesText.split(/\r?\n/)
      .filter((line) => /copyright|©|\(c\)\s*\d{4}/i.test(line))
      .map((line) => line.replace(/^\s*(?:\/\*+|\/\/|[*#@;])?\s?/, "").trim())
      .filter((line) => /(?:copyright\s*(?:(?:\(c\)|©)\s*)?\d{4}|©\s*\d{4}|\(c\)\s*\d{4})/i.test(line)))]
      .sort(compare);
    if (!holders.length) throw new Error(`Empty copyright holders list: ${name}; rerun licenses:extract-upstream.`);
    libraries.set(name, {
      holders, holdersBytes, sourceNotices,
      copying: required(`${prefix}/COPYING`),
      authors: name === "libde265" ? required(`${prefix}/AUTHORS`) : null,
    });
  }
  const buildPrefix = `${upstreamPath("libheif-js", config)}/build`;
  for (const [name, path] of BUILD_INPUTS) required(`${buildPrefix}/${name}/${path}`);
  const build = required(`${buildPrefix}/BUILD.md`);
  if (!build.equals(Buffer.from(buildReadme(config)))) {
    throw new Error("Stale upstream BUILD.md; rerun licenses:extract-upstream.");
  }
  return { bytes, libraries, buildPrefix };
}

function archive(name, config) {
  const pin = config.upstreamSources[name];
  return { label: `${name} ${pin.version} (${pin.kind})`, url: pin.url, sha256: pin.sha256 };
}

function noticeBytes(upstream, config) {
  const chunks = [];
  for (const name of ["libheif", "libde265"]) {
    const item = upstream.libraries.get(name);
    chunks.push(Buffer.from(`=== ${name} ${config.upstreamSources[name].version} ===\n\n`));
    chunks.push(item.holdersBytes);
    if (item.authors) chunks.push(Buffer.from("\nAUTHORS\n\n"), item.authors);
    chunks.push(Buffer.from("\n\n----- SOURCE-NOTICES.txt -----\n\n"), item.sourceNotices);
    chunks.push(Buffer.from("\n\n----- COPYING -----\n\n"), item.copying, Buffer.from("\n\n"));
  }
  return Buffer.concat(chunks);
}

function npmIntegrity(lock, version) {
  const item = lock.packages?.["node_modules/libheif-js"];
  if (item?.version !== version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity ?? "")) {
    throw new Error("Missing matching sha512 integrity in package-lock.json node_modules/libheif-js");
  }
  return item.integrity;
}

function selfHostedFontEntries(rootDir, config) {
  const readVerified = (file) => {
    if (
      typeof file?.path !== "string" ||
      !/^public\/[^\\]+$/.test(file.path) ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")
    ) {
      throw new Error("Invalid self-hosted asset path or SHA-256");
    }
    const bytes = readFileSync(join(rootDir, file.path));
    const actual = hash(bytes);
    if (actual !== file.sha256) {
      throw new Error(`Self-hosted asset SHA-256 mismatch: ${file.path}; expected ${file.sha256}, got ${actual}`);
    }
    return bytes;
  };
  return (config.selfHostedAssets ?? []).map((asset) => {
    if (
      !/^(?:@[^/]+\/)?[^/]+$/.test(asset.package ?? "") ||
      typeof asset.version !== "string" || !asset.version.trim() ||
      asset.license !== "OFL-1.1" ||
      !Array.isArray(asset.files) || !asset.files.length ||
      asset.sourceArchive?.url !== npmTarballUrl(asset.package, asset.version) ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(asset.sourceArchive?.integrity ?? "")
    ) {
      throw new Error(`Invalid self-hosted font configuration: ${asset.package}`);
    }
    for (const file of asset.files) readVerified(file);
    const licenseText = readVerified(asset.licenseFile).toString("utf8");
    const copyrightHolders = [...new Set(licenseText.split(/\r?\n/)
      .filter((line) => /^\s*Copyright\s+\d{4}\b/i.test(line))
      .map((line) => line.trim()))].sort(compare);
    if (!copyrightHolders.length) {
      throw new Error(`Missing self-hosted font copyright lines: ${asset.package}`);
    }
    const repository = repositoryUrl(asset.repository);
    if (!repository) throw new Error(`Missing self-hosted font repository: ${asset.package}`);
    const file = asset.files[0];
    return {
      name: asset.package,
      version: asset.version,
      license: asset.license,
      licenseText,
      licenseTextSource: `public-file:${asset.licenseFile.path}`,
      licenseUrl: publicUrl(asset.licenseFile.path.slice("public/".length)),
      gplUrl: null,
      noticeUrl: null,
      sourceNoticesUrl: null,
      repository,
      sourceUrl: `https://www.npmjs.com/package/${asset.package}/v/${asset.version}`,
      sourceArchives: [{
        label: `${asset.package} ${asset.version} (npm)`,
        url: asset.sourceArchive.url,
        integrity: asset.sourceArchive.integrity,
      }],
      copyrightHolders,
      buildInputsUrl: null,
      buildInputFiles: [],
      buildProvenance: null,
      delivery: "self-hosted-font",
      assetPath: publicUrl(file.path.slice("public/".length)),
      sha256: file.sha256,
      requiredBy: ["brand-v2"],
    };
  });
}

export async function buildManifest(rootDir, config, options = {}) {
  verifySuppliedTexts(rootDir, config);
  const upstream = upstreamData(rootDir, config);
  const collected = collectBrowserPackages(rootDir, config);
  const lock = validateLibheifVersions(rootDir, collected);
  const entries = new Map();
  let verifiedProvenance;
  for (const item of collected) {
    const { metadata: pkg, directory, requiredBy } = item;
    const key = `${pkg.name}\0${pkg.version}`;
    if (copyleft(pkg.license) && !config.copyleftTexts[pkg.license]) {
      throw new Error(`No configured copyleft text for ${pkg.name}: ${pkg.license}`);
    }
    const vendor = config.vendored.find((entry) => entry.package === pkg.name);
    const notice = config.extraNotices.find((entry) => entry.from.startsWith(`${pkg.name}/`));
    const license = packageLicense(directory, pkg, config);
    const special = pkg.name === "libheif-js";
    if (special && pkg.version !== config.upstreamSources["libheif-js"].version) {
      throw new Error(`libheif-js ${pkg.version} does not match pinned upstream sources`);
    }
    const assetPath = vendor
      ? publicUrl(`${substitute(vendor.publicDir, pkg.version)}/${basename(vendor.file)}`) : null;
    const vendorBytes = vendor ? readFileSync(join(directory, vendor.file)) : null;
    if (special) {
      if (!vendorBytes || !assetPath) throw new Error("Missing separate decoder asset configuration");
      const checked = verifyDecoderProvenance(vendorBytes, config.buildProvenance);
      if (options.verifyPublic !== false || options.requirePublic) {
        const target = join(rootDir, "public", assetPath.slice(1));
        if (existsSync(target)) {
          verifyDecoderProvenance(readFileSync(target), config.buildProvenance);
        } else if (options.requirePublic) {
          throw new Error(`Missing vendored decoder ${assetPath}; run npm run licenses:vendor.`);
        }
      }
      verifiedProvenance = { ...config.buildProvenance, ...checked };
    }
    const entry = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      licenseText: copyleft(pkg.license) ? null : license.licenseText,
      licenseTextSource: license.licenseTextSource,
      licenseUrl: copyleft(pkg.license) ? publicUrl(config.copyleftTexts[pkg.license].public) : null,
      gplUrl: lgpl(pkg.license) ? publicUrl(config.copyleftTexts["GPL-3.0"].public) : null,
      noticeUrl: special ? `/third-party/libheif-js/${pkg.version}/NOTICE.txt`
        : notice ? publicUrl(substitute(notice.public, pkg.version)) : null,
      sourceNoticesUrl: null,
      repository: repositoryUrl(pkg.repository),
      sourceUrl: npmTarballUrl(pkg.name, pkg.version),
      sourceArchives: special ? [
        {
          label: `libheif-js ${pkg.version} (npm)`,
          url: npmTarballUrl(pkg.name, pkg.version),
          integrity: npmIntegrity(lock, pkg.version),
        },
        archive("libheif-js", config),
        archive("libheif-emscripten", config),
      ] : [],
      copyrightHolders: [],
      buildInputsUrl: special ? `/third-party/upstream/${upstream.buildPrefix}/BUILD.md` : null,
      buildInputFiles: special ? BUILD_INPUTS.map(([name, path]) => ({
        label: `${name}/${path}`,
        url: `/third-party/upstream/${upstream.buildPrefix}/${name}/${path}`,
      })) : [],
      buildProvenance: special ? verifiedProvenance : null,
      delivery: vendor ? "separate-unmodified-file" : "bundled",
      assetPath,
      sha256: vendorBytes ? hash(vendorBytes) : null,
      requiredBy,
    };
    const existing = entries.get(key);
    if (existing) {
      if (JSON.stringify({ ...existing, requiredBy: [] }) !== JSON.stringify({ ...entry, requiredBy: [] })) {
        throw new Error(`Conflicting metadata for ${pkg.name}@${pkg.version}`);
      }
      existing.requiredBy = [...new Set([...existing.requiredBy, ...requiredBy])].sort(compare);
    } else {
      entries.set(key, entry);
    }
  }
  for (const entry of selfHostedFontEntries(rootDir, config)) {
    const key = `${entry.name}\0${entry.version}`;
    if (entries.has(key)) {
      throw new Error(`Duplicate self-hosted font package: ${entry.name}@${entry.version}`);
    }
    entries.set(key, entry);
  }
  if (config.embedded.length) {
    const versions = await probeEmbedded(rootDir);
    for (const embedded of config.embedded) {
      const parents = [...entries.values()].filter((entry) => entry.name === embedded.parent);
      if (!parents.length) throw new Error(`Missing embedded parent ${embedded.parent}`);
      const version = versions[embedded.probe];
      if (!version) throw new Error(`Unknown embedded probe ${embedded.probe}`);
      const pin = config.upstreamSources[embedded.name];
      if (!pin || pin.version !== version) {
        throw new Error(`${embedded.name} ${version} does not match pinned upstream sources`);
      }
      const data = upstream.libraries.get(embedded.name);
      if (!data) throw new Error(`Missing upstream notices: ${embedded.name}`);
      const prefix = `/third-party/upstream/${upstreamPath(embedded.name, config)}`;
      const entry = {
        name: embedded.name,
        version,
        license: embedded.license,
        licenseText: null,
        licenseTextSource: `upstream-file:${upstreamPath(embedded.name, config)}/COPYING`,
        licenseUrl: `${prefix}/COPYING`,
        gplUrl: lgpl(embedded.license) ? publicUrl(config.copyleftTexts["GPL-3.0"].public) : null,
        noticeUrl: parents[0].noticeUrl,
        sourceNoticesUrl: `${prefix}/SOURCE-NOTICES.txt`,
        repository: embedded.homepage,
        sourceUrl: substitute(embedded.sourceUrlTemplate, version),
        sourceArchives: [archive(embedded.name, config)],
        copyrightHolders: data.holders,
        buildInputsUrl: parents[0].buildInputsUrl,
        buildInputFiles: [],
        buildProvenance: null,
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
    packages: [...entries.values()].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version)),
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
  const upstream = upstreamData(rootDir, config);
  const outputs = new Map([
    ["src/generated/third-party-licenses.json", Buffer.from(json(manifest))],
    ["src/generated/libheif-asset.ts", Buffer.from(assetModule(manifest))],
  ]);
  for (const text of Object.values(config.copyleftTexts)) {
    if (text.from) outputs.set(`public/${text.public}`, readFileSync(sourceReference(rootDir, text.from).path));
  }
  for (const notice of config.extraNotices) {
    const source = sourceReference(rootDir, notice.from);
    outputs.set(`public/${substitute(notice.public, source.version)}`, readFileSync(source.path));
  }
  for (const [path, bytes] of upstream.bytes) outputs.set(`public/third-party/upstream/${path}`, bytes);
  outputs.set(
    `public/third-party/libheif-js/${config.upstreamSources["libheif-js"].version}/NOTICE.txt`,
    noticeBytes(upstream, config),
  );
  const stale = [];
  for (const [relative, bytes] of outputs) {
    const path = join(rootDir, relative);
    const previous = existsSync(path) ? readFileSync(path) : null;
    if (!previous?.equals(bytes)) {
      stale.push(`${relative}: ${previous ? `changed (${previous.length} -> ${bytes.length} bytes)` : "missing"}`);
      if (!check) atomicWrite(path, bytes);
    }
  }
  if (check && stale.length) {
    throw new Error(`Stale third-party outputs:\n${stale.map((line) => `  ${line}`).join("\n")}\nRun npm run licenses:generate.`);
  }
  return manifest;
}

export async function vendorAssets(rootDir, config) {
  const collected = collectBrowserPackages(rootDir, config);
  const manifest = await buildManifest(rootDir, config, { verifyPublic: false });
  for (const vendor of config.vendored) {
    const items = collected.filter((item) => item.metadata.name === vendor.package);
    const versions = [...new Set(items.map((item) => item.metadata.version))];
    if (versions.length !== 1) {
      throw new Error(`Vendoring requires one ${vendor.package} version; found: ${versions.join(", ")}`);
    }
    const item = items[0];
    const entry = manifest.packages.find((pkg) =>
      pkg.name === vendor.package && pkg.version === item.metadata.version);
    const sourceBytes = readFileSync(join(item.directory, vendor.file));
    if (!entry?.sha256 || hash(sourceBytes) !== entry.sha256) {
      throw new Error(`Vendor source hash mismatch: ${vendor.package}`);
    }
    const targetDirectory = join(rootDir, "public", substitute(vendor.publicDir, item.metadata.version));
    const target = join(targetDirectory, basename(vendor.file));
    atomicWrite(target, sourceBytes);
    if (hash(readFileSync(target)) !== entry.sha256) throw new Error(`Copied asset hash mismatch: ${target}`);
    if (vendor.package === "libheif-js") verifyDecoderProvenance(readFileSync(target), config.buildProvenance);
    const parent = dirname(targetDirectory);
    for (const other of readdirSync(parent, { withFileTypes: true })) {
      if (other.isDirectory() && other.name !== basename(targetDirectory)) {
        rmSync(join(parent, other.name), { recursive: true, force: true });
      }
    }
  }
  return manifest;
}

function packageKeys(packages, label) {
  if (!Array.isArray(packages)) throw new Error(`${label} must be an array`);
  const keys = new Set();
  for (const item of packages) {
    if (typeof item?.name !== "string" || !item.name.trim() ||
        typeof item.version !== "string" || !item.version.trim()) {
      throw new Error(`Invalid ${label} entry`);
    }
    keys.add(`${item.name}@${item.version}`);
  }
  return keys;
}

export function verifyBundle(manifest, bundled, config) {
  const manifestKeys = packageKeys(manifest.packages, "manifest packages");
  const bundledKeys = packageKeys(bundled, "client packages");
  const exceptions = config.notInWebpackBundle ?? {};
  for (const [name, reason] of Object.entries(exceptions)) {
    if (!name.trim() || typeof reason !== "string" || !reason.trim()) {
      throw new Error(`Missing notInWebpackBundle reason: ${name}`);
    }
  }
  return {
    missing: [...bundledKeys].filter((key) => !manifestKeys.has(key)).sort(compare),
    unexpected: manifest.packages
      .filter((item) => item.delivery !== "self-hosted-font")
      .filter((item) => !bundledKeys.has(`${item.name}@${item.version}`) && !Object.hasOwn(exceptions, item.name))
      .map((item) => `${item.name}@${item.version}`)
      .filter((key, index, all) => all.indexOf(key) === index).sort(compare),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const modes = ["--check", "--vendor", "--verify-bundle"];
  if (args.length > 1 || args.some((arg) => !modes.includes(arg))) {
    throw new Error("Usage: node scripts/third-party-licenses.mjs [--check | --vendor | --verify-bundle]");
  }
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const config = readJson(join(rootDir, "third-party/browser-packages.json"));
  const mode = args[0];
  if (mode === "--verify-bundle") {
    const path = join(rootDir, ".next/client-packages.json");
    if (!existsSync(path)) {
      throw new Error("Missing .next/client-packages.json; run the production Next webpack build first.");
    }
    await buildManifest(rootDir, config, { requirePublic: true });
    const manifest = readJson(join(rootDir, "src/generated/third-party-licenses.json"));
    const bundled = readJson(path);
    const result = verifyBundle(manifest, bundled, config);
    if (result.missing.length || result.unexpected.length) {
      throw new Error([
        "Client bundle licence verification failed.",
        "Bundled packages missing from manifest:",
        ...(result.missing.length ? result.missing.map((key) => `  ${key}`) : ["  (none)"]),
        "Manifest packages absent from client bundle without a configured reason:",
        ...(result.unexpected.length ? result.unexpected.map((key) => `  ${key}`) : ["  (none)"]),
        "Adjust third-party/browser-packages.json roots/exclude/notInWebpackBundle, regenerate, and rebuild.",
      ].join("\n"));
    }
    console.log(`Client bundle verified: ${packageKeys(bundled, "client packages").size} packages; ${manifest.packages.length} manifest entries.`);
    return;
  }
  if (mode === "--vendor") {
    await vendorAssets(rootDir, config);
    console.log("Separate browser assets vendored and verified.");
    return;
  }
  await generate(rootDir, config, mode === "--check");
  console.log(mode === "--check" ? "Third-party outputs are current." : "Third-party outputs generated.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
