import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  assetModule, buildManifest, collectBrowserPackages, npmTarballUrl,
  readLicenseText, resolvePackageDir, verifyBundle, verifyDecoderProvenance,
} from "../../scripts/third-party-licenses.mjs";
import {
  buildReadme, commentBlocks, extractionHeader, formatNotices,
  holdersFromNotices, noticeBlocks,
} from "../../scripts/extract-upstream-notices.mjs";
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
  return JSON.parse(readFileSync(join(resolvePackageDir(fromDir, name), "package.json"), "utf8")).version;
}

test("generated manifest and asset module are current", async () => {
  assert.deepEqual(await buildManifest(root, config), manifest);
  assert.equal(read("src/generated/libheif-asset.ts"), assetModule(manifest));
  assert.deepEqual(licenseEntries(), manifest.packages);
});

test("self-hosted brand fonts retain shipped licences and pinned provenance", () => {
  const assets = config.selfHostedAssets;
  assert.ok(assets);
  assert.deepEqual(assets.map((asset) => asset.package).sort(), [
    "@fontsource-variable/inter",
    "@fontsource-variable/plus-jakarta-sans",
  ]);
  const fonts = manifest.packages.filter((entry) => entry.delivery === "self-hosted-font");
  assert.equal(fonts.length, 2);
  for (const asset of assets) {
    const entry = fonts.find((item) => item.name === asset.package);
    assert.ok(entry, asset.package);
    assert.equal(entry.version, "5.3.0");
    assert.equal(entry.version, asset.version);
    assert.equal(entry.license, "OFL-1.1");
    assert.equal(entry.delivery, "self-hosted-font");
    assert.equal(deliveryLabelKey(entry.delivery), "i_lic_delivery_font");
    assert.equal(entry.licenseText, read(asset.licenseFile.path));
    assert.equal(entry.licenseTextSource, `public-file:${asset.licenseFile.path}`);
    assert.equal(entry.licenseUrl, `/${asset.licenseFile.path.slice("public/".length)}`);
    assert.equal(sha256(readFileSync(join(root, asset.licenseFile.path))), asset.licenseFile.sha256);
    for (const file of asset.files) {
      assert.equal(sha256(readFileSync(join(root, file.path))), file.sha256, file.path);
    }
    assert.equal(entry.assetPath, `/${asset.files[0].path.slice("public/".length)}`);
    assert.equal(entry.sha256, asset.files[0].sha256);
    assert.deepEqual(entry.copyrightHolders, [...new Set(read(asset.licenseFile.path)
      .split(/\r?\n/)
      .filter((line) => /^\s*Copyright\s+\d{4}\b/i.test(line))
      .map((line) => line.trim()))].sort());
    assert.ok(entry.copyrightHolders.length);
    assert.equal(entry.sourceUrl,
      `https://www.npmjs.com/package/${asset.package}/v/${asset.version}`);
    assert.equal(entry.repository, asset.repository);
    assert.deepEqual(entry.sourceArchives, [{
      label: `${asset.package} ${asset.version} (npm)`,
      url: npmTarballUrl(asset.package, asset.version),
      integrity: asset.sourceArchive.integrity,
    }]);
  }
});

test("self-hosted font and licence hash mismatches reject manifest generation", async () => {
  const assets = config.selfHostedAssets;
  assert.ok(assets?.length);
  for (const asset of assets) {
    for (const file of [...asset.files, asset.licenseFile]) {
      const changed = structuredClone(config);
      const changedAsset = changed.selfHostedAssets?.find((item) => item.package === asset.package);
      assert.ok(changedAsset);
      const changedFile = [...changedAsset.files, changedAsset.licenseFile]
        .find((item) => item.path === file.path);
      assert.ok(changedFile);
      changedFile.sha256 = "0".repeat(64);
      await assert.rejects(buildManifest(root, changed), /Self-hosted asset SHA-256 mismatch/);
    }
  }
});

