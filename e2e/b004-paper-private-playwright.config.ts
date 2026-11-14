import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

if (process.env.B004_VIEWPORT_WIDTH || Object.entries(process.env).some(([name, value]) => Boolean(value) && (
  name === "DEBUG" || name === "PWDEBUG" || name.startsWith("PW_") ||
  (name.startsWith("PLAYWRIGHT_") && !(value === "1" && (name === "PLAYWRIGHT_TEST" || name === "PLAYWRIGHT_NO_COPY_PROMPT")))
))) throw new Error("B004 private test rejects debug, viewport and remote overrides");
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
process.env.B004_PRIVATE_HTTP_CONFIG = "1";
process.env.PAPER_LEASE_VERSIONS_ENABLED = "true";
process.env.TENANT_SIGNED_PDF_ENABLED = "true";
export default defineConfig({
  testDir: ".", testMatch: "b004-paper-delivery.spec.ts", fullyParallel: false, workers: 1, timeout: 180_000,
  expect: { timeout: 15_000 }, reporter: "line",
  use: { baseURL: "http://127.0.0.1:43135", trace: "off", screenshot: "off", video: "off" },
  webServer: {
    cwd: resolve(__dirname, ".."),
    command: "node scripts/third-party-licenses.mjs --check && node scripts/third-party-licenses.mjs --vendor && node node_modules/next/dist/bin/next dev -p 43135 -H 127.0.0.1",
    url: "http://127.0.0.1:43135", reuseExistingServer: false, timeout: 180_000, stdout: "ignore", stderr: "ignore",
    env: { ...process.env, PAPER_LEASE_VERSIONS_ENABLED: "true", TENANT_SIGNED_PDF_ENABLED: "true", SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" },
  },
  projects: [390, 1280].map(width => ({ name: `chromium-${width}`, use: { ...devices["Desktop Chrome"], viewport: { width, height: 900 } } })),
});
