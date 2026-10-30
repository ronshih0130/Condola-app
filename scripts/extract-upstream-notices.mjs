import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noticeMarker = /copyright|©|\(c\)\s*\d{4}|public\s+domain|permission\s+is\s+hereby\s+granted|redistribution|licen[cs]e|SPDX-License-Identifier/i;
const wholeFileName = /^(COPYING|LICEN[CS]E|NOTICE|AUTHORS|README)/i;
const sourceExtension = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl|S|s|asm)$/;

export const BUILD_INPUTS = [
  ["libheif-js", "scripts/install.js"],
  ["libheif-js", "scripts/bundle.js"],
  ["libheif-js", "package.json"],
  ["libheif-emscripten", ".github/workflows/emscripten.yml"],
  ["libheif-emscripten", "dist-prep.sh"],
  ["libheif-emscripten", ".gitmodules"],
  ["libheif", "build-emscripten.sh"],
  ["libheif", "scripts/run-ci.sh"],
];

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

/**
 * Return raw comment blocks, including original line endings and indentation.
 * Strings and C++ raw strings are skipped so comment-like string contents do
 * not truncate a real comment or become a fabricated notice.
 */
export function commentBlocks(text, ext = "") {
  const assembly = /^(?:\.?S|\.?s|\.?asm)$/.test(ext);
  const blocks = [];
  const lineStart = (offset) => text.lastIndexOf("\n", offset - 1) + 1;
  const rawStart = (offset) => {
    const start = lineStart(offset);
    return /^[ \t]*$/.test(text.slice(start, offset)) ? start : offset;
  };
  const afterLine = (offset) => {
    const end = text.indexOf("\n", offset);
    return end < 0 ? text.length : end + 1;
  };
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("/*", index)) {
      const start = rawStart(index);
      const close = text.indexOf("*/", index + 2);
      let end = close < 0 ? text.length : close + 2;
      const lineEnd = afterLine(end);
      if (/^[ \t]*(?:\r?\n)?$/.test(text.slice(end, lineEnd))) end = lineEnd;
      blocks.push(text.slice(start, end));
      index = end;
      continue;
    }

    const prefix = text.slice(lineStart(index), index);
    const assemblyComment = assembly && /^[ \t]*$/.test(prefix) &&
      /[#@;]/.test(text[index]);
    if (text.startsWith("//", index) || assemblyComment) {
      const start = rawStart(index);
      let end = afterLine(index);
      while (end < text.length) {
        const nextEnd = afterLine(end);
        const next = text.slice(end, nextEnd);
        const continuation = assembly
          ? /^[ \t]*(?:\/\/|[#@;])/.test(next)
          : /^[ \t]*\/\//.test(next);
        if (!continuation) break;
        end = nextEnd;
      }
      blocks.push(text.slice(start, end));
      index = end;
      continue;
    }

    const raw = text.slice(index).match(/^R"([^ ()\\\t\r\n]{0,16})\(/);
    if (raw) {
      const close = text.indexOf(`)${raw[1]}"`, index + raw[0].length);
      index = close < 0 ? text.length : close + raw[1].length + 2;
      continue;
    }

    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index++];
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
        } else if (text[index++] === quote) {
          break;
        }
      }
      continue;
    }
    index += 1;
  }
  return blocks;
}

/**
 * files: { path, text, ext?, whole? }[]
 * Whole-file inputs are retained even when their notices use no marker.
 */
