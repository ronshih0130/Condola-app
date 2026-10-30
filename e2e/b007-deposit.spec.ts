import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { resetDemo } from "./session";
import { disposableDbUrl } from "../src/server/test-disposable-db";

// Validate before test registration and any HTTP/reset operation. The runner
// may use any explicitly disposable local port; CI is not tied to this Mac.
const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true") throw new Error("B007 requires disposable demo mode");
function guardedUrl() { return databaseUrl; }

const scenarios = [
  { name: "off-us", enabled: false, jurisdiction: "US", currency: "USD", state: "reason" },
  { name: "on-tw", enabled: true, jurisdiction: "TW", currency: "TWD", state: "reason" },
  { name: "on-ca", enabled: true, jurisdiction: "US-CA", currency: "USD", state: "warn" },
  { name: "on-us-missing", enabled: true, jurisdiction: "US", currency: "USD", state: "missing" },
] as const;

async function configure(scenario: typeof scenarios[number]) {
  const client = new Client({ connectionString: guardedUrl() });
  await client.connect();
  try {
    await client.query(`UPDATE platform_settings SET value=CASE WHEN $1::boolean THEN jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($2::text)) ELSE '{"enabled":false,"allowed_org_ids":[]}'::jsonb END WHERE key='deposit_rule_hints'`, [scenario.enabled, ORG_ID]);
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('deposit_rule_hints',$2::boolean) WHERE id=$1`, [ORG_ID, scenario.enabled]);
    const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,jurisdiction_id,currency,timezone,default_rental_mode)
      SELECT $1,$2,CASE WHEN $3='TW' THEN 'TW' ELSE 'US' END,id,$4,'Asia/Taipei','whole_unit' FROM jurisdictions WHERE code=$3 RETURNING id::text`, [ORG_ID, `B007 ${scenario.name}`, scenario.jurisdiction, scenario.currency])).rows[0].id;
    const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor)
      VALUES ($1,$2,'B007','whole_unit',1000000) RETURNING id::text`, [ORG_ID, property])).rows[0].id;
    return { property, unit };
  } finally { await client.end(); }
}

async function expectStackedAlert(page: Page) {
  const alert = page.getByTestId("deposit-alert");
  // Navigation/scroll can move the whole form between separate browser calls.
  // Compare one synchronous layout snapshot rather than mixing coordinates.
  const { description, label, textarea, container } = await alert.evaluate((node) => {
    const box = (element: Element | null) => element?.getBoundingClientRect().toJSON() ?? null;
    return {
      description: box(node.querySelector(":scope > div")),
      label: box(node.querySelector("label")),
      textarea: box(node.querySelector("textarea")),
      container: box(node),
    };
  });
  expect(description && label && textarea && container).toBeTruthy();
  for (const rectangle of [description, label, textarea, container]) {
    expect(rectangle!.width).toBeGreaterThan(0);
    expect(rectangle!.height).toBeGreaterThan(0);
  }
  expect(description!.y + description!.height).toBeLessThanOrEqual(label!.y + 1);
  expect(label!.y + label!.height).toBeLessThanOrEqual(textarea!.y + 1);
  expect(textarea!.width).toBeGreaterThan(container!.width * 0.8);
  expect(await alert.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function wizard(page: Page, unit: string) {
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");
  await page.getByTestId("lease-room").selectOption(unit);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("B007 synthetic tenant");
  await page.getByTestId("tenant-phone").fill("0912000333");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("start-date").fill("2035-01-01");
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("10000");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("deposit-months").fill("3");
}

for (const width of [390, 1280]) for (const scenario of scenarios) {
  test(`B007 ${scenario.name} at ${width}px`, async ({ page }, testInfo) => {
    guardedUrl(); // Must precede any HTTP or demo reset.
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("response", (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
    await resetDemo(page);
    const { property, unit } = await configure(scenario);
    try {
      await wizard(page, unit);
      if (scenario.state === "reason") {
        await expect(page.getByTestId("deposit-alert")).toContainText("請填寫原因");
        await expect(page.getByTestId("wizard-next")).toBeDisabled();
        await page.getByTestId("deposit-reason").fill("B007 initial reason");
        await expectStackedAlert(page);
      } else {
        await expect(page.getByTestId("deposit-alert")).toHaveCount(0);
        if (scenario.state === "warn") await expect(page.getByText(/超過設定的 1 個月門檻/)).toBeVisible();
        else await expect(page.getByText("這個地區尚未設定押金上限。")).toBeVisible();
      }
      await expect(page.getByTestId("wizard-next")).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`wizard-${scenario.name}-${width}.png`), fullPage: true });
      await page.getByTestId("wizard-next").click();
      await page.getByTestId("wizard-next").click();
      await page.getByTestId("wizard-next").click();
      await page.getByTestId("wizard-next").click();
      await expect(page.getByTestId("submit-lease")).toBeEnabled();
      await page.getByTestId("submit-lease").click();
      await page.waitForURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
      const leaseId = new URL(page.url()).pathname.split("/").at(-1)!;
      await page.getByRole("link", { name: "摘要" }).click();
      await page.waitForURL(/\/m\/leases\/[0-9a-f-]{36}\?tab=summary$/);
      await expect(page.getByTestId("lease-terms")).toBeVisible();
      await page.getByTestId("deposit-months").fill("4");
      if (scenario.state === "reason") {
        await expect(page.getByTestId("deposit-alert")).toBeVisible();
        await expect(page.getByTestId("save-lease-terms")).toBeDisabled();
        await page.getByTestId("deposit-reason").fill("B007 edited reason");
        await expectStackedAlert(page);
      } else {
        await expect(page.getByTestId("deposit-alert")).toHaveCount(0);
      }
      await expect(page.getByTestId("save-lease-terms")).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`edit-${scenario.name}-${width}.png`), fullPage: true });
      await page.getByTestId("save-lease-terms").click();
      await expect(page.getByTestId("save-lease-terms")).toBeEnabled();
      const db = new Client({ connectionString: guardedUrl() });
      await db.connect();
      try {
        const rows = await db.query<{ months: string; reason: string | null; actor: string | null; recorded: boolean; currency: string; start_date: string; property_id: string }>(`SELECT deposit_months::text AS months,deposit_override_reason AS reason,deposit_overridden_by::text AS actor,deposit_overridden_at IS NOT NULL AS recorded,currency,start_date::text,property_id::text FROM leases WHERE id=$1 AND org_id=$2`, [leaseId, ORG_ID]);
        expect(rows.rows).toHaveLength(1);
        expect(Number(rows.rows[0].months)).toBe(4);
        expect(rows.rows[0].property_id).toBe(property);
        expect(rows.rows[0].currency).toBe(scenario.currency);
        expect(rows.rows[0].start_date).toBe("2035-01-01");
        expect(rows.rows[0].reason).toBe(scenario.state === "reason" ? "B007 edited reason" : null);
        expect(rows.rows[0].actor).toBe(scenario.state === "reason" ? USERS.admin : null);
        expect(rows.rows[0].recorded).toBe(scenario.state === "reason");
        const rule = await db.query<{ regional_enabled: boolean; enforcement: string | null; max_months: string | null }>(`SELECT regional_enabled,enforcement,max_months::text FROM resolve_deposit_rule($1,$2,$3::date)`, [ORG_ID, property, "2035-01-01"]);
        expect(rule.rows[0].regional_enabled).toBe(scenario.enabled);
        expect(rule.rows[0].enforcement).toBe(scenario.jurisdiction === "TW" ? "override_required" : scenario.jurisdiction === "US-CA" ? "warn" : "info");
        expect(rule.rows[0].max_months).toBe(scenario.jurisdiction === "TW" ? "2" : scenario.jurisdiction === "US-CA" ? "1" : null);
        const evidence = await db.query<{ outcome: string; actor: string | null; reason: string | null; amount: string; rent: string; currency: string; source: string }>(
          `SELECT c.outcome::text,c.overridden_by::text AS actor,c.override_reason AS reason,
                  c.observed->>'deposit_amount_minor' AS amount,c.observed->>'rent_amount_minor' AS rent,
                  c.observed->>'currency' AS currency,j.code AS source
             FROM rule_check_results c JOIN jurisdiction_rules r ON r.id=c.rule_id JOIN jurisdictions j ON j.id=r.jurisdiction_id
            WHERE c.org_id=$1 AND c.entity_table='leases' AND c.entity_id=$2 AND (c.observed->>'deposit_months')::numeric=4`, [ORG_ID, leaseId]);
        expect(evidence.rows).toHaveLength(1);
        expect(evidence.rows[0]).toMatchObject({ outcome: scenario.state === "reason" ? "overridden" : scenario.state === "warn" ? "warn" : "pass", actor: scenario.state === "reason" ? USERS.admin : null, reason: scenario.state === "reason" ? "B007 edited reason" : null, amount: "4000000", rent: "1000000", currency: scenario.currency, source: scenario.jurisdiction });
      } finally { await db.end(); }
      expect(errors).toEqual([]);
    } finally {
      await testInfo.attach("browser-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      const db = new Client({ connectionString: guardedUrl() });
      await db.connect();
      try {
        await db.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='deposit_rule_hints'`);
        await db.query(`UPDATE organizations SET feature_flags=feature_flags - 'deposit_rule_hints' WHERE id=$1`, [ORG_ID]);
      } finally { await db.end(); }
    }
  });
}
