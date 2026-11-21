import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { insertTestAuthSession } from "../src/server/test-auth-session";
import { prepareUtilityRun } from "../src/server/utility-posting";
import type { Session } from "../src/server/types";
import { ACCOUNTS, signIn } from "./session";

const url=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true" || process.env.B008_PRIVATE_HTTP_CONFIG !== "1" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") throw new Error("B008 requires disposable demo mode");
async function db<T>(fn:(client:Client)=>Promise<T>) { const client=new Client({connectionString:url}); try { await client.connect(); return await fn(client); } finally { try { await client.end(); } catch { /* preserve primary result */ } } }
const admin:Session={userId:USERS.admin,sessionId:"b008-browser",email:"fixture@example.invalid",name:"Fixture",kind:"staff",role:"admin",orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"en",calendar:"gregorian",leaseId:null};

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

test("statement and close preview",async ({page},info)=>{
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
  let snapshot: Snapshot | undefined, primary: string | undefined, restoration: string | undefined, sessionCleanup: string | undefined;
  let adminSessionId: string | undefined;
  try {
    await reset(page); snapshot=await capture(); await establishOff();

  const fixture=await db(async(c)=>{
    const owner=(await c.query<{owner:string;property:string}>(`SELECT po.owner_contact_id::text AS owner,po.property_id::text AS property FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND p.currency='TWD' ORDER BY p.name LIMIT 1`,[ORG_ID])).rows[0];
    const expense=(await c.query<{id:string}>(`INSERT INTO expenses(org_id,property_id,category,currency,amount_minor,incurred_on,paid_by,bill_to,status) VALUES ($1,$2,'fixture','TWD',10000,'2099-06-15','owner','owner','approved') RETURNING id::text`,[ORG_ID,owner.property])).rows[0].id;
    const unit=(await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'B008 browser','by_room') RETURNING id::text`,[ORG_ID,owner.property])).rows[0].id;
    await c.query(`INSERT INTO rooms(org_id,unit_id,label,electricity_method) VALUES ($1,$2,'A','even'),($1,$2,'B','even'),($1,$2,'C','even')`,[ORG_ID,unit]);
    return {...owner,expense,unit};
  });
  const path=`/m/statements/preview?owner=${fixture.owner}&month=2099-06`;
  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(path)}`);
  await expect(page.getByTestId("statement-amount-preview")).toHaveCount(0);
  await expect(page.getByTestId("preview-generate")).toBeVisible();
  await db(async(c)=>{await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);});
  await signIn(page,ACCOUNTS.manager);
  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(path)}`);
  await expect(page.getByTestId("statement-amount-preview")).toBeVisible();
  await expect(page.getByTestId("preview-generate")).toHaveCount(0);
  await signIn(page,ACCOUNTS.admin);
  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(path)}`);
  const preview=page.getByTestId("statement-amount-preview");
  await expect(preview).toContainText("Expenses");
  await expect(page.getByTestId("preview-generate")).toBeVisible();
  await top(page);
  await page.screenshot({path:info.outputPath(`statement-${width}.png`),fullPage:true});
  await db((c)=>c.query(`UPDATE expenses SET amount_minor=20000 WHERE id=$1`,[fixture.expense]));
  await page.getByTestId("preview-generate").click();
  await expect(page.getByText("The sources changed. Review the refreshed preview before generating.")).toBeVisible();
  await expect(page.getByTestId("statement-amount-preview")).toBeVisible();
  await page.getByTestId("preview-generate").click();
  await page.waitForURL(/\/m\/statements\/[0-9a-f-]{36}$/);
  const statementId=new URL(page.url()).pathname.split("/").at(-1)!;
  const amount=await db(async(c)=>(await c.query(`SELECT expenses_minor::text AS value FROM owner_statements WHERE id=$1`,[statementId])).rows[0].value);
  expect(Number(amount)).toBe(20000);
  adminSessionId=await db(c=>insertTestAuthSession(c,USERS.admin));
  const run=await prepareUtilityRun({...admin,sessionId:adminSessionId},{unitId:fixture.unit,periodStart:"2099-07-01",periodEnd:"2099-07-31",rateMajor:4,totalKwh:null,billTotalMajor:100,overrideReason:"",readings:[]});
  await db((c)=>c.query(`UPDATE utility_allocation_lines SET amount_minor=amount_minor+100 WHERE id=(SELECT id FROM utility_allocation_lines WHERE run_id=$1 ORDER BY id LIMIT 1)`,[run.runId]));
  await page.goto("/m/close?month=2099-07");
  await expect(page.getByTestId("utility-reconciliation")).toContainText("Unexplained difference");
  await expect(page.getByTestId("utility-reconciliation")).toContainText("−NT$1");
  await expect(page.getByTestId("close-month")).toHaveValue("2099-07");
  await top(page);
  await page.screenshot({path:info.outputPath(`close-${width}.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth+1)).toBe(true);
  expect(errors).toEqual([]);
  } catch (error) { primary=safeFailure("preview journey",error); }
  if (snapshot) try { await restore(snapshot); } catch (error) { restoration=safeFailure("control restoration",error); }
  if (adminSessionId) { const sid=adminSessionId; try { await db(c=>c.query(`DELETE FROM auth_sessions WHERE id=$1`,[sid])); } catch (error) { sessionCleanup=safeFailure("auth session cleanup",error); } }
  if (primary || restoration || sessionCleanup) throw new Error([primary,restoration,sessionCleanup].filter(Boolean).join("; "));
});