test("browser graph includes required packages and excludes server encoders and build tools", () => {
  const required = [
    "libheif-js", "heic-decode", "heic-convert", "react", "react-dom", "scheduler",
    "next", "@swc/helpers", "tslib", "pdf-lib", "@pdf-lib/fontkit",
    "@pdf-lib/standard-fonts", "@pdf-lib/upng", "pako", "tailwindcss",
  ];
  const collected = collectBrowserPackages(root, config);
  for (const name of required) {
    const resolved = collected.filter((entry) => entry.metadata.name === name);
    assert.ok(resolved.length, name);
    for (const entry of resolved) {
      assert.ok(manifest.packages.some((pkg) =>
        pkg.name === name && pkg.version === entry.metadata.version), name);
    }
  }
  for (const name of ["jpeg-js", "pngjs", "postcss", "sharp", "caniuse-lite"]) {
    assert.equal(manifest.packages.some((entry) => entry.name === name), false, name);
  }
  for (const name of ["libheif-js", "heic-decode", "heic-convert", "react", "react-dom", "next", "pdf-lib"]) {
    assert.ok(manifest.packages.some((entry) =>
      entry.name === name && entry.version === packageVersion(name)), name);
  }
  assert.ok(manifest.packages.some((entry) =>
    entry.name === "tslib" && entry.version === packageVersion("tslib", resolvePackageDir(root, "pdf-lib"))));
  const asset = manifest.packages.find((entry) => entry.name === "libheif-js");
  assert.ok(asset);
  assert.equal(asset.license, "LGPL-3.0");
  assert.equal(asset.licenseUrl, "/third-party/LGPL-3.0.txt");
  assert.equal(asset.gplUrl, "/third-party/GPL-3.0.txt");
  assert.equal(asset.sourceUrl, npmTarballUrl("libheif-js", asset.version));
  assert.equal(asset.delivery, "separate-unmodified-file");
  assert.equal(asset.version, LIBHEIF_ASSET.version);
  assert.equal(asset.assetPath, LIBHEIF_ASSET.path);
  assert.equal(asset.sha256, LIBHEIF_ASSET.sha256);
  assert.equal(asset.sha256, sha256(readFileSync(
    join(resolvePackageDir(root, "libheif-js"), "libheif-wasm/libheif-bundle.mjs"),
  )));
  for (const [name, version] of [["libheif", "1.23.5"], ["libde265", "1.0.15"]]) {
    const entry = manifest.packages.find((pkg) => pkg.name === name);
    assert.ok(entry);
    assert.equal(entry.version, version);
    assert.equal(entry.license, "LGPL-3.0");
    assert.equal(entry.delivery, "inside:libheif-js");
    assert.match(entry.sourceUrl, /^https:\/\/github\.com\/strukturag\/[^/]+\/releases\/tag\/v/);
    assert.ok(entry.requiredBy.includes("heic-convert"));
  }
});

test("every package provides its licence and source link", () => {
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

test("public copyleft texts and upstream COPYING retain exact bytes", () => {
  const directory = resolvePackageDir(root, "libheif-js");
  assert.deepEqual(readFileSync(join(root, "public/third-party/LGPL-3.0.txt")),
    readFileSync(join(directory, "LICENSE")));
  assert.equal(sha256(readFileSync(join(root, "public/third-party/GPL-3.0.txt"))), gplHash);
  assert.deepEqual(
    readFileSync(join(root, `public/third-party/libheif-js/${LIBHEIF_ASSET.version}/LICENSE`)),
    readFileSync(join(directory, "libheif-wasm/LICENSE")),
  );
  assert.deepEqual(readFileSync(join(root, "third-party/upstream/libheif-1.23.5/COPYING")),
    readFileSync(join(directory, "libheif-wasm/LICENSE")));
});

const peslyak = `/*
 * This software was written by Alexander Peslyak in 2001. No copyright is
 * claimed, and the software is hereby placed in the public domain.
 * Copyright (c) 2001 Alexander Peslyak and it is hereby released to the
 * general public under the following terms:
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted.
 *
 * There's ABSOLUTELY NO WARRANTY, express or implied.
 * (This is a heavily cut-down "BSD license".)
 *
 * This trailing paragraph must also be retained.
 */
`;
const bsd = `//***************************************************************************
// Copyright 2024 Example contributors
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// 1. Redistributions of source code must retain the above copyright notice.
// 2. Redistributions in binary form must reproduce this list of conditions.
// THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTIES.
// IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY DAMAGES.
//***************************************************************************/
`;
const mit = `/*****
 * MIT License
 * Copyright (c) 2018 Example Author
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software to deal in the Software without restriction.
 * The above copyright notice and this permission notice shall be included.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */
`;

test("comment blocks preserve complete Peslyak, BSD-2 and MIT notices verbatim", () => {
  for (const block of [peslyak, bsd, mit]) {
    assert.deepEqual(commentBlocks(`${block}\nint value = 0;\n`, ".cc"), [block]);
    const result = noticeBlocks([{ path: "lib/sample.cc", text: `${block}\nint value;` }]);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].text, block);
  }
  assert.ok(peslyak.includes("Redistribution and use in source and binary forms, with or without modification, are permitted."));
  assert.ok(bsd.includes("// 1."));
  assert.ok(bsd.includes("// 2."));
  assert.ok(bsd.includes("IN NO EVENT"));
});

