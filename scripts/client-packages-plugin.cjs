const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { randomUUID } = require("node:crypto");
const { dirname, join, resolve } = require("node:path");

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function readPackage(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value.name !== "string" || !value.name ||
    typeof value.version !== "string" || !value.version
  ) {
    throw new Error(`Invalid client package metadata: ${path}`);
  }
  return { name: value.name, version: value.version };
}

function owningPackage(resource) {
  const normalized = resource.replaceAll("\\", "/").split("?")[0];
  if (!normalized.includes("/node_modules/")) return null;

  const compiled = normalized.lastIndexOf("/node_modules/next/dist/compiled/");
  if (compiled >= 0) {
    return readPackage(`${normalized.slice(0, compiled)}/node_modules/next/package.json`);
  }

  let directory = dirname(normalized);
  while (true) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const value = JSON.parse(readFileSync(path, "utf8"));
      // Some package subdirectories contain only {"type":"module"}.
      if (typeof value.name === "string" && typeof value.version === "string") {
        return readPackage(path);
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot identify package for client module: ${resource}`);
}

class ClientPackagesPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("ClientPackagesPlugin", (compilation) => {
      compilation.hooks.afterSeal.tap("ClientPackagesPlugin", () => {
        const packages = new Map();
        const seen = new Set();
        const cache = new Map();

        function visit(webpackModule) {
          if (seen.has(webpackModule)) return;
          seen.add(webpackModule);
          const condition = typeof webpackModule.nameForCondition === "function"
            ? webpackModule.nameForCondition()
            : null;
          const resources = new Set([webpackModule.resource, condition]);
          for (const resource of resources) {
            if (typeof resource !== "string") continue;
            let item = cache.get(resource);
            if (!cache.has(resource)) {
              item = owningPackage(resource);
              cache.set(resource, item);
            }
            if (item) packages.set(`${item.name}\0${item.version}`, item);
          }
          if (webpackModule.modules && typeof webpackModule.modules[Symbol.iterator] === "function") {
            for (const inner of webpackModule.modules) visit(inner);
          }
        }

        for (const chunk of compilation.chunks) {
          for (const webpackModule of compilation.chunkGraph.getChunkModulesIterable(chunk)) {
            visit(webpackModule);
          }
        }
        const result = [...packages.values()].sort((a, b) =>
          compare(a.name, b.name) || compare(a.version, b.version));
        const context = realpathSync(compiler.context);
        const target = resolve(context, ".next/client-packages.json");
        mkdirSync(dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
          renameSync(temporary, target);
        } finally {
          rmSync(temporary, { force: true });
        }
      });
    });
  }
}

module.exports = { ClientPackagesPlugin };
