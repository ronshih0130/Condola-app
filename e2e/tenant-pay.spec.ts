import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const FORBIDDEN = ["收款", "收租", "入帳", "房東", "LINE"];

async function openPay(page: Page) {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t/pay");
  await expect(page.getByRole("heading", { name: "我的帳單" })).toBeVisible();
}

async function expectClean(page: Page) {
  // 匯入帳戶 is the transfer account, not the staff term 入帳.
  const text = (await page.locator("body").innerText()).split("匯入帳戶").join("");
  for (const word of FORBIDDEN) expect(text, word).not.toContain(word);
}

async function rememberScroll(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector(".liffb");
    const button = document.querySelector("[data-testid='record-payment']");
    if (!(scroller instanceof HTMLElement) || !(button instanceof HTMLElement)) throw new Error("missing bill scroller");
    let spacer = scroller.querySelector("[data-testid='scroll-spacer']");
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.setAttribute("data-testid", "scroll-spacer");
      (spacer as HTMLElement).style.height = "900px";
      scroller.insertBefore(spacer, scroller.firstChild);
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const buttonTop = button.getBoundingClientRect().top;
    scroller.scrollTop += buttonTop - scrollerTop - 80;
    document.documentElement.style.minHeight = "1800px";
    window.scrollTo(0, 180);
    return { inner: scroller.scrollTop, windowY: window.scrollY };
  });
}

async function expectScroll(page: Page, saved: { inner: number; windowY: number }) {
  await expect.poll(async () =>
    page.evaluate(() => {
      const scroller = document.querySelector(".liffb");
      return {
        inner: scroller instanceof HTMLElement ? scroller.scrollTop : -1,
        windowY: window.scrollY,
      };
    }),
  ).toEqual(saved);
  expect(saved.inner).toBeGreaterThan(0);
  expect(saved.windowY).toBeGreaterThan(0);
}

test.describe("tenant pay dialog", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1280, height: 800 } });
    test("bills stay visible until 回報繳款, and each close restores scroll", async ({ page }) => {
      await runPayDialog(page, "click");
    });
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
    test("bills stay visible until 回報繳款, and each close restores scroll", async ({ page }) => {
      await runPayDialog(page, "tap");
    });
  });
});

async function runPayDialog(page: Page, backdrop: "click" | "tap") {
  await openPay(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const bill = page.getByTestId("tenant-bill");
  await expect(bill).toBeVisible();
  await expect(bill).toContainText("12,000");
  await expectClean(page);

  const trigger = page.getByTestId("record-payment");
  await expect(trigger).toHaveText("回報繳款");
  const saved = await rememberScroll(page);

  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  const titleId = await dialog.getAttribute("aria-labelledby");
  expect(titleId).toBeTruthy();
  await expect(page.locator(`[id="${titleId}"]`)).toHaveText("回報繳款");
  await expect(page.getByTestId("submit-payment")).toHaveText("回報繳款");
  await page.getByTestId("pay-amount").click();
  await expect(dialog).toBeVisible();
  await expectClean(page);

  await page.evaluate(() => {
    const scroller = document.querySelector(".liffb");
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  const close = page.getByTestId("pay-dialog-close");
  await expect(close).toHaveText("✕");
  await expect(close).toHaveAttribute("aria-label", "關閉");
  await close.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(bill).toBeVisible();
  await expect(trigger).toBeFocused();
  await expectScroll(page, saved);

  await trigger.click();
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectScroll(page, saved);

  await trigger.click();
  await expect(dialog).toBeVisible();
  if (backdrop === "tap") await dialog.tap({ position: { x: 8, y: 8 } });
  else await dialog.click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(bill).toBeVisible();
  await expectScroll(page, saved);
}
