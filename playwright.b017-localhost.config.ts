import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

// Local Next reports localhost as request.url's origin. Keep the product
// same-origin check strict and run this isolated proof at that same origin.
export const B017_LOCAL_ORIGIN = "http://localhost:43123";

export default defineConfig({
  ...baseConfig,
  use: { ...baseConfig.use, baseURL: B017_LOCAL_ORIGIN },
});
