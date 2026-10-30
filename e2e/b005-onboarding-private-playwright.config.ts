import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

if (process.env.B005_VIEWPORT_WIDTH || Object.entries(process.env).some(([name, value]) => Boolean(value) && (
  name === "DEBUG" || name === "PWDEBUG" || name.startsWith("PW_") ||
  (name.startsWith("PLAYWRIGHT_") && !(value === "1" && (name === "PLAYWRIGHT_TEST" || name === "PLAYWRIGHT_NO_COPY_PROMPT")))
))) throw new Error("B005 private test rejects debug, viewport and remote overrides");
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
process.env.B005_PRIVATE_HTTP_CONFIG = "1";
export default defineConfig({
  testDir: ".", testMatch: ["onboarding-progress.spec.ts", "b005-report-isolation.spec.ts"], fullyParallel: false, workers: 1, timeout: 180_000,
  expect: { timeout: 15_000 }, reporter: "line",
  use: { baseURL: "http://127.0.0.1:43136", trace: "off", screenshot: "off", video: "off" },
  webServer: {
    cwd: resolve(__dirname, ".."),
    command: "node scripts/third-party-licenses.mjs --check && node scripts/third-party-licenses.mjs --vendor && node node_modules/next/dist/bin/next dev -p 43136 -H 127.0.0.1",
    url: "http://127.0.0.1:43136", reuseExistingServer: false, timeout: 180_000, stdout: "ignore", stderr: "ignore",
    env: { ...process.env, SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" },
  },
  projects: [390, 1280].map(width => ({ name: `chromium-${width}`, use: { ...devices["Desktop Chrome"], viewport: { width, height: 900 } } })),
});