export function noticeBlocks(files) {
  const occurrences = new Map();
  let filesWithoutNotice = 0;
  for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
    const whole = file.whole ?? wholeFileName.test(basename(file.path));
    const blocks = whole
      ? [file.text]
      : commentBlocks(file.text, file.ext ?? extname(file.path))
        .filter((block) => noticeMarker.test(block));
    if (!blocks.length) filesWithoutNotice += 1;
    for (const text of blocks) {
      if (!occurrences.has(text)) occurrences.set(text, new Set());
      occurrences.get(text).add(file.path.replaceAll("\\", "/"));
    }
  }
  return {
    filesScanned: files.length,
    filesWithoutNotice,
    blocks: [...occurrences]
      .sort(([a], [b]) => compare(a, b))
      .map(([text, paths]) => ({ text, paths: [...paths].sort(compare) })),
  };
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => compare(a.name, b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() &&
        (sourceExtension.test(entry.name) || wholeFileName.test(entry.name))
        ? [path] : [];
    });
}

export function extractionHeader(pin) {
  return `Notice extraction v3: verbatim blocks from ${pin.file} (${pin.sha256}).`;
}

export function formatNotices(result, pin) {
  const header = [
    extractionHeader(pin),
    `Files scanned: ${result.filesScanned}; files with no notice block: ${result.filesWithoutNotice}.`,
    "Conservative extraction: includes sources that may not be compiled into the shipped wasm, including encoder/plugin sources.",
    "See COPYING for the library's accompanying licence text.",
  ].join("\n");
  const blocks = result.blocks.map((block) =>
    `${block.text}${block.text.endsWith("\n") ? "" : "\n"}\nSource paths:\n${block.paths.map((path) => `  ${path}`).join("\n")}\n`);
  return `${header}\n\n${blocks.join("\n")}`;
}

export function extractLibraryNotices(sourceRoot, pin) {
  const files = sourceFiles(join(sourceRoot, pin.libraryDir)).map((path) => ({
    path: relative(sourceRoot, path).replaceAll("\\", "/"),
    text: readFileSync(path, "utf8"),
    ext: extname(path),
    whole: wholeFileName.test(basename(path)),
  }));
  const result = noticeBlocks(files);
  if (!result.blocks.length) throw new Error(`No notice blocks found: ${pin.file}`);
  return formatNotices(result, pin);
}

/**
 * The holders artifact retains the same complete blocks, including adjacent
 * permission conditions. The page derives its concise holder lines from it.
 */
export function holdersFromNotices(notices) {
  return `Copyright-holder reference; complete extracted notice blocks follow.\n${notices}`;
}

export function copyrightNotice(sourceRoot, pin) {
  return holdersFromNotices(extractLibraryNotices(sourceRoot, pin));
}