test("assembly runs, marker forms, whole files and unrelated comments", () => {
  for (const marker of ["@", "#", ";"]) {
    const block = `${marker} (c) 2024 Example\n${marker} Redistribution permitted\n${marker} disclaimer\n`;
    const result = noticeBlocks([{ path: "lib/a.S", text: `${block}mov r0, r1\n` }]);
    assert.deepEqual(result.blocks, [{ text: block, paths: ["lib/a.S"] }]);
  }
  for (const marker of ["© 2024 Example", "SPDX-License-Identifier: MIT", "public domain"]) {
    assert.equal(noticeBlocks([{ path: "lib/a.hxx", text: `/* ${marker} */` }]).blocks.length, 1);
  }
  const unrelated = noticeBlocks([{ path: "lib/a.c", text: "/* unrelated implementation comment */\nint a;" }]);
  assert.equal(unrelated.blocks.length, 0);
  assert.equal(unrelated.filesWithoutNotice, 1);
  assert.deepEqual(commentBlocks('const char *s = "/* copyright fake */";\n' + mit, ".cpp"), [mit]);
  const whole = "Contributors\nA Person\n";
  assert.equal(noticeBlocks([{ path: "lib/AUTHORS.extra", text: whole }]).blocks[0].text, whole);
});

test("notice extraction deduplicates exact text and sorts paths and output deterministically", () => {
  const files = [
    { path: "lib/z.c", text: peslyak },
    { path: "lib/a.c", text: peslyak },
    { path: "lib/b.hxx", text: mit },
    { path: "lib/no.cxx", text: "/* unrelated */" },
  ];
  const result = noticeBlocks(files);
  assert.deepEqual(result, noticeBlocks([...files].reverse()));
  assert.equal(result.filesScanned, 4);
  assert.equal(result.filesWithoutNotice, 1);
  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks.find((block) => block.text === peslyak)?.paths, ["lib/a.c", "lib/z.c"]);
  const formatted = formatNotices(result, config.upstreamSources.libde265);
  assert.equal(formatted, formatNotices(noticeBlocks([...files].reverse()), config.upstreamSources.libde265));
  assert.ok(formatted.includes(peslyak));
  assert.ok(formatted.includes("Files scanned: 4; files with no notice block: 1."));
  const crlf = peslyak.replaceAll("\n", "\r\n");
  assert.equal(commentBlocks(crlf, ".c")[0], crlf);
});

function allFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  }).sort();
}

