import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { resetDemo, signIn, ACCOUNTS } from "./session";

const ORG_ID = "10000000-0000-4000-8000-000000000001";

function db() {
  return new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
}

async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = db();
  await client.connect();
  try {
    const result = await client.query<T>(text, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function setTrial(daysAgo: number) {
  await sql(
    `UPDATE organizations
        SET settings = jsonb_set(
              coalesce(settings, '{}'::jsonb),
              '{plan}',
              coalesce(settings->'plan', '{}'::jsonb) || jsonb_build_object(
                'tier', 'free',
                'trialUntil', (now() - ($2::text || ' days')::interval)::text
              ),
              true
            ),
            kept_unit_ids = CASE WHEN $3::boolean THEN NULL ELSE kept_unit_ids END,
            billed_unit_count = 0,
            pending_unit_count = NULL,
            billing_period_end = current_date + 30,
            billing_cycle = 'month'
      WHERE id = $1`,
    [ORG_ID, String(daysAgo), daysAgo >= 40],
  );
}

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
});

test.afterEach(async ({ page }) => {
  await resetDemo(page);
});

test("grace, the default four, a new pick, and payments on a read-only unit", async ({ page }) => {
  await setTrial(40);
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/units");

  await expect(page.getByTestId("plan-s16")).toContainText("寬限期已結束");
  await expect(page.getByTestId("plan-s16")).toContainText("仍可登記和撤銷付款");
  await expect(page.getByTestId("open-unit-keep")).toHaveText("選擇保留的 4 戶");
  const editable = page.locator("[data-space-id][data-editable='true']");
  const readOnly = page.locator("[data-space-id][data-editable='false']");
  await expect(editable).toHaveCount(4);
  await expect(readOnly).not.toHaveCount(0);

  const next = page.getByTestId("plan-next-period");
  await expect(next).toBeVisible();
  await expect(next).toContainText("下期生效");
  const billed = await next.getAttribute("data-billed");
  const pending = await next.getAttribute("data-pending");
  expect(billed).not.toEqual(pending);

  const lockedRow = readOnly.first();
  await expect(lockedRow.getByTestId("edit-locked")).toBeDisabled();
  await expect(lockedRow.getByTestId("readonly-edit-note")).toHaveAttribute("data-i18n-key", "i_readonly_edit_pending");
  await expect(lockedRow.getByTestId("readonly-edit-note")).toHaveText("");
  const lockedId = await lockedRow.getAttribute("data-space-id");
  const kind = await lockedRow.getAttribute("data-kind");
  expect(lockedId).toBeTruthy();
  await page.goto(kind === "room" ? `/m/units/room/${lockedId}` : `/m/units/whole/${lockedId}`);
  await expect(page.getByTestId("save-space")).toBeDisabled();
  await expect(page.getByTestId("save-space")).toHaveAttribute("data-i18n-key", "i_readonly_edit_pending");
  await expect(page.getByTestId("readonly-edit-note")).toHaveText("");

  await page.goto("/m/units");
  await page.getByTestId("open-unit-keep").click();
  const dialog = page.getByTestId("plan-s17");
  await expect(dialog).toContainText("最早建立的 4 戶");
  await expect(dialog).toContainText("已選 4 / 4");
  const boxes = dialog.locator("input[type=checkbox]");
  const boxCount = await boxes.count();
  let droppedId = "";
  let addedId = "";
  for (let index = 0; index < boxCount; index += 1) {
    if (await boxes.nth(index).isChecked()) {
      droppedId = await boxes.nth(index).inputValue();
      await boxes.nth(index).uncheck();
      break;
    }
  }
  for (let index = 0; index < boxCount; index += 1) {
    const box = boxes.nth(index);
    const id = await box.inputValue();
    if (id !== droppedId && !(await box.isChecked())) {
      addedId = id;
      await box.check();
      break;
    }
  }
  expect(droppedId).not.toEqual("");
  expect(addedId).not.toEqual("");
  expect(addedId).not.toEqual(droppedId);
  await expect(page.getByTestId("save-kept")).toBeEnabled();
  await page.getByTestId("save-kept").click();
  await expect(page.getByTestId("kept-saved")).toBeVisible();
  await expect(page.locator(`[data-space-id="${addedId}"]`)).toHaveAttribute("data-editable", "true");
  await expect(page.locator(`[data-space-id="${droppedId}"]`)).toHaveAttribute("data-editable", "false");

  await openReadOnlyLease(page);
  await page.goto("/m/units");
  await sql(
    `UPDATE organizations
        SET settings = jsonb_set(
              settings,
              '{plan}',
              coalesce(settings->'plan', '{}'::jsonb) || jsonb_build_object('trialUntil', (now() - interval '10 days')::text),
              true
            )
      WHERE id = $1`,
    [ORG_ID],
  );
  await page.goto("/m/units");
  await expect(page.getByTestId("plan-grace")).toBeVisible();
  await expect(page.getByTestId("plan-s15")).toContainText("寬限期剩");
  await expect(page.getByTestId("plan-s12")).toContainText("30 天寬限期");
  const left = Number(await page.getByTestId("plan-grace").getAttribute("data-grace-left"));
  expect(left).toBeGreaterThan(0);
  expect(left).toBeLessThanOrEqual(30);
  await expect(page.locator("[data-space-id][data-editable='false']")).toHaveCount(0);
});

