import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const globals = readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");
const targets = readFileSync(path.resolve(__dirname, "../src/app/ui-targets.css"), "utf8");
const theme = readFileSync(path.resolve(__dirname, "../public/brand/v2/theme.css"), "utf8");

for (const brand of ["v1", "v2"] as const) {
  test(`${brand}: checkbox labels provide 44px targets and preserve hidden controls`, async ({ page }) => {
    await page.setContent(`
      <html ${brand === "v2" ? 'data-brand="v2"' : ""}>
        <head><style>${globals}\n${targets}\n${brand === "v2" ? theme : ""}</style></head>
        <body>
          <label id="plain"><input type="checkbox">Internal only</label>
          <label id="consent" class="radio"><input type="checkbox"><span>Consent</span></label>
          <label id="hidden"><input class="nav-check" type="checkbox">Navigation</label>
        </body>
      </html>
    `);
    for (const id of ["plain", "consent"]) {
      const label = page.locator(`#${id}`);
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await label.click({ position: { x: 35, y: 35 } });
      await expect(label.locator("input")).toBeChecked();
    }
    await expect(page.locator("#consent")).toHaveCSS("align-items", "flex-start");
    await expect(page.locator("#hidden input")).toHaveCSS("width", "1px");
    await expect(page.locator("#hidden input")).toHaveCSS("height", "1px");
    await expect(page.locator("#hidden")).not.toHaveCSS("min-height", "44px");
  });

  test(`${brand}: tenant frame fills mobile widths and retains desktop framing`, async ({ page }) => {
    await page.setContent(`
      <html ${brand === "v2" ? 'data-brand="v2"' : ""}>
        <head><style>${globals}\n${targets}\n${brand === "v2" ? theme : ""}</style></head>
        <body>
          <div class="stage">
            <div class="phone" data-testid="liff-frame">
              <div class="scr"><div class="notch"></div></div>
            </div>
          </div>
        </body>
      </html>
    `);
    const frame = page.getByTestId("liff-frame");
    for (const width of [360, 480]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(frame).toHaveCSS("width", `${width}px`);
      await expect(frame).toHaveCSS("padding", "0px");
      await expect(frame).toHaveCSS("border-radius", "0px");
      await expect(frame).toHaveCSS("box-shadow", "none");
      await expect(frame.locator(".scr")).toHaveCSS("border-radius", "0px");
      await expect(frame.locator(".notch")).toBeHidden();
      expect(await frame.evaluate((element) => {
        const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h"));
        return Math.abs(element.getBoundingClientRect().height - (window.innerHeight - top));
      })).toBeLessThan(1);
    }
    await page.setViewportSize({ width: 481, height: 800 });
    await expect(frame).toHaveCSS("width", "375px");
    await expect(frame).toHaveCSS("padding", "12px");
    await expect(frame).toHaveCSS("border-radius", "44px");
    await expect(frame.locator(".notch")).toBeVisible();
  });
}
