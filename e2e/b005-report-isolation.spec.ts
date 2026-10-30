import { expect, test, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { Client } from "pg";
import { ACCOUNTS, signIn } from "./session";
import { FIRM_NAME, ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";

const origin = "http://127.0.0.1:43136";
const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
const liveMarker = "B005-LIVE-REPORT";
const sandboxMarker = "B005-SANDBOX-REPORT";
if (process.env.DEMO_MODE !== "true" || process.env.B005_PRIVATE_HTTP_CONFIG !== "1" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") {
  throw new Error("B005 private disposable configuration required");
}

function privateGuard(info: TestInfo) {
  if (!info.config.configFile?.endsWith("/e2e/b005-onboarding-private-playwright.config.ts") ||
      info.project.use.trace !== "off" || info.project.use.video !== "off" || info.project.use.screenshot !== "off" ||
      info.config.reporter.length !== 1 || info.config.reporter[0][0] !== "line") {
    throw new Error("B005 private configuration required");
  }
}

async function db<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  try { await client.connect(); return await fn(client); }
  catch { throw new Error("B005 database fixture failed"); }
  finally { try { await client.end(); } catch { /* preserve primary failure */ } }
}

async function local(api: APIRequestContext, path: string, post = false) {
  let target: URL;
  try { target = new URL(path, origin); } catch { throw new Error("B005 local request rejected"); }
  if (!path.startsWith("/") || path.startsWith("//") || target.origin !== origin) throw new Error("B005 local request rejected");
  try {
    const response = post ? await api.post(target.href, { maxRedirects: 0 }) : await api.get(target.href, { maxRedirects: 0 });
    if (new URL(response.url()).origin !== origin) throw new Error("B005 local request rejected");
    return response;
  } catch { throw new Error("B005 local request failed"); }
}

async function fence(context: BrowserContext, page: Page, errors: string[]) {
  context.on("page", other => { if (other !== page) errors.push("unexpected page"); });
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", message => { if (message.type() === "error") errors.push("console error"); });
  page.on("response", response => { if (response.status() >= 500) errors.push("server error"); });
  await context.route("**/*", async route => {
    try { if (new URL(route.request().url()).origin === origin) { await route.continue(); return; } } catch { /* reject malformed */ }
    errors.push("off-origin request"); await route.abort();
  });
}

test("live and owned sandbox reports keep positive income and expense isolated", async ({ page, context }, info) => {
  privateGuard(info);
  const errors: string[] = [];
  let phase = "setup";
  let failure: string | undefined;
  try {
    await fence(context, page, errors);
    await signIn(page, ACCOUNTS.admin);
    expect((await local(page.request, "/api/demo/reset", true)).ok()).toBe(true);
    await signIn(page, ACCOUNTS.admin);
    const controlsOff = await db(async c => (await c.query<{ global_off: boolean; org_off: boolean }>(
      `SELECT NOT coalesce((SELECT value->'enabled'='true'::jsonb FROM platform_settings WHERE key='onboarding_progress'),false) AS global_off,
              feature_flags->'onboarding_progress' IS DISTINCT FROM 'true'::jsonb AS org_off
         FROM organizations WHERE id=$1`, [ORG_ID])).rows);
    expect(controlsOff.length === 1 && controlsOff[0].global_off && controlsOff[0].org_off).toBe(true);

    phase = "live fixture";
    const live = await db(async c => {
      const rows = await c.query<{ property: string; paid: string; incurred: string; income: string; expense: string }>(
        `SELECT p.id::text AS property, pay.paid_on::text AS paid, e.incurred_on::text AS incurred,
                a.amount_minor::text AS income,e.amount_minor::text AS expense
           FROM properties p JOIN leases l ON l.org_id=p.org_id AND l.property_id=p.id
           JOIN payments pay ON pay.org_id=l.org_id AND pay.lease_id=l.id AND pay.status='confirmed' AND pay.currency=p.currency
           JOIN payment_allocations a ON a.org_id=pay.org_id AND a.payment_id=pay.id
           JOIN invoices i ON i.org_id=a.org_id AND i.id=a.invoice_id AND i.lease_id=l.id
           JOIN invoice_lines il ON il.org_id=i.org_id AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor=a.amount_minor
           JOIN expenses e ON e.org_id=p.org_id AND e.property_id=p.id AND e.currency=p.currency
             AND e.status='approved' AND e.bill_to='owner' AND e.ticket_id IS NULL
          WHERE p.org_id=$1 AND p.name='信義松仁' AND a.amount_minor=1000000 AND e.amount_minor=280000`, [ORG_ID]);
      if (rows.rowCount !== 1) throw new Error("fixture mismatch");
      if ((await c.query(`UPDATE properties SET name=$2 WHERE org_id=$1 AND id=$3`, [ORG_ID, liveMarker, rows.rows[0].property])).rowCount !== 1) throw new Error("fixture mismatch");
      return rows.rows[0];
    });

    phase = "sandbox selection";
    await page.goto("/api/env?set=sandbox&next=/m");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    const sandboxId = await db(async c => {
      const r = await c.query<{ id: string }>(`SELECT o.id::text FROM organizations o JOIN org_members m ON m.org_id=o.id
        WHERE o.environment='sandbox' AND o.live_org_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role='admin'
          AND o.feature_flags->'onboarding_progress' IS DISTINCT FROM 'true'::jsonb`, [ORG_ID, USERS.admin]);
      if (r.rowCount !== 1) throw new Error("sandbox mismatch");
      return r.rows[0].id;
    });

    phase = "sandbox fixture";
    await db(async c => {
      await c.query("BEGIN");
      try {
        const p = (await c.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode)
          VALUES($1,$2,'TW','TWD','Asia/Taipei','whole_unit') RETURNING id::text`, [sandboxId, sandboxMarker])).rows[0].id;
        const u = (await c.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'B005','whole_unit') RETURNING id::text`, [sandboxId,p])).rows[0].id;
        const contact = (await c.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,'B005 synthetic') RETURNING id::text`, [sandboxId])).rows[0].id;
        const lease = (await c.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor)
          VALUES($1,$2,$3,$3,'active',current_date-10,'TWD',432100) RETURNING id::text`, [sandboxId,p,u])).rows[0].id;
        await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [sandboxId,lease,contact]);
        const invoice = (await c.query<{ id: string }>(`INSERT INTO invoices(org_id,property_id,lease_id,bill_to_contact_id,invoice_number,currency,issue_date,due_date,period_start,period_end,status,source,created_by)
          VALUES($1,$2,$3,$4,'B005-SB-REPORT','TWD',current_date,current_date,current_date,current_date,'open','recurring',$5) RETURNING id::text`, [sandboxId,p,lease,contact,USERS.admin])).rows[0].id;
        await c.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor)
          VALUES($1,$2,1,'rent','synthetic rent',1,432100,432100)`, [sandboxId,invoice]);
        const invTxn = (await c.query<{ id: string }>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by)
          VALUES($1,$2,$3,'invoice','TWD',current_date,'synthetic','invoices',$4,$5) RETURNING id::text`, [sandboxId,p,lease,invoice,USERS.admin])).rows[0].id;
        await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id)
          VALUES($1,$2,'tenant_receivable',432100,'TWD',$3,$4,$5,$6),($1,$2,'rental_income',-432100,'TWD',$3,$4,$5,$6)`, [sandboxId,invTxn,contact,p,lease,invoice]);
        await c.query(`UPDATE invoices SET ledger_transaction_id=$2 WHERE id=$1`, [invoice,invTxn]);
        const payment = (await c.query<{ id: string }>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by,confirmed_by,confirmed_at)
          VALUES($1,$2,$3,$4,'TWD',432100,current_date,'bank_transfer','confirmed','manager_entry',$5,$5,now()) RETURNING id::text`, [sandboxId,p,lease,contact,USERS.admin])).rows[0].id;
        await c.query(`INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor,created_by) VALUES($1,$2,$3,432100,$4)`, [sandboxId,payment,invoice,USERS.admin]);
        const payTxn = (await c.query<{ id: string }>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by)
          VALUES($1,$2,$3,'payment','TWD',current_date,'synthetic','payments',$4,$5) RETURNING id::text`, [sandboxId,p,lease,payment,USERS.admin])).rows[0].id;
        await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id)
          VALUES($1,$2,'cash_clearing',432100,'TWD',$3,$4,$5,$6),($1,$2,'tenant_receivable',-432100,'TWD',$3,$4,$5,$6)`, [sandboxId,payTxn,contact,p,lease,invoice]);
        await c.query(`UPDATE payments SET ledger_transaction_id=$2 WHERE id=$1`, [payment,payTxn]);
        await c.query(`INSERT INTO expenses(org_id,property_id,category,description,currency,amount_minor,incurred_on,paid_by,bill_to,status,approved_by,approved_at,created_by)
          VALUES($1,$2,'repair','synthetic','TWD',123400,current_date,'manager_firm','owner','approved',$3,now(),$3)`, [sandboxId,p,USERS.admin]);
        const counts = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments pay
          JOIN payment_allocations a ON a.org_id=pay.org_id AND a.payment_id=pay.id
          JOIN invoices i ON i.org_id=a.org_id AND i.id=a.invoice_id
          JOIN invoice_lines il ON il.org_id=i.org_id AND il.invoice_id=i.id
          JOIN expenses e ON e.org_id=pay.org_id AND e.property_id=pay.property_id
          WHERE pay.id=$1 AND pay.org_id=$2 AND pay.property_id=$3 AND pay.lease_id=$4 AND pay.payer_contact_id=$5
            AND pay.currency='TWD' AND pay.status='confirmed' AND pay.amount_minor=432100 AND a.amount_minor=432100
            AND i.id=$6 AND i.property_id=$3 AND i.lease_id=$4 AND il.charge_type='rent' AND il.amount_minor=432100
            AND e.currency='TWD' AND e.amount_minor=123400 AND e.status='approved' AND e.bill_to='owner' AND e.ticket_id IS NULL`,
          [payment,sandboxId,p,lease,contact,invoice]);
        if (counts.rows[0].n !== 1) throw new Error("fixture mismatch");
        await c.query("COMMIT");
      } catch (error) { try { await c.query("ROLLBACK"); } catch { /* preserve failure */ } throw error; }
    });

    const dates = await db(async c => (await c.query<{ start: string; end: string }>(
      `SELECT least($1::date,$2::date,current_date)::text AS start, greatest($1::date,$2::date,current_date)::text AS end`, [live.paid, live.incurred])).rows[0]);
    const reportPath = `/m/reports?mode=range&from=${dates.start}&to=${dates.end}`;
    const csvPath = `/m/reports/export?mode=range&from=${dates.start}&to=${dates.end}`;
    async function verify(own: string, foreign: string, amounts: readonly string[], csvAmounts: readonly string[]) {
      await page.goto(reportPath);
      await expect(page.getByTestId("report-row").filter({ hasText: own })).toHaveCount(1);
      const row = page.getByTestId("report-row").filter({ hasText: own });
      const cells = await row.locator("td").allTextContents();
      expect(cells.length === 6 && cells[2].trim() === "TWD" &&
        amounts.every((amount, index) => cells[index + 3].trim() === `NT$${amount}`)).toBe(true);
      expect((await page.content()).includes(foreign) === false).toBe(true);
      await expect(page.getByTestId("report-property")).not.toContainText(foreign);
      const response = await local(page.request, csvPath);
      expect(response.status()).toBe(200);
      expect((response.headers()["content-type"] ?? "").startsWith("text/csv") &&
        (response.headers()["content-disposition"] ?? "").startsWith("attachment;")).toBe(true);
      const csv = await response.text();
      const lines = csv.split("\n").filter(line => line.includes(own));
      const suffix = `,"TWD",${csvAmounts.map(value => `"${value}"`).join(",")}`;
      expect(lines.length === 1 && !csv.includes(foreign) && lines[0].trimEnd().endsWith(suffix)).toBe(true);
    }
    phase = "live report";
    await page.goto("/api/env?set=live&next=/m");
    await expect(page.getByTestId("env-banner")).toHaveCount(0);
    await expect(page.getByTestId("org-switch")).toContainText(FIRM_NAME);
    await verify(liveMarker, sandboxMarker, ["10,000", "2,800", "7,200"], ["10000.00", "2800.00", "7200.00"]);
    await page.screenshot({ path: info.outputPath("b005-live-report.png"), fullPage: true });
    phase = "sandbox report";
    await page.goto("/api/env?set=sandbox&next=/m");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    await expect(page.getByTestId("org-switch")).toContainText("範例公司");
    await verify(sandboxMarker, liveMarker, ["4,321", "1,234", "3,087"], ["4321.00", "1234.00", "3087.00"]);
    await page.screenshot({ path: info.outputPath("b005-sandbox-report.png"), fullPage: true });
    phase = "return live";
    await page.goto("/api/env?set=live&next=/m");
    await expect(page.getByTestId("env-banner")).toHaveCount(0);
    await expect(page.getByTestId("org-switch")).toContainText(FIRM_NAME);
    await verify(liveMarker, sandboxMarker, ["10,000", "2,800", "7,200"], ["10000.00", "2800.00", "7200.00"]);
    const finalControls = await db(async c => (await c.query<{ global_off: boolean; orgs_off: number }>(
      `SELECT NOT coalesce((SELECT value->'enabled'='true'::jsonb FROM platform_settings WHERE key='onboarding_progress'),false) AS global_off,
              (SELECT count(*)::int FROM organizations WHERE id=ANY($1::uuid[]) AND feature_flags->'onboarding_progress' IS DISTINCT FROM 'true'::jsonb) AS orgs_off`,
      [[ORG_ID,sandboxId]])).rows[0]);
    expect(finalControls.global_off && finalControls.orgs_off === 2).toBe(true);
    expect(errors.length === 0).toBe(true);
  } catch { failure = `B005 report isolation failed during ${phase}`; }
  if (failure) throw new Error(failure);
});
