# libheif-js build inputs

This directory preserves verbatim build inputs from the pinned source archives.

## Source archives

- libde265 1.0.15 (release): https://github.com/strukturag/libde265/releases/download/v1.0.15/libde265-1.0.15.tar.gz
  File: libde265-1.0.15.tar.gz
  SHA-256: 00251986c29d34d3af7117ed05874950c875dd9292d016be29d3b3762666511d
- libheif 1.23.5 (release): https://github.com/strukturag/libheif/releases/download/v1.23.5/libheif-1.23.5.tar.gz
  File: libheif-1.23.5.tar.gz
  SHA-256: fd9036064c4432f0550d15072ddf34956a248279ee9aeaff0fba3fa0f77d8f1a
- libheif-emscripten 1.23.5 (tag): https://github.com/catdad-experiments/libheif-emscripten/archive/refs/tags/v1.23.5.tar.gz
  File: libheif-emscripten-v1.23.5-src.tar.gz
  SHA-256: 8e3395ca983e369448bea84d223c35f1117373953e00219588415f1bc37c86ea
- libheif-js 1.23.5 (tag): https://github.com/catdad-experiments/libheif-js/archive/refs/tags/1.23.5.tar.gz
  File: libheif-js-1.23.5-src.tar.gz
  SHA-256: b2bcc4d1e94a47eff30afa05671374170f2f9f5ad88dd2e3cb1196d2df4d6f76

## Shipped build chain

libheif-js 1.23.5 scripts/install.js uses this upstream prebuilt release:
https://github.com/catdad-experiments/libheif-emscripten/releases/download/v1.23.5/libheif.tar.gz

Downloaded and verified on 2026-10-26.
Prebuilt archive SHA-256: 0fa8629a75344389f0da842f659cc952ecaa39cde400eed42b80e4a82a3af778

The archive contains libheif/{LICENSE,libheif.js,libheif.d.ts} and libheif-wasm/{libheif.wasm,LICENSE,libheif.js,libheif.d.ts}.

The libheif-wasm/libheif.wasm in that archive is 1463506 bytes.
Its SHA-256 is 184d3d20f8323877f13e9f5254f9c6a0ce272c9a3a2f823b0b2bcd2ee9f73f80.
The wasm embedded as base64 by esbuild's binary loader in the shipped bundle decodes to exactly those bytes.

The prebuilt LICENSE matches libheif COPYING.

libheif-emscripten 1.23.5 pins its libheif git submodule at:
413e2a87e6a70b3eccc3a3adc5801179dd2d9e00

That commit is libheif tag v1.23.5.

The preserved .github/workflows/emscripten.yml runs on ubuntu-22.04 with Emscripten 3.1.61. It runs libheif scripts/run-ci.sh with USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1, which invokes build-emscripten.sh. Defaults are ENABLE_LIBDE265=1, LIBDE265_VERSION=1.0.15, ENABLE_AOM=0, ENABLE_OPENJPEG=0 and ENABLE_WEBCODECS=0.

dist-prep.sh copies libheif.js, libheif.wasm and libheif.d.ts, and copies libheif COPYING to LICENSE.

scripts/bundle.js imports ../libheif-wasm/libheif.js and ../libheif-wasm/libheif.wasm, then exports:
export default (opts = {}) => libheif({ ...opts, wasmBinary });

libheif-js scripts/install.js minifies with esbuild target es2019 and bundles scripts/bundle.js into libheif-wasm/libheif-bundle.mjs as ESM. Its banner is 'var process, __dirname;'. The wasm loader is binary, the platform is neutral, and fs/path are polyfilled with empty modules.

Using the libheif-js 1.23.5 tag source, npm install and node scripts/install.js with the verified prebuilt archive reproduced the shipped bundle exactly.
Reproduction tools: Node 20, esbuild 0.19.12, esbuild-plugins-node-modules-polyfill 1.8.3.
Reproduced and shipped bundle SHA-256: 095194187be00d3e36335b8ad7f5552d70655e5e2159486d7d36cd4daa47bba9.

