import { Client } from "pg";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { buildXlsx } from "../src/lib/spreadsheet";

/**
 * End-to-end regression for the shipped flows.
 * Every person, firm, and phone is generated for this run (example.com only).
 * No customer rows, national IDs, or API keys are used. The database is the
 * local CI/dev Postgres, not a hosted project.
 */

const DATABASE_URL = process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";

type QaRun = {
  stamp: string;
  password: string;
  adminEmail: string;
  managerEmail: string;
  managerName: string;
  firm: string;
  property: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  tenantName: string;
  tenantEmail: string;
  tenantPhone: string;
  firmPhone: string;
  csvTenant: string;
  csvMarker: string;
  csvPhone: string;
  xlsxTenant: string;
  xlsxMarker: string;
  xlsxPhone: string;
};

function qaRun(): QaRun {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const phone = (offset: number) => `09${String((Date.now() + offset) % 100_000_000).padStart(8, "0")}`;
  return {
    stamp,
    password: `Qa${stamp}a9`,
    adminEmail: `qa.admin.${stamp}@example.com`,
    managerEmail: `qa.manager.${stamp}@example.com`,
    managerName: `QA經理${stamp}`,
    firm: `QA Firm ${stamp}`,
    property: `QA宅${stamp}`,
    ownerName: `QA屋主${stamp}`,
    ownerEmail: `qa.owner.${stamp}@example.com`,
    ownerPhone: phone(11),
    tenantName: `QA租客${stamp}`,
    tenantEmail: `qa.tenant.${stamp}@example.com`,
    tenantPhone: phone(22),
    firmPhone: phone(33),
    csvTenant: `QA匯入租客${stamp}`,
    csvMarker: `QAIDCSV${stamp}`,
    csvPhone: phone(44),
    xlsxTenant: `QA表格租客${stamp}`,
    xlsxMarker: `QAIDXLS${stamp}`,
    xlsxPhone: phone(55),
  };
}

function taipeiMonthStart() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  return `${today.slice(0, 7)}-01`;
}

