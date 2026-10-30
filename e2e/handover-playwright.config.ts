import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export default defineConfig({
  testDir: ".", testMatch: "handover.spec.ts", workers: 1, timeout: 180_000,
  expect: { timeout: 20_000 },
  use: { baseURL: "http://127.0.0.1:43123", trace: "retain-on-failure" },
  webServer: [
    { cwd: repositoryRoot, command: "node e2e/handover-bucket.mjs", url: "http://127.0.0.1:4599/health", reuseExistingServer: false, timeout: 30000 },
    { cwd: repositoryRoot, command: "npm run dev:e2e", url: "http://127.0.0.1:43123", reuseExistingServer: false, timeout: 180000,
      env: { ...process.env, SUPABASE_URL: "http://127.0.0.1:4599", SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "e2e-photo-key" } },
  ],
  projects: [{ name:"chromium", use:{ ...devices["Desktop Chrome"] } }],
});
