import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCOUNTS, signIn } from "./session";

// Brand 3.0 Batch 1 visual evidence (design: condola-hub 20-build/specs/BRAND-3.0-batch1-design.md §9).
// Stories: B-069 PLT-46…PLT-51 (condola-hub 07-brand/brand-3.0-1113/stories.md). The pages are evidence pages for the
// shared 3.0 base, not restyle targets (Ron 2026-11-14: unbuilt designs are built directly in 3.0).
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
  { account: ACCOUNTS.tenant2, shots: [{ name: "t-home", path: "/t" }, { name: "t-pay", path: "/t/pay" }, { name: "t-pay-done", path: "/t/pay?done=1" }] },
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
  test(`B-069 PLT-46-AC2 / PLT-47 / PLT-50 — brand v3 visual (${MODE}): ${group.account ?? "signed out"}`, async ({ page }) => {
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
        expect.soft(image, `${id}: flag OFF equals the v2 baseline`).toMatchSnapshot(`${id}.png`);
      } else {
        expect(v3, `${id}: v3 attribute`).toBe("1");
        expect(v3Sheet, `${id}: v3 base and shell stylesheets`).toBe(2);
        if (group.account === ACCOUNTS.admin && ["/m", "/m/payments"].includes(shot.path)) {
          await assertManagerShell(page, "admin", size.width, shot.path === "/m" ? "today" : "money");
        }
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
            .filter(el => el.offsetParent !== null && (el.matches(".btn, .nav-toggle, .seg a, .tnav a, .tnav button") || bottomNav(el)))
            .filter(el => { const r = el.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; })
            .map(el => { const r = el.getBoundingClientRect(); return `${(el.textContent ?? "").trim().slice(0, 10) || el.className}:${Math.round(r.width)}x${Math.round(r.height)}`; });
        });
        expect([...new Set(small)], `${id}: 44px minimum touch size (width and height)`).toEqual([]);
        // Bottom-navigation labels share one line: growing one item's hit area must not push its label off the row.
        const skew = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".tnav")].filter(nav => nav.offsetParent !== null).map(nav => {
          const mids = [...nav.querySelectorAll<HTMLElement>("a, button")].map(el => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return b.top + b.height / 2; });
          return Math.round(Math.max(...mids) - Math.min(...mids));
        }).filter(d => d > 2));
        expect(skew, `${id}: bottom-nav labels are vertically aligned`).toEqual([]);
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

