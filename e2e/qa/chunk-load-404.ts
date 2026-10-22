import { expect, type Page } from "@playwright/test";

/** True for the app router page chunk, not the layout or a nested route. */
export function isAppPageChunkUrl(url: string) {
  let path = url;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    path = url;
  }
  if (!path.includes("/_next/static/chunks/")) return false;
  return /(?:^|\/)app\/page(?:[./-]|$)/.test(path) || /(?:^|\/)src_app_page_tsx/.test(path);
}

/**
 * The layout listener is mounted in useEffect, so a cold document cannot see
 * its own script-tag 404. Hydrate another route, then 404 the app/page chunk
 * during the client navigation that requests it. That may reload once. A second
 * miss must not reload again.
 */
export async function expectOneReloadOnChunk404(page: Page, path = "/") {
  const marker = "__qa_chunk_doc_loads";
  const blocked: string[] = [];
  await page.addInitScript((key) => {
    const next = Number(window.sessionStorage.getItem(key) || "0") + 1;
    window.sessionStorage.setItem(key, String(next));
  }, marker);

  await page.goto("/login", { waitUntil: "networkidle" });
  await expect(page.getByTestId("brand-name")).toBeVisible();
  const baseline = Number(await page.evaluate((key) => window.sessionStorage.getItem(key), marker));
  expect(baseline).toBeGreaterThan(0);

  await page.route("**/_next/static/chunks/**", async (route) => {
    const url = route.request().url();
    if (!isAppPageChunkUrl(url)) {
      await route.continue();
      return;
    }
    blocked.push(url);
    await route.fulfill({ status: 404, contentType: "text/plain", body: "missing chunk" });
  });

  await page.getByTestId("brand-name").click();
  const loads = async () => {
    try {
      return Number(await page.evaluate((key) => window.sessionStorage.getItem(key), marker));
    } catch {
      return -1;
    }
  };
  try {
    await expect.poll(loads, { timeout: 20_000 }).toBe(baseline + 1);
  } catch (error) {
    throw new Error(
      `expected one reload after app/page chunk 404 (${baseline + 1} document loads), saw ${await loads()}. blocked=${blocked.join(" ") || "<none>"} from ${path}`,
      { cause: error },
    );
  }
  expect(blocked.length, "the app/page chunk was not requested").toBeGreaterThan(0);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);
  expect(await loads(), "a second chunk 404 reloaded again").toBe(baseline + 1);
}
