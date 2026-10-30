import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// Refuse debug forwarding or a remotely connected browser before starting the server.
if (Object.entries(process.env).some(([name, value]) => Boolean(value) && (name === "DEBUG" || name === "PWDEBUG" || name.startsWith("PW_") || (name.startsWith("PLAYWRIGHT_") && !(name === "PLAYWRIGHT_TEST" && value === "1"))))) {
  throw new Error("B002 private test rejects debug and remote overrides");
}
// This file is the only authorized launcher for the token-bearing B002 proof.
process.env.B002_PRIVATE_HTTP_CONFIG = "1";
export default defineConfig({
  testDir: ".",
  testMatch: "b002-retention-http.spec.ts",
  fullyParallel: false,
  reporter: "line",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:43133",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    cwd: resolve(__dirname, ".."),
    command: "node scripts/third-party-licenses.mjs --check && node scripts/third-party-licenses.mjs --vendor && node node_modules/next/dist/bin/next dev -p 43133 -H 127.0.0.1",
    url: "http://127.0.0.1:43133",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
