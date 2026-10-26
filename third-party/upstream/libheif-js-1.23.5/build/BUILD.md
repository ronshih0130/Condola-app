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

libheif-js 1.23.5 scripts/install.js downloads the prebuilt archive:
https://github.com/catdad-experiments/libheif-emscripten/releases/download/v1.23.5/libheif.tar.gz

The prebuilt archive is identified here by its release URL. No SHA-256 for that prebuilt archive has been supplied.

libheif-emscripten 1.23.5 pins its libheif git submodule at:
413e2a87e6a70b3eccc3a3adc5801179dd2d9e00

That commit is libheif tag v1.23.5.

The .github/workflows/emscripten.yml workflow runs on ubuntu-22.04 with Emscripten 3.1.61. It runs libheif scripts/run-ci.sh with USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1, which invokes build-emscripten.sh. Defaults are ENABLE_LIBDE265=1, LIBDE265_VERSION=1.0.15, ENABLE_AOM=0, ENABLE_OPENJPEG=0 and ENABLE_WEBCODECS=0.

dist-prep.sh copies libheif.js, libheif.wasm and libheif.d.ts, and copies libheif COPYING to LICENSE.

libheif-js scripts/install.js minifies with esbuild target es2019 and bundles scripts/bundle.js into libheif-wasm/libheif-bundle.mjs as ESM. Its banner is 'var process, __dirname;'. The wasm loader is binary, the platform is neutral, and fs/path are polyfilled with empty modules.

## Reproduce

1. Verify the source archive hashes above and extract them. Install and activate emsdk 3.1.61; source its environment script.
2. Check out libheif v1.23.5 at 413e2a87e6a70b3eccc3a3adc5801179dd2d9e00 in the libheif-emscripten submodule location. Follow the preserved workflow's setup and working-directory steps.
3. Run libheif scripts/run-ci.sh with USE_WASM=1 USE_UNSAFE_EVAL=0 USE_TYPESCRIPT=1 as in the workflow. Retain the defaults listed above, including libde265 1.0.15.
4. Run the preserved dist-prep.sh as in the workflow and package its prepared distribution as libheif.tar.gz.
5. In the libheif-js 1.23.5 source tree, install its declared build dependencies, then run:
   node scripts/install.js <libheif.tar.gz>
   Supply the local archive's path in place of <libheif.tar.gz>.
6. The resulting libheif-wasm/libheif-bundle.mjs is the separate browser module. For a modified build, preserve its compatible ES module factory interface.

The preserved scripts and workflow specify the complete command context and packaging steps. Rebuilding with the same inputs does not by itself guarantee byte-identical toolchain output.