async function withDb<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function liveOrgId(name: string) {
  return withDb(async (client) => {
    const found = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM organizations WHERE environment = 'live' AND name = $1`,
      [name],
    );
    expect(found.rows, `QA firm ${name} was not saved`).toHaveLength(1);
    return found.rows[0].id;
  });
}

/** Free firms have one seat. Give this generated firm the standard allowance so the invite can be sent. */
async function allowQaSeats(orgId: string, firm: string) {
  await withDb(async (client) => {
    const updated = await client.query(
      `UPDATE organizations
          SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{plan,tier}', '"standard"', true)
        WHERE id = $1 AND name = $2 AND environment = 'live'`,
      [orgId, firm],
    );
    expect(updated.rowCount).toBe(1);
  });
}

async function chooseRoom(page: Page, propertyName: string, label: string) {
  const options = page.getByTestId("lease-room").locator("option");
  const count = await options.count();
  for (let index = 0; index < count; index += 1) {
    const text = (await options.nth(index).innerText()).replace(/\s+/g, " ").trim();
    if (text.includes(propertyName) && text.endsWith(` ${label}`)) {
      const value = await options.nth(index).getAttribute("value");
      expect(value).toBeTruthy();
      await page.getByTestId("lease-room").selectOption(value ?? "");
      return;
    }
  }
  throw new Error(`no room ${label} on ${propertyName}`);
}

function importSheet(qa: QaRun, kind: "csv" | "xlsx") {
  const tenant = kind === "csv" ? qa.csvTenant : qa.xlsxTenant;
  const marker = kind === "csv" ? qa.csvMarker : qa.xlsxMarker;
  const phone = kind === "csv" ? qa.csvPhone : qa.xlsxPhone;
  const property = kind === "csv" ? `QA匯入宅${qa.stamp}` : `QA表格宅${qa.stamp}`;
  // Each file needs its own address and unit. A second file on the same whole unit is rejected as occupied.
  const address = kind === "csv" ? `台北市松山區匯入路${qa.stamp}號` : `台北市大安區表格路${qa.stamp}號`;
  const unit = kind === "csv" ? "2F" : "4F";
  return [
    ["物件名稱", "租客身分證字號", "地址", "屋主姓名", "出租型態", "戶別／樓層", "月租", "租客姓名", "租客電話", "起租日", "到期日", "押金", "繳租日"],
    [property, marker, address, `QA匯入屋主${qa.stamp}`, "整層", unit, "10000", tenant, phone, "2026-11-01", "2027-10-31", "20000", "5"],
  ];
}

async function uploadImport(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, marker: string) {
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/import");
  await page.getByTestId("import-to-upload").click();
  await page.getByTestId("import-file").setInputFiles(file);
  await expect(page.getByTestId("import-ignored-id")).toContainText("租客身分證字號");
  await expect(page.getByTestId("import-ignored-id")).toContainText("不會匯入");
  await expect(page.getByTestId("import-preview")).not.toContainText(marker);
  const okCount = page.getByTestId("import-ok-count");
  try {
    await expect(okCount).toHaveText("1");
  } catch (error) {
    const preview = await page.getByTestId("import-preview").innerText().catch(() => "");
    throw new Error(`${file.name} preview was not importable:\n${preview}\n${error instanceof Error ? error.message : String(error)}`);
  }
  await page.getByTestId("import-run").click();
  await expect(page.getByTestId("import-result")).toBeVisible();
  await expect(page.getByTestId("import-result")).not.toContainText(marker);
  await expect(page.getByTestId("import-count-leases")).toHaveText("1");
}

test("QA regression covers signup, invite resend, lease, bills, electricity, import, owner PDF, and signed-out denial", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const qa = qaRun();
  let leaseId = "";
  let statementId = "";
  let tenantContext: BrowserContext | undefined;

  await test.step("sign up a generated QA firm", async () => {
    await page.goto("/signup");
    await page.getByTestId("signup-email").fill(qa.adminEmail);
    await page.getByTestId("signup-password").fill(qa.password);
    await page.getByTestId("signup-confirm").fill(qa.password);
    await page.getByTestId("signup-submit").click();
    await page.waitForURL(/\/signup\/verify/);
    await expect(page.getByTestId("verify-body")).toContainText(qa.adminEmail);
    const devLink = page.getByTestId("verify-dev-link");
    await expect(devLink).toBeVisible();
    await devLink.click();
    await expect(page.getByTestId("signup-confirm-submit")).toBeVisible();
    await page.getByTestId("signup-confirm-submit").click();
    await page.waitForURL(/\/signup\/firm/);
    await page.getByTestId("kind-firm").check();
    await page.getByTestId("kind-next").click();
    await page.getByTestId("firm-name").fill(qa.firm);
    await page.getByTestId("firm-contact").fill(qa.managerName);
    await page.getByTestId("firm-phone").fill(qa.firmPhone);
    await expect(page.getByTestId("firm-submit")).toBeEnabled();
    await page.getByTestId("firm-submit").click();
    await page.waitForURL((url) => url.pathname === "/m");
    await expect(page.getByTestId("build-sha")).toBeVisible();
    await expect(page.locator("body")).toContainText(qa.firm);
  });

  await test.step("invite a QA teammate and resend so the first link dies", async () => {
    const orgId = await liveOrgId(qa.firm);
    await allowQaSeats(orgId, qa.firm);
    await page.goto("/api/demo/locale?set=zh-TW&next=/m/team");
    await expect(page.getByTestId("invite-email")).toBeVisible();
    await expect(page.getByTestId("seat-limit")).toHaveCount(0);
    await page.getByTestId("invite-email").fill(qa.managerEmail);
    await page.getByTestId("invite-name").fill(qa.managerName);
    await page.getByTestId("invite-role").selectOption("manager");
    await page.getByRole("button", { name: "送出邀請" }).click();
    await page.waitForURL(/token=/);
    const firstToken = new URL(page.url()).searchParams.get("token");
    expect(firstToken).toBeTruthy();
    await expect(page.getByTestId("invite-link")).toContainText(`/accept/${firstToken}`);

    const row = page.getByTestId("team-table").locator("tr", { hasText: qa.managerEmail });
    await row.getByRole("button", { name: "重寄邀請" }).click();
    await page.waitForURL((url) => url.searchParams.get("token") !== firstToken && url.searchParams.has("token"));
    const resentToken = new URL(page.url()).searchParams.get("token");
    expect(resentToken).toBeTruthy();
    expect(resentToken).not.toBe(firstToken);

    const stale = await browser.newContext();
    const stalePage = await stale.newPage();
    await stalePage.goto(`/accept/${firstToken}`);
    await expect(stalePage.getByTestId("invite-state")).toContainText("失效");
    await expect(stalePage.getByTestId("accept-submit")).toHaveCount(0);
    await stale.close();

    const invited = await browser.newContext();
    const invitedPage = await invited.newPage();
    await invitedPage.goto(`/accept/${resentToken}`);
    await expect(invitedPage.getByRole("heading", { name: "接受邀請" })).toBeVisible();
    await invitedPage.getByTestId("accept-name").fill(qa.managerName);
    await invitedPage.getByTestId("new-password").fill(qa.password);
    await invitedPage.getByTestId("password-confirm").fill(qa.password);
    await invitedPage.getByTestId("accept-submit").click();
    await invitedPage.waitForURL((url) => !url.pathname.startsWith("/accept"));
    await expect(invitedPage).not.toHaveURL(/\/login/);
    await invited.close();

    await page.reload();
    await expect(page.getByTestId("team-table").locator("tr", { hasText: qa.managerEmail })).toContainText("使用中");
    await expect(page.getByTestId("team-table").locator("tr", { hasText: qa.managerEmail }).getByRole("button", { name: "重寄邀請" })).toHaveCount(0);
  });

  await test.step("create a lease and show the move-in bill after both signatures", async () => {
    await page.goto("/api/demo/locale?set=zh-TW&next=/m/properties/new");
    await page.getByTestId("property-name").fill(qa.property);
    await page.getByTestId("property-city").fill("台北市");
    await page.getByTestId("property-district").fill("松山區");
    await page.getByTestId("property-street").fill("測試路");
    await page.getByText("新屋主", { exact: true }).click();
    await page.getByTestId("owner-name").fill(qa.ownerName);
    await page.getByTestId("owner-phone").fill(qa.ownerPhone);
    await page.locator("input[name=ownerEmail]").fill(qa.ownerEmail);
    await page.getByTestId("wizard-next").click();
    await page.getByText("分房出租", { exact: true }).click();
    await page.getByTestId("wizard-next").click();
    await page.locator("input[name=floor]").fill("3F");
    await page.getByTestId("room-0-label").fill("A");
    await page.getByTestId("room-0-type").selectOption("suite");
    await page.getByTestId("room-0-rent").fill("10000");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("property-split").selectOption("sub");
    await page.getByTestId("property-rate").fill("4");
    await expect(page.getByTestId("submit-property")).toBeEnabled();
    await page.getByTestId("submit-property").click();
    await page.waitForURL(/\/m\/properties\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { name: qa.property })).toBeVisible();

    await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");
    await chooseRoom(page, qa.property, "A");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("tenant-name").fill(qa.tenantName);
    await page.getByTestId("tenant-phone").fill(qa.tenantPhone);
    await page.getByTestId("tenant-email").fill(qa.tenantEmail);
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("start-date").fill(taipeiMonthStart());
    await page.getByTestId("term-months").fill("12");
    await page.getByTestId("rent").fill("10000");
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("deposit-months")).toHaveValue("2");
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("due-day")).toHaveValue("5");
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("lease-confirm-rent")).toHaveText("NT$10,000");
    await expect(page.getByTestId("submit-lease")).toBeEnabled();
    await page.getByTestId("submit-lease").click();
    await page.waitForURL(/\/m\/leases\/[0-9a-f-]{36}/);
    leaseId = page.url().match(/leases\/([0-9a-f-]{36})/)?.[1] ?? "";
    expect(leaseId).toBeTruthy();

    await page.getByTestId("portal-invite-copy").click();
    const copied = page.getByTestId("portal-invite-copied");
    const manual = page.getByTestId("portal-invite-link");
    await expect(copied.or(manual)).toBeVisible();
    const tenantUrl = (await copied.count()) ? await copied.getAttribute("data-url") : await manual.inputValue();
    expect(tenantUrl).toMatch(/\/accept\//);
    tenantContext = await browser.newContext();
    const tenantPage = await tenantContext.newPage();
    await tenantPage.goto(tenantUrl || "/");
    await expect(tenantPage.getByTestId("portal-email")).toHaveValue(qa.tenantEmail);
    await tenantPage.getByTestId("new-password").fill(qa.password);
    await tenantPage.getByTestId("portal-submit").click();
    await tenantPage.waitForURL(/\/t\/?$/);

    await page.goto(`/m/leases/${leaseId}?tab=sign`);
    await page.getByTestId("simulate-tenant-sign").click();
    await expect(page.getByTestId("submit-sign")).toBeVisible();
    await page.getByTestId("sign-name").fill(qa.managerName);
    await page.getByTestId("sign-consent").check();
    await page.getByTestId("submit-sign").click();
    await page.waitForURL(new RegExp(`/m/leases/${leaseId}\\?tab=ledger`));
    await expect(page.getByTestId("invoice-rent")).toHaveAttribute("data-minor", "1000000");
    await expect(page.getByTestId("invoice-deposit")).toHaveAttribute("data-minor", "2000000");
    await expect(page.getByTestId("invoice-utility")).toHaveAttribute("data-minor", "0");
  });

  await test.step("post electricity onto that bill", async () => {
    await page.goto("/m/rent/utilities");
    await page.getByTestId("utility-unit").selectOption({ label: `${qa.property} · 3F` });
    await page.getByTestId("utility-month-form").getByRole("button", { name: "查看這個月" }).click();
    await expect(page.getByTestId("utility-method")).toContainText("依分表度數");
    await page.getByTestId("utility-rate").fill("4");
    await page.getByTestId("kwh-prev-A").fill("0");
    await page.getByTestId("kwh-curr-A").fill("100");
    await page.getByTestId("utility-preview").click();
    await expect(page.getByTestId("utility-review")).toBeVisible();
    await expect(page.getByTestId("error-banner")).toHaveCount(0);
    await expect(page.getByTestId("utility-share-desc").first()).toContainText("電費 100 度 × 4 元");
    await page.getByTestId("utility-confirm").click();
    await expect(page.getByTestId("utility-saved")).toContainText("電費已記入租客本期帳單");

    await page.goto(`/m/leases/${leaseId}?tab=ledger`);
    await expect(page.getByTestId("invoice-utility-line")).toContainText("電費 100 度 × 4 元");
    await expect(page.getByTestId("invoice-utility")).toHaveAttribute("data-minor", "40000");

    const tenantPage = await tenantContext!.newPage();
    await tenantPage.goto("/api/demo/locale?set=zh-TW&next=/t/pay");
    await expect(tenantPage.getByTestId("tenant-rent-line")).toBeVisible();
    await expect(tenantPage.getByTestId("tenant-utility-line")).toContainText("電費 100 度 × 4 元");
    await expect(tenantPage.getByTestId("tenant-bill")).toBeVisible();
    await expect(tenantPage.locator("body")).not.toContainText(qa.csvMarker);
    await tenantContext!.close();
  });

  await test.step("import a CSV and an Excel file without storing the tenant ID column", async () => {
    const csv = importSheet(qa, "csv");
    await uploadImport(
      page,
      { name: "qa-import.csv", mimeType: "text/csv", buffer: Buffer.from(csv.map((row) => row.join(",")).join("\n"), "utf8") },
      qa.csvMarker,
    );
    const xlsx = await buildXlsx(importSheet(qa, "xlsx"));
    await uploadImport(
      page,
      {
        name: "qa-import.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(xlsx),
      },
      qa.xlsxMarker,
    );

    for (const [tenant, marker] of [
      [qa.csvTenant, qa.csvMarker],
      [qa.xlsxTenant, qa.xlsxMarker],
    ] as const) {
      await page.goto(`/m/leases?q=${encodeURIComponent(tenant)}`);
      await page.getByRole("link", { name: tenant }).click();
      await expect(page.locator("body")).not.toContainText(marker);
    }

    const orgId = await liveOrgId(qa.firm);
    const stored = await withDb(async (client) => {
      const contacts = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM contacts
          WHERE org_id = $1
            AND (
              position($2 in coalesce(notes, '')) > 0
              OR position($2 in coalesce(id_number_hash, '')) > 0
              OR position($2 in coalesce(display_name, '')) > 0
              OR position($3 in coalesce(notes, '')) > 0
              OR position($3 in coalesce(id_number_hash, '')) > 0
              OR position($3 in coalesce(display_name, '')) > 0
            )`,
        [orgId, qa.csvMarker, qa.xlsxMarker],
      );
      const documents = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM identity_documents WHERE org_id = $1`,
        [orgId],
      );
      return { contacts: contacts.rows[0].n, documents: documents.rows[0].n };
    });
    expect(stored.contacts).toBe(0);
    expect(stored.documents).toBe(0);
  });

  await test.step("download the owner statement PDF", async () => {
    await page.goto("/api/demo/locale?set=zh-TW&next=/m/statements");
    await page.getByTestId("statement-owner").selectOption({ label: qa.ownerName });
    await page.getByTestId("submit-statement").click();
    await page.waitForURL(/\/m\/statements\/[0-9a-f-]{36}/);
    statementId = page.url().match(/statements\/([0-9a-f-]{36})/)?.[1] ?? "";
    expect(statementId).toBeTruthy();
    await expect(page.getByRole("heading", { name: qa.ownerName })).toBeVisible();

    const meta = await page.request.get(`/api/pdf/statements/${statementId}`);
    expect(meta.ok()).toBeTruthy();
    const doc = (await meta.json()) as { filename?: string };
    expect(doc.filename).toBe("owner-statement.pdf");

    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("download-statement-pdf").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("owner-statement.pdf");
  });

  await test.step("deny manager, tenant, owner, import, and PDF routes when signed out", async () => {
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    const pages = [
      "/m",
      "/m/team",
      "/m/leases",
      `/m/leases/${leaseId}`,
      "/m/import",
      "/m/statements",
      `/m/statements/${statementId}`,
      "/t",
      "/t/pay",
      "/o",
      "/o/statements",
    ];
    for (const path of pages) {
      await guestPage.goto(path);
      await expect(guestPage).toHaveURL(/\/login/);
    }

    for (const path of [`/api/pdf/leases/${leaseId}`, `/api/pdf/statements/${statementId}`]) {
      const response = await guestPage.request.get(path, { maxRedirects: 0 });
      const status = response.status();
      const location = response.headers().location ?? "";
      const body = await response.text();
      const redirected = status >= 300 && status < 400 && location.includes("/login");
      const rejected = status === 401 || status === 403 || status === 404;
      expect(redirected || rejected, `${path} returned ${status} ${location}`).toBeTruthy();
      expect(body).not.toContain("owner-statement.pdf");
      expect(body).not.toContain("footerHash");
      expect(body.startsWith("%PDF-")).toBe(false);
    }

    const imported = await guestPage.request.post("/api/import", {
      data: { mode: "preview", fileName: "qa.csv", rows: [] },
      maxRedirects: 0,
    });
    expect(imported.status()).toBe(401);
    await guest.close();
  });
});
