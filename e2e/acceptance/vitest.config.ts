import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  root,
  resolve: {
    alias: { "@": path.join(root, "src") },
  },
  test: {
    include: ["e2e/acceptance/tests/**/*.spec.ts"],
    exclude: ["**/*.e2e.spec.ts"],
  },
});
