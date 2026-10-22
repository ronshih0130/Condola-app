import { defineConfig, devices } from "@playwright/test";

/**
 * Regression server stays on local Postgres.
 * The photo-bucket SUPABASE_URL in playwright.config.ts would send sign-up to GoTrue
 * and hide the local confirm link. This config does not set a Supabase URL or any key.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/regression.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://127.0.0.1:43123",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:43123",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DEMO_MODE: "true",
      LINE_LOGIN_ENABLED: "false",
      CONDOLA_ENV: "",
      SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
      SUPABASE_ANON_KEY: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      ID_DOC_HMAC_KEY: "",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
