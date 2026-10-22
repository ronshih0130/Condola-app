import { expect, test, type Page } from "@playwright/test";
import { SAMPLE_JPEG_BASE64 } from "../src/lib/idv";
import { checkboxLabel, displayedShortNotice, fullNoticeText, ID_NOTICE_PATH } from "../src/lib/id-notice";
import { ID_COMPRESS_LONG_EDGE } from "../src/lib/id-compress";
import { MAX_LONG_EDGE, MAX_PHOTO_BYTES, readJpegSize } from "../src/lib/jpeg-size";
import { FIRM_NAME } from "../src/server/ids";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const NOTICE_VARS = {
  firmName: FIRM_NAME,
  firmContact: "電話 +886921000001、電子郵件 yating.lin@songxin.demo",
  fullNoticeUrl: ID_NOTICE_PATH,
};
const NOTICE = displayedShortNotice(NOTICE_VARS);
const AGREE = checkboxLabel();
const PHOTO_TYPE = "只接受 JPG 或 PNG 格式";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const WHITE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const SAMPLE_JPEG = Buffer.from(SAMPLE_JPEG_BASE64, "base64");

async function zh(page: Page, next: string) {
  await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(next)}`);
}

async function upload(page: Page, slot: "front" | "back" | "selfie", file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByTestId(`idv-${slot}-upload`).setInputFiles(file);
}

async function phoneJpeg(page: Page) {
  const bytes = await page.evaluate(async () => {
    const width = 1600;
    const height = 1200;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    const image = ctx.createImageData(width, height);
    const data = image.data;
    let seed = 0x6d2b79f5;
    for (let index = 0; index < data.length; index += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[index] = seed & 180;
      data[index + 1] = (seed >>> 8) & 180;
      data[index + 2] = (seed >>> 16) & 180;
      data[index + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("blob"))), "image/jpeg", 0.92);
    });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return Buffer.from(bytes);
}

test("tenant ID check follows the consent, mask, review, and retention rules", async ({ page }) => {
  test.setTimeout(360_000);
  await resetDemo(page);

  await signIn(page, ACCOUNTS.tenant2);
  await zh(page, "/t");
  await expect(page.getByTestId("idv-home-link")).toHaveText("開始拍攝");
  await page.goto("/t/lease");
  await expect(page.locator("#idvGate")).toBeVisible();
  await expect(page.locator("#idvGate")).toContainText("上傳身分證件與手持證件自拍後，才能簽署租約。");
  await page.goto("/t/id");
  await expect(page.locator("#idvNotice")).toHaveText(NOTICE);
  expect(await page.locator("#idvNotice").evaluate((node) => node.textContent)).toBe(NOTICE);
  await expect(page.locator("#idvNotice a")).toHaveAttribute("href", "/t/id/notice");
  await expect(page.locator("#idvNotice a")).toHaveText("完整版");
  expect(NOTICE.includes("/t/id/notice")).toBe(false);
  await expect(page.locator("#idvAgree + span")).toHaveText(AGREE);
  expect(await page.locator("#idvAgree + span").evaluate((node) => node.textContent)).toBe(AGREE);
  expect(NOTICE.includes("審閱提示")).toBe(false);
  expect(NOTICE.includes("A. 上傳畫面簡短版")).toBe(false);
  expect(NOTICE.includes("B. 完整版")).toBe(false);
  await page.goto("/t/id/notice");
  const full = page.getByTestId("idv-notice-full");
  expect(await full.evaluate((node) => node.textContent)).toBe(fullNoticeText(NOTICE_VARS));
  await expect(full.locator("h3").first()).toHaveText("個人資料保護法第8條告知事項暨同意書");
  await expect(full.locator("pre")).toHaveCount(0);
  const fullText = await full.evaluate((node) => node.textContent ?? "");
  expect(fullText.startsWith("個人資料保護法第8條告知事項暨同意書")).toBe(true);
  expect(fullText.includes("審閱提示")).toBe(false);
  expect(fullText.includes("A. 上傳畫面簡短版")).toBe(false);
  expect(fullText.includes("B. 完整版")).toBe(false);
  expect(fullText.includes("☐")).toBe(false);
  expect(fullText.includes("本人同意上述事項")).toBe(false);
  expect(fullText.includes("滿90日")).toBe(true);
  expect(fullText.includes("依告知事項所定期限")).toBe(false);
  expect(fullText.includes("403 台中市西區府後街38號")).toBe(true);
  expect(fullText.includes("###")).toBe(false);
  await page.goto("/t/id");
  await expect(page.getByTestId("idv-start")).toBeDisabled();
  await page.locator("#idvAgree").check();
  await expect(page.getByTestId("idv-start")).toBeEnabled();

  await signIn(page, ACCOUNTS.admin);
  await zh(page, "/m/settings");
  await expect(page.locator("#idvRetainDays")).toHaveText(
    "身分證件照片：已生效之租約，於租約結束（期滿或提前終止）後滿90日自動刪除（系統每日執行，最遲次日完成）；租約為草稿、未簽署、取消或作廢者，自上傳日起滿90日自動刪除（系統每日執行，最遲次日完成），不另行通知。",
  );
  await expect(page.locator("#idvRetainDays input")).toHaveCount(0);

  await signIn(page, ACCOUNTS.manager);
  await page.goto("/m/settings");
  await expect(page.locator("#idvRetainDays")).toHaveCount(0);

  await signIn(page, ACCOUNTS.tenant2);
  await zh(page, "/t/id");
  await expect(page.locator("#idvNotice")).toHaveText(NOTICE);
  await page.locator("#idvAgree").check();
  await page.getByTestId("idv-start").click();
  await expect(page.locator("#idvDoc")).toBeVisible();
  await expect(page.getByRole("button", { name: "上一步" })).toBeVisible();
  await page.getByRole("radio", { name: "護照" }).click();
  await expect(page.getByTestId("idv-back-upload")).toHaveCount(0);
  await expect(page.getByTestId("idv-front-camera")).toHaveAttribute("capture", "environment");
  await expect(page.getByTestId("idv-front-upload")).not.toHaveAttribute("capture");
  await page.getByRole("radio", { name: "身分證" }).click();
  await expect(page.getByTestId("idv-back-upload")).toHaveCount(1);
  await expect(page.getByTestId("idv-missing")).toHaveText("還缺少：正面、背面");
  await upload(page, "front", { name: "card.heic", mimeType: "image/heic", buffer: Buffer.from("not-a-photo") });
  await expect(page.getByTestId("idv-photo-error")).toHaveText(PHOTO_TYPE);
  await upload(page, "front", { name: "card.gif", mimeType: "image/gif", buffer: GIF });
  await expect(page.getByTestId("idv-photo-error")).toHaveText(PHOTO_TYPE);
  await upload(page, "front", { name: "card.jpg", mimeType: "image/jpeg", buffer: GIF });
  await expect(page.getByTestId("idv-photo-error")).toHaveText(PHOTO_TYPE);
  await upload(page, "front", { name: "white.png", mimeType: "image/png", buffer: WHITE_PNG });
  await expect(page.getByTestId("idv-glare-front")).toContainText("反光");
  await expect(page.getByTestId("idv-photo-error")).toHaveCount(0);
  const phone = await phoneJpeg(page);
  const phoneSize = readJpegSize(phone);
  expect(phoneSize?.width).toBe(1600);
  expect(phoneSize?.height).toBe(1200);
  expect(phone.length).toBeGreaterThan(700 * 1024);
  await page.getByTestId("idv-front-retake").click();
  await upload(page, "front", { name: "phone.jpg", mimeType: "image/jpeg", buffer: phone });
  await expect(page.getByTestId("idv-glare-front")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("idv-photo-error")).toHaveCount(0);
  await upload(page, "back", { name: "back.jpg", mimeType: "image/jpeg", buffer: SAMPLE_JPEG });
  await page.getByTestId("idv-doc-next").click();
  await expect(page.locator("#idvSelfie")).toBeVisible();
  await expect(page.getByTestId("idv-selfie-camera")).toHaveAttribute("capture", "user");
  await upload(page, "selfie", { name: "selfie.jpg", mimeType: "image/jpeg", buffer: SAMPLE_JPEG });
  await page.getByTestId("idv-selfie-next").click();
  await page.getByTestId("idv-number").fill("A123456788");
  await expect(page.getByTestId("idv-submit")).toBeDisabled();
  await page.getByTestId("idv-number").fill("A123456789");
  await expect(page.getByTestId("idv-mask-preview")).toHaveText("之後顯示為：A******789");
  await page.getByTestId("idv-submit").click();
  await expect(page.getByTestId("idv-status")).toHaveText("待核對");
  await expect(page.getByTestId("idv-masked")).toHaveText("A******789");
  await expect(page.getByTestId("idv-keep")).toHaveText("照片依告知事項所定期限自動刪除");
  await expect(page.getByTestId("idv-keep").getByRole("link", { name: "告知事項" })).toHaveAttribute("href", "/t/id/notice");
  await expect(page.getByTestId("idv-toast")).toHaveText("核對完成後，請留意管理公司通知");
  await expect(page.getByRole("button", { name: /重拍/ })).toHaveCount(0);
  await expect(page.locator("#idvAgree")).toHaveCount(0);
  const pending = await page.locator("body").innerText();
  expect(pending).not.toContain("已驗證");
  expect(pending).not.toMatch(/verified/i);
  await expect(page.getByTestId("idv-watermark")).toHaveCount(0);

  await signIn(page, ACCOUNTS.manager);
  await zh(page, "/m/leases");
  await page.getByRole("link", { name: "張雅文" }).click();
  await expect(page.getByTestId("idv-card")).toContainText("範例資料");
  await expect(page.getByTestId("idv-masked")).toHaveText("A******001");
  await expect(page.getByTestId("idv-card")).not.toContainText("A000000001");
  await page.goto("/m/leases");
  await page.getByRole("link", { name: "王小美" }).click();
  await expect(page.getByTestId("idv-status")).toHaveText("待核對");
  await expect(page.getByTestId("idv-masked")).toHaveText("A******789");
  await expect(page.getByTestId("idv-keep")).toHaveText("照片依告知事項所定期限自動刪除");
  await expect(page.getByTestId("idv-keep").getByRole("link")).toHaveCount(0);
  await page.getByTestId("idv-view").click();
  await expect(page.getByRole("dialog")).toContainText("身分證件 · 王小美");
  await expect(page.getByTestId("idv-slot-front")).toHaveText("正面");
  await expect(page.getByTestId("idv-slot-back")).toHaveText("背面");
  await expect(page.getByTestId("idv-slot-selfie")).toHaveText("手持證件自拍");
  await expect(page.getByTestId("idv-logged")).toContainText("這次查看已記錄在稽核紀錄");
  await expect(page.getByTestId("idv-audit-reason")).toHaveText("查看租客 王小美 的身分證件照片");
  await expect(page.getByTestId("idv-watermark")).toHaveCount(3);
  await expect(page.getByTestId("idv-watermark").first()).toContainText("僅供");
  const src = await page.getByTestId("idv-photo-front").getAttribute("src");
  expect(src).toBeTruthy();
  const image = await page.request.get(src!);
  expect(image.ok()).toBeTruthy();
  expect(image.headers()["content-type"]).toContain("image/jpeg");
  const bytes = Buffer.from(await image.body());
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  expect(bytes.includes(Buffer.from("<svg"))).toBe(false);
  expect(bytes.length).toBeGreaterThan(500 * 1024);
  expect(bytes.length).toBeLessThanOrEqual(MAX_PHOTO_BYTES);
  expect(bytes.subarray(bytes.length - 2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  expect(bytes.includes(Buffer.from("condola-id-wm"))).toBe(false);
  await expect
    .poll(() => page.getByTestId("idv-photo-front").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const burned = await page.getByTestId("idv-photo-front").evaluate((img: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.drawImage(img, 0, 0);
    const pixel = ctx.getImageData(Math.floor(canvas.width / 2), canvas.height - 1, 1, 1).data;
    return { r: pixel[0] ?? 0, g: pixel[1] ?? 0, b: pixel[2] ?? 0 };
  });
  expect(burned.r).toBeGreaterThan(100);
  expect(burned.r).toBeGreaterThan(burned.g + 30);
  expect(burned.r).toBeGreaterThan(burned.b + 30);
  const stored = readJpegSize(bytes);
  expect(stored?.width).toBe(1600);
  expect(stored?.height).toBe(1200);
  expect(Math.max(stored?.width ?? 0, stored?.height ?? 0)).toBeLessThanOrEqual(MAX_LONG_EDGE);
  await page.getByRole("dialog").getByRole("button", { name: "關閉" }).click();
  await page.getByTestId("idv-return-reason-input").fill("反光看不清");
  await page.getByTestId("idv-return").click();
  await expect(page.getByTestId("idv-toast")).toContainText("已退回");
  await expect(page.getByTestId("idv-status")).toHaveText("退回重傳");

  await signIn(page, ACCOUNTS.tenant2);
  await zh(page, "/t/id");
  await expect(page.getByTestId("idv-returned")).toContainText("反光看不清");
  await expect(page.locator("#idvConsent")).toBeVisible();
  await page.locator("#idvAgree").check();
  await page.getByTestId("idv-start").click();
  await page.getByTestId("idv-sample").click();
  await page.getByTestId("idv-doc-next").click();
  await page.getByTestId("idv-selfie-next").click();
  await page.getByTestId("idv-number").fill("A123456789");
  await page.getByTestId("idv-submit").click();
  await expect(page.getByTestId("idv-status")).toHaveText("待核對");
  await expect(page.getByTestId("idv-keep").getByRole("link", { name: "告知事項" })).toHaveAttribute("href", "/t/id/notice");

  await signIn(page, ACCOUNTS.manager);
  await zh(page, "/m/leases");
  await page.getByRole("link", { name: "王小美" }).click();
  await page.getByTestId("idv-mark-checked").click();
  await expect(page.getByTestId("idv-toast")).toContainText("已核對");
  await expect(page.getByTestId("idv-status")).toHaveText("已核對");
  await expect(page.getByTestId("idv-return")).toHaveCount(0);
  const checked = await page.locator("#idvCard").innerText();
  expect(checked).not.toContain("已驗證");
  expect(checked).not.toMatch(/verified/i);

  await signIn(page, ACCOUNTS.accountant);
  await zh(page, "/m/leases");
  await page.getByRole("link", { name: "王小美" }).click();
  await expect(page.locator("#idvNoAccess")).toBeVisible();
  await expect(page.locator("#idvNoAccess")).toContainText("只有管理員與經理可以查看證件照片");
  await expect(page.getByTestId("idv-view")).toHaveCount(0);
  await expect(page.getByTestId("idv-masked")).toHaveCount(0);

  await signIn(page, ACCOUNTS.owner);
  await zh(page, "/o");
  const owner = await page.locator("body").innerText();
  expect(owner).not.toContain("待核對");
  expect(owner).not.toContain("已核對");
  expect(owner).not.toContain("身分證件");
  expect(owner).not.toContain("A******789");

  await signIn(page, ACCOUNTS.maintenance);
  await page.goto("/m/leases");
  await expect(page.getByTestId("forbidden")).toBeVisible();

  await signIn(page, ACCOUNTS.admin);
  const csv = await page.request.get("/api/export");
  expect(csv.ok()).toBeTruthy();
  const text = await csv.text();
  expect(text).not.toContain("A12");
  expect(text).not.toContain("number_masked");
  expect(text).not.toContain("identity_document");
  expect(text).not.toContain("身分證");

  await signIn(page, ACCOUNTS.tenant2);
  await zh(page, "/t");
  await expect(page.getByTestId("idv-home-link")).toHaveCount(0);
  await page.goto("/t/lease");
  await expect(page.locator("#idvGate")).toHaveCount(0);
});

async function wideJpeg(page: Page, width: number, height: number) {
  const bytes = await page.evaluate(async ({ width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.fillStyle = "#6e6248";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#243044";
    ctx.fillRect(Math.round(width * 0.08), Math.round(height * 0.12), Math.round(width * 0.84), Math.round(height * 0.28));
    ctx.fillStyle = "#c4b49a";
    for (let row = 0; row < 8; row += 1) {
      ctx.fillRect(Math.round(width * 0.12), Math.round(height * (0.48 + row * 0.05)), Math.round(width * 0.7), Math.round(height * 0.02));
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("blob"))), "image/jpeg", 0.92);
    });
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, { width, height });
  return Buffer.from(bytes);
}

test("a compressed ID photo still uploads and shows 待核對", async ({ page }) => {
  test.setTimeout(180_000);
  await resetDemo(page);
  const source = await wideJpeg(page, 2400, 1800);
  const sourceSize = readJpegSize(source);
  expect(sourceSize?.width).toBe(2400);
  expect(Math.max(sourceSize?.width ?? 0, sourceSize?.height ?? 0)).toBeGreaterThan(ID_COMPRESS_LONG_EDGE);

  await signIn(page, ACCOUNTS.tenant2);
  await zh(page, "/t/id?compress=1");
  await page.locator("#idvAgree").check();
  await page.getByTestId("idv-start").click();
  const file = { name: "wide.jpg", mimeType: "image/jpeg", buffer: source };
  await upload(page, "front", file);
  const preview = page.getByTestId("idv-preview-front");
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 60_000 }).toBe(ID_COMPRESS_LONG_EDGE);
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(1500);
  await upload(page, "back", file);
  await expect(page.getByTestId("idv-preview-back")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("idv-doc-next").click();
  await upload(page, "selfie", file);
  await expect(page.getByTestId("idv-preview-selfie")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("idv-selfie-next").click();
  await page.getByTestId("idv-number").fill("A123456789");
  await page.getByTestId("idv-submit").click();
  await expect(page.getByTestId("idv-status")).toHaveText("待核對");

  await signIn(page, ACCOUNTS.manager);
  await zh(page, "/m/leases");
  await page.getByRole("link", { name: "王小美" }).click();
  await expect(page.getByTestId("idv-status")).toHaveText("待核對");
  await page.getByTestId("idv-view").click();
  const src = await page.getByTestId("idv-photo-front").getAttribute("src");
  expect(src).toBeTruthy();
  const image = await page.request.get(src!);
  expect(image.ok()).toBeTruthy();
  expect(image.headers()["content-type"]).toContain("image/jpeg");
  const stored = readJpegSize(Buffer.from(await image.body()));
  expect(stored?.width).toBe(ID_COMPRESS_LONG_EDGE);
  expect(stored?.height).toBe(1500);
  expect(Math.max(stored?.width ?? 0, stored?.height ?? 0)).toBeLessThanOrEqual(MAX_LONG_EDGE);
});
