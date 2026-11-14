import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// Brand 3.0 Batch 1: isolated local server for the v2-baseline / flag-OFF / flag-ON visual runs.
// BRAND_V3_VISUAL=baseline|off|on selects the mode (see brand-v3-visual.spec.ts).
//   baseline: run with --update-snapshots on the commit before any v3 code.
//   off:      compares every page against the baseline (flag OFF must equal v2).
//   on:       captures the v3 pages and runs the layout / a11y assertions.
const origin = "http://127.0.0.1:43163";
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
for (const name of Object.keys(env)) if (/SUPABASE|GOTRUE|BREVO|RESEND|LINE_CHANNEL|CLOUDFLARE|PROD|TOKEN/i.test(name)) delete env[name];
env.NEXT_TELEMETRY_DISABLED = "1";
env.WRANGLER_SEND_METRICS = "false";
env.BRAND_V2 = "true"; // production's setting; v3 is a delta on v2
env.DEMO_MODE = env.DEMO_MODE || "true";
env.ID_DOC_ENCRYPTION_KEY = env.ID_DOC_ENCRYPTION_KEY || "11".repeat(32);
export default defineConfig({
  testDir: ".", testMatch: ["brand-v3-visual.spec.ts"], fullyParallel: false, workers: 1, timeout: 600_000,
  expect: { timeout: 20_000, toMatchSnapshot: { maxDiffPixelRatio: 0.001 } },
  reporter: "line",
  snapshotPathTemplate: resolve(__dirname, "results/brand-v3/baseline/{arg}{ext}"),
  use: { baseURL: origin, trace: "off", video: "off", screenshot: "off" },
  webServer: { cwd: resolve(__dirname, ".."), command: "node scripts/third-party-licenses.mjs --check && node scripts/third-party-licenses.mjs --vendor && node node_modules/next/dist/bin/next dev -p 43163 -H 127.0.0.1", url: origin, reuseExistingServer: false, timeout: 240_000, env },
  // PW_CHANNEL=chrome uses an installed Google Chrome when no Playwright browser is downloaded (local Mac runs).
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) } }],
});
