import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "b005-unit-qr-local.spec.ts",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: "/private/tmp/b005-r2-browser-results",
  use: { baseURL: "http://127.0.0.1:43125", trace: "off", ...devices["Desktop Chrome"] },
  webServer: {
    command: "node_modules/.bin/next dev -p 43125 -H 127.0.0.1",
    url: "http://127.0.0.1:43125/signup",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_URL: "" },
  },
});