test("upstream notices, holders, archives and build provenance are preserved", () => {
  const asset = manifest.packages.find((entry) => entry.name === "libheif-js");
  assert.ok(asset?.noticeUrl);
  const notice = readFileSync(join(root, "public", asset.noticeUrl.slice(1)));
  for (const name of ["libheif", "libde265"]) {
    const entry = manifest.packages.find((item) => item.name === name);
    assert.ok(entry);
    assert.ok(entry.copyrightHolders.some((line) => line.includes("Dirk Farin")));
    if (name === "libde265") {
      assert.ok(entry.copyrightHolders.some((line) => line.includes("struktur AG")));
    }
    const prefix = `third-party/upstream/${name}-${entry.version}`;
    const sourceNotices = read(`${prefix}/SOURCE-NOTICES.txt`);
    assert.equal(sourceNotices.split("\n")[0], extractionHeader(config.upstreamSources[name]));
    assert.equal(read(`${prefix}/COPYRIGHT-HOLDERS.txt`), holdersFromNotices(sourceNotices));
    assert.equal(entry.sourceNoticesUrl, `/${prefix}/SOURCE-NOTICES.txt`);
    assert.ok(notice.includes(Buffer.from(sourceNotices)));
    for (const line of entry.copyrightHolders) {
      assert.ok(read(`${prefix}/COPYRIGHT-HOLDERS.txt`).includes(line), line);
    }
    assert.ok(notice.includes(readFileSync(join(root, prefix, "COPYING"))));
    if (name === "libde265") assert.ok(notice.includes(readFileSync(join(root, prefix, "AUTHORS"))));
    assert.equal(entry.noticeUrl, asset.noticeUrl);
    assert.equal(entry.licenseUrl, `/${prefix}/COPYING`);
    const pin = config.upstreamSources[name];
    assert.deepEqual(entry.sourceArchives, [{
      label: `${name} ${pin.version} (${pin.kind})`, url: pin.url, sha256: pin.sha256,
    }]);
  }
  const de265 = read("third-party/upstream/libde265-1.0.15/SOURCE-NOTICES.txt");
  assert.ok(de265.includes("Redistribution and use in source and binary forms, with or without"));
  assert.ok(de265.includes("heavily cut-down"));
  assert.ok(de265.includes("the properties of the two independent implementations."));
  const heif = read("third-party/upstream/libheif-1.23.5/SOURCE-NOTICES.txt");
  assert.ok(heif.includes("Permission is hereby granted"));
  assert.ok(heif.includes("heif_cxx.h"));
  assert.ok(heif.includes("encoder_openjph"));
  assert.ok(heif.includes("Redistributions in binary form"));
  for (const file of allFiles(join(root, "third-party/upstream"))) {
    const path = relative(join(root, "third-party/upstream"), file);
    assert.deepEqual(readFileSync(file), readFileSync(join(root, "public/third-party/upstream", path)));
  }
  assert.ok(asset.buildInputsUrl);
  const build = read(`public${asset.buildInputsUrl}`);
  assert.equal(build, buildReadme(config));
  for (const pin of Object.values(config.upstreamSources)) {
    assert.ok(build.includes(pin.url));
    assert.ok(build.includes(pin.sha256));
  }
  for (const value of [
    config.buildProvenance.libheifCommit, config.buildProvenance.emscriptenVersion,
    config.buildProvenance.prebuiltSha256, config.buildProvenance.prebuiltWasmSha256,
    config.buildProvenance.shippedBundleSha256, config.sourceOfferEmail,
  ]) assert.ok(build.includes(value));
  assert.ok(build.includes("We did not rebuild"));
  assert.ok(build.includes("## Verify"));
  assert.ok(build.includes("at least three years"));
  for (const file of asset.buildInputFiles) {
    assert.ok(readFileSync(join(root, "public", file.url.slice(1))).length, file.label);
  }
  for (const name of ["libheif-js", "libheif-emscripten"]) {
    const pin = config.upstreamSources[name];
    assert.equal(asset.sourceArchives.find((item) => item.url === pin.url)?.sha256, pin.sha256);
  }
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(asset.sourceArchives.find((item) => item.url === asset.sourceUrl)?.integrity,
    lock.packages["node_modules/libheif-js"].integrity);
});

test("vendored provenance matches pins and rejects tampered bundle or wasm", () => {
  const bytes = readFileSync(
    join(resolvePackageDir(root, "libheif-js"), "libheif-wasm/libheif-bundle.mjs"),
  );
  const verified = verifyDecoderProvenance(bytes, config.buildProvenance);
  const publicPath = join(root, "public", LIBHEIF_ASSET.path.slice(1));
  if (existsSync(publicPath)) {
    assert.deepEqual(verifyDecoderProvenance(readFileSync(publicPath), config.buildProvenance), verified);
  }
  assert.equal(verified.shippedBundleSha256, config.buildProvenance.shippedBundleSha256);
  assert.equal(verified.embeddedWasmSha256, config.buildProvenance.prebuiltWasmSha256);
  assert.equal(verified.embeddedWasmBytes, config.buildProvenance.prebuiltWasmBytes);
  const asset = manifest.packages.find((entry) => entry.name === "libheif-js");
  assert.deepEqual(asset?.buildProvenance, { ...config.buildProvenance, ...verified });
  assert.throws(() => verifyDecoderProvenance(Buffer.concat([bytes, Buffer.from("\n// tampered")]),
    config.buildProvenance), /bundle SHA-256 mismatch/);
  assert.throws(() => verifyDecoderProvenance(bytes, {
    ...config.buildProvenance, prebuiltWasmSha256: "0".repeat(64),
  }), /wasm SHA-256 mismatch/);
  assert.throws(() => verifyDecoderProvenance(bytes, {
    ...config.buildProvenance, prebuiltWasmBytes: config.buildProvenance.prebuiltWasmBytes + 1,
  }), /wasm length mismatch/);
  const synthetic = Buffer.from('export default "bm90LXdhc20=";');
  assert.throws(() => verifyDecoderProvenance(synthetic, {
    ...config.buildProvenance, shippedBundleSha256: sha256(synthetic),
  }), /expected exactly one base64 wasm literal/);
});

