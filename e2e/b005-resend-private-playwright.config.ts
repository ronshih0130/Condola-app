import { defineConfig, devices } from "@playwright/test";

if (Object.entries(process.env).some(([name, value]) => Boolean(value) && (
  name === "DEBUG" || name === "PWDEBUG" || name.startsWith("PW_") ||
  (name.startsWith("PLAYWRIGHT_") && !(value === "1" && (name === "PLAYWRIGHT_TEST" || name === "PLAYWRIGHT_NO_COPY_PROMPT")))
))) throw new Error("B005 result preview rejects debug and remote overrides");
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
process.env.B005_RESEND_PRIVATE_CONFIG = "1";
export default defineConfig({
  testDir: ".", testMatch: "b005-resend-result.spec.ts", fullyParallel: false, workers: 1, timeout: 30_000,
  expect: { timeout: 10_000 }, reporter: "line",
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [390, 1280].map(width => ({ name: `chromium-${width}`, use: { ...devices["Desktop Chrome"], viewport: { width, height: 900 } } })),
});
