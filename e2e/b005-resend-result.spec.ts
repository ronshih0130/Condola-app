import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "@playwright/test";
import { PortalResendResult } from "../src/components/portal-resend-result";
import { simulatedResult, type ResendStatus } from "../src/lib/portal-resend-state";

for (const locale of ["en", "zh-TW"] as const) test(`synthetic result presentation remains clear (${locale})`, async ({ page }, info) => {
  if (process.env.B005_RESEND_PRIVATE_CONFIG !== "1" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1" || !info.config.configFile?.endsWith("/e2e/b005-resend-private-playwright.config.ts") || info.project.use.trace !== "off" || info.project.use.video !== "off" || info.project.use.screenshot !== "off" || info.config.reporter.length !== 1 || info.config.reporter[0][0] !== "line") throw new Error("B005 private preview required");
  let requests = 0;
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", message => { if (message.type() === "error") errors.push("console error"); });
  await page.context().route("**/*", async route => { requests++; await route.abort(); });
  const css = ["src/app/tokens.css", "src/app/globals.css"].map(path => readFileSync(resolve(process.cwd(), path), "utf8").replace(/@(?:import|config)[^;]*;/gi, "").replace(/url\s*\([^)]*\)/gi, "none")).join("\n");
  if (/@(?:import|config)|url\s*\(|<\/style/i.test(css)) throw new Error("Unsafe preview style");
  const statuses: ResendStatus[] = ["captured", "accepted", "rejected", "unknown", "already_connected", "unavailable"];
  const markup = statuses.map(status => renderToStaticMarkup(createElement(PortalResendResult, { result: simulatedResult(status), locale, company: "Synthetic company", audience: locale === "en" ? "tenant" : "owner" }))).join("");
  await page.setContent(`<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} main.preview { box-sizing: border-box; width: 100%; max-width: 760px; padding: 16px; margin: 0 auto; }</style></head><body><main class="preview"><h1>${locale === "en" ? "Synthetic simulation preview" : "合成模擬預覽"}</h1>${markup}</main></body></html>`);
  await expect(page.getByText(locale === "en" ? "Simulation preview" : "模擬預覽", { exact: true })).toHaveCount(statuses.length);
  const results = page.getByTestId("resend-status");
  const expected = locale === "en"
    ? ["delivery is not confirmed", "delivery is not confirmed", "simulated provider rejected", "result is unknown", "no request was made", "not available"]
    : ["尚未確認送達", "尚未確認送達", "拒絕", "結果尚未確認", "未發出請求", "無法重寄"];
  for (let i = 0; i < expected.length; i++) await expect(results.nth(i)).toContainText(expected[i]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(requests).toBe(0);
  await page.screenshot({ path: info.outputPath(`resend-simulation-${locale}.png`), fullPage: true });
  expect(requests).toBe(0);
  expect(errors).toEqual([]);
});
