import { test } from "@playwright/test";
import { expectOneReloadOnChunk404 } from "./chunk-load-404";

test("app/page chunk 404 reloads once and does not loop", async ({ page }) => {
  await expectOneReloadOnChunk404(page, "/");
});
