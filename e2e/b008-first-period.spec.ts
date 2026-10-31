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

test("first period preview and saved edit",async ({page},info)=>{
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

  await page.goto("/api/demo/locale?set=en&next=/m/leases/new");
  await expect(page.getByTestId("first-period-preview")).toHaveCount(0);
  const unit=await db(async c=>{
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    const property=(await c.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,jurisdiction_id,currency,timezone,default_rental_mode) SELECT $1,'First period fixture','US',id,'USD','America/Los_Angeles','whole_unit' FROM jurisdictions WHERE code='US' RETURNING id::text`,[ORG_ID])).rows[0].id;
    return (await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES ($1,$2,'First period','whole_unit',30000) RETURNING id::text`,[ORG_ID,property])).rows[0].id;
  });
  await page.goto("/m/leases/new");
  await page.getByTestId("lease-room").selectOption(unit);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("First period fixture");
  await page.getByTestId("tenant-phone").fill("0912000333");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("start-date").fill("2035-12-16");
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("300");
  await page.getByLabel("Calculate partial first-month rent by day").check();
  await expect(page.getByTestId("first-period-preview")).toContainText("160.00");
  await expect(page.getByTestId("first-period-preview")).toContainText("16 days");
  await top(page);
  await page.screenshot({path:info.outputPath(`first-period-wizard-${width}.png`),fullPage:true});
  for(let step=0;step<5;step++) await page.getByTestId("wizard-next").click();
  await page.getByTestId("submit-lease").click();
  await page.waitForURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1/);
  const id=new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByTestId("first-period-summary")).toContainText("160.00");
  await expect(page.getByTestId("first-period-summary")).toContainText("separately from the lease PDF");
  const combined=page.getByTestId("move-in-invoice-preview");
  await expect(combined.getByRole("heading", {name:"First invoice estimate"})).toBeVisible();
  await expect(combined.locator("tr").filter({has:page.getByText("Rent",{exact:true})}).locator("td.num")).toHaveText("$160.00");
  await expect(combined.locator("tr").filter({has:page.getByText("Deposit",{exact:true})}).locator("td.num")).toHaveText("$600.00");
  await expect(combined.locator("tr").filter({has:page.getByText("Total",{exact:true})}).locator("td.num")).toHaveText("$760.00");
  await expect(combined).toContainText("Rent service period: Dec 16, 2035 – Dec 31, 2035");
  await expect(combined).toContainText("Monthly rent ÷ 30 × days (16 days)");
  await combined.screenshot({path:info.outputPath(`combined-before-${width}.png`)});
  await page.locator("#first-period-choice").selectOption("false");
  await expect(page.getByTestId("edit-first-period-preview")).toContainText("300.00");
  await top(page);
  await page.screenshot({path:info.outputPath(`first-period-edit-${width}.png`),fullPage:true});
  await page.getByTestId("save-lease-terms").click();
  await expect.poll(async()=>db(async c=>(await c.query<{basis:{prorateFirstPeriod:boolean}}>(`SELECT first_period_basis AS basis FROM leases WHERE id=$1`,[id])).rows[0].basis.prorateFirstPeriod)).toBe(false);
  await expect(page.getByTestId("first-period-summary")).toContainText("300.00");
  await expect(combined.locator("tr").filter({has:page.getByText("Rent",{exact:true})}).locator("td.num")).toHaveText("$300.00");
  await expect(combined.locator("tr").filter({has:page.getByText("Deposit",{exact:true})}).locator("td.num")).toHaveText("$600.00");
  await expect(combined.locator("tr").filter({has:page.getByText("Total",{exact:true})}).locator("td.num")).toHaveText("$900.00");
  await expect(combined).toContainText("Rent service period: Dec 16, 2035 – Dec 31, 2035");
  await expect(combined).toContainText("Full rent");
  await combined.screenshot({path:info.outputPath(`combined-after-${width}.png`)});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
  expect(errors).toEqual([]);
  } catch (error) { primary=safeFailure("preview journey",error); }
  if (snapshot) try { await restore(snapshot); } catch (error) { restoration=safeFailure("control restoration",error); }
  if (primary || restoration) throw new Error([primary,restoration].filter(Boolean).join("; "));
});
