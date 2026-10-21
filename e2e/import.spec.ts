import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { buildXlsx } from "../src/lib/spreadsheet";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const BIG5_CSV = Buffer.from(
  "qqul86ZXutkspmGnfSyrzqVEqW2mVyyrzqVEIEVtYWlsLKVYr7KrrLpBLKThp0+h/rzTvGgsqdC4uSyp0KusLKlXvMYspOuvsiyvsqvIqW2mVyyvsqvIuXG43CyvsqvIIEVtYWlsLK+yq8ioraTAw9Kmcri5LLBfr7Kk6Syo7LTBpOksqeOq9yzDuq+ypOksuXG2T6TopqEsqEOr17lxu/kspXi5cbFis+ar17zGLKV4uXGxYrPmqvfDQiy0warspO202iyp46r3tle5TKRXra2t7KZdLLlxu/m2V7lMpFetra3spl0ss8a1+Qq216RKpL20SiyleKVfpaukaqZ3sM+216RKuPQ4uLkstPq41avOpUQsb3duZXIuYmlnNUBleGFtcGxlLmNvbSykwK+yLDJGLEEsLCwxMDAwMCyp46r3r7KryCwwOTEyMDAwMTExLGRlcC5iaWc1QGV4YW1wbGUuY29tLEExMjM0NTY3ODksMjAyNi0xMS0wMSwyMDI3LTEwLTMxLDMwMDAwLDUspMCq7Sw2LDEwMCw0MDAsLCy5cbv5reymXSwKttekSqS9tEospXilX6WrpGqmd7DPttekSrj0OLi5LLT6uNWrzqVELG93bmVyLmJpZzVAZXhhbXBsZS5jb20spMCvsiwyRixCLCwsMTAwMDAsqOy0wa+yq8gsMDkxMjAwMDMzMyxlbmQuYmlnNUBleGFtcGxlLmNvbSxCMTIzNDU2NzgwLDIwMjQtMDEtMDEsMjAyNS0wMS0wMSwyMDAwMCw1LKTAqu0sLCwsLCwsCrbXpEqkvbRKLKV4pV+lq6Rqpnewz7bXpEq49Di4uSy0+rjVq86lRCxvd25lci5iaWc1QGV4YW1wbGUuY29tLKTAr7IsM0YsQSwsLDEwMDAwLKazrsSvsqvILDA5MTIwMDAyMjIsb2suYmlnNUBleGFtcGxlLmNvbSxDMTIzNDU2NzgxLDIwMjYtMTEtMDEsMjAyNy0xMC0zMSwyMDAwMCw1LCwsLCwsLCwK",
  "base64",
);

const HEADERS = [
  "物件名稱",
  "地址",
  "屋主姓名",
  "屋主 Email",
  "出租型態",
  "戶別／樓層",
  "房號",
  "房型",
  "坪數",
  "月租",
  "租客姓名",
  "租客電話",
  "租客 Email",
  "租客身分證字號",
  "起租日",
  "到期日",
  "押金",
  "繳租日",
  "電費方式",
  "每度電價",
  "台電帳單度數",
  "台電帳單金額",
  "期初欠款",
  "押金超過上限原因",
  "電價超過上限原因",
  "備註",
];

