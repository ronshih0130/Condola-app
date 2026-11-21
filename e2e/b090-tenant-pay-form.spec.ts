import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";

// B-090 slice 2 re-land, RT-REPORT (TEN-53-AC6) in a real browser: the report form's error announcements and focus, and the
// per-tenant draft across a same-tab account switch. The client component is bundled on its own and mounted on a
// synthetic origin (no app server, no database); the action is a local stub, so nothing is sent anywhere.

const ORIGIN = "http://b090-report.test";
const labels = {
  amount: "金額", max: "最多 NT$1（還沒回報的部分）。", paidOn: "匯款日期", last5: "帳號末五碼", required: "必填", lastUsed: "上次填的，可以改。", note: "備註（選填）",
  notePlaceholder: "例：分兩次匯", submit: "送出回報", saving: "處理中…", cancel: "取消", retry: "再試一次", errorItem: "{field}：{message}",
};
const messages = { amountPositive: "請填大於 0 的金額。", overLimit: "金額超過還沒回報的部分。", required: "還有必填欄位沒有填。", last5: "末五碼請輸入 5 位數字" };
const A = { userId: "user-a", orgId: "org-1", leaseId: "lease-1" };
const B = { userId: "user-b", orgId: "org-1", leaseId: "lease-1" };
const defaults = { amount: "1", paidOn: "2026-11-18", last5: "", note: "" };

let bundle = "";
test.beforeAll(async () => {
  const root = resolve(__dirname, "..");
  const out = await build({
    stdin: {
      resolveDir: root, loader: "tsx", sourcefile: "b090-report-harness.tsx",
      contents: `import React from "react"; import { createRoot } from "react-dom/client";
        import { TenantReportForm } from "./src/components/v3/tenant/pay-client";
        let root = null;
        window.__mount = (props) => {
          root = root ?? createRoot(document.getElementById("app"));
          root.render(React.createElement(TenantReportForm, { ...props, key: props.mountKey, action: async () => { window.__sent = (window.__sent ?? 0) + 1; if (window.__hold) await new Promise(() => {}); } }));
        };
        window.__unmount = () => { root?.unmount(); root = null; };`,
    },
    bundle: true, write: false, format: "iife", jsx: "automatic", platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-link", setup(b) {
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "tsx", resolveDir: root, contents: `import React from "react"; export default function Link({ href, children, ...rest }) { return React.createElement("a", { href, ...rest }, children); }` }));
    } }],
  });
  bundle = out.outputFiles[0].text;
});

async function open(page: Page) {
  await page.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-Hant"><body><div id="app"></div></body></html>` }));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle });
}
type Mount = { mountKey: string; owner: typeof A; serverError?: { field: string | null; message: string } | null };
const mount = (page: Page, m: Mount) => page.evaluate(p => (window as unknown as { __mount: (x: unknown) => void }).__mount(p),
  { currency: "TWD", restMinor: 100, defaults, lastUsed: false, needsLast5: true, serverError: null, messages, labels, ...m });
const unmount = (page: Page) => page.evaluate(() => (window as unknown as { __unmount: () => void }).__unmount());
const live = (page: Page) => page.getByTestId("tenant-report-errors");
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-field") ?? null);

test("TEN-53-AC6 a11y: an Enter-triggered validation error is announced and focuses the first invalid field", async ({ page }) => {
  await open(page);
  await mount(page, { mountKey: "1", owner: A });
  await expect(live(page)).toHaveAttribute("aria-live", "assertive");
  await expect(live(page)).toHaveText("");
  const amount = page.locator('[data-field="amount"]');
  await amount.fill("5");
  await page.locator('[data-field="last5"]').focus();
  await page.keyboard.press("Enter");
  await expect(live(page)).toHaveText("金額：金額超過還沒回報的部分。 帳號末五碼：末五碼請輸入 5 位數字");
  await expect.poll(() => focused(page)).toBe("amount");
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  expect(await page.evaluate(() => (window as unknown as { __sent?: number }).__sent ?? 0)).toBe(0);
  // the same mistake again is announced again (the region is cleared, then refilled)
  await page.locator('[data-field="last5"]').focus();
  await page.keyboard.press("Enter");
  await expect(live(page)).toHaveText("金額：金額超過還沒回報的部分。 帳號末五碼：末五碼請輸入 5 位數字");
  await expect.poll(() => focused(page)).toBe("amount");
});

