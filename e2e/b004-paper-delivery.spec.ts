import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, resetDemo, signIn } from "./session";

if (process.env.B004_VIEWPORT_WIDTH === "390" || process.env.B004_VIEWPORT_WIDTH === "1280") {
  test.use({ viewport: { width: Number(process.env.B004_VIEWPORT_WIDTH), height: 900 } });
}

const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true" || process.env.PAPER_LEASE_VERSIONS_ENABLED !== "true") {
  throw new Error("B004 requires disposable demo mode and the paper-version switch");
}
async function db<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}
const pdf = (name: string, text: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`) });

test.afterEach(async ({}, testInfo) => {
  if (testInfo.title === "paper history follows the selected live or sandbox organization") return;
  await db(async (client) => {
    await client.query(`DROP TRIGGER IF EXISTS b004_test_audit_failure ON audit_log`);
    await client.query(`DROP FUNCTION IF EXISTS public.b004_test_audit_failure()`);
    await client.query(`UPDATE platform_settings SET value='false'::jsonb WHERE key='tenant_signed_pdf'`);
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"paper_lease_versions":false,"tenant_signed_pdf":false}'::jsonb WHERE id=$1`, [ORG_ID]);
  });
});

test("paper history follows the selected live or sandbox organization", async ({ page }, testInfo) => {
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error") errors.push(message.text());});
  page.on("response",response=>{if(response.status()>=500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);});
  await page.route("**/*",async route=>{
    const parsed=new URL(route.request().url());
    if((parsed.protocol==="http:" || parsed.protocol==="https:") && ["127.0.0.1","localhost"].includes(parsed.hostname)) await route.continue();
    else {errors.push("unexpected external request");await route.abort();}
  });
  await resetDemo(page);
  const liveFlags=(await db(client=>client.query<{feature_flags:unknown}>(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID]))).rows[0].feature_flags;
  let sandboxId="", sandboxFlags:unknown;
  try {
    await db(client=>client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"paper_lease_versions":true}'::jsonb WHERE id=$1`,[ORG_ID]));
    const liveLease=(await db(client=>client.query<{id:string}>(`SELECT l.id::text FROM leases l
      JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary'
      JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 LIMIT 1`,[ORG_ID,USERS.tenant]))).rows[0].id;
    expect((await page.request.post("/api/demo/id-sample",{data:{leaseId:liveLease}})).ok()).toBe(true);
    await page.goto(`/m/leases/${liveLease}?tab=sign`);
    await page.getByTestId("signed-pdf").setInputFiles(pdf("b004-live-only.pdf","LIVE-ONLY"));
    await page.getByTestId("upload-signed-pdf").click();
    await expect(page.getByTestId("paper-version-history")).toContainText("b004-live-only.pdf");
    const liveVersion=(await db(client=>client.query<{id:string}>(`SELECT p.id::text FROM lease_signed_pdfs p
      JOIN files f ON f.id=p.file_id WHERE p.org_id=$1 AND p.lease_id=$2 AND f.file_name='b004-live-only.pdf'`,[ORG_ID,liveLease]))).rows[0].id;
    const liveUrl=`/m/leases/${liveLease}/signed/${liveVersion}`;
    const livePdf=await page.request.get(liveUrl);expect(livePdf.status()).toBe(200);
    expect(livePdf.headers()["cache-control"]).toBe("private, no-store");
    expect((await livePdf.body()).toString()).toContain("LIVE-ONLY");

    await page.goto("/api/env?set=sandbox&next=/m/properties");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    const sandbox=(await db(client=>client.query<{id:string;feature_flags:unknown}>(`SELECT id::text,feature_flags FROM organizations WHERE environment='sandbox' AND live_org_id=$1`,[ORG_ID]))).rows[0];
    sandboxId=sandbox.id;sandboxFlags=sandbox.feature_flags;
    await db(client=>client.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('paper_lease_versions',id=$2::uuid) WHERE id=ANY($1::uuid[])`,[[ORG_ID,sandboxId],sandboxId]));
    const sandboxLease=(await db(client=>client.query<{id:string}>(`SELECT l.id::text FROM leases l
      JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary'
      WHERE l.org_id=$1 AND l.status IN ('active','pending_signature') ORDER BY l.id LIMIT 1`,[sandboxId]))).rows[0].id;
    expect((await page.request.post("/api/demo/id-sample",{data:{leaseId:sandboxLease}})).ok()).toBe(true);
    await page.goto(`/m/leases/${sandboxLease}?tab=sign`);
    const history=page.getByTestId("paper-version-history");await expect(history).toHaveCount(1);
    await expect(history.locator("li")).toHaveCount(0);
    await page.getByTestId("signed-pdf").setInputFiles(pdf("b004-sandbox-first.pdf","SANDBOX-FIRST"));
    await page.getByTestId("upload-signed-pdf").click();
    await expect(history.locator("li")).toHaveCount(1);
    await expect(history).toBeVisible();
    await expect(history).toContainText("b004-sandbox-first.pdf");
    await page.getByTestId("signed-pdf").setInputFiles(pdf("b004-sandbox-current.pdf","SANDBOX-CURRENT"));
    await page.getByTestId("paper-replace-reason").fill("Synthetic correction");
    await page.getByTestId("upload-signed-pdf").click();
    await expect(history.locator("li")).toHaveCount(2);
    await expect(history.locator('[data-current="true"]')).toContainText("b004-sandbox-current.pdf");
    await expect(history).toContainText("b004-sandbox-first.pdf");await expect(history).not.toContainText("b004-live-only.pdf");
    const metadata=(await db(client=>client.query<{id:string;name:string;timezone:string;uploaded_at:Date;pointer:boolean}>(`SELECT p.id::text,profile.display_name AS name,o.timezone,p.created_at AS uploaded_at,
      p.file_id=l.document_file_id AS pointer FROM lease_signed_pdfs p JOIN leases l ON l.id=p.lease_id
      JOIN organizations o ON o.id=p.org_id JOIN profiles profile ON profile.id=p.uploaded_by
      JOIN files f ON f.id=p.file_id WHERE p.org_id=$1 AND p.lease_id=$2 AND f.file_name='b004-sandbox-current.pdf'`,[sandboxId,sandboxLease]))).rows[0];
    expect(metadata.pointer).toBe(true);
    const current=history.locator('[data-current="true"]');
    await expect(current).toContainText(metadata.name);await expect(current).not.toContainText(USERS.admin);
    const time=new Intl.DateTimeFormat("zh-TW",{calendar:"gregory",timeZone:metadata.timezone,year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(metadata.uploaded_at);
    await expect(current.locator("time")).toHaveAttribute("datetime",metadata.uploaded_at.toISOString());
    await expect(current.locator("time")).toHaveText(`${time} (${metadata.timezone})`);
    const sandboxUrl=`/m/leases/${sandboxLease}/signed/${metadata.id}`;
    const sandboxPdf=await page.request.get(sandboxUrl);expect(sandboxPdf.status()).toBe(200);
    expect(sandboxPdf.headers()["cache-control"]).toBe("private, no-store");expect((await sandboxPdf.body()).toString()).toContain("SANDBOX-CURRENT");
    expect((await page.request.get(liveUrl)).status()).toBe(404);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("sandbox-paper-history.png"),fullPage:true});

    await page.goto("/api/env?set=live&next=/m");
    await db(client=>client.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('paper_lease_versions',id=$2::uuid) WHERE id=ANY($1::uuid[])`,[[ORG_ID,sandboxId],ORG_ID]));
    await page.goto(`/m/leases/${liveLease}?tab=sign`);
    await expect(page.getByTestId("paper-version-history")).toContainText("b004-live-only.pdf");
    await expect(page.getByTestId("paper-version-history")).not.toContainText("b004-sandbox-current.pdf");
    expect((await page.request.get(sandboxUrl)).status()).toBe(404);
    expect((await page.request.get(liveUrl)).status()).toBe(200);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("live-paper-history.png"),fullPage:true});
    expect(errors).toEqual([]);
  } finally {
    if(sandboxId) await db(client=>client.query("UPDATE organizations SET feature_flags=$2 WHERE id=$1",[sandboxId,sandboxFlags]));
    await db(client=>client.query("UPDATE organizations SET feature_flags=$2 WHERE id=$1",[ORG_ID,liveFlags]));
  }
});