test("generation checks optional public decoder and --verify-bundle requires it", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "condola-licenses-"));
  try {
    for (const path of ["scripts", "third-party", "src/generated"]) {
      cpSync(join(root, path), join(temporary, path), { recursive: true });
    }
    cpSync(join(root, "public"), join(temporary, "public"), {
      recursive: true,
      filter: (path) => path !== join(root, "public/vendor"),
    });
    for (const path of ["package.json", "package-lock.json"]) {
      cpSync(join(root, path), join(temporary, path));
    }
    symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), "junction");
    mkdirSync(join(temporary, ".next"));
    writeFileSync(join(temporary, ".next/client-packages.json"), JSON.stringify(
      manifest.packages.filter((entry) => entry.delivery !== "self-hosted-font")
        .map(({ name, version }) => ({ name, version })),
    ));
    const target = join(temporary, "public", LIBHEIF_ASSET.path.slice(1));
    const bytes = readFileSync(
      join(resolvePackageDir(root, "libheif-js"), "libheif-wasm/libheif-bundle.mjs"),
    );
    const run = (mode: string) => execFileSync(
      process.execPath, ["scripts/third-party-licenses.mjs", mode],
      { cwd: temporary, stdio: "pipe" },
    );
    const checkUnchanged = () => {
      const directories = ["public", "src/generated"].map((path) => join(temporary, path));
      const before = directories.map(snapshot);
      run("--check");
      assert.deepEqual(directories.map(snapshot), before);
    };

    assert.deepEqual(await buildManifest(temporary, config), manifest);
    checkUnchanged();
    assert.equal(existsSync(join(temporary, "public/vendor")), false);
    assert.throws(() => run("--verify-bundle"), /Missing vendored decoder/);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    assert.deepEqual(await buildManifest(temporary, config), manifest);
    checkUnchanged();
    run("--verify-bundle");

    for (const asset of config.selfHostedAssets ?? []) {
      for (const file of [...asset.files, asset.licenseFile]) {
        const path = join(temporary, file.path);
        const original = readFileSync(path);
        try {
          writeFileSync(path, Buffer.concat([original, Buffer.from("\n// tampered")]));
          await assert.rejects(buildManifest(temporary, config), /Self-hosted asset SHA-256 mismatch/);
          assert.throws(() => run("--check"), /Self-hosted asset SHA-256 mismatch/);
          assert.throws(() => run("--verify-bundle"), /Self-hosted asset SHA-256 mismatch/);
        } finally {
          writeFileSync(path, original);
        }
      }
    }
    checkUnchanged();

    writeFileSync(target, Buffer.concat([bytes, Buffer.from("\n// tampered")]));
    await assert.rejects(buildManifest(temporary, config), /bundle SHA-256 mismatch/);
    assert.throws(() => run("--check"), /bundle SHA-256 mismatch/);
    assert.throws(() => run("--verify-bundle"), /bundle SHA-256 mismatch/);

    run("--vendor");
    assert.deepEqual(readFileSync(target), bytes);
    run("--verify-bundle");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function snapshotPaths(directory: string): string[] {
  return [directory, ...readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? snapshotPaths(path) : [path];
  })];
}

function snapshot(directory: string) {
  if (!existsSync(directory)) return [];
  return snapshotPaths(directory).sort().map((path) => {
    const stat = statSync(path, { bigint: true });
    return {
      path: relative(root, path),
      mtime: stat.mtimeNs.toString(),
      size: stat.size.toString(),
      kind: stat.isDirectory() ? "directory" : "file",
      hash: stat.isFile() ? sha256(readFileSync(path)) : null,
    };
  });
}

