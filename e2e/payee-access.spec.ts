import { expect, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { SESSION_COOKIE } from "../src/server/auth";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ORG_ID, USERS } from "../src/server/ids";
import { ACCOUNTS, signIn } from "./session";

const origin = "http://127.0.0.1:43134";
const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
// Only synthetic local values. Never include them in errors or audit output.
const companyNumber = ["12345", "09876"].join("");
const ownerNumber = ["65432", "04567"].join("");
const sandboxNumber = ["71234", "05678"].join("");
if (process.env.DEMO_MODE !== "true" || process.env.B003_PRIVATE_HTTP_CONFIG !== "1" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") throw new Error("B003 requires its private local configuration");

class SafeDbError extends Error {
  constructor(readonly sqlstate: string | null) { super("B003 local database operation failed"); }
}
async function db<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  try { await client.connect(); return await run(client); }
  catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
    throw new SafeDbError(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null);
  } finally { try { await client.end(); } catch { /* preserve the primary result */ } }
}
async function local(api: APIRequestContext, path: string, data?: object): Promise<APIResponse> {
  const target = new URL(path, origin);
  if (target.origin !== origin) throw new Error("B003 local request rejected");
  try { return await api.post(target.href, { data, maxRedirects: 0, timeout: 15_000 }); }
  catch { throw new Error("B003 local HTTP request failed"); }
}
function privateGuard(info: TestInfo) {
  if (!info.config.configFile?.endsWith("/e2e/b003-payee-private-playwright.config.ts") || info.project.use.trace !== "off" || info.project.use.video !== "off" || info.project.use.screenshot !== "off" || info.config.reporter.length !== 1 || info.config.reporter[0][0] !== "line" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") throw new Error("B003 private configuration required");
}
async function installFence(page: Page, errors: string[]) {
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", message => { if (message.type() === "error") errors.push("console error"); });
  page.on("response", response => { if (response.status() >= 500) errors.push("server error"); });
  await page.route("**/*", async route => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { errors.push("off-origin request"); await route.abort(); }
  });
}
async function reset(page: Page) {
  await signIn(page, ACCOUNTS.admin);
  expect((await local(page.request, "/api/demo/reset" )).status()).toBe(200);
  await signIn(page, ACCOUNTS.admin);
}
async function chooseLease(page: Page, account: string, leaseId: string, singleActor?: string) {
  await signIn(page, account);
  await page.goto("/t");
  const picker = page.getByTestId("lease-picker");
  if (await picker.count()) {
    const form = picker.locator("form").filter({ has: page.locator(`input[name="leaseId"][value="${leaseId}"]`) });
    await expect(form).toHaveCount(1);
    await form.getByRole("button").click();
    await expect(picker).toHaveCount(0);
  } else {
    if (!singleActor) throw new Error("B003 lease picker unavailable");
    const own = await db(async client => (await client.query<{ id: string }>(`SELECT DISTINCT l.id::text FROM leases l JOIN lease_parties p ON p.lease_id=l.id AND p.org_id=l.org_id JOIN contacts c ON c.id=p.contact_id AND c.org_id=l.org_id WHERE c.user_id=$1 AND c.archived_at IS NULL AND l.status IN ('active','pending_signature')`, [singleActor])).rows);
    expect(own.length === 1 && own[0].id === leaseId).toBe(true);
  }
  await page.goto("/t/pay");
}
async function auditCursor() {
  return db(async client => (await client.query<{ id: string }>(`SELECT coalesce(max(id),0)::text AS id FROM app.payee_access_log`)).rows[0].id);
}
async function auditAfter(cursor: string, operation: string) {
  return db(async client => (await client.query<{ actor_id: string | null; org_id: string | null; environment: string | null; target_id: string | null; outcome: string; reason: string; body: string }>(`SELECT actor_id::text,org_id::text,environment,target_id::text,outcome,reason,row_to_json(a)::text AS body FROM app.payee_access_log a WHERE id>$1::bigint AND operation=$2 ORDER BY id`, [cursor, operation])).rows);
}
function noNumbers(text: string) { return ![companyNumber, ownerNumber, sandboxNumber].some(number => text.includes(number)); }
async function saveAccount(page: Page, holder: string, number: string, defaultAccount: boolean, expectedOrg: string, ownerId?: string) {
  const form = page.locator("form").filter({ has: page.locator('[name="accountNumber"]') }).filter({ hasNot: page.locator('[name="id"]') });
  await expect(form).toHaveCount(1);
  await form.locator('[name="holderName"]').fill(holder);
  await form.locator('[name="bankName"]').fill("合成測試銀行");
  await form.locator('[name="bankCode"]').fill("123");
  await form.locator('[name="branchCode"]').fill("456");
  await form.locator('[name="accountNumber"]').fill(number);
  if (ownerId) await form.locator('[name="ownerContactId"]').selectOption(ownerId);
  if (defaultAccount) await form.locator('[name="isDefault"]').check();
  const cursor = await auditCursor();
  await form.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(page).toHaveURL(/\/m\/settings\?saved=1/);
  await expect(page.locator("form").filter({ has: page.getByRole("heading", { name: holder, exact: true }) }).locator('[name="accountNumber"]')).toHaveValue(number);
  const rows = await auditAfter(cursor, "save");
  expect(rows.length === 1 && rows[0].actor_id === USERS.admin && rows[0].org_id === expectedOrg && rows[0].outcome === "allowed" && rows[0].reason === "ok" && noNumbers(rows[0].body)).toBe(true);
}