export function buildReadme(config) {
  const pins = Object.entries(config.upstreamSources)
    .sort(([a], [b]) => compare(a, b))
    .map(([name, pin]) =>
      `- ${name} ${pin.version} (${pin.kind}): ${pin.url}\n  File: ${pin.file}\n  SHA-256: ${pin.sha256}`)
    .join("\n");
  const p = config.buildProvenance;
  const version = config.upstreamSources["libheif-js"].version;
  return `# libheif-js build inputs

This directory preserves verbatim build inputs from the pinned source archives.

## Source archives

${pins}

## Shipped build chain

libheif-js ${version} scripts/install.js uses this upstream prebuilt release:
${p.prebuiltUrl}

Downloaded and verified on 2026-10-26.
Prebuilt archive SHA-256: ${p.prebuiltSha256}

The archive contains libheif/{LICENSE,libheif.js,libheif.d.ts} and libheif-wasm/{libheif.wasm,LICENSE,libheif.js,libheif.d.ts}.

The libheif-wasm/libheif.wasm in that archive is ${p.prebuiltWasmBytes} bytes.
Its SHA-256 is ${p.prebuiltWasmSha256}.
The wasm embedded as base64 by esbuild's binary loader in the shipped bundle decodes to exactly those bytes.

The prebuilt LICENSE matches libheif COPYING.

libheif-emscripten ${config.upstreamSources["libheif-emscripten"].version} pins its libheif git submodule at:
${p.libheifCommit}

That commit is libheif tag v${config.upstreamSources.libheif.version}.

The preserved .github/workflows/emscripten.yml runs on ubuntu-22.04 with Emscripten ${p.emscriptenVersion}. It runs libheif scripts/run-ci.sh with USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1, which invokes build-emscripten.sh. Defaults are ENABLE_LIBDE265=1, LIBDE265_VERSION=${config.upstreamSources.libde265.version}, ENABLE_AOM=0, ENABLE_OPENJPEG=0 and ENABLE_WEBCODECS=0.

dist-prep.sh copies libheif.js, libheif.wasm and libheif.d.ts, and copies libheif COPYING to LICENSE.

scripts/bundle.js imports ../libheif-wasm/libheif.js and ../libheif-wasm/libheif.wasm, then exports:
export default (opts = {}) => libheif({ ...opts, wasmBinary });

libheif-js scripts/install.js minifies with esbuild target es2019 and bundles scripts/bundle.js into libheif-wasm/libheif-bundle.mjs as ESM. Its banner is 'var process, __dirname;'. The wasm loader is binary, the platform is neutral, and fs/path are polyfilled with empty modules.

Using the libheif-js ${version} tag source, npm install and node scripts/install.js with the verified prebuilt archive reproduced the shipped bundle exactly.
Reproduction tools: Node ${p.reproducedWith.node}, esbuild ${p.reproducedWith.esbuild}, esbuild-plugins-node-modules-polyfill ${p.reproducedWith["esbuild-plugins-node-modules-polyfill"]}.
Reproduced and shipped bundle SHA-256: ${p.shippedBundleSha256}.

This reproduces the prebuilt-release-to-bundle step. We did not rebuild libheif/libde265 into wasm with Emscripten or byte-compare an Emscripten rebuild against the shipped wasm. Toolchain output may differ.

## Verify

Run from a working directory containing the downloaded upstream prebuilt libheif.tar.gz, the extracted libheif-js ${version} tag source as libheif-js-${version}, and a copy of the shipped libheif-bundle.mjs as shipped-libheif-bundle.mjs.

    printf '%s  %s\\n' '${p.prebuiltSha256}' libheif.tar.gz | sha256sum -c -
    mkdir prebuilt
    tar -xzf libheif.tar.gz -C prebuilt
    printf '%s  %s\\n' '${p.prebuiltWasmSha256}' prebuilt/libheif-wasm/libheif.wasm | sha256sum -c -
    test "$(wc -c < prebuilt/libheif-wasm/libheif.wasm)" -eq ${p.prebuiltWasmBytes}
    node --input-type=module -e 'import fs from "node:fs"; const s=fs.readFileSync("shipped-libheif-bundle.mjs","utf8"); const a=[...s.matchAll(/["\\x27]([A-Za-z0-9+/]{64,}={0,2})["\\x27]/g)].map(m=>Buffer.from(m[1],"base64")).filter(b=>b.subarray(0,4).equals(Buffer.from([0,97,115,109]))); if(a.length!==1)throw Error("Expected one embedded wasm"); fs.writeFileSync("embedded.wasm",a[0]);'
    cmp embedded.wasm prebuilt/libheif-wasm/libheif.wasm
    printf '%s  %s\\n' '${p.shippedBundleSha256}' shipped-libheif-bundle.mjs | sha256sum -c -
    cd libheif-js-${version}
    node --version
    npm install
    npm ls esbuild esbuild-plugins-node-modules-polyfill
    node scripts/install.js ../libheif.tar.gz
    printf '%s  %s\\n' '${p.shippedBundleSha256}' libheif-wasm/libheif-bundle.mjs | sha256sum -c -
    cmp libheif-wasm/libheif-bundle.mjs ../shipped-libheif-bundle.mjs

Use Node ${p.reproducedWith.node} and confirm the two dependency versions above before comparing reproduction results. npm install alone does not pin future dependency resolution.

## Rebuild or modify

1. Verify the four source archive hashes above and extract them. Install and activate emsdk ${p.emscriptenVersion}; source its environment script.
2. Place libheif v${config.upstreamSources.libheif.version}, commit ${p.libheifCommit}, in the libheif-emscripten submodule location. Follow the preserved workflow's setup and working-directory steps.
3. Run libheif scripts/run-ci.sh with USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1 as in the workflow, retaining the defaults above, including libde265 ${config.upstreamSources.libde265.version}.
4. Run the preserved dist-prep.sh and package the prepared distribution as libheif.tar.gz, preserving the libheif and libheif-wasm top directories. For small changes, an alternative is to edit libheif-wasm/libheif.js or libheif-wasm/libheif.wasm inside an extracted prebuilt archive and repack those same directories.
5. In the libheif-js ${version} source tree with its build dependencies installed, run node scripts/install.js <your-libheif.tar.gz>, supplying an absolute archive path.
6. Use the resulting libheif-wasm/libheif-bundle.mjs. Its default export must remain a factory returning a module with .ready and HeifDecoder, compatible with libheif-js ${version}.

## Written source offer

Anyone who wants the complete corresponding source from us may request it at ${config.sourceOfferEmail}. This written offer is valid for at least three years from the last distribution of the relevant decoder version. The links above identify upstream archives; this site does not host those source archives.

The preserved inputs document the upstream build procedure and the verified packaging step. They do not establish byte-identical Emscripten compilation from source.
`;
}

