import { expect, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, signIn } from "./session";

const origin = "http://127.0.0.1:43135";
const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true" || process.env.PAPER_LEASE_VERSIONS_ENABLED !== "true" || process.env.B004_PRIVATE_HTTP_CONFIG !== "1" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") {
  throw new Error("B004 requires disposable demo mode and the paper-version switch");
}
class SafeDbError extends Error {
  constructor(readonly sqlstate: string | null) { super("B004 database operation failed"); }
}
async function db<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  try { await client.connect(); return await fn(client); }
  catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
    throw new SafeDbError(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null);
  } finally { try { await client.end(); } catch { /* preserve primary result */ } }
}
async function local(api: APIRequestContext, path: string, data?: object): Promise<APIResponse> {
  let target: URL;
  try { target = new URL(path, origin); } catch { throw new Error("B004 local request rejected"); }
  if (target.origin !== origin || !path.startsWith("/") || path.startsWith("//")) throw new Error("B004 local request rejected");
  try {
    const result = data === undefined ? await api.get(target.href, { maxRedirects: 0 }) : await api.post(target.href, { data, maxRedirects: 0 });
    if (new URL(result.url()).origin !== origin) throw new Error("unexpected origin");
    return result;
  } catch { throw new Error("B004 local HTTP request failed"); }
}
function privateGuard(info: TestInfo) {
  if (!info.config.configFile?.endsWith("/e2e/b004-paper-private-playwright.config.ts") || info.project.use.trace !== "off" || info.project.use.video !== "off" || info.project.use.screenshot !== "off" || info.config.reporter.length !== 1 || info.config.reporter[0][0] !== "line" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") throw new Error("B004 private configuration required");
}
async function installFence(page: Page, errors: string[]) {
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", message => { if (message.type() === "error") errors.push("console error"); });
  page.on("response", response => { if (response.status() >= 500) errors.push("server error"); });
  await page.route("**/*", async route => {
    try { if (new URL(route.request().url()).origin === origin) { await route.continue(); return; } } catch { /* reject malformed URL */ }
    errors.push("off-origin request"); await route.abort();
  });
}
async function reset(page: Page) {
  await signIn(page, ACCOUNTS.admin);
  expect((await local(page.request, "/api/demo/reset", {})).ok()).toBe(true);
  await signIn(page, ACCOUNTS.admin);
}
type Control = { value: unknown; description: string | null; updated_at: string };
type Flags = { id: string; feature_flags: unknown };
async function capture(page: Page) {
  await reset(page);
  await page.goto("/api/env?set=sandbox&next=/m");
  await expect(page.getByTestId("env-banner")).toBeVisible();
  const sandbox = await db(async c => (await c.query<{id:string}>(`SELECT id::text FROM organizations WHERE environment='sandbox' AND live_org_id=$1`, [ORG_ID])).rows);
  expect(sandbox.length === 1).toBe(true);
  await page.goto("/api/env?set=live&next=/m");
  const saved = await db(async c => ({ control: (await c.query<Control>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='tenant_signed_pdf'`)).rows[0], flags: (await c.query<Flags>(`SELECT id::text,feature_flags FROM organizations WHERE id=ANY($1::uuid[]) ORDER BY id`, [[ORG_ID,sandbox[0].id]])).rows }));
  expect((saved.control === undefined || saved.control.value === false) && saved.flags.length === 2).toBe(true);
  return { ...saved, sandboxId: sandbox[0].id };
}
async function restore(saved: Awaited<ReturnType<typeof capture>>) {
  await db(async c => {
    await c.query("BEGIN");
    try {
      await c.query(`DELETE FROM platform_settings WHERE key='tenant_signed_pdf'`);
      if (saved.control) await c.query(`INSERT INTO platform_settings(key,value,description,updated_at) VALUES ('tenant_signed_pdf',$1::jsonb,$2,$3::timestamptz)`, [JSON.stringify(saved.control.value),saved.control.description,saved.control.updated_at]);
      for (const row of saved.flags) await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`, [row.id,JSON.stringify(row.feature_flags)]);
      const actual = (await c.query<Control>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='tenant_signed_pdf'`)).rows;
      const flags = (await c.query<Flags>(`SELECT id::text,feature_flags FROM organizations WHERE id=ANY($1::uuid[]) ORDER BY id`, [saved.flags.map(row=>row.id)])).rows;
      expect(JSON.stringify(actual) === JSON.stringify(saved.control ? [saved.control] : []) && JSON.stringify(flags) === JSON.stringify(saved.flags)).toBe(true);
      await c.query("COMMIT");
    } catch (error) { try { await c.query("ROLLBACK"); } catch { /* retain failure */ } throw error; }
  });
}
function safeFailure(phase: string, error: unknown) { return `${phase}${error instanceof SafeDbError && error.sqlstate ? ` (${error.sqlstate})` : ""}`; }
const pdf = (name: string, text: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`) });

test("paper history follows the selected live or sandbox organization", async ({ page }, testInfo) => {
  privateGuard(testInfo);
  const errors: string[] = [];
  await installFence(page, errors);
  let saved: Awaited<ReturnType<typeof capture>> | undefined;
  let primary: string | undefined;
  try {
    saved = await capture(page);
    const sandboxId = saved.sandboxId;
    await db(client=>client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"paper_lease_versions":true}'::jsonb WHERE id=$1`,[ORG_ID]));
    const liveLease=(await db(client=>client.query<{id:string}>(`SELECT l.id::text FROM leases l
      JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary'
      JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 LIMIT 1`,[ORG_ID,USERS.tenant]))).rows[0].id;
    expect((await local(page.request, "/api/demo/id-sample", {leaseId:liveLease})).ok()).toBe(true);
    await page.goto(`/m/leases/${liveLease}?tab=sign`);
    await page.getByTestId("signed-pdf").setInputFiles(pdf("b004-live-only.pdf","LIVE-ONLY"));
    await page.getByTestId("upload-signed-pdf").click();
    await expect(page.getByTestId("paper-version-history")).toContainText("b004-live-only.pdf");
    const liveVersion=(await db(client=>client.query<{id:string}>(`SELECT p.id::text FROM lease_signed_pdfs p
      JOIN files f ON f.id=p.file_id WHERE p.org_id=$1 AND p.lease_id=$2 AND f.file_name='b004-live-only.pdf'`,[ORG_ID,liveLease]))).rows[0].id;
    const liveUrl=`/m/leases/${liveLease}/signed/${liveVersion}`;
    const livePdf=await local(page.request, liveUrl);expect(livePdf.status()).toBe(200);
    expect(livePdf.headers()["cache-control"]).toBe("private, no-store");
    expect((await livePdf.body()).includes(Buffer.from("LIVE-ONLY"))).toBe(true);

    await page.goto("/api/env?set=sandbox&next=/m/properties");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    await db(client=>client.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('paper_lease_versions',id=$2::uuid) WHERE id=ANY($1::uuid[])`,[[ORG_ID,sandboxId],sandboxId]));
    const sandboxLease=(await db(client=>client.query<{id:string}>(`SELECT l.id::text FROM leases l
      JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary'
      WHERE l.org_id=$1 AND l.status IN ('active','pending_signature') ORDER BY l.id LIMIT 1`,[sandboxId]))).rows[0].id;
    expect((await local(page.request, "/api/demo/id-sample", {leaseId:sandboxLease})).ok()).toBe(true);
    await page.goto(`/m/leases/${sandboxLease}?tab=sign`);
    const history=page.getByTestId("paper-version-history");await expect(history).toHaveCount(1);
    await expect(history.locator("li")).toHaveCount(0);
    await page.getByTestId("signed-pdf").setInputFiles(pdf("b004-sandbox-first.pdf","SANDBOX-FIRST"));
    await page.getByTestId("upload-signed-pdf").click();
    await expect(history.locator("li")).toHaveCount(1);
    await expect(history).toBeVisible();
    await expect(history).toContainText("b004-sandbox-first.pdf");
    await page.getByTestId("signed-pdf").setInputFiles(pdf("b004-sandbox-current.pdf","SANDBOX-CURRENT"));
    await page.getByTestId("paper-replace-reason").selectOption("corrected_signature");
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
    const sandboxPdf=await local(page.request, sandboxUrl);expect(sandboxPdf.status()).toBe(200);
    expect(sandboxPdf.headers()["cache-control"]).toBe("private, no-store");expect((await sandboxPdf.body()).includes(Buffer.from("SANDBOX-CURRENT"))).toBe(true);
    expect((await local(page.request, liveUrl)).status()).toBe(404);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("sandbox-paper-history.png"),fullPage:true});

    await page.goto("/api/env?set=live&next=/m");
    await db(client=>client.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('paper_lease_versions',id=$2::uuid) WHERE id=ANY($1::uuid[])`,[[ORG_ID,sandboxId],ORG_ID]));
    await page.goto(`/m/leases/${liveLease}?tab=sign`);
    await expect(page.getByTestId("paper-version-history")).toContainText("b004-live-only.pdf");
    await expect(page.getByTestId("paper-version-history")).not.toContainText("b004-sandbox-current.pdf");
    expect((await local(page.request, sandboxUrl)).status()).toBe(404);
    expect((await local(page.request, liveUrl)).status()).toBe(200);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:testInfo.outputPath("live-paper-history.png"),fullPage:true});
    expect(errors).toEqual([]);
  } catch (error) { primary = safeFailure("paper history", error); }
  let restoration: string | undefined;
  if (saved) try { await restore(saved); } catch (error) { restoration = safeFailure("control restoration", error); }
  if (primary || restoration) throw new Error([primary, restoration].filter(Boolean).join("; "));

});