This reproduces the prebuilt-release-to-bundle step. We did not rebuild libheif/libde265 into wasm with Emscripten or byte-compare an Emscripten rebuild against the shipped wasm. Toolchain output may differ.

## Verify

Run from a working directory containing the downloaded upstream prebuilt libheif.tar.gz, the extracted libheif-js 1.23.5 tag source as libheif-js-1.23.5, and a copy of the shipped libheif-bundle.mjs as shipped-libheif-bundle.mjs.

    printf '%s  %s\n' '0fa8629a75344389f0da842f659cc952ecaa39cde400eed42b80e4a82a3af778' libheif.tar.gz | sha256sum -c -
    mkdir prebuilt
    tar -xzf libheif.tar.gz -C prebuilt
    printf '%s  %s\n' '184d3d20f8323877f13e9f5254f9c6a0ce272c9a3a2f823b0b2bcd2ee9f73f80' prebuilt/libheif-wasm/libheif.wasm | sha256sum -c -
    test "$(wc -c < prebuilt/libheif-wasm/libheif.wasm)" -eq 1463506
    node --input-type=module -e 'import fs from "node:fs"; const s=fs.readFileSync("shipped-libheif-bundle.mjs","utf8"); const a=[...s.matchAll(/["\x27]([A-Za-z0-9+/]{64,}={0,2})["\x27]/g)].map(m=>Buffer.from(m[1],"base64")).filter(b=>b.subarray(0,4).equals(Buffer.from([0,97,115,109]))); if(a.length!==1)throw Error("Expected one embedded wasm"); fs.writeFileSync("embedded.wasm",a[0]);'
    cmp embedded.wasm prebuilt/libheif-wasm/libheif.wasm
    printf '%s  %s\n' '095194187be00d3e36335b8ad7f5552d70655e5e2159486d7d36cd4daa47bba9' shipped-libheif-bundle.mjs | sha256sum -c -
    cd libheif-js-1.23.5
    node --version
    npm install
    npm ls esbuild esbuild-plugins-node-modules-polyfill
    node scripts/install.js ../libheif.tar.gz
    printf '%s  %s\n' '095194187be00d3e36335b8ad7f5552d70655e5e2159486d7d36cd4daa47bba9' libheif-wasm/libheif-bundle.mjs | sha256sum -c -
    cmp libheif-wasm/libheif-bundle.mjs ../shipped-libheif-bundle.mjs

Use Node 20 and confirm the two dependency versions above before comparing reproduction results. npm install alone does not pin future dependency resolution.

## Rebuild or modify

1. Verify the four source archive hashes above and extract them. Install and activate emsdk 3.1.61; source its environment script.
2. Place libheif v1.23.5, commit 413e2a87e6a70b3eccc3a3adc5801179dd2d9e00, in the libheif-emscripten submodule location. Follow the preserved workflow's setup and working-directory steps.
3. Run libheif scripts/run-ci.sh with USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1 as in the workflow, retaining the defaults above, including libde265 1.0.15.
4. Run the preserved dist-prep.sh and package the prepared distribution as libheif.tar.gz, preserving the libheif and libheif-wasm top directories. For small changes, an alternative is to edit libheif-wasm/libheif.js or libheif-wasm/libheif.wasm inside an extracted prebuilt archive and repack those same directories.
5. In the libheif-js 1.23.5 source tree with its build dependencies installed, run node scripts/install.js <your-libheif.tar.gz>, supplying an absolute archive path.
6. Use the resulting libheif-wasm/libheif-bundle.mjs. Its default export must remain a factory returning a module with .ready and HeifDecoder, compatible with libheif-js 1.23.5.

## Written source offer

Anyone who wants the complete corresponding source from us may request it at service@condola.app. This written offer is valid for at least three years from the last distribution of the relevant decoder version. The links above identify upstream archives; this site does not host those source archives.

The preserved inputs document the upstream build procedure and the verified packaging step. They do not establish byte-identical Emscripten compilation from source.