test("TEN-53-AC6 a11y: a server-returned field error is announced and its field focused on restore", async ({ page }) => {
  await open(page);
  await mount(page, { mountKey: "1", owner: A, serverError: { field: "last5", message: "末五碼請輸入 5 位數字" } });
  await expect(live(page)).toHaveText("帳號末五碼：末五碼請輸入 5 位數字");
  await expect.poll(() => focused(page)).toBe("last5");
  await expect(page.locator('[data-field="last5"]')).toHaveAttribute("aria-invalid", "true");
  await unmount(page);
  // a form-level refusal is announced too (no field to focus)
  await mount(page, { mountKey: "2", owner: A, serverError: { field: null, message: "沒有完成。請檢查欄位後再試一次。" } });
  await expect(live(page)).toHaveText("沒有完成。請檢查欄位後再試一次。");
});

test("TEN-53-AC6 draft: restored once for the same tenant; a same-tab account switch never shows another tenant's draft", async ({ page }) => {
  await open(page);
  const keyA = "condola:b090-report:user-a:org-1:lease-1";
  const send = async (note: string) => {
    await page.locator('[data-field="last5"]').fill("12345");
    await page.locator('input[name="reference"]').fill(note);
    await page.getByTestId("tenant-report-submit").click();
    await expect.poll(() => page.evaluate(k => sessionStorage.getItem(k), keyA)).not.toBeNull();
  };
  // A sends, the server refuses: A's values come back once, then the draft is gone
  await mount(page, { mountKey: "1", owner: A });
  await send("A 的備註");
  const stored = JSON.parse((await page.evaluate(k => sessionStorage.getItem(k), keyA))!);
  expect(stored).toEqual({ v: 1, ...A, values: { amount: "1", paidOn: "2026-11-18", last5: "12345", note: "A 的備註" } });
  await unmount(page);
  await mount(page, { mountKey: "2", owner: A, serverError: { field: null, message: "沒有完成。" } });
  await expect(page.locator('input[name="reference"]')).toHaveValue("A 的備註");
  await expect(page.locator('[data-field="last5"]')).toHaveValue("12345");
  expect(await page.evaluate(k => sessionStorage.getItem(k), keyA)).toBeNull();
  await unmount(page);
  await mount(page, { mountKey: "3", owner: A, serverError: { field: null, message: "沒有完成。" } });
  await expect(page.locator('input[name="reference"]')).toHaveValue("");
  await unmount(page);
  // A sends again, then B signs in on the same tab and gets a refusal: B sees the defaults, and A's draft is swept
  await mount(page, { mountKey: "4", owner: A });
  await send("A 的第二筆");
  await unmount(page);
  await mount(page, { mountKey: "5", owner: B, serverError: { field: null, message: "沒有完成。" } });
  await expect(page.locator('input[name="reference"]')).toHaveValue("");
  await expect(page.locator('[data-field="last5"]')).toHaveValue("");
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith("condola:b090-report:")))).toEqual([]);
  // a draft stored under B's key but written for A is rejected
  await unmount(page);
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), ["condola:b090-report:user-b:org-1:lease-1", JSON.stringify({ v: 1, ...A, values: { ...defaults, note: "A" } })]);
  await mount(page, { mountKey: "6", owner: B, serverError: { field: null, message: "沒有完成。" } });
  await expect(page.locator('input[name="reference"]')).toHaveValue("");
});

test("TEN-53-AC6: no double submit — a second press or Enter while the send is under way sends nothing more", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as unknown as { __hold: boolean }).__hold = true; });
  await mount(page, { mountKey: "1", owner: A });
  await page.locator('[data-field="last5"]').fill("12345");
  const submit = page.getByTestId("tenant-report-submit");
  await submit.dblclick();
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText("處理中…");
  await page.locator('[data-field="last5"]').press("Enter");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as { __sent?: number }).__sent ?? 0)).toBe(1);
});