for (const width of [390, 1280]) test(`payee OFF, missing and isolated audited accounts at ${width}px`, async ({ page }, info) => {
  privateGuard(info);
  await page.setViewportSize({ width, height: 844 });
  const errors: string[] = [];
  await installFence(page, errors);
  let phase = "initial setup", failed: string | null = null, restoreFailed = false;
  let control: { value: unknown; description: string | null; updated_at: string } | undefined;
  let flags: { id: string; feature_flags: unknown }[] = [];
  let eligible = false;
  try {
    phase = "demo reset and admin login";
    await reset(page);
    phase = "sandbox selection";
    await page.goto("/api/env?set=sandbox&next=/m");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    phase = "sandbox context";
    const sandboxId = await db(async client => (await client.query<{ id: string }>(`SELECT id::text FROM organizations WHERE environment='sandbox' AND live_org_id=$1`, [ORG_ID])).rows[0]?.id);
    expect(Boolean(sandboxId)).toBe(true);
    phase = "live selection";
    await page.goto("/api/env?set=live&next=/m");
    phase = "read controls";
    const saved = await db(async client => ({
      control: (await client.query<{ value: unknown; description: string | null; updated_at: string }>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='payee_details'`)).rows[0],
      flags: (await client.query<{ id: string; feature_flags: unknown }>(`SELECT id::text,feature_flags FROM organizations WHERE id=ANY($1::uuid[]) ORDER BY id`, [[ORG_ID, sandboxId]])).rows,
    }));
    control = saved.control; flags = saved.flags;
    phase = "validate controls";
    const value = control?.value as { enabled?: unknown; allowed_org_ids?: unknown } | undefined;
    expect(control === undefined || (!!value && typeof value === "object" && !Array.isArray(value) && value.enabled === false && Array.isArray(value.allowed_org_ids))).toBe(true);
    expect(flags.length).toBe(2);
    eligible = true;
    phase = "establish OFF control";
    await db(async client => { await client.query(`INSERT INTO platform_settings(key,value) VALUES('payee_details','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`); });
    phase = "select eligible leases";
    const leases = await db(async client => (await client.query<{ id: string; user_id: string }>(`SELECT DISTINCT l.id::text,c.user_id::text FROM leases l JOIN lease_parties p ON p.org_id=l.org_id AND p.lease_id=l.id JOIN contacts c ON c.id=p.contact_id AND c.org_id=l.org_id WHERE l.org_id=$1 AND c.user_id=ANY($2::uuid[]) AND l.status='active' AND l.start_date<=current_date AND (l.end_date IS NULL OR l.end_date>=current_date) ORDER BY 1`, [ORG_ID, [USERS.tenant, USERS.tenant2]])).rows);
    const liveLease = leases.find(row => row.user_id === USERS.tenant)?.id;
    const otherLease = leases.find(row => row.user_id === USERS.tenant2)?.id;
    expect(Boolean(liveLease && otherLease && liveLease !== otherLease)).toBe(true);
    if (!liveLease || !otherLease) throw new Error("B003 synthetic leases unavailable");
    phase = "OFF behavior";
    await page.goto("/m/settings");
    await expect(page.getByRole("heading", { name: "匯款資訊", exact: true })).toHaveCount(0);
    await chooseLease(page, ACCOUNTS.tenant, liveLease);
    await expect(page.getByTestId("tenant-payee")).toHaveCount(0);
    const legacyLast5 = await db(async client => (await client.query<{ last5: string | null }>(`SELECT b.account_last5::text AS last5 FROM leases l JOIN bank_accounts b ON b.org_id=l.org_id AND b.archived_at IS NULL AND b.show_to_tenants AND (b.property_id IS NULL OR b.property_id=l.property_id) WHERE l.id=$1 ORDER BY b.created_at,b.id LIMIT 1`, [liveLease])).rows[0]?.last5);
    expect(Boolean(legacyLast5)).toBe(true);
    await expect(page.getByText(`匯入帳戶末五碼 ${legacyLast5}`, { exact: true })).toBeVisible();
    expect(noNumbers(await page.locator("body").innerText()) && noNumbers(await page.content())).toBe(true);
    await page.screenshot({ path: info.outputPath(`off-${width}.png`), fullPage: true });
    phase = "enabled missing account";
    await signIn(page, ACCOUNTS.admin);
    await db(async client => {
      const initial = (await client.query<{ assigned: boolean; n: number }>(`SELECT l.payee_bank_account_id IS NOT NULL AS assigned,(SELECT count(*)::int FROM bank_accounts b WHERE b.org_id=l.org_id AND b.archived_at IS NULL AND b.show_to_tenants AND (b.property_id IS NULL OR b.property_id=l.property_id) AND b.is_default_payee AND b.owner_contact_id IS NULL) AS n FROM leases l WHERE l.id=$1 AND l.org_id=$2`, [liveLease, ORG_ID])).rows;
      expect(initial.length === 1 && initial[0].assigned === false && initial[0].n === 0).toBe(true);
      await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='payee_details'`, [ORG_ID, sandboxId]);
      await client.query(`UPDATE organizations SET feature_flags=feature_flags||'{"payee_details":true}'::jsonb WHERE id=ANY($1::uuid[])`, [[ORG_ID, sandboxId]]);
    });
    await chooseLease(page, ACCOUNTS.tenant, liveLease);
    await expect(page.getByText("匯款資訊尚未設定，請聯絡管理公司", { exact: true })).toBeVisible();
    await expect(page.getByText(`匯入帳戶末五碼 ${legacyLast5}`, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("tenant-payee")).toHaveCount(0);
    await expect(page.locator(".fn")).toContainText("不經手任何款項");
    expect(noNumbers(await page.locator("body").innerText()) && noNumbers(await page.content())).toBe(true);
    const missingCursor = await auditCursor();
    const missing = await local(page.request, `/api/payee/${liveLease}`);
    expect(missing.status()).toBe(200);
    const missingBody = await missing.json();
    expect(missingBody.ok === true && missingBody.data?.enabled === true && missingBody.data?.last5 === null && missingBody.data?.account === null).toBe(true);
    const missingAudit = await auditAfter(missingCursor, "tenant");
    expect(missingAudit.length === 1 && missingAudit[0].actor_id === USERS.tenant && missingAudit[0].org_id === ORG_ID && missingAudit[0].target_id === liveLease && missingAudit[0].outcome === "missing" && missingAudit[0].reason === "ok" && noNumbers(missingAudit[0].body)).toBe(true);
    await page.screenshot({ path: info.outputPath(`missing-${width}.png`), fullPage: true });
    phase = "company default and owner assignment";
    await signIn(page, ACCOUNTS.admin);
    await page.goto("/m/settings");
    await saveAccount(page, "合成公司戶名", companyNumber, true, ORG_ID);
    await page.screenshot({ path: info.outputPath(`settings-${width}.png`), fullPage: true });
    await chooseLease(page, ACCOUNTS.tenant, liveLease);
    await expect(page.getByTestId("tenant-payee")).toContainText(companyNumber);
    await expect(page.getByTestId("tenant-payee")).toContainText("合成公司戶名");
    await expect(page.getByTestId("tenant-payee")).toContainText("合成測試銀行");
    await expect(page.locator(".fn")).toContainText("不經手任何款項");
    const companyCursor = await auditCursor();
    const companyResponse = await local(page.request, `/api/payee/${liveLease}`);
    expect(companyResponse.status()).toBe(200);
    expect(companyResponse.headers()["cache-control"]).toBe("private, no-store");
    expect(companyResponse.headers()["x-content-type-options"]).toBe("nosniff");
    const companyBody = await companyResponse.json();
    expect(companyBody.data.account.account_number === companyNumber && companyBody.data.account.holder_name === "合成公司戶名" && companyBody.data.account.bank_name === "合成測試銀行").toBe(true);
    const companyAudit = await auditAfter(companyCursor, "tenant");
    expect(companyAudit.length === 1 && companyAudit[0].actor_id === USERS.tenant && companyAudit[0].org_id === ORG_ID && companyAudit[0].target_id === liveLease && companyAudit[0].outcome === "allowed" && companyAudit[0].reason === "ok" && noNumbers(companyAudit[0].body)).toBe(true);
    const invalidCursor = await auditCursor();
    const invalid = await local(page.request, "/api/payee/00000000-0000-4000-8000-000000000000");
    expect(invalid.status()).toBe(403);
    expect(invalid.headers()["cache-control"]).toBe("private, no-store");
    expect(invalid.headers()["x-content-type-options"]).toBe("nosniff");
    const invalidBody = await invalid.json();
    expect(invalidBody.ok === false && Object.keys(invalidBody).length === 1 && noNumbers(JSON.stringify(invalidBody))).toBe(true);
    const invalidAudit = await auditAfter(invalidCursor, "tenant");
    expect(invalidAudit.length === 1 && invalidAudit[0].actor_id === USERS.tenant && invalidAudit[0].org_id === ORG_ID && invalidAudit[0].outcome === "denied" && noNumbers(invalidAudit[0].body)).toBe(true);
    await signIn(page, ACCOUNTS.admin);
    await page.goto("/m/settings");
    const ownerId = await db(async client => (await client.query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id=$1 AND is_owner AND archived_at IS NULL ORDER BY id LIMIT 1`, [ORG_ID])).rows[0]?.id);
    expect(Boolean(ownerId)).toBe(true);
    if (!ownerId) throw new Error("B003 synthetic owner unavailable");
    await saveAccount(page, "合成屋主戶名", ownerNumber, false, ORG_ID, ownerId);
    const assignment = page.locator("form").filter({ has: page.locator(`input[name="leaseId"][value="${liveLease}"]`) });
    await expect(assignment).toHaveCount(1);
    const selected = await assignment.locator('select[name="accountId"]').selectOption({ label: "屋主帳戶: 合成屋主戶名" });
    expect(selected.length).toBe(1);
    const assignCursor = await auditCursor();
    await assignment.getByRole("button", { name: "指定匯款帳戶", exact: true }).click();
    await expect.poll(async () => db(async client => (await client.query<{ id: string | null }>(`SELECT payee_bank_account_id::text AS id FROM leases WHERE id=$1 AND org_id=$2`, [liveLease, ORG_ID])).rows[0]?.id === selected[0])).toBe(true);
    await expect(page).toHaveURL(/\/m\/settings\?saved=1/);
    const assignAudit = await auditAfter(assignCursor, "assign");
    expect(assignAudit.length === 1 && assignAudit[0].actor_id === USERS.admin && assignAudit[0].org_id === ORG_ID && assignAudit[0].target_id === liveLease && assignAudit[0].outcome === "allowed" && assignAudit[0].reason === "ok" && noNumbers(assignAudit[0].body)).toBe(true);
    await chooseLease(page, ACCOUNTS.tenant, liveLease);
    await expect(page.getByTestId("tenant-payee")).toContainText(ownerNumber);
    await expect(page.getByTestId("tenant-payee")).toContainText("合成屋主戶名");
    await expect(page.getByTestId("tenant-payee")).toContainText("合成測試銀行");
    await expect(page.getByTestId("tenant-payee")).not.toContainText(companyNumber);
    await expect(page.locator(".fn")).toContainText("不經手任何款項");
    const ownerCursor = await auditCursor();
    const ownerResponse = await local(page.request, `/api/payee/${liveLease}`);
    expect(ownerResponse.status()).toBe(200);
    const ownerBody = await ownerResponse.json();
    expect(ownerBody.data.account.account_number === ownerNumber && ownerBody.data.account.holder_name === "合成屋主戶名" && ownerBody.data.account.bank_name === "合成測試銀行").toBe(true);
    const ownerAudit = await auditAfter(ownerCursor, "tenant");
    expect(ownerAudit.length === 1 && ownerAudit[0].actor_id === USERS.tenant && ownerAudit[0].org_id === ORG_ID && ownerAudit[0].target_id === liveLease && ownerAudit[0].outcome === "allowed" && ownerAudit[0].reason === "ok" && noNumbers(ownerAudit[0].body)).toBe(true);
    await page.screenshot({ path: info.outputPath(`owner-${width}.png`), fullPage: true });
    phase = "other tenant denial";
    await chooseLease(page, ACCOUNTS.tenant2, otherLease, USERS.tenant2);
    await expect(page.getByTestId("tenant-payee")).toContainText(companyNumber);
    await expect(page.getByTestId("tenant-payee")).toContainText("合成公司戶名");
    await expect(page.getByTestId("tenant-payee")).toContainText("合成測試銀行");
    expect(!(await page.locator("body").innerText()).includes(ownerNumber) && !(await page.content()).includes(ownerNumber)).toBe(true);
    const deniedCursor = await auditCursor();
    const denied = await local(page.request, `/api/payee/${liveLease}`);
    expect(denied.status()).toBe(403);
    expect(denied.headers()["cache-control"]).toBe("private, no-store");
    expect(denied.headers()["x-content-type-options"]).toBe("nosniff");
    const deniedBody = await denied.json();
    expect(deniedBody.ok === false && Object.keys(deniedBody).length === 1 && noNumbers(JSON.stringify(deniedBody))).toBe(true);
    const deniedAudit = await auditAfter(deniedCursor, "tenant");
    expect(deniedAudit.length === 1 && deniedAudit[0].actor_id === USERS.tenant2 && deniedAudit[0].org_id === ORG_ID && deniedAudit[0].target_id === liveLease && deniedAudit[0].outcome === "denied" && deniedAudit[0].reason === "forbidden" && noNumbers(deniedAudit[0].body)).toBe(true);
    phase = "sandbox and live isolation";
    await signIn(page, ACCOUNTS.admin);
    await page.goto("/api/env?set=sandbox&next=/m");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    const sandboxLease = await db(async client => {
      const property = randomUUID(), unit = randomUUID(), contact = randomUUID(), lease = randomUUID();
      await client.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'B003 synthetic sandbox','TW','TWD','Asia/Taipei')`, [property, sandboxId]);
      await client.query(`INSERT INTO units(id,org_id,property_id,label) VALUES($1,$2,$3,'B003')`, [unit, sandboxId, property]);
      await client.query(`INSERT INTO contacts(id,org_id,user_id,is_tenant,display_name) VALUES($1,$2,$3,true,'B003 synthetic tenant')`, [contact, sandboxId, USERS.tenant]);
      await client.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,status,esign_status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,$4,'active','fully_signed',current_date-1,current_date+365,'TWD',0)`, [lease, sandboxId, property, unit]);
      await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [sandboxId, lease, contact]);
      return lease;
    });
    await page.goto("/m/settings");
    await saveAccount(page, "合成沙盒戶名", sandboxNumber, true, sandboxId!);
    await chooseLease(page, ACCOUNTS.tenant, sandboxLease);
    await expect(page.getByTestId("tenant-payee")).toContainText(sandboxNumber);
    await expect(page.getByTestId("tenant-payee")).toContainText("合成沙盒戶名");
    await expect(page.getByTestId("tenant-payee")).toContainText("合成測試銀行");
    await expect(page.getByTestId("tenant-payee")).not.toContainText(ownerNumber);
    expect(!(await page.content()).includes(ownerNumber)).toBe(true);
    const sandboxCursor = await auditCursor();
    const sandboxResponse = await local(page.request, `/api/payee/${sandboxLease}`);
    expect(sandboxResponse.status()).toBe(200);
    const sandboxBody = await sandboxResponse.json();
    expect(sandboxBody.data.account.account_number === sandboxNumber && sandboxBody.data.account.holder_name === "合成沙盒戶名" && sandboxBody.data.account.bank_name === "合成測試銀行").toBe(true);
    const sandboxAudit = await auditAfter(sandboxCursor, "tenant");
    expect(sandboxAudit.length === 1 && sandboxAudit[0].actor_id === USERS.tenant && sandboxAudit[0].org_id === sandboxId && sandboxAudit[0].environment === "sandbox" && sandboxAudit[0].target_id === sandboxLease && sandboxAudit[0].outcome === "allowed" && sandboxAudit[0].reason === "ok" && noNumbers(sandboxAudit[0].body)).toBe(true);
    const crossCursor = await auditCursor();
    const cross = await local(page.request, `/api/payee/${liveLease}`);
    expect(cross.status()).toBe(403);
    expect(cross.headers()["cache-control"]).toBe("private, no-store");
    expect(cross.headers()["x-content-type-options"]).toBe("nosniff");
    const crossBody = await cross.json();
    expect(crossBody.ok === false && Object.keys(crossBody).length === 1 && noNumbers(JSON.stringify(crossBody))).toBe(true);
    const crossAudit = await auditAfter(crossCursor, "tenant");
    expect(crossAudit.length === 1 && crossAudit[0].actor_id === USERS.tenant && crossAudit[0].org_id === sandboxId && crossAudit[0].environment === "sandbox" && crossAudit[0].target_id === liveLease && crossAudit[0].outcome === "denied" && crossAudit[0].reason === "forbidden" && noNumbers(crossAudit[0].body)).toBe(true);
    await page.screenshot({ path: info.outputPath(`sandbox-${width}.png`), fullPage: true });
    await chooseLease(page, ACCOUNTS.tenant, liveLease);
    await expect(page.getByTestId("tenant-payee")).toContainText(ownerNumber);
    await expect(page.getByTestId("tenant-payee")).not.toContainText(sandboxNumber);
    expect(!(await page.content()).includes(sandboxNumber)).toBe(true);
    const auditText = await db(async client => (await client.query<{ data: string }>(`SELECT row_to_json(a)::text AS data FROM app.payee_access_log a WHERE org_id=ANY($1::uuid[])`, [[ORG_ID, sandboxId]])).rows);
    expect(auditText.every(row => noNumbers(row.data))).toBe(true);
    expect(errors.length).toBe(0);
  } catch (error) {
    const code = error instanceof SafeDbError ? error.sqlstate : null;
    failed = `${phase}${code ? ` (SQLSTATE ${code})` : ""}`;
  } finally {
    if (eligible) try {
      await db(async client => {
        await client.query("BEGIN");
        try {
          // DELETE + INSERT preserves the exact timestamp without disabling
          // the normal BEFORE UPDATE timestamp trigger on this isolated clone.
          await client.query(`DELETE FROM platform_settings WHERE key='payee_details'`);
          if (control) await client.query(`INSERT INTO platform_settings(key,value,description,updated_at) VALUES('payee_details',$1::jsonb,$2,$3::timestamptz)`, [JSON.stringify(control.value), control.description, control.updated_at]);
          for (const row of flags) await client.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`, [row.id, JSON.stringify(row.feature_flags)]);
          const restored = (await client.query<{ value: unknown; description: string | null; updated_at: string }>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='payee_details'`)).rows[0];
          const restoredFlags = (await client.query<{ id: string; feature_flags: unknown }>(`SELECT id::text,feature_flags FROM organizations WHERE id=ANY($1::uuid[]) ORDER BY id`, [flags.map(row => row.id)])).rows;
          if (JSON.stringify(restored ?? null) !== JSON.stringify(control ?? null) || JSON.stringify(restoredFlags) !== JSON.stringify(flags)) throw new Error("B003 restoration failed");
          await client.query("COMMIT");
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch { /* report the original restoration failure */ }
          throw error;
        }
      });
    } catch { restoreFailed = true; }
  }
  if (failed || restoreFailed) throw new Error(`B003 local proof failed${failed ? ` during ${failed}` : ""}${restoreFailed ? "; control restoration failed" : ""}`);
});