test("Big5 import maps columns, skips invalid rows, and is idempotent", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/properties");
  await expect(page.locator(".main")).not.toContainText("房東");
  await expect(page.locator(".main")).not.toContainText("房客");
  await page.getByTestId("import-link").click();
  await expect(page.getByRole("heading", { name: "Excel 匯入" })).toBeVisible();
  await expect(page.locator(".main")).not.toContainText("房東");
  await expect(page.locator(".main")).not.toContainText("房客");

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("import-template-zh").click();
  const download = await downloadPromise;
  const templatePath = `/tmp/condola-import-template-${Date.now()}.csv`;
  await download.saveAs(templatePath);
  const template = readFileSync(templatePath, "utf8");
  expect(template).toContain("屋主姓名");
  expect(template).toContain("租客");
  expect(template).not.toContain("房東");
  expect(template).not.toContain("房客");
  expect(template).not.toContain("身分證");

  await expect(page.locator(".import-steps .st")).toHaveCount(3);
  await expect(page.locator(".import-steps")).toContainText("下載範本");
  await expect(page.locator(".import-steps")).toContainText("上傳檔案");
  await expect(page.locator(".import-steps")).toContainText("確認匯入");

  await page.getByTestId("import-to-upload").click();
  const blankRent = [
    "物件名稱,地址,屋主姓名,出租型態,戶別／樓層,月租,租客姓名,租客電話,起租日,到期日,押金,繳租日",
    "中山北路公寓,台北市中山區中山北路1號,王屋主,整層,3F,9500,陳美玲,0912000111,2026-11-01,2027-10-31,19000,5",
    "民生東路套房,台北市松山區民生東路2號,王屋主,整層,2F,,黃怡君,0912000222,2026-11-01,2027-10-31,,5",
  ].join("\n");
  await page.getByTestId("import-file").setInputFiles({
    name: "租金空白.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(blankRent, "utf8"),
  });
  await expect(page.getByTestId("import-preview-table")).toContainText("狀態");
  await expect(page.getByTestId("import-preview-table")).toContainText("單位／房間");
  await expect(page.getByTestId("import-preview")).toContainText("預覽前 5 列");
  await expect(page.getByTestId("import-bad-cell")).toHaveText("（空白）");
  await expect(page.getByTestId("import-bad-cell")).toHaveAttribute("title", "此儲存格必填");
  await expect(page.getByTestId("import-preview")).toContainText("⚠ 租金空白");
  await expect(page.getByTestId("import-ok-count")).toHaveText("1");
  await expect(page.getByTestId("import-err-count")).toHaveText("1");
  await expect(page.getByTestId("import-ignored-id")).toHaveCount(0);
  await expect(page.getByTestId("import-run")).toHaveText("匯入 1 筆");
  await expect(page.getByTestId("import-errors-csv")).toBeEnabled();
  const problemDownload = page.waitForEvent("download");
  await page.getByTestId("import-errors-csv").click();
  const problems = await problemDownload;
  const problemPath = `/tmp/condola-import-problems-${Date.now()}.csv`;
  await problems.saveAs(problemPath);
  const problemCsv = readFileSync(problemPath, "utf8");
  expect(problemCsv).toContain("黃怡君");
  expect(problemCsv).toContain("問題");
  expect(problemCsv).not.toContain("陳美玲");

  await page.getByTestId("import-restart").click();
  await page.getByTestId("import-file").setInputFiles({
    name: "owners.big5.csv",
    mimeType: "text/csv",
    buffer: BIG5_CSV,
  });
  await expect(page.getByTestId("import-preview")).toBeVisible();
  await expect(page.getByTestId("import-encoding-value")).toContainText("big5");
  await expect(page.getByTestId("import-ignored-id")).toContainText("不會匯入");
  await expect(page.getByTestId("import-ignored-id")).toContainText("身分證");
  await expect(page.getByTestId("import-preview")).toContainText("押金約 3 個月");
  await expect(page.getByTestId("import-preview")).toContainText("租約已到期");
  await expect(page.getByTestId("import-preview")).toContainText("✓ 可匯入");
  await page.getByTestId("import-run").click();
  await expect(page.getByTestId("import-result")).toBeVisible();
  await expect(page.getByRole("heading", { name: "匯入完成" })).toBeVisible();
  await expect(page.getByTestId("import-count-leases")).toHaveText("1");

  const errorDownload = page.waitForEvent("download");
  await page.getByTestId("import-errors-csv").click();
  const errors = await errorDownload;
  const errorPath = `/tmp/condola-import-errors-${Date.now()}.csv`;
  await errors.saveAs(errorPath);
  expect(readFileSync(errorPath, "utf8")).toContain("押金");

  await page.getByTestId("import-go-props").click();
  await expect(page.getByRole("link", { name: "匯入公寓" })).toBeVisible();
  await page.getByRole("link", { name: "匯入公寓" }).click();
  await page.getByRole("link", { name: "有效租客" }).click();
  await expect(page.getByTestId("lease-imported")).toContainText("沒有電子簽署");
  await page.getByRole("link", { name: "簽署與文件" }).click();
  await expect(page.getByTestId("lease-imported-sign")).toBeVisible();
  await expect(page.getByTestId("simulate-tenant-sign")).toHaveCount(0);
  await expect(page.getByTestId("submit-sign")).toHaveCount(0);
  await expect(page.getByTestId("paper-sign")).toBeVisible();

  await page.goto("/m/import");
  await page.getByTestId("import-to-upload").click();
  await page.getByTestId("import-file").setInputFiles({
    name: "owners.big5.csv",
    mimeType: "text/csv",
    buffer: BIG5_CSV,
  });
  await expect(page.getByTestId("import-preview")).toContainText("已經存在");
  await expect(page.getByTestId("import-ok-count")).toHaveText("0");
  await expect(page.getByTestId("import-nothing")).toHaveText("沒有可匯入的資料");
  await expect(page.getByTestId("import-run")).toHaveText("匯入");
  await expect(page.getByTestId("import-run")).toBeDisabled();

  await signIn(page, ACCOUNTS.accountant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/properties");
  await expect(page.getByTestId("import-link")).toHaveCount(0);
  await page.goto("/m/import");
  await expect(page.getByTestId("forbidden")).toBeVisible();
});

test("a 500-row workbook imports in batches", async ({ page }) => {
  test.setTimeout(180_000);
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/import");
  await page.getByTestId("import-to-upload").click();
  const rows = [HEADERS];
  for (let i = 1; i <= 500; i += 1) {
    const label = `U${String(i).padStart(4, "0")}`;
    const phone = `09${String(10000000 + i).slice(-8)}`;
    rows.push([
      "匯入五百",
      "台北市大安區五百路1號",
      "五百屋主",
      "bulk500@example.com",
      "整層",
      label,
      "",
      "",
      "10",
      "8000",
      `租客${label}`,
      phone,
      `t${label}@example.com`,
      "",
      "2026-11-01",
      "2027-10-31",
      "16000",
      "5",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
  }
  const bytes = await buildXlsx(rows);
  await page.getByTestId("import-file").setInputFiles({
    name: "five-hundred.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByTestId("import-encoding-value")).toContainText("xlsx");
  await expect(page.getByTestId("import-row-count")).toContainText("500");
  await expect(page.getByTestId("import-ok-count")).toContainText("500");
  await expect(page.getByTestId("import-err-count")).toContainText("0");
  await expect(page.getByTestId("import-run")).toContainText("500");
  await page.getByTestId("import-run").click();
  await expect(page.getByTestId("import-result")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId("import-count-properties")).toHaveText("1");
  await expect(page.getByTestId("import-count-units")).toHaveText("500");
  await expect(page.getByTestId("import-count-leases")).toHaveText("500");
  await expect(page.getByTestId("import-count-tenants")).toHaveText("500");
  await resetDemo(page);
});