export function extractUpstream(rootDir, archiveDir, config) {
  const pins = Object.entries(config.upstreamSources).sort(([a], [b]) => compare(a, b));
  for (const [name, pin] of pins) {
    const actual = sha256(readFileSync(join(archiveDir, pin.file)));
    if (actual !== pin.sha256) {
      throw new Error(`${name}: SHA-256 mismatch for ${pin.file}; expected ${pin.sha256}, got ${actual}`);
    }
  }
  const temporary = mkdtempSync(join(tmpdir(), "condola-upstream-"));
  try {
    const extracted = new Map();
    for (const [name, pin] of pins) {
      const target = join(temporary, name);
      mkdirSync(target);
      execFileSync("tar", ["-xzf", resolve(archiveDir, pin.file), "-C", target], { stdio: "pipe" });
      extracted.set(name, join(target, pin.topDir));
    }
    const outputs = new Map();
    for (const name of ["libheif", "libde265"]) {
      const pin = config.upstreamSources[name];
      const sourceRoot = extracted.get(name);
      const prefix = `third-party/upstream/${name}-${pin.version}`;
      const notices = extractLibraryNotices(sourceRoot, pin);
      outputs.set(`${prefix}/COPYING`, readFileSync(join(sourceRoot, "COPYING")));
      if (name === "libde265") {
        outputs.set(`${prefix}/AUTHORS`, readFileSync(join(sourceRoot, "AUTHORS")));
      }
      outputs.set(`${prefix}/SOURCE-NOTICES.txt`, Buffer.from(notices));
      outputs.set(`${prefix}/COPYRIGHT-HOLDERS.txt`, Buffer.from(holdersFromNotices(notices)));
    }
    const buildPrefix = `third-party/upstream/libheif-js-${config.upstreamSources["libheif-js"].version}/build`;
    for (const [name, path] of BUILD_INPUTS) {
      outputs.set(`${buildPrefix}/${name}/${path}`, readFileSync(join(extracted.get(name), path)));
    }
    outputs.set(`${buildPrefix}/BUILD.md`, Buffer.from(buildReadme(config)));
    for (const [path, bytes] of outputs) atomicWrite(join(rootDir, path), bytes);
    return [...outputs.keys()].sort(compare);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node scripts/extract-upstream-notices.mjs <dir-with-archives>");
  }
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const config = JSON.parse(readFileSync(join(rootDir, "third-party/browser-packages.json"), "utf8"));
  const outputs = extractUpstream(rootDir, resolve(process.argv[2]), config);
  console.log(`Extracted ${outputs.length} upstream notice and build-input files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