test("explicit payee HTTP attempts audit unauthenticated and verified no-org identity", async ({ page }, info) => {
  privateGuard(info);
  const errors: string[] = [];
  await installFence(page, errors);
  let phase = "anonymous ingress";
  let user: string | null = null;
  let failed: string | null = null, cleanupFailed = false;
  try {
    const before = await auditCursor();
    const anonymous = await local(page.request, "/api/payee/00000000-0000-4000-8000-000000000000");
    expect(anonymous.status()).toBe(401);
    const anonymousRows = await auditAfter(before, "ingress");
    expect(anonymousRows.length === 1 && anonymousRows[0].actor_id === null && anonymousRows[0].org_id === null && anonymousRows[0].reason === "unauthenticated" && noNumbers(anonymousRows[0].body)).toBe(true);
    phase = "no-context ingress";
    user = randomUUID();
    const token = randomBytes(32).toString("hex");
    await db(async client => {
      await client.query(`INSERT INTO auth.users(id,email) VALUES($1,$2)`, [user, `${user}@no-org.example.test`]);
      await client.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')`, [user, createHash("sha256").update(token).digest("hex")]);
    });
    await page.context().addCookies([{ name: SESSION_COOKIE, value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const cursor = await auditCursor();
    const response = await local(page.request, "/api/payee/00000000-0000-4000-8000-000000000000", { userId: USERS.admin, orgId: ORG_ID });
    expect(response.status()).toBe(401);
    expect(noNumbers(await response.text())).toBe(true);
    const rows = await auditAfter(cursor, "ingress");
    expect(rows.length === 1 && rows[0].actor_id === user && rows[0].org_id === null && rows[0].reason === "no_context" && noNumbers(rows[0].body)).toBe(true);
    expect(errors.length).toBe(0);
  } catch { failed = phase; }
  finally {
    if (user) try { await db(async client => { await client.query(`DELETE FROM auth.users WHERE id=$1`, [user]); }); }
    catch { cleanupFailed = true; }
  }
  if (failed || cleanupFailed) throw new Error(`B003 local proof failed${failed ? ` during ${failed}` : ""}${cleanupFailed ? "; synthetic user cleanup failed" : ""}`);
});