test("--check leaves public and generated listings, bytes and mtimes unchanged", () => {
  const directories = ["public", "src/generated"].map((path) => join(root, path));
  const before = directories.map(snapshot);
  execFileSync(process.execPath, ["scripts/third-party-licenses.mjs", "--check"], {
    cwd: root, stdio: "pipe",
  });
  assert.deepEqual(directories.map(snapshot), before);
});

test("verifyBundle reports exact missing and unexpected versions without mutation", () => {
  const existing = manifest.packages[0];
  assert.ok(existing);
  const fake = { packages: [
    { ...existing, name: "present", version: "1.0.0", delivery: "bundled" as const },
    { ...existing, name: "absent", version: "2.0.0", delivery: "bundled" as const },
    { ...existing, name: "separate", version: "3.0.0", delivery: "separate-unmodified-file" as const },
  ] };
  const bundled = [
    { name: "present", version: "1.0.0" }, { name: "present", version: "1.0.0" },
    { name: "present", version: "2.0.0" }, { name: "extra", version: "4.0.0" },
  ];
  const options = { notInWebpackBundle: { separate: "Separate static file." } };
  const before = JSON.stringify({ fake, bundled, options });
  assert.deepEqual(verifyBundle(fake, bundled, options), {
    missing: ["extra@4.0.0", "present@2.0.0"], unexpected: ["absent@2.0.0"],
  });
  assert.equal(JSON.stringify({ fake, bundled, options }), before);
  assert.deepEqual(verifyBundle({ packages: [fake.packages[0]] },
    [{ name: "present", version: "1.0.0" }], { notInWebpackBundle: {} }),
  { missing: [], unexpected: [] });
  assert.throws(() => verifyBundle(fake, bundled, { notInWebpackBundle: { separate: "" } }), /reason/);
});

test("verifyBundle ignores self-hosted fonts absent from the client bundle", () => {
  const fonts = manifest.packages.filter((entry) => entry.delivery === "self-hosted-font");
  assert.equal(fonts.length, 2);
  const before = JSON.stringify(fonts);
  assert.deepEqual(verifyBundle({ packages: fonts }, [], { notInWebpackBundle: {} }),
    { missing: [], unexpected: [] });
  assert.deepEqual(verifyBundle({ packages: fonts },
    [{ name: "unlisted-client-package", version: "1.0.0" }],
    { notInWebpackBundle: {} }),
  { missing: ["unlisted-client-package@1.0.0"], unexpected: [] });
  assert.equal(JSON.stringify(fonts), before);
});

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest,
    true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) imports.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function resolveLocalImport(file: string, specifier: string): string {
  const base = specifier.startsWith("@/")
    ? resolve(root, "src", specifier.slice(2)) : resolve(dirname(file), specifier);
  const extensions = [".ts", ".tsx", ".js", ".mjs", ".json", ".css"];
  const candidates = [
    base, ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => join(base, `index${extension}`)),
  ];
  if ([".js", ".mjs"].includes(extname(base))) {
    const stem = base.slice(0, -extname(base).length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  const resolved = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  assert.ok(resolved, `${relative(root, file)} cannot resolve ${specifier}`);
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
        ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (["server-only", "client-only", "next"].includes(name)) continue;
      packages.add(name);
      if (!names.has(name)) uncovered.add(`${relative(root, file).replaceAll("\\", "/")} -> ${name}`);
    }
  }
  assert.ok(reached.has(join(root, "src/lib/heic-browser.ts")));
  assert.ok(packages.has("heic-decode"));
  assert.ok(packages.has("heic-convert"));
  assert.equal(uncovered.size, 0, `Browser imports uncovered:\n${[...uncovered].sort().join("\n")}`);
});

