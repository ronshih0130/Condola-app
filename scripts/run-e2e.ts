import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { disposableDbUrl } from "../src/server/test-disposable-db";

// Validate before Playwright can start a server or reset any demo fixtures.
const target = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
if (process.env.DEMO_MODE !== "true") throw new Error("Browser checks require explicit local demo mode");
const cli = resolve("node_modules/@playwright/test/cli.js");
if (!existsSync(cli)) throw new Error("Install the pinned browser-test dependencies first");

// Only the opted-in local test process enables these global controls. Each
// journey still controls its own org opt-in and verifies the OFF branch.
const result = spawnSync(process.execPath, [cli, "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: target.href,
    IMPORT_ERROR_DETAILS_ENABLED: "true",
    PAPER_LEASE_VERSIONS_ENABLED: "true",
    WRANGLER_SEND_METRICS: "false",
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
if (result.error) throw new Error("Browser checks could not start");
process.exit(result.status ?? 1);
