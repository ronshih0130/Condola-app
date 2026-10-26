import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => compare(a.name, b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.(?:c|cc|cpp|h|hpp|S|s)$/.test(entry.name)
        ? [path]
        : [];
    });
}

function stripComment(line) {
  return line
    .replace(/^\s*(?:\/\*+|\*|\/\/|#)\s?/, "")
    .trimEnd();
}

function commentContinuation(line) {
  return /^\s*(?:\*(?!\/)|\/\/|#)/.test(line);
}

export function copyrightNotice(sourceRoot, pin) {
  const occurrences = new Map();
  for (const path of sourceFiles(join(sourceRoot, pin.libraryDir))) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = stripComment(lines[index]);
      if (!/copyright\s*(\(c\)|©)/i.test(line)) continue;
      let item = occurrences.get(line);
      if (!item) {
        item = { paths: new Set(), continuations: new Set() };
        occurrences.set(line, item);
      }
      item.paths.add(relative(sourceRoot, path).replaceAll("\\", "/"));
      if (/\b(?:the|to|and|of|is|by|a|an)$|[,;]$/i.test(line)) {
        const continuation = [];
        for (let next = index + 1; next < lines.length; next += 1) {
          const raw = lines[next];
          const content = stripComment(raw);
          if (
            !commentContinuation(raw) ||
            !content.trim() ||
            /copyright\s*(\(c\)|©)/i.test(content)
          ) break;
          continuation.push(raw);
        }
        if (continuation.length) item.continuations.add(continuation.join("\n"));
      }
    }
  }
  if (!occurrences.size) throw new Error(`No copyright lines found: ${pin.file}`);
  const blocks = [...occurrences].sort(([a], [b]) => compare(a, b)).map(([line, item]) => {
    const continuations = [...item.continuations].sort(compare);
    return [
      line,
      ...continuations,
      ...[...item.paths].sort(compare).map((path) => `  ${path}`),
    ].join("\n");
  });
  return `Copyright lines quoted verbatim from ${pin.file} (${pin.sha256}), library sources only.\n\n${blocks.join("\n\n")}\n`;
}

export function buildReadme(config) {
  const pins = Object.entries(config.upstreamSources)
    .sort(([a], [b]) => compare(a, b))
    .map(([name, pin]) =>
      `- ${name} ${pin.version} (${pin.kind}): ${pin.url}\n  File: ${pin.file}\n  SHA-256: ${pin.sha256}`)
    .join("\n");
  const provenance = config.buildProvenance;
  return `# libheif-js build inputs

This directory preserves verbatim build inputs from the pinned source archives.

## Source archives

${pins}

## Shipped build chain

libheif-js ${config.upstreamSources["libheif-js"].version} scripts/install.js downloads the prebuilt archive:
${provenance.prebuiltUrl}

The prebuilt archive is identified here by its release URL. No SHA-256 for that prebuilt archive has been supplied.

libheif-emscripten ${config.upstreamSources["libheif-emscripten"].version} pins its libheif git submodule at:
${provenance.libheifCommit}

That commit is libheif tag v${config.upstreamSources.libheif.version}.

The .github/workflows/emscripten.yml workflow runs on ubuntu-22.04 with Emscripten ${provenance.emscriptenVersion}. It runs libheif scripts/run-ci.sh with USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1, which invokes build-emscripten.sh. Defaults are ENABLE_LIBDE265=1, LIBDE265_VERSION=${config.upstreamSources.libde265.version}, ENABLE_AOM=0, ENABLE_OPENJPEG=0 and ENABLE_WEBCODECS=0.

dist-prep.sh copies libheif.js, libheif.wasm and libheif.d.ts, and copies libheif COPYING to LICENSE.

libheif-js scripts/install.js minifies with esbuild target es2019 and bundles scripts/bundle.js into libheif-wasm/libheif-bundle.mjs as ESM. Its banner is 'var process, __dirname;'. The wasm loader is binary, the platform is neutral, and fs/path are polyfilled with empty modules.

## Reproduce

1. Verify the source archive hashes above and extract them. Install and activate emsdk ${provenance.emscriptenVersion}; source its environment script.
2. Check out libheif v${config.upstreamSources.libheif.version} at ${provenance.libheifCommit} in the libheif-emscripten submodule location. Follow the preserved workflow's setup and working-directory steps.
3. Run libheif scripts/run-ci.sh with USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1 as in the workflow. Retain the defaults listed above, including libde265 ${config.upstreamSources.libde265.version}.
4. Run the preserved dist-prep.sh as in the workflow and package its prepared distribution as libheif.tar.gz.
5. In the libheif-js ${config.upstreamSources["libheif-js"].version} source tree, install its declared build dependencies, then run:
   node scripts/install.js <libheif.tar.gz>
   Supply the local archive's path in place of <libheif.tar.gz>.
6. The resulting libheif-wasm/libheif-bundle.mjs is the separate browser module. For a modified build, preserve its compatible ES module factory interface.

The preserved scripts and workflow specify the complete command context and packaging steps. Rebuilding with the same inputs does not by itself guarantee byte-identical toolchain output.
`;
}

export function extractUpstream(rootDir, archiveDir, config) {
  const pins = Object.entries(config.upstreamSources).sort(([a], [b]) => compare(a, b));
  // Verify every archive before invoking tar or writing repository outputs.
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
      execFileSync("tar", [
        "-xzf", resolve(archiveDir, pin.file),
        "-C", target,
      ], { stdio: "pipe" });
      extracted.set(name, join(target, pin.topDir));
    }

    const outputs = new Map();
    for (const name of ["libheif", "libde265"]) {
      const pin = config.upstreamSources[name];
      const sourceRoot = extracted.get(name);
      const prefix = `third-party/upstream/${name}-${pin.version}`;
      outputs.set(`${prefix}/COPYING`, readFileSync(join(sourceRoot, "COPYING")));
      if (name === "libde265") {
        outputs.set(`${prefix}/AUTHORS`, readFileSync(join(sourceRoot, "AUTHORS")));
      }
      outputs.set(
        `${prefix}/COPYRIGHT-HOLDERS.txt`,
        Buffer.from(copyrightNotice(sourceRoot, pin)),
      );
    }
    const buildPrefix = `third-party/upstream/libheif-js-${config.upstreamSources["libheif-js"].version}/build`;
    for (const [name, path] of BUILD_INPUTS) {
      outputs.set(
        `${buildPrefix}/${name}/${path}`,
        readFileSync(join(extracted.get(name), path)),
      );
    }
    outputs.set(`${buildPrefix}/BUILD.md`, Buffer.from(buildReadme(config)));
    for (const [path, bytes] of outputs) {
      atomicWrite(join(rootDir, path), bytes);
    }
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
