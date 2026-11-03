import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { disposableDbUrl } from "../src/server/test-disposable-db";

// Validate before Playwright can start a server or reset any demo fixtures.
const target = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
if (process.env.DEMO_MODE !== "true") throw new Error("Browser checks require explicit local demo mode");
const cli = resolve("node_modules/@playwright/test/cli.js");
if (!existsSync(cli)) throw new Error("Install the pinned browser-test dependencies first");
mkdirSync(resolve("../e2e-artifacts"), { recursive: true, mode: 0o700 });

// Only the opted-in local test process enables these global controls. Each
// journey still controls its own org opt-in and verifies the OFF branch.
const childEnv = {
  ...process.env,
  DATABASE_URL: target.href,
  IMPORT_ERROR_DETAILS_ENABLED: "true",
  PAPER_LEASE_VERSIONS_ENABLED: "true",
  WRANGLER_SEND_METRICS: "false",
  NEXT_TELEMETRY_DISABLED: "1",
};
function run(args: string[], scopedEnv: Record<string, string> = {}): number {
  const result = spawnSync(process.execPath, [cli, "test", ...args], { stdio: "inherit", env: { ...childEnv, ...scopedEnv } });
  if (result.error) throw new Error("Browser checks could not start");
  if (result.signal === "SIGINT") return 130;
  if (result.signal === "SIGTERM") return 143;
  return result.status ?? 1;
}
const requested = process.argv.slice(2);
if (requested.length) process.exit(run(requested));

// A long-lived Next dev server restarts at 80% heap usage. That interrupted
// the full journey run on Mac. Fresh servers per spec keep the same tests,
// database and flags while bounding each compiler's lifetime. Preserve each
// spec's traces in its own output folder; never drop a failed batch's evidence.
function specs(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? specs(file) : entry.isFile() && /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  }).sort();
}
const files = specs("e2e");
if (!files.length) throw new Error("No browser specifications found");
let failed = 0;
for (const file of files) {
  const output = join("test-results", file.replace(/[^a-zA-Z0-9_-]/g, "_"));
  // Only this isolated synthetic signing batch opts into the global control;
  // the test separately opts in its own organization. Do not leak it to the
  // next compatibility batch or use an ambient asset server.
  const scopedEnv: Record<string, string> = file === "e2e/b001-activation.spec.ts"
    ? { ESIGN_ENABLED: "true", ESIGN_ASSET_ORIGIN: "http://127.0.0.1:43123" }
    : { ESIGN_ENABLED: "false" };
  // Handover uses its own bounded private object-service fixture; select its
  // exact checked-in config only for that file, keeping other batches isolated.
  const centerSpecs = new Set(["e2e/b028-center-local.spec.ts", "e2e/b017-center-busy.spec.ts", "e2e/b017-mark-response-loss.spec.ts", "e2e/b017-mark-hydration.spec.ts"]);
  const config = file === "e2e/handover.spec.ts"
    ? ["--config", "e2e/handover-playwright.config.ts"]
    : file === "e2e/b011-handover-comparison.spec.ts" ? ["--config", "e2e/b011-comparison-private-playwright.config.ts"]
    : file === "e2e/b014-owner-transfers.spec.ts" ? ["--config", "e2e/b014-owner-transfers-private-playwright.config.ts"]
    : file === "e2e/b012-renewal-comparison.spec.ts" ? ["--config", "e2e/b012-renewal-comparison-private-playwright.config.ts"]
    : file === "e2e/b013-owner-override-local.spec.ts" ? ["--config", "e2e/repair-owner-override-playwright.config.ts"]
    : file === "e2e/b013-owner-policy-local.spec.ts" ? ["--config", "e2e/repair-owner-policy-playwright.config.ts"]
    : file === "e2e/b002-retention-http.spec.ts" ? ["--config", "e2e/b002-retention-http-playwright.config.ts"]
    : file === "e2e/payee-access.spec.ts" ? ["--config", "e2e/b003-payee-private-playwright.config.ts"]
    : file === "e2e/b004-paper-delivery.spec.ts" ? ["--config", "e2e/b004-paper-private-playwright.config.ts"]
    : ["e2e/onboarding-progress.spec.ts", "e2e/b005-report-isolation.spec.ts"].includes(file) ? ["--config", "e2e/b005-onboarding-private-playwright.config.ts"]
    : file === "e2e/b005-resend-result.spec.ts" ? ["--config", "e2e/b005-resend-private-playwright.config.ts"]
    : file === "e2e/import-region.spec.ts" ? ["--config", "e2e/b006-import-private-playwright.config.ts"]
    : file === "e2e/b007-deposit.spec.ts" ? ["--config", "e2e/b007-deposit-private-playwright.config.ts"]
    : ["e2e/b008-billing-preview.spec.ts", "e2e/b008-first-period.spec.ts", "e2e/b008-monthly-preview.spec.ts", "e2e/b008-monthly-rent-detail.spec.ts"].includes(file) ? ["--config", "e2e/b008-preview-private-playwright.config.ts"]
    : file === "e2e/bank-matching.spec.ts" ? ["--config", "e2e/b009-bank-private-playwright.config.ts"]
    : file === "e2e/payment-center-events.spec.ts" ? ["--config", "e2e/b010-payment-center-private-playwright.config.ts"]
    : file === "e2e/b015-archive-guard.spec.ts" ? ["--config", "e2e/b015-archive-guard-private-playwright.config.ts"]
    : file === "e2e/b015-edit-local.spec.ts" ? ["--config", "e2e/tenant-directory-edit-playwright.config.ts"]
    : file === "e2e/b015-directory-local.spec.ts" ? ["--config", "e2e/tenant-directory-compat-playwright.config.ts"]
    : centerSpecs.has(file) ? ["--config", "playwright.b017-localhost.config.ts"] : [];
  const status = run([...config, file, "--output", output], scopedEnv);
  if (status === 130 || status === 143) process.exit(status);
  if (status !== 0) failed++;
}
process.stdout.write(`Browser batches completed: ${files.length}; failed: ${failed}\n`);
process.exit(failed ? 1 : 0);
