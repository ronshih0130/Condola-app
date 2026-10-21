import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:43123",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/photo-bucket.mjs",
      url: "http://127.0.0.1:4599/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:43123",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        SUPABASE_URL: "http://127.0.0.1:4599",
        SUPABASE_SERVICE_ROLE_KEY: "e2e-photo-key",
      },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