test("paper replacement and private tenant delivery", async ({ page }, testInfo) => {
  privateGuard(testInfo);
  const errors: string[] = [];
  await installFence(page, errors);
  let saved: Awaited<ReturnType<typeof capture>> | undefined;
  let primary: string | undefined, faultCleanup: string | undefined, restoration: string | undefined;
  let functionCreated = false, triggerCreated = false;
  try {
  saved = await capture(page);
  const { leaseId, sandboxLeaseId } = await db(async (client) => {
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"paper_lease_versions":true,"tenant_signed_pdf":true}'::jsonb WHERE id=$1`, [ORG_ID]);
    await client.query(`INSERT INTO platform_settings(key,value) VALUES ('tenant_signed_pdf','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    const result = await client.query<{ id: string }>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id JOIN contacts c ON c.id=lp.contact_id WHERE l.org_id=$1 AND c.user_id=$2 LIMIT 1`, [ORG_ID, USERS.tenant]);
    const sandbox = saved!.sandboxId;
    const contact = (await client.query<{ id: string }>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES ($1,$2,true,'B004 sandbox tenant') RETURNING id::text`, [sandbox, USERS.tenant])).rows[0].id;
    const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES ($1,'B004 sandbox','TW','TWD','Asia/Taipei','whole_unit') RETURNING id::text`, [sandbox])).rows[0].id;
    const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'B004','whole_unit') RETURNING id::text`, [sandbox, property])).rows[0].id;
    const sandboxLeaseId = (await client.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active',current_date,'TWD',0) RETURNING id::text`, [sandbox, property, unit])).rows[0].id;
    await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id) VALUES ($1,$2,$3)`, [sandbox, sandboxLeaseId, contact]);
    return { leaseId: result.rows[0].id, sandboxLeaseId };
  });
  const sample = await local(page.request, "/api/demo/id-sample", { leaseId });
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
  await page.getByTestId("paper-replace-reason").selectOption("corrected_signature");
  await page.getByTestId("upload-signed-pdf").click();
  await expect(page.getByTestId("paper-version-history").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("paper-version-history").locator('[data-current="true"]')).toContainText("b004-second.pdf");
  await expect(page.getByTestId("paper-version-history")).toContainText("更正簽名");
  const versions = await db(async (client) => (await client.query<{ id: string; current: boolean; reason: string | null; supersedes: string | null }>(`SELECT p.id::text,(p.file_id=l.document_file_id) AS current,p.replace_reason AS reason,p.supersedes_id::text AS supersedes FROM lease_signed_pdfs p JOIN leases l ON l.id=p.lease_id WHERE p.lease_id=$1 ORDER BY p.created_at,p.id`, [leaseId])).rows);
  expect(versions).toHaveLength(2);
  const current = versions.find((v) => v.current)!;
  const old = versions.find((v) => !v.current)!;
  expect(current.reason).toBe("corrected_signature");
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
  const anonymous = await local(page.request, url);
  expect(anonymous.status()).toBe(307);
  const loginRedirect = new URL(anonymous.headers()["location"], origin);
  expect(loginRedirect.origin === origin && loginRedirect.pathname === "/login").toBe(true);
  expect(anonymous.headers()["content-type"] ?? "").not.toContain("application/pdf");
  expect(await count()).toBe(initial);
  await signIn(page, ACCOUNTS.tenant2);
  expect((await local(page.request, url)).status()).toBe(404);
  expect(await count()).toBe(initial);
  await signIn(page, ACCOUNTS.tenant);
  await page.context().addCookies([{ name: "condola_lease", value: sandboxLeaseId, url: origin }]);
  expect((await local(page.request, url)).status()).toBe(404);
  expect(await count()).toBe(initial);
  await signIn(page, ACCOUNTS.tenant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  await page.getByRole("button", { name: "海岸公寓管理" }).click();
  await expect(page.getByTestId("lease-picker")).toHaveCount(0);
  expect((await local(page.request, url)).status()).toBe(404);
  expect(await count()).toBe(initial);
  await signIn(page, ACCOUNTS.tenant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  const ownForm = page.getByTestId("lease-picker").locator("form").filter({ has: page.locator(`input[name="leaseId"][value="${leaseId}"]`) });
  await expect(ownForm).toHaveCount(1);
  await ownForm.getByRole("button").click();
  await expect(page.getByTestId("lease-picker")).toHaveCount(0);
  await page.goto("/t/lease");
  await expect(page.getByText("目前版本")).toBeVisible();
  await expect(page.getByText("歷史版本")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("tenant-paper-history.png"), fullPage: true });
  const success = await local(page.request, url);
  expect(success.status()).toBe(200);
  expect(success.headers()["cache-control"]).toBe("private, no-store");
  expect(success.headers()["x-content-type-options"]).toBe("nosniff");
  expect(success.headers()["content-type"]).toContain("application/pdf");
  expect(success.headers()["content-disposition"]).toContain("attachment");
  expect((await success.body()).includes(Buffer.from("B004-SECOND"))).toBe(true);
  expect(await count()).toBe(initial + 1);
  const totalDownloads = () => db(async client => Number((await client.query(`SELECT count(*) FROM audit_log WHERE event_type='signed_pdf_downloaded'`)).rows[0].count));
  for (const invalid of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
    const totalBefore = await totalDownloads();
    const denied = await local(page.request, `/t/lease/signed/${invalid}`);
    expect(denied.status() === 404 && denied.headers()["cache-control"] === "private, no-store" && denied.headers()["x-content-type-options"] === "nosniff" && !denied.headers()["content-disposition"] && !(denied.headers()["content-type"] ?? "").includes("application/pdf") && !(await denied.body()).includes(Buffer.from("%PDF"))).toBe(true);
    expect(await count()).toBe(initial + 1);
    expect(await totalDownloads()).toBe(totalBefore);
  }
  const event = await db(async (client) => (await client.query(`SELECT actor_user_id::text,org_id::text,request_id,new_row FROM audit_log WHERE event_type='signed_pdf_downloaded' AND row_id=$1`, [current.id])).rows[0]);
  expect(event.actor_user_id).toBe(USERS.tenant);
  expect(event.org_id).toBe(ORG_ID);
  expect(event.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(event.new_row.lease_id).toBe(leaseId);
  await db((client) => client.query(`UPDATE platform_settings SET value='false'::jsonb WHERE key='tenant_signed_pdf'`));
  expect((await local(page.request, url)).status()).toBe(404);
  expect(await count()).toBe(initial + 1);
  await db((client) => client.query(`UPDATE platform_settings SET value='true'::jsonb WHERE key='tenant_signed_pdf'`));
  await db((client) => client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_signed_pdf":false}'::jsonb WHERE id=$1`, [ORG_ID]));
  expect((await local(page.request, url)).status()).toBe(404);
  expect(await count()).toBe(initial + 1);
  await db((client) => client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_signed_pdf":true}'::jsonb WHERE id=$1`, [ORG_ID]));
  const existingFault = await db(async c => (await c.query<{ function_exists: boolean; trigger_exists: boolean }>(`SELECT to_regprocedure('public.b004_test_audit_failure()') IS NOT NULL AS function_exists, EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='audit_log'::regclass AND tgname='b004_test_audit_failure' AND NOT tgisinternal) AS trigger_exists`)).rows[0]);
  expect(!existingFault.function_exists && !existingFault.trigger_exists).toBe(true);
  await db(c => c.query(`CREATE FUNCTION public.b004_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='signed_pdf_downloaded' THEN RAISE EXCEPTION 'B004 synthetic audit failure'; END IF; RETURN NEW; END $$`));
  functionCreated = true;
  await db(c => c.query(`CREATE TRIGGER b004_test_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION public.b004_test_audit_failure()`));
  triggerCreated = true;
  const blocked = await local(page.request, url);
  expect(blocked.status()).toBe(503);
  expect(blocked.headers()["cache-control"]).toBe("private, no-store");
  expect(blocked.headers()["x-content-type-options"]).toBe("nosniff");
  expect(blocked.headers()["content-disposition"]).toBeUndefined();
  expect(await blocked.text()).toBe("Unavailable");
  expect(await count()).toBe(initial + 1);
  expect(errors).toEqual([]);
  } catch (error) { primary = safeFailure("paper replacement", error); }
  try {
    if (triggerCreated) await db(c => c.query(`DROP TRIGGER b004_test_audit_failure ON audit_log`));
    if (functionCreated) await db(c => c.query(`DROP FUNCTION public.b004_test_audit_failure()`));
    if (triggerCreated || functionCreated) {
      const remaining = await db(async c => (await c.query<{ f: boolean; t: boolean }>(`SELECT to_regprocedure('public.b004_test_audit_failure()') IS NOT NULL AS f, EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='audit_log'::regclass AND tgname='b004_test_audit_failure' AND NOT tgisinternal) AS t`)).rows[0]);
      expect(!remaining.f && !remaining.t).toBe(true);
    }
  } catch (error) { faultCleanup = safeFailure("fault cleanup", error); }
  if (saved) try { await restore(saved); } catch (error) { restoration = safeFailure("control restoration", error); }
  if (primary || faultCleanup || restoration) throw new Error([primary, faultCleanup, restoration].filter(Boolean).join("; "));

});