test("browser conversion loads separate asset without runtime hash verification", () => {
  const source = read("src/lib/heic-browser.ts");
  assert.doesNotMatch(source, /(?:from\s*|import\s*\(\s*)["'](?:heic-convert\/browser|heic-decode|libheif-js)["']/);
  assert.match(source, /import\(\s*\/\*\s*webpackIgnore:\s*true\s*\*\/\s*LIBHEIF_ASSET\.path\s*\)/);
  for (const name of ["heic-decode/lib.js", "heic-convert/lib.js", "heic-convert/formats-browser.js"]) {
    assert.ok(source.includes(`import("${name}")`));
  }
  assert.doesNotMatch(source, /sha256|integrity|crypto\.subtle/i);
  const aliases = read("next.config.ts").split("} else {")[1];
  assert.ok(aliases);
  assert.match(aliases, /"libheif-js": false/);
  assert.match(aliases, /"libheif-js\/wasm-bundle": false/);
});

test("page uses service email and renders replacement instructions and provenance", () => {
  const page = read("src/app/licenses/page.tsx");
  assert.match(page, /import\s*\{\s*SERVICE_EMAIL\s*\}\s*from\s*["']@\/server\/mail["']/);
  assert.match(page, /t\("i_lic_offer"\)\.split\("\{email\}"\)/);
  assert.match(page, /mailto:\$\{SERVICE_EMAIL\}/);
  assert.match(page, />\{SERVICE_EMAIL\}<\/a>/);
  assert.doesNotMatch(page, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  for (const value of [
    "<ol>", "entry.copyrightHolders.map", "entry.sourceArchives.map",
    "asset.buildInputFiles.map", "asset.assetPath", "AUTHORS", "entry.sourceNoticesUrl",
    "provenance.prebuiltSha256", "provenance.embeddedWasmSha256", "provenance.shippedBundleSha256",
  ]) assert.ok(page.includes(value), value);
});

test("licence copy has matching keys, CSS scope and qualified wording", () => {
  const en = JSON.parse(read("src/i18n/en.json")) as Record<string, string>;
  const zh = JSON.parse(read("src/i18n/zh-TW.json")) as Record<string, string>;
  const keys = new Set([...Object.keys(en), ...Object.keys(zh)]
    .filter((key) => key.startsWith("i_lic_") || key === "i_legal_licenses"));
  const referenced = [
    read("src/app/licenses/page.tsx"), read("src/server/third-party-licenses.ts"), read("src/app/layout.tsx"),
  ].join("\n");
  for (const match of referenced.matchAll(/["'](i_lic_[\w]+|i_legal_licenses)["']/g)) {
    assert.ok(keys.has(match[1]), match[1]);
  }
  const banned = [
    "收租", "收款", "欠租", "已收", "入帳", "房東", "代收", "轉付",
    "統一編號", "含稅", "本公司", "事務所",
    "\u623f\u5ba2", "即將推出", "測試模式", "範例沙盒", "示範",
  ];
  for (const key of keys) {
    for (const locale of [en, zh]) {
      assert.equal(typeof locale[key], "string", key);
      assert.ok(locale[key].trim(), key);
      for (const word of banned) assert.equal(locale[key].includes(word), false, `${key}: ${word}`);
      assert.doesNotMatch(locale[key], /完全合規|fully compliant|complete compliance|\bdemo\b/i);
    }
  }
  assert.ok(en.i_lic_intro.includes("CSS"));
  assert.ok(zh.i_lic_intro.includes("CSS"));
  assert.ok(en.i_lic_offer.includes("{email}"));
  assert.ok(zh.i_lic_offer.includes("{email}"));
  assert.ok(en.i_lic_offer.includes("three years"));
  assert.ok(zh.i_lic_offer.includes("三年"));
  assert.equal(config.sourceOfferEmail, "service@condola.app");
  assert.equal(en.i_lic_tested, "We have tested this procedure with a modified build of the decoder.");
  for (const signature of ["heif_context_alloc", "_de265_get_version"]) {
    assert.equal(JSON.stringify(manifest).includes(signature), false);
    assert.equal(read("src/app/licenses/page.tsx").includes(signature), false);
    for (const key of keys) {
      assert.equal(en[key].includes(signature), false);
      assert.equal(zh[key].includes(signature), false);
    }
  }
  for (const locale of [en, zh]) {
    assert.ok(locale.i_lic_step_interface.includes("HeifDecoder"));
    assert.ok(locale.i_lic_step_interface.includes(".ready"));
    assert.ok(locale.i_lic_step_install.includes("node scripts/install.js"));
    assert.ok(locale.i_lic_step_place.includes("Overrides"));
  }
});

test("footer links to licences between privacy and refunds", () => {
  const layout = read("src/app/layout.tsx");
  const footer = layout.slice(layout.indexOf("<footer"));
  assert.match(footer, /href="\/privacy"[\s\S]*href="\/licenses"[\s\S]*href="\/refund"/);
  assert.match(footer, /href="\/licenses">\{t\("i_legal_licenses"\)\}/);
});
