import { expect, test, type Page } from "@playwright/test";
import { resetDemo, signIn } from "./session";

async function roomValue(page: Page, propertyName: string, label: string) {
  const options = page.getByTestId("lease-room").locator("option");
  const count = await options.count();
  for (let index = 0; index < count; index += 1) {
    const text = (await options.nth(index).innerText()).replace(/\s+/g, " ").trim();
    if (text.includes(propertyName) && text.endsWith(` ${label}`)) {
      return options.nth(index).getAttribute("value");
    }
  }
  throw new Error(`no room ${label} on ${propertyName}`);
}

async function reachLeaseSubmit(page: Page, opts: { propertyName: string; label: string; tenant: string; phone: string }) {
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");
  await expect(page.locator("body")).not.toContainText("房東");
  const value = await roomValue(page, opts.propertyName, opts.label);
  expect(value).toBeTruthy();
  await page.getByTestId("lease-room").selectOption(value ?? "");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill(opts.tenant);
  await page.getByTestId("tenant-phone").fill(opts.phone);
  await page.getByTestId("wizard-next").click();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  await page.getByTestId("start-date").fill(today);
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("10000");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("deposit-months").fill("2");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("due-day").fill("5");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
  await expect(page.getByTestId("utility-monthly-note")).toContainText("建立租約時不用填");
  await expect(page.getByTestId("utility-monthly-note").getByRole("link", { name: "電費登記" })).toHaveAttribute("href", "/m/rent/utilities");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("lease-template")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  const submit = page.getByTestId("submit-lease");
  await expect(submit).toBeEnabled();
  await expect(page.getByTestId("lease-confirm-rent")).toHaveText("NT$10,000");
  await expect(page.getByTestId("lease-confirm-deposit")).toHaveText("2 個月（NT$20,000）");
  return submit;
}

async function expectOneLease(page: Page, tenant: string) {
  await page.goto("/m/leases?q=" + encodeURIComponent(tenant));
  await expect(page.getByTestId("lease-list").locator("tr", { hasText: tenant })).toHaveCount(1);
}