test("paper replacement and private tenant delivery", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  await resetDemo(page);
  const { leaseId, sandboxLeaseId } = await db(async (client) => {
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"paper_lease_versions":true,"tenant_signed_pdf":true}'::jsonb WHERE id=$1`, [ORG_ID]);
    await client.query(`INSERT INTO platform_settings(key,value) VALUES ('tenant_signed_pdf','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    const result = await client.query<{ id: string }>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 LIMIT 1`, [ORG_ID, USERS.tenant]);
    const existingSandbox = (await client.query<{ id: string }>(`SELECT id::text FROM organizations WHERE environment='sandbox' AND live_org_id=$1`, [ORG_ID])).rows[0]?.id;
    const sandbox = existingSandbox ?? (await client.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency,feature_flags,environment,live_org_id) VALUES ('B004 sandbox','TW','TWD','{"tenant_signed_pdf":true}','sandbox',$1) RETURNING id::text`, [ORG_ID])).rows[0].id;
    const contact = (await client.query<{ id: string }>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES ($1,$2,true,'B004 sandbox tenant') RETURNING id::text`, [sandbox, USERS.tenant])).rows[0].id;
    const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES ($1,'B004 sandbox','TW','TWD','Asia/Taipei','whole_unit') RETURNING id::text`, [sandbox])).rows[0].id;
    const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'B004','whole_unit') RETURNING id::text`, [sandbox, property])).rows[0].id;
    const sandboxLeaseId = (await client.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active',current_date,'TWD',0) RETURNING id::text`, [sandbox, property, unit])).rows[0].id;
    await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id) VALUES ($1,$2,$3)`, [sandbox, sandboxLeaseId, contact]);
    return { leaseId: result.rows[0].id, sandboxLeaseId };
  });
  const sample = await page.request.post("/api/demo/id-sample", { data: { leaseId } });
  expect(sample.ok()).toBeTruthy();
  await page.goto(`/m/leases/${leaseId}?tab=sign`);
  await expect(page.getByTestId("paper-version-history")).toHaveCount(1);
  await page.getByTestId("signed-pdf").setInputFiles(pdf("b004-first.pdf", "B004-FIRST"));
  await page.getByTestId("upload-signed-pdf").click();
  await expect(page.getByTestId("paper-version-history").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("paper-replace-reason")).toHaveAttribute("required", "");
  await page.getByTestId("signed-pdf").setInputFiles(pdf("b004-second.pdf", "B004-SECOND"));
  await page.getByTestId("upload-signed-pdf").click();
  await expect(page.getByTestId("paper-version-history").locator("li")).toHaveCount(1);
  await page.getByTestId("paper-replace-reason").fill("Corrected paper copy");
  await page.getByTestId("upload-signed-pdf").click();
  await expect(page.getByTestId("paper-version-history").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("paper-version-history").locator('[data-current="true"]')).toContainText("b004-second.pdf");
  await expect(page.getByTestId("paper-version-history")).toContainText("Corrected paper copy");
  const versions = await db(async (client) => (await client.query<{ id: string; current: boolean; reason: string | null; supersedes: string | null }>(`SELECT p.id::text,(p.file_id=l.document_file_id) AS current,p.replace_reason AS reason,p.supersedes_id::text AS supersedes FROM lease_signed_pdfs p JOIN leases l ON l.id=p.lease_id WHERE p.lease_id=$1 ORDER BY p.created_at,p.id`, [leaseId])).rows);
  expect(versions).toHaveLength(2);
  const current = versions.find((v) => v.current)!;
  const old = versions.find((v) => !v.current)!;
  expect(current.reason).toBe("Corrected paper copy");
  expect(current.supersedes).toBe(old.id);
  const metadata = await db(async (client) => (await client.query<{ uploaded_at: Date; timezone: string; name: string }>(
    `SELECT p.created_at AS uploaded_at, o.timezone, profile.display_name AS name
       FROM lease_signed_pdfs p JOIN organizations o ON o.id=p.org_id
       JOIN profiles profile ON profile.id=p.uploaded_by WHERE p.id=$1`, [current.id])).rows[0]);
  const currentRow = page.getByTestId("paper-version-history").locator('[data-current="true"]');
  await expect(currentRow).toContainText(metadata.name);
  await expect(currentRow).not.toContainText(USERS.admin);
  const display = new Intl.DateTimeFormat("zh-TW", { calendar: "gregory", timeZone: metadata.timezone,
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(metadata.uploaded_at);
  await expect(currentRow.locator("time")).toHaveAttribute("datetime", metadata.uploaded_at.toISOString());
  await expect(currentRow.locator("time")).toHaveText(`${display} (${metadata.timezone})`);
  await page.screenshot({ path: testInfo.outputPath("manager-paper-history.png"), fullPage: true });
  const url = `/t/lease/signed/${current.id}`;
  const count = () => db(async (client) => Number((await client.query(`SELECT count(*) FROM audit_log WHERE event_type='signed_pdf_downloaded' AND row_id=$1`, [current.id])).rows[0].count));
  const initial = await count();
  await page.context().clearCookies();
  const anonymous = await page.request.get(url, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);
  expect(new URL(anonymous.headers()["location"], "http://127.0.0.1:43123").pathname).toBe("/login");
  expect(anonymous.headers()["content-type"] ?? "").not.toContain("application/pdf");
  expect(await count()).toBe(initial);
  await signIn(page, ACCOUNTS.tenant2);
  expect((await page.request.get(url)).status()).toBe(404);
  expect(await count()).toBe(initial);
  await signIn(page, ACCOUNTS.tenant);
  await page.context().addCookies([{ name: "condola_lease", value: sandboxLeaseId, url: "http://127.0.0.1:43123" }]);
  expect((await page.request.get(url)).status()).toBe(404);
  expect(await count()).toBe(initial);
  await signIn(page, ACCOUNTS.tenant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  await page.getByRole("button", { name: "海岸公寓管理" }).click();
  await expect(page.getByTestId("lease-picker")).toHaveCount(0);
  expect((await page.request.get(url, { maxRedirects: 0 })).status()).toBe(404);
  expect(await count()).toBe(initial);
  await signIn(page, ACCOUNTS.tenant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  await page.getByRole("button", { name: "松信住宅管理" }).click();
  await expect(page.getByTestId("lease-picker")).toHaveCount(0);
  await page.goto("/t/lease");
  await expect(page.getByText("目前版本")).toBeVisible();
  await expect(page.getByText("歷史版本")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("tenant-paper-history.png"), fullPage: true });
  const success = await page.request.get(url);
  expect(success.status()).toBe(200);
  expect(success.headers()["cache-control"]).toBe("private, no-store");
  expect(success.headers()["x-content-type-options"]).toBe("nosniff");
  expect(success.headers()["content-type"]).toContain("application/pdf");
  expect(success.headers()["content-disposition"]).toContain("attachment");
  expect((await success.body()).toString()).toContain("B004-SECOND");
  expect(await count()).toBe(initial + 1);
  const event = await db(async (client) => (await client.query(`SELECT actor_user_id::text,org_id::text,request_id,new_row FROM audit_log WHERE event_type='signed_pdf_downloaded' AND row_id=$1`, [current.id])).rows[0]);
  expect(event.actor_user_id).toBe(USERS.tenant);
  expect(event.org_id).toBe(ORG_ID);
  expect(event.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(event.new_row.lease_id).toBe(leaseId);
  await db((client) => client.query(`UPDATE platform_settings SET value='false'::jsonb WHERE key='tenant_signed_pdf'`));
  expect((await page.request.get(url)).status()).toBe(404);
  expect(await count()).toBe(initial + 1);
  await db((client) => client.query(`UPDATE platform_settings SET value='true'::jsonb WHERE key='tenant_signed_pdf'`));
  await db((client) => client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_signed_pdf":false}'::jsonb WHERE id=$1`, [ORG_ID]));
  expect((await page.request.get(url)).status()).toBe(404);
  expect(await count()).toBe(initial + 1);
  await db((client) => client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_signed_pdf":true}'::jsonb WHERE id=$1`, [ORG_ID]));
  await db((client) => client.query(`CREATE FUNCTION public.b004_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='signed_pdf_downloaded' THEN RAISE EXCEPTION 'B004 synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER b004_test_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION public.b004_test_audit_failure()`));
  try {
    const blocked = await page.request.get(url);
    expect(blocked.status()).toBe(503);
    expect(blocked.headers()["cache-control"]).toBe("private, no-store");
    expect(blocked.headers()["x-content-type-options"]).toBe("nosniff");
    expect(blocked.headers()["content-disposition"]).toBeUndefined();
    expect(await blocked.text()).toBe("Unavailable");
    expect(await count()).toBe(initial + 1);
  } finally {
    await db((client) => client.query(`DROP TRIGGER b004_test_audit_failure ON audit_log; DROP FUNCTION public.b004_test_audit_failure(); UPDATE platform_settings SET value='false'::jsonb WHERE key='tenant_signed_pdf'; UPDATE organizations SET feature_flags=feature_flags || '{"paper_lease_versions":false,"tenant_signed_pdf":false}'::jsonb WHERE id='${ORG_ID}'`));
  }
  expect(errors).toEqual([]);
});
