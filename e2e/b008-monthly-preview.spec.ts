import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, signIn } from "./session";

const url = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true" || process.env.B008_PRIVATE_HTTP_CONFIG !== "1" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") throw new Error("B008 requires disposable demo mode");
async function db<T>(fn:(client:Client)=>Promise<T>) { const client=new Client({connectionString:url}); try { await client.connect(); return await fn(client); } finally { try { await client.end(); } catch { /* preserve primary result */ } } }
const origin = "http://127.0.0.1:43139";
type Control = { value: unknown; description: string | null; updated_at: string };
type Snapshot = { control: Control | undefined; flags: unknown };
function guard(info: TestInfo) {
  if (!info.config.configFile?.endsWith("/e2e/b008-preview-private-playwright.config.ts") || info.project.use.trace !== "off" || info.project.use.video !== "off" || info.project.use.screenshot !== "off" || info.config.reporter.length !== 1 || info.config.reporter[0][0] !== "line" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") throw new Error("B008 private configuration required");
}
function safeFailure(phase: string, error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as {code?:unknown}).code : null;
  return `${phase}${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : ""}`;
}
async function reset(page: Page) {
  await signIn(page, ACCOUNTS.admin);
  let status: number;
  try {
    const response = await page.request.post(`${origin}/api/demo/reset`, { data: {}, maxRedirects: 0 });
    if (new URL(response.url()).origin !== origin) throw new Error("unexpected origin");
    status = response.status();
  } catch { throw new Error("B008 local reset failed"); }
  expect(status).toBe(200);
  await signIn(page, ACCOUNTS.admin);
}
async function capture(): Promise<Snapshot> {
  return db(async client => {
    const control=(await client.query<Control>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='billing_previews'`)).rows[0];
    const orgs=(await client.query<{feature_flags:unknown}>(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows;
    const value=control?.value as {enabled?:unknown;allowed_org_ids?:unknown} | undefined;
    expect((control === undefined || (!!value && typeof value === "object" && !Array.isArray(value) && value.enabled === false && Array.isArray(value.allowed_org_ids))) && orgs.length === 1).toBe(true);
    const flags=orgs[0].feature_flags as Record<string,unknown>;
    expect(flags && typeof flags === "object" && !Array.isArray(flags) && flags.billing_previews !== true).toBe(true);
    const inbound=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND confrelid='public.platform_settings'::regclass`)).rows[0].n;
    expect(inbound === 0).toBe(true);
    return {control,flags};
  });
}
async function restore(snapshot: Snapshot) {
  await db(async client => {
    await client.query("BEGIN");
    try {
      await client.query(`DELETE FROM platform_settings WHERE key='billing_previews'`);
      if (snapshot.control) await client.query(`INSERT INTO platform_settings(key,value,description,updated_at) VALUES ('billing_previews',$1::jsonb,$2,$3::timestamptz)`,[JSON.stringify(snapshot.control.value),snapshot.control.description,snapshot.control.updated_at]);
      await client.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,[ORG_ID,JSON.stringify(snapshot.flags)]);
      const control=(await client.query<Control>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='billing_previews'`)).rows;
      const orgs=(await client.query<{feature_flags:unknown}>(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows;
      expect(JSON.stringify(control) === JSON.stringify(snapshot.control ? [snapshot.control] : []) && orgs.length === 1 && JSON.stringify(orgs[0].feature_flags) === JSON.stringify(snapshot.flags)).toBe(true);
      await client.query("COMMIT");
    } catch (error) { try { await client.query("ROLLBACK"); } catch { /* retain failure */ } throw error; }
  });
}
async function establishOff() {
  await db(c=>c.query(`INSERT INTO platform_settings(key,value) VALUES ('billing_previews','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`));
}
async function top(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => { window.scrollTo(0, 0); requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
}

test("monthly rent preview preserves source distinctions",async ({page},info)=>{
  guard(info);
  const width=info.project.use.viewport?.width;
  if (width !== 390 && width !== 1280) throw new Error("B008 invalid viewport");
  const errors:string[]=[];
  page.on("pageerror",()=>errors.push("page error"));
  page.on("console",message=>{if(message.type()==="error")errors.push("console error");});
  page.on("response",response=>{if(response.status()>=500)errors.push("server error");});
  await page.context().route("**/*",async route=>{
    try { if(new URL(route.request().url()).origin === origin) { await route.continue(); return; } } catch { /* reject malformed URL */ }
    errors.push("off-origin request"); await route.abort();
  });
  let snapshot: Snapshot | undefined, primary: string | undefined, restoration: string | undefined;
  try {
    await reset(page); snapshot=await capture(); await establishOff();
    const path="/m/rent/monthly-preview?month=2035-02";
    await page.goto("/api/demo/locale?set=en&next=/m/rent");
    await expect(page.getByRole("link",{name:"Monthly rent preview"})).toHaveCount(0);
    await page.goto(path);
    await expect(page.getByText("Preview unavailable.",{exact:true})).toBeVisible();
    await expect(page.getByTestId("monthly-preview")).toHaveCount(0);
    await top(page); await page.screenshot({path:info.outputPath(`monthly-off-${width}.png`),fullPage:true});
    const fixtures=await db(async c=>{
      await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
      await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
      const create=async(name:string,currency:string,rent:number,start="2035-01-01",frequency="monthly")=>{
        const property=(await c.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,$2,$3,$4,'Asia/Taipei') RETURNING id::text`,[ORG_ID,`B008 monthly ${name}`,currency === "TWD" ? "TW" : "US",currency])).rows[0].id;
        const unit=(await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'Synthetic') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
        const lease=(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,rent_frequency,due_day) VALUES ($1,$2,$3,$3,'active',$4,$5,$6,$7,31) RETURNING id::text`,[ORG_ID,property,unit,start,currency,rent,frequency])).rows[0].id;
        return {property,lease};
      };
      const twd=await create("TWD","TWD",100000), usd=await create("USD","USD",12345), zero=await create("Zero","TWD",0);
      const partial=await create("Partial","USD",20000,"2035-02-16"), quarterly=await create("Quarterly","USD",30000,"2035-01-01","quarterly");
      const missing=await create("Missing period","USD",50000), existing=await create("Existing rent","USD",50000);
      for (const [fixture,number,period] of [[missing,"B008-NULL",null],[existing,"B008-EXISTING","[2035-02-01,2035-03-01)"]] as const) {
        const invoice=(await c.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,source) VALUES ($1,$2,$3,$4,'USD','2035-02-28','open','move_in') RETURNING id::text`,[ORG_ID,fixture.property,fixture.lease,number])).rows[0].id;
        await c.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor,service_period) VALUES ($1,$2,1,'rent','Synthetic rent',50000,50000,$3::daterange)`,[ORG_ID,invoice,period]);
      }
      return {twd,usd,zero,partial,quarterly,missing,existing};
    });
    await page.goto("/m/rent");
    await expect(page.getByRole("link",{name:"Monthly rent preview"})).toBeVisible();
    await page.getByRole("link",{name:"Monthly rent preview"}).click();
    await expect(page.locator('input[name="month"]')).toHaveValue("");
    await expect(page.getByText("Choose a month to review.",{exact:true})).toBeVisible();
    await expect(page.getByTestId("monthly-preview")).toHaveCount(0);
    const geometry=await page.locator('input[name="month"]').evaluate(input=>{
      const form=input.closest("form"), button=form?.querySelector("button");
      const rect=(element:Element|null|undefined)=>element?.getBoundingClientRect().toJSON() ?? null;
      return {field:rect(input),button:rect(button),viewport:window.innerWidth};
    });
    expect(geometry.field && geometry.button).toBeTruthy();
    for (const box of [geometry.field,geometry.button]) {
      expect(box!.width).toBeGreaterThan(0); expect(box!.height).toBeGreaterThan(0);
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x+box!.width).toBeLessThanOrEqual(geometry.viewport+1);
      if (width === 390) expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const field=geometry.field!, action=geometry.button!;
    expect(field.right <= action.left || action.right <= field.left || field.bottom <= action.top || action.bottom <= field.top).toBe(true);
    await top(page); await page.screenshot({path:info.outputPath(`monthly-choose-${width}.png`),fullPage:true});
    await page.locator('input[name="month"]').fill("2035-02");
    await page.getByRole("button",{name:"Review",exact:true}).click();
    await expect(page).toHaveURL(/month=2035-02/);
    const preview=page.getByTestId("monthly-preview"); await expect(preview).toBeVisible();
    await expect(preview).toContainText("Supported rent subtotal only. This is not a complete bill.");
    const row=(name:string)=>page.getByTestId("monthly-rows").locator("tbody tr").filter({hasText:`B008 monthly ${name} · Synthetic`});
    await expect(row("TWD")).toContainText("TWD"); await expect(row("TWD").locator('td[data-label="Rent"] .v')).toHaveText("1000"); await expect(row("TWD")).toContainText("Ready for rent review");
    await expect(row("USD")).toContainText("USD"); await expect(row("USD").locator('td[data-label="Rent"] .v')).toHaveText("123.45"); await expect(row("USD")).toContainText("Ready for rent review");
    await expect(row("Zero")).toContainText("Ready for rent review"); await expect(row("Zero").locator('td[data-label="Rent"] .v')).toHaveText("0");
    await expect(row("Partial")).toContainText("Partial period or move-out needs review");
    await expect(row("Quarterly")).toContainText("Unsupported rent frequency");
    await expect(row("Missing period")).toContainText("A historical rent period is missing"); await expect(row("Missing period")).toContainText("B008-NULL");
    await expect(row("Existing rent")).toContainText("Rent coverage already exists"); await expect(row("Existing rent")).toContainText("B008-EXISTING");
    const subtotals=page.getByTestId("monthly-subtotals");
    await expect(subtotals.locator("li").filter({hasText:"TWD:"})).toHaveText("TWD: 1000 (2)");
    await expect(subtotals.locator("li").filter({hasText:"USD:"})).toHaveText("USD: 123.45 (1)");
    await expect(page.getByRole("button",{name:/generate|issue|post/i})).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
    await top(page); await page.screenshot({path:info.outputPath(`monthly-on-${width}.png`),fullPage:true});
    await db(c=>c.query(`UPDATE leases SET rent_amount_minor=23456 WHERE id=$1 AND org_id=$2`,[fixtures.usd.lease,ORG_ID]));
    await page.reload(); await expect(row("USD").locator('td[data-label="Rent"] .v')).toHaveText("234.56");
    await expect(subtotals.locator("li").filter({hasText:"TWD:"})).toHaveText("TWD: 1000 (2)");
    await expect(subtotals.locator("li").filter({hasText:"USD:"})).toHaveText("USD: 234.56 (1)");
    await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(path)}`);
    await expect(page.getByTestId("monthly-preview")).toContainText("僅為可核對租金小計，並非完整帳單。");
    await expect(row("Partial")).toContainText("部分期間或搬離需核對");
    await expect(row("Quarterly")).toContainText("租金週期尚未支援");
    await expect(row("Missing period")).toContainText("歷史租金期間未記錄");
    await top(page); await page.screenshot({path:info.outputPath(`monthly-zh-${width}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
    await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent("/m/rent/monthly-preview?month=invalid")}`);
    await expect(page.getByText("Preview unavailable.",{exact:true})).toBeVisible();
    await expect(page.getByTestId("monthly-preview")).toHaveCount(0);
    await top(page); await page.screenshot({path:info.outputPath(`monthly-invalid-${width}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
    expect(errors).toEqual([]);
  } catch(error) { primary=safeFailure("monthly preview journey",error); }
  if(snapshot) try { await restore(snapshot); } catch(error) { restoration=safeFailure("control restoration",error); }
  if(primary || restoration) throw new Error([primary,restoration].filter(Boolean).join("; "));
});