test("deposit reason and a private signed PDF", async ({ page }) => {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");
  await expect(page.locator("body")).not.toContainText("房東");

  const room = page.getByTestId("lease-room");
  const roomValue = await room.locator("option", { hasText: "3F C" }).first().getAttribute("value");
  expect(roomValue).toBeTruthy();
  await room.selectOption(roomValue ?? "");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("紙本房客");
  await page.getByTestId("tenant-phone").fill("+886912300088");
  await expect(page.getByTestId("tenant-line")).toHaveCount(0);
  await page.getByTestId("wizard-next").click();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  await page.getByTestId("start-date").fill(today);
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("10000");
  await page.getByTestId("wizard-next").click();

  await expect(page.getByTestId("deposit-months")).toHaveValue("2");
  await page.getByTestId("deposit-months").fill("3");
  const alert = page.getByTestId("deposit-alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("請填寫原因");
  await expect(alert).not.toContainText("房東");
  await expect(page.getByTestId("wizard-next")).toBeDisabled();
  await page.getByTestId("deposit-reason").fill("   ");
  await expect(page.getByTestId("wizard-next")).toBeDisabled();
  await page.getByTestId("deposit-reason").fill("屋主同意兩個月以上押金");
  await expect(page.getByTestId("wizard-next")).toBeEnabled();
  await page.getByTestId("wizard-next").click();

  await expect(page.getByTestId("due-day")).toHaveValue("5");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
  await expect(page.getByTestId("bill-total")).toHaveCount(0);
  await expect(page.getByTestId("usage")).toHaveCount(0);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("lease-template")).toBeVisible();
  await page.getByTestId("template-lang-zh").press("Enter");
  await expect(page.getByTestId("lease-template")).toBeVisible();
  await expect(page).toHaveURL(/\/m\/leases\/new/);
  const nextBox = await page.getByTestId("wizard-next").boundingBox();
  expect(nextBox).toBeTruthy();
  await page.mouse.click(nextBox!.x + nextBox!.width / 2, nextBox!.y + nextBox!.height / 2, { clickCount: 2 });
  const submit = page.getByTestId("submit-lease");
  await expect(submit).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(page).toHaveURL(/\/m\/leases\/new/);
  await expect(page.getByText("確認後送出給租客簽名")).toBeVisible();
  await expect(submit).toBeEnabled();
  await expect(page).toHaveURL(/\/m\/leases\/new/);
  await expect(page.getByTestId("paper-sign")).toHaveCount(0);
  await expect(page.getByTestId("lease-confirm-rent")).toHaveText("NT$10,000");
  await expect(page.getByTestId("lease-confirm-deposit")).toHaveText("3 個月（NT$30,000）");
  await submit.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  const error = page.getByTestId("error-banner");
  if (await error.isVisible().catch(() => false)) {
    throw new Error(await error.innerText());
  }
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  await expect(page.getByTestId("lease-created")).toHaveText("租約已建立，請將簽署連結傳給租客");
  const createdUrl = page.url();
  await page.goto("/m/leases?q=" + encodeURIComponent("紙本房客"));
  await expect(page.getByTestId("lease-list").locator("tr", { hasText: "紙本房客" })).toHaveCount(1);
  await page.goto(createdUrl);
  await page.locator(".tabsx a[href*='tab=sign']").click();
  await expect(page.getByTestId("idv-sign-wait")).toBeVisible();
  await expect(page.getByTestId("paper-sign")).toHaveCount(0);
  const blockedId = page.url().match(/leases\/([^/?]+)/)?.[1];
  expect(blockedId).toBeTruthy();
  const sample = await page.request.post("/api/demo/id-sample", { data: { leaseId: blockedId } });
  expect(sample.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("paper-sign")).toBeVisible();
  expect(crashes).toEqual([]);

  await page.getByRole("link", { name: "摘要" }).click();
  await expect(page.getByTestId("deposit-override-reason")).toContainText("屋主同意兩個月以上押金");
  await expect(page.getByTestId("deposit-alert")).toHaveCount(0);
  await expect(page.getByTestId("summary-deposit")).toHaveText("NT$30,000");
  await page.getByTestId("deposit-months").fill("4");
  const editAlert = page.getByTestId("deposit-alert");
  await expect(editAlert).toBeVisible();
  await expect(editAlert).toContainText("請填寫原因");
  await expect(editAlert).not.toContainText("房東");
  await page.getByTestId("deposit-reason").fill("   ");
  await expect(page.getByTestId("save-lease-terms")).toBeDisabled();
  await page.getByTestId("deposit-reason").fill("屋主同意調整為四個月押金");
  await expect(page.getByTestId("save-lease-terms")).toBeEnabled();
  await page.getByTestId("save-lease-terms").click();
  const editError = page.getByTestId("lease-error");
  if (await editError.isVisible().catch(() => false)) {
    throw new Error(await editError.innerText());
  }
  await expect(page.getByTestId("deposit-alert")).toHaveCount(0);
  await expect(page.getByTestId("deposit-reason")).toHaveCount(0);
  await expect(page.getByTestId("deposit-override-reason")).toContainText("屋主同意調整為四個月押金");
  await expect(page.getByTestId("summary-deposit")).toHaveText("NT$40,000");
  await expect(page.getByTestId("summary-rent")).toHaveText("NT$10,000");

  await page.locator(".tabsx").getByRole("link", { name: "簽署與文件" }).click();
  await page.getByTestId("signed-pdf").setInputFiles({
    name: "signed-lease.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
  });
  await page.getByTestId("upload-signed-pdf").click();
  if (await error.isVisible().catch(() => false)) {
    throw new Error(await error.innerText());
  }
  await expect(page.getByTestId("paper-signed")).toContainText("已上傳紙本租約");
  await expect(page.getByTestId("paper-signed")).toContainText("signed-lease.pdf");

  await page.getByRole("link", { name: "摘要" }).click();
  await expect(page.getByTestId("tenant-line-id")).toHaveCount(0);
  await expect(page.getByText("生效中")).toBeVisible();
  await expect(page.getByTestId("deposit-override-reason")).toContainText("屋主同意調整為四個月押金");
  await expect(page.getByTestId("lease-terms-locked")).toContainText("已簽署或已生效");
  await expect(page.getByTestId("lease-terms-locked")).not.toContainText("房東");
  await expect(page.getByTestId("save-lease-terms")).toHaveCount(0);

  const leaseId = page.url().match(/leases\/([^/?]+)/)?.[1];
  expect(leaseId).toBeTruthy();
  const pdf = await page.request.get(`/m/leases/${leaseId}/signed`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");

  await signIn(page, "admin@coast.demo");
  const leaked = await page.request.get(`/m/leases/${leaseId}/signed`);
  expect(leaked.status()).toBe(404);
  expect(crashes).toEqual([]);
});

test("two leases save back to back, a triple click saves one, and a failed submit can be resent", async ({ page }) => {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));
  await resetDemo(page);
  const stamp = Date.now().toString(36);
  const propertyName = `冪等${stamp}`;
  const created = await page.request.post("/api/flows/createProperty", {
    data: {
      name: propertyName,
      city: "台北市",
      district: "大安區",
      street: "冪等路1號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "冪等屋主",
      ownerPhone: "0912000000",
      ownerEmail: `idempotent.owner.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "9F",
      floor: "9",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10000 },
        { label: "B", roomType: "suite", baseRentMajor: 10000 },
        { label: "C", roomType: "suite", baseRentMajor: 10000 },
        { label: "D", roomType: "suite", baseRentMajor: 10000 },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  const first = await reachLeaseSubmit(page, { propertyName, label: "A", tenant: "甲租客", phone: "+886912300101" });
  await first.click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  const second = await reachLeaseSubmit(page, { propertyName, label: "B", tenant: "乙租客", phone: "+886912300102" });
  await second.click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  await expectOneLease(page, "甲租客");
  await expectOneLease(page, "乙租客");

  const triple = await reachLeaseSubmit(page, { propertyName, label: "C", tenant: "丙租客", phone: "+886912300103" });
  await triple.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
    button.click();
  });
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  await expectOneLease(page, "丙租客");

  const failed = await reachLeaseSubmit(page, { propertyName, label: "D", tenant: "丁租客", phone: "+886912300104" });
  await failed.evaluate((button: HTMLButtonElement) => {
    const input = button.form?.elements.namedItem("dueDay");
    if (input instanceof HTMLInputElement) input.value = "99";
    button.click();
  });
  const error = page.getByTestId("lease-error");
  await expect(error).toBeVisible();
  await expect(failed).toBeEnabled();
  await failed.click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  await expectOneLease(page, "丁租客");
  expect(crashes).toEqual([]);
});

test("an aborted create stays on the wizard and a resubmit saves one lease", async ({ page }) => {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));
  await resetDemo(page);
  const stamp = Date.now().toString(36);
  const propertyName = `重送${stamp}`;
  const tenant = "重送租客";
  const created = await page.request.post("/api/flows/createProperty", {
    data: {
      name: propertyName,
      city: "台北市",
      district: "大安區",
      street: "重送路1號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "重送屋主",
      ownerPhone: "0912000099",
      ownerEmail: `retry.owner.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "8F",
      floor: "8",
      rentalMode: "by_room",
      rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  const submit = await reachLeaseSubmit(page, { propertyName, label: "A", tenant, phone: "+886912300199" });
  const keys: string[] = [];
  let aborted = false;
  await page.route("**/m/leases/new**", async (route) => {
    const request = route.request();
    const action = request.headers()["next-action"];
    if (request.method() !== "POST" || !action) {
      await route.continue();
      return;
    }
    const body = request.postData() ?? "";
    const key = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]?.toLowerCase() ?? "";
    keys.push(key);
    if (!aborted) {
      aborted = true;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await submit.click();
  const error = page.getByTestId("lease-error");
  const failureCopy = "租約沒有送出成功，填好的資料都還在，請再送出一次。";
  await expect(error).toBeVisible();
  await expect(error).toHaveText(failureCopy);
  await expect(submit).toBeEnabled();
  const errorBox = await error.boundingBox();
  const buttonBox = await submit.boundingBox();
  expect(errorBox).toBeTruthy();
  expect(buttonBox).toBeTruthy();
  expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(buttonBox!.y);
  expect(buttonBox!.y - (errorBox!.y + errorBox!.height)).toBeLessThan(24);
  expect(errorBox!.x).toBeLessThan(buttonBox!.x + buttonBox!.width);
  expect(errorBox!.x + errorBox!.width).toBeGreaterThan(buttonBox!.x);
  await expect(page).toHaveURL(/\/m\/leases\/new/);
  await expect(page.locator("body")).not.toContainText("Application error");
  await expect(page.getByTestId("lease-confirm-tenant")).toContainText(tenant);
  expect(keys, "aborted request did not include an idempotency key").toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);

  await submit.click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await expectOneLease(page, tenant);
  expect(crashes).toEqual([]);
});
