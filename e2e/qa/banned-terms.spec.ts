import { expect, test } from "@playwright/test";
import { scanRenderedHtml } from "./check-banned-terms";

const PUBLIC_PAGES = ["/", "/login", "/signup", "/forgot", "/pricing"];

test("rendered public pages pass the shared banned-word checker", async ({ page }) => {
  for (const path of PUBLIC_PAGES) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    scanRenderedHtml(path, await response.text());
  }
});
