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
    { name: "m-noperm", path: "/m/noperm?need=admin" }, { name: "not-found", path: "/brand-v3-visual-missing-page" },
  ] },
  // tenant2 has one lease in the seeded org, so /t is the tenant home and not the lease picker.
  { account: ACCOUNTS.tenant2, shots: [{ name: "t-home", path: "/t" }, { name: "t-pay", path: "/t/pay" }] },
  { account: ACCOUNTS.owner, shots: [{ name: "o-home", path: "/o" }] },
];

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // The commit stamp differs between commits and the Next.js dev badge is not product UI; neither is brand surface.
  await page.addStyleTag({ content: `[data-testid="app-version"],.build-sha{visibility:hidden!important} nextjs-portal{display:none!important} *{caret-color:transparent!important}` });
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
        // Every navy-filled action in the page body counts, whatever its class (review r1: not only .btn.pri).
        const solid = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("a, button, input[type=submit]")]
          .filter(el => el.offsetParent !== null && !el.closest("header.top, .side, footer, nav, dialog, [role=dialog]")
            && getComputedStyle(el).backgroundColor === "rgb(20, 50, 92)").map(el => (el.textContent ?? "").trim().slice(0, 12)));
        expect(solid.length, `${id}: at most one solid primary (${solid.join(" | ")})`).toBeLessThanOrEqual(1);
        // Ron: 44px minimum touch. Buttons, the menu toggle, the language switch and bottom-navigation actions.
        const small = await page.evaluate(() => {
          const bottomNav = (el: Element) => { for (let p = el.parentElement; p; p = p.parentElement) {
            const st = getComputedStyle(p); if ((st.position === "fixed" || st.position === "sticky") && p.getBoundingClientRect().bottom >= innerHeight - 2 && p.getBoundingClientRect().top > innerHeight / 2) return true; } return false; };
          return [...document.querySelectorAll<HTMLElement>(".main a.btn, .main button.btn, header.top .btn, header.top .nav-toggle, header.top .seg a, a, button")]
            .filter(el => el.offsetParent !== null && (el.matches(".btn, .nav-toggle, .seg a") || bottomNav(el)))
            .filter(el => el.getBoundingClientRect().height < 43.5)
            .map(el => `${(el.textContent ?? "").trim().slice(0, 10) || el.className}:${Math.round(el.getBoundingClientRect().height)}`);
        });
        expect([...new Set(small)], `${id}: 44px minimum touch height`).toEqual([]);
        // A pill is wider than it is tall, and a short label stays on one line (B-046 empty-state CTAs may wrap).
        const shapes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("header.top .btn, .main a.btn, .main button.btn, .side .btn")]
          .filter(el => el.offsetParent !== null && (el.textContent ?? "").trim().length > 0).map(el => {
            const box = el.getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(el);
            const lines = new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size;
            return { text: (el.textContent ?? "").trim().slice(0, 12), width: Math.round(box.width), height: Math.round(box.height), lines, cta: !!el.closest(".es-primary") };
          }));
        expect(shapes.filter(b => b.width < b.height * 1.4), `${id}: pills, not circles`).toEqual([]);
        expect(shapes.filter(b => b.lines > 1 && !b.cta), `${id}: short labels stay on one line`).toEqual([]);
        // A card's table never paints square corners over the card radius: measure the first visible row.
        const poking = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".main .card")].flatMap(card => {
          const style = getComputedStyle(card);
          const radius = parseFloat(style.borderTopLeftRadius) || 0;
          const table = card.querySelector<HTMLElement>(":scope > table");
          if (!table || radius < 14 || style.overflow !== "visible") return [];
          const row = [...table.querySelectorAll<HTMLElement>("tr")].find(tr => tr.getClientRects().length > 0);
          if (!row || Math.abs(row.getBoundingClientRect().top - card.getBoundingClientRect().top) > radius) return [];
          const painted = (el: Element) => !["rgba(0, 0, 0, 0)", "transparent"].includes(getComputedStyle(el).backgroundColor);
          const corner = getComputedStyle(row).display === "block" ? row : row.firstElementChild!;
          const paints = painted(row) || painted(corner) || painted(row.parentElement!);
          return paints && (parseFloat(getComputedStyle(corner).borderTopLeftRadius) || 0) < radius - 2
            ? [`${card.querySelector("table")?.getAttribute("data-testid") ?? "table"}: ${getComputedStyle(corner).borderTopLeftRadius}`] : [];
        }));
        expect(poking, `${id}: table rows stay inside the card radius`).toEqual([]);
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
