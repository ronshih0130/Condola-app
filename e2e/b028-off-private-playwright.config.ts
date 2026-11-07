import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// B-028 package 5: isolated localhost server for the center/OFF browser matrix.
// Next reports localhost as request.url's origin, so the strict same-origin
// mark check runs at that same origin (see playwright.b017-localhost.config.ts).
const origin = "http://localhost:43153";
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
for (const name of Object.keys(env)) if (/SUPABASE|GOTRUE|BREVO|RESEND|LINE_CHANNEL|CLOUDFLARE|PROD|TOKEN/i.test(name)) delete env[name];
// Keep the local dev server from sending tool telemetry off the machine (matches scripts/run-e2e.ts).
env.NEXT_TELEMETRY_DISABLED = "1";
env.WRANGLER_SEND_METRICS = "false";
export default defineConfig({
  testDir: ".", testMatch: ["b028-center-local.spec.ts"], fullyParallel: false, workers: 1, timeout: 600_000, expect: { timeout: 20_000 }, reporter: "line",
  use: { baseURL: origin, trace: "off", video: "off", screenshot: "off" },
  webServer: { cwd: resolve(__dirname, ".."), command: "node scripts/third-party-licenses.mjs --check && node scripts/third-party-licenses.mjs --vendor && node node_modules/next/dist/bin/next dev -p 43153 -H 127.0.0.1", url: origin, reuseExistingServer: false, timeout: 180_000, stdout: "ignore", stderr: "ignore", env },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
