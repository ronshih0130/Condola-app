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
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
      },
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:43123",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
        DEMO_MODE: process.env.DEMO_MODE || "true",
        ID_DOC_ENCRYPTION_KEY: process.env.ID_DOC_ENCRYPTION_KEY || "11".repeat(32),
        SUPABASE_URL: "http://127.0.0.1:4599",
        SUPABASE_ANON_KEY: "e2e-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "e2e-photo-key",
      },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