test(`B-069 PLT-51-AC4 — brand v3 visual (${MODE}): reduced motion keeps the completion tick static`, async ({ browser }) => {
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


const SHELL_AREAS = {
  admin: ["today", "messages", "properties", "leases", "money", "maintenance", "settings"],
  manager: ["today", "messages", "properties", "leases", "money", "maintenance", "settings"],
  accountant: ["today", "properties", "leases", "money", "maintenance", "settings"],
  maintenance: ["maintenance", "settings"],
};
const SHELL_TABS = {
  admin: ["today", "messages", "properties", "leases", "more"],
  manager: ["today", "messages", "properties", "leases", "more"],
  accountant: ["today", "properties", "leases", "money", "more"],
  maintenance: ["maintenance", "settings"],
};
type StaffRole = keyof typeof SHELL_AREAS;
async function assertManagerShell(page: Page, role: StaffRole, width: number, area: string) {
  await expect(page.getByTestId("manager-shell-v3")).toBeVisible();
  await expect(page.locator("header.top, aside.side")).toHaveCount(0);
  await expect(page.getByTestId("tryout-panel")).toHaveCount(0);
  const nav = page.getByTestId(width >= 1024 ? "v3-sidebar-nav" : "v3-phone-tabs");
  await expect(nav).toBeVisible();
  const expected = width >= 1024 ? SHELL_AREAS[role] : SHELL_TABS[role];
  expect(await nav.locator("a[data-area]").evaluateAll(links => links.map(link => link.getAttribute("data-area")))).toEqual(expected);
  const active = expected.includes(area) ? area : "more";
  await expect(nav.locator(`a[data-area="${active}"]`)).toHaveAttribute("aria-current", "page");
  await expect(nav.locator("a[data-area][aria-current=page]")).toHaveCount(1);
  expect(await nav.locator("a").evaluateAll(links => links.filter(link => {
    const box = link.getBoundingClientRect(); return box.width < 44 || box.height < 44;
  }).map(link => link.textContent))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // Interim controls (OQ-032 until phase 1b): reachable, readable and 44px at both widths.
  const tools = page.locator(".v3-shell .shell-tools");
  const resetShown = (await tools.getByTestId("reset-demo").count()) > 0;
  await tools.getByTestId("org-switch").click();
  for (const id of ["locale-zh", "locale-en", "sign-out", "org-switch", "org-pick-live", "org-pick-sandbox", ...(resetShown ? ["reset-demo"] : [])]) {
    const control = tools.getByTestId(id);
    await control.scrollIntoViewIfNeeded();
    await expect(control, `${id} visible`).toBeVisible();
    const contrast = await control.evaluate(el => {
      const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const rgb = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)); };
      const lum = (c: string) => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
      let node: Element | null = el; let bg = "transparent";
      const clear = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3] === 0; };
      while (node && clear(bg)) { bg = getComputedStyle(node).backgroundColor; node = node.parentElement; }
      const [a, b] = [lum(getComputedStyle(el).color), lum(bg)].sort((x, y) => y - x);
      return (a + .05) / (b + .05);
    });
    expect(contrast, `${id} text contrast`).toBeGreaterThanOrEqual(4.5);
    const box = await control.boundingBox();
    expect(Math.min(box?.width ?? 0, box?.height ?? 0), `${id} target`).toBeGreaterThanOrEqual(44);
  }
  await tools.getByTestId("org-switch").click();
  if (role === "admin") expect(resetShown, "reset-demo shown for admin in demo mode").toBe(true);
  if (width >= 1024) {
    await expect(page.locator(".v3-shell .appbar.navy")).toBeHidden();
    await expect(page.locator(".v3-shell .deskbar")).toBeVisible();
    await expect(page.getByTestId("v3-phone-tabs")).toBeHidden();
  } else {
    await expect(page.locator(".v3-shell .appbar.navy")).toBeVisible();
    await expect(page.locator(".v3-shell .deskbar")).toBeHidden();
    await expect(page.getByTestId("v3-sidebar-nav")).toBeHidden();
  }
}

for (const role of ["admin", "manager", "accountant", "maintenance"] as const) {
  test(`B-043 MGT-47-AC3/AC4/AC7, MGT-48-AC5, MGT-49-AC5 / PLT-44: ${role} shell`, async ({ page }) => {
    test.skip(MODE !== "on", "Preserve the existing OFF and baseline evidence set");
    await signIn(page, ACCOUNTS[role]);
    await page.goto("/auth/continue");
    await expect(page).toHaveURL(new RegExp(`${role === "accountant" ? "/m/payments" : role === "maintenance" ? "/m/tickets" : "/m"}$`));
    const paths = role === "maintenance" ? ["/m/tickets", "/m/account"] : ["/m", "/m/payments"];
    for (const path of paths) for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(path)}`);
      await settle(page);
      const area = path === "/m" ? "today" : path === "/m/payments" ? "money" : path === "/m/tickets" ? "maintenance" : "settings";
      await assertManagerShell(page, role, size.width, area);
      if (path === "/m/payments") {
        const subnav = page.locator(size.width >= 1024 ? ".v3-shell .snav" : ".v3-shell .subchips");
        await expect(subnav.locator('a[href="/m/payments"]')).toHaveAttribute("aria-current", "page");
        await expect(subnav.locator('a[href="/m/bank"]')).toHaveCount(role === "manager" ? 0 : 1);
      }
      mkdirSync(OUT, { recursive: true });
      writeFileSync(resolve(OUT, `shell-${role}-${area}-${size.name}.png`), await page.screenshot({ fullPage: true, animations: "disabled" }));
    }
    if (role === "manager") {
      await page.goto("/m/bank");
      await expect(page).toHaveURL(/\/m\/noperm\?need=bank.reconcile/);
      await expect(page.getByTestId("forbidden").locator('a[href="/m"]')).toBeVisible();
    }
  });
}