async function openReadOnlyLease(page: Page) {
  const leases = await sql<{ id: string; space_id: string }>(
    `SELECT l.id::text, coalesce(l.target_room_id, l.target_unit_id)::text AS space_id
       FROM leases l
       JOIN invoices i ON i.lease_id = l.id AND i.status IN ('open', 'partially_paid') AND i.balance_minor > 0
       JOIN invoice_lines il ON il.invoice_id = i.id AND il.charge_type = 'rent' AND il.amount_minor > 0
      WHERE l.org_id = $1
        AND l.currency = 'TWD'
        AND coalesce(l.target_room_id, l.target_unit_id) IN (SELECT id FROM app.portfolio_spaces($1::uuid))
      LIMIT 1`,
    [ORG_ID],
  );
  expect(leases.length).toBeGreaterThan(0);
  const lease = leases[0];
  if (!lease) return;
  const spaces = await sql<{ id: string }>(
    `SELECT id::text FROM app.portfolio_spaces($1::uuid) ORDER BY created_at, id`,
    [ORG_ID],
  );
  const keep = spaces.map((space) => space.id).filter((id) => id !== lease.space_id).slice(0, 4);
  await sql(`UPDATE organizations SET kept_unit_ids = $2::uuid[] WHERE id = $1`, [ORG_ID, keep]);
  await page.goto(`/m/leases/${lease.id}`);
  await expect(page.getByTestId("edit-locked")).toBeDisabled();
  await expect(page.getByTestId("edit-locked")).toHaveAttribute("data-i18n-key", "i_readonly_edit_pending");
  await expect(page.getByTestId("readonly-edit-note").first()).toHaveText("");
  await page.goto(`/m/leases/${lease.id}?tab=sign`);
  for (const testId of ["simulate-tenant-sign", "upload-signed-pdf", "submit-sign"]) {
    const button = page.getByTestId(testId);
    if ((await button.count()) > 0) await expect(button).toBeDisabled();
  }
  await page.goto(`/m/leases/${lease.id}?tab=ledger`);
  const pay = page.getByTestId("record-payment");
  if ((await pay.count()) === 0) return;
  await expect(pay).toBeEnabled();
  await pay.click();
  await page.getByTestId("pay-last5").fill("90817");
  await page.getByTestId("submit-payment").click();
  await expect(page.getByTestId("record-payment")).toBeEnabled();
  await page.goto("/m/payments");
  const row = page.locator("tr").filter({ hasText: "90817" }).first();
  await row.getByTestId("reverse-reason").fill("read-only unit");
  await row.getByRole("button", { name: "沖銷" }).click();
  await expect(page.locator("tr").filter({ hasText: "90817" }).getByTestId("reverse-form")).toHaveCount(0);
}
