import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCOUNTS, signIn } from "./session";

// Brand 3.0 Batch 1 visual evidence (design: condola-hub 20-build/specs/BRAND-3.0-batch1-design.md §9).
// Run through e2e/brand-v3-visual-playwright.config.ts with BRAND_V3_VISUAL=baseline|off|on.
// Seeded demo accounts only; a disposable local database; no outbound.
const MODE = (process.env.BRAND_V3_VISUAL ?? "off") as "baseline" | "off" | "on";
const OUT = resolve(__dirname, "results/brand-v3", MODE);
const SIZES = [{ name: "390", width: 390, height: 844 }, { name: "1280", width: 1280, height: 800 }] as const;

type Shot = { name: string; path: string };
const PAGES: { account: string | null; shots: Shot[] }[] = [
  { account: null, shots: [{ name: "login", path: "/login" }] },
  { account: ACCOUNTS.admin, shots: [
    { name: "m-today", path: "/m" }, { name: "m-units", path: "/m/units" }, { name: "m-leases", path: "/m/leases" },
    { name: "m-rent", path: "/m/rent" }, { name: "m-payments", path: "/m/payments" }, { name: "m-tickets", path: "/m/tickets" },
    { name: "m-messages", path: "/m/messages" }, { name: "m-settings", path: "/m/settings" },
  ] },
  { account: ACCOUNTS.tenant, shots: [{ name: "t-home", path: "/t" }, { name: "t-pay", path: "/t/pay" }] },
  { account: ACCOUNTS.owner, shots: [{ name: "o-home", path: "/o" }] },
];

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // The commit stamp and relative times differ between runs; they are not brand surface.
  await page.addStyleTag({ content: `[data-testid="app-version"]{visibility:hidden!important} *{caret-color:transparent!important}` });
}

test.describe.configure({ mode: "serial" });

for (const group of PAGES) {
  test(`brand v3 visual (${MODE}): ${group.account ?? "signed out"}`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    if (group.account) await signIn(page, group.account);
    else await page.context().clearCookies();
    const html = page.locator("html");
    for (const shot of group.shots) for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(shot.path)}`);
      await settle(page);
      const id = `${shot.name}-${size.name}`;
      const image = await page.screenshot({ fullPage: true, animations: "disabled" });
      writeFileSync(resolve(OUT, `${id}.png`), image);

      await expect(html, `${id}: v2 is the base in every mode`).toHaveAttribute("data-brand", "v2");
      const v3 = await html.getAttribute("data-brand-v3");
      const v3Sheet = await page.locator('link[rel="stylesheet"][href*="/brand/v3/"]').count();
      if (MODE !== "on" || !group.account) {
        // Flag OFF (and every signed-out page): no v3 attribute, no v3 stylesheet request.
        expect(v3, `${id}: no v3 attribute`).toBeNull();
        expect(v3Sheet, `${id}: no v3 stylesheet`).toBe(0);
        // baseline mode writes the reference (--update-snapshots); off mode compares against it.
        expect(image).toMatchSnapshot(`${id}.png`);
      } else {
        expect(v3, `${id}: v3 attribute`).toBe("1");
        expect(v3Sheet, `${id}: v3 stylesheet`).toBe(1);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${id}: no horizontal overflow`).toBeLessThanOrEqual(0);
        const solid = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".main .btn.pri")]
          .filter(el => el.offsetParent !== null && getComputedStyle(el).backgroundColor === "rgb(20, 50, 92)").length);
        expect(solid, `${id}: at most one solid primary`).toBeLessThanOrEqual(1);
        const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".main a.btn, .main button.btn")]
          .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height < 44).length);
        expect(small, `${id}: 44px minimum touch height on buttons`).toBe(0);
      }
    }
  });
}

test(`brand v3 visual (${MODE}): reduced motion keeps the completion tick static`, async ({ browser }) => {
  test.skip(MODE !== "on", "v3 only");
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/m");
  const names = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "v3-check";
    probe.innerHTML = '<svg><path class="v3-check-tick"></path></svg>';
    document.body.appendChild(probe);
    const tick = probe.querySelector(".v3-check-tick")!;
    const out = { name: getComputedStyle(tick).animationName, duration: getComputedStyle(tick).animationDuration };
    probe.remove();
    return out;
  });
  expect(names.name === "none" || names.duration === "0s", `tick animation under reduced motion: ${JSON.stringify(names)}`).toBeTruthy();
  await context.close();
});
