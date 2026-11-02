import { expect, test, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ORG_ID, USERS } from "../src/server/ids";
import { ACCOUNTS, signIn } from "./session";

const url = disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
const database = decodeURIComponent(url.pathname.slice(1));
const origin = "http://127.0.0.1:43140";
if (process.env.DEMO_MODE !== "true" || !/^condola_b009_[a-z0-9_]+$/.test(database) || process.env.B009_OWNED_DATABASE !== database) throw new Error("Owned local B009 browser database required");
type Control = {value:unknown;description:string|null;updated_at:string};
function guard(info: TestInfo) {
  if (!info.config.configFile?.endsWith("/e2e/b009-bank-private-playwright.config.ts") || info.project.use.trace !== "off" || info.project.use.video !== "off" || info.project.use.screenshot !== "off" || info.config.reporter.length !== 1 || info.config.reporter[0][0] !== "line" || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1" || process.env.B009_PRIVATE_HTTP_CONFIG !== "1") throw new Error("B009 private configuration required");
}
for (const width of [390,1280]) test(`manual bank reconciliation at ${width}px`,async ({page},info) => {
  guard(info);
  await page.setViewportSize({width,height:900});
  const errors:string[]=[];
  page.on("pageerror",()=>errors.push("page error"));
  page.on("console",m=>{if (m.type()==="error") errors.push("console error");});
  page.on("response",r=>{if (r.status()>=500) errors.push("server error");});
  await page.context().route("**/*", async route => {
    try { if (new URL(route.request().url()).origin === origin) { await route.continue(); return; } } catch { /* reject malformed origin */ }
    errors.push("off-origin request"); await route.abort();
  });
  const db=new Client({connectionString:url.href});
  let saved:{control:Control|undefined;flags:unknown}|undefined, primary:string|undefined, restoration=false;
  let phase="setup";
  try {
    await db.connect();
    await signIn(page,ACCOUNTS.admin);
    phase="reset";
    const reset=await page.request.post(`${origin}/api/demo/reset`,{data:{},maxRedirects:0});
    expect(new URL(reset.url()).origin===origin && reset.status()===200).toBe(true);
    await signIn(page,ACCOUNTS.admin);
    phase="baseline";
    const control=(await db.query<Control>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='bank_matching'`)).rows[0];
    const orgs=(await db.query<{feature_flags:Record<string,unknown>}>(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows;
    const value=control?.value as {enabled?:unknown;allowed_org_ids?:unknown}|undefined;
    expect((!control || (!!value && typeof value==='object' && !Array.isArray(value) && value.enabled===false && Array.isArray(value.allowed_org_ids))) && orgs.length===1 && orgs[0].feature_flags.bank_matching!==true).toBe(true);
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND confrelid='public.platform_settings'::regclass`)).rows[0].n).toBe(0);
    saved={control,flags:orgs[0].feature_flags};
    const fixture = randomUUID();
    phase="OFF";
    await db.query(`INSERT INTO platform_settings(key,value) VALUES ('bank_matching','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
    await page.goto("/m/bank"); await expect(page.getByTestId("bank-matching")).toHaveCount(0);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"bank_matching":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='bank_matching'`,[ORG_ID]);
    phase="fixture";
    const account=(await db.query<{id:string;currency:string}>(`SELECT id::text,currency FROM bank_accounts WHERE org_id=$1 AND archived_at IS NULL AND property_id IS NULL ORDER BY created_at,id LIMIT 1`,[ORG_ID])).rows[0]; expect(account).toBeTruthy();
    const property=(await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,'B009 browser','TW',$2,'Asia/Taipei') RETURNING id::text`,[ORG_ID,account.currency])).rows[0].id;
    const unit=(await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'B009') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
    const lease=(await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active','2026-01-01',$4,0) RETURNING id::text`,[ORG_ID,property,unit,account.currency])).rows[0].id;
    await db.query(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor) VALUES ($1,$2,$3,$5,$4,current_date,'open',76500)`,[ORG_ID,property,lease,account.currency,`B009-${fixture}`]);
    const payment=(await db.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,payer_account_last5,method,status,source,submitted_by) VALUES ($1,$2,$3,$4,76500,'2026-01-01','01234','bank_transfer','submitted','tenant_portal',$5) RETURNING id::text`,[ORG_ID,property,lease,account.currency,USERS.admin])).rows[0].id;
    const fallbackPayment=(await db.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES ($1,$2,$3,$4,1100,'2026-01-01','bank_transfer','submitted','tenant_portal',$5) RETURNING id::text`,[ORG_ID,property,lease,account.currency,USERS.admin])).rows[0].id;
    await page.goto("/m/bank"); const card=page.getByTestId("bank-matching"); await expect(card).toBeVisible();
    const upload=card.locator('form').first(); await upload.locator('select[name="account"]').selectOption(account.id);
    const file={name:"synthetic.csv",mimeType:"text/csv",buffer:Buffer.from(`date,amount,last5,memo\n2026-01-03,765.00,01234,B009 browser ${fixture}\n2026-01-03,11.00,,B009 fallback ${fixture}`)};
    phase="import";
    await upload.locator('input[type="file"]').setInputFiles(file); await upload.getByRole("button",{name:"匯入"}).click();
    const line=page.getByTestId("bank-line").filter({hasText:`B009 browser ${fixture}`}); await expect(line).toBeVisible();
    await expect(line).toContainText("配對建議");
    phase="dedupe";
    await upload.locator('select[name="account"]').selectOption(account.id); await upload.locator('input[type="file"]').setInputFiles(file); await upload.getByRole("button",{name:"匯入"}).click();
    await expect(page.getByTestId("bank-line").filter({hasText:`B009 browser ${fixture}`})).toHaveCount(1);
    phase="history";
    // Current payment/bank details diverge; display must retain the saved basis.
    await db.query(`UPDATE payments SET payer_account_last5='99999',paid_on='2026-01-20' WHERE id=$1`,[payment]);
    await db.query(`UPDATE bank_transactions SET counterparty_account_last5='54321' WHERE id IN (SELECT bank_transaction_id FROM bank_match_suggestions WHERE payment_id=$1)`,[payment]);
    await db.query(`UPDATE bank_match_suggestions SET reasons='{"private":"B009-private-raw-marker","amount_exact":"true","last5":12345,"date_delta_days":-1}'::jsonb WHERE payment_id=$1`,[fallbackPayment]);
    const fallback=page.getByTestId("bank-line").filter({hasText:`B009 fallback ${fixture}`});
    for (const locale of ["en","zh-TW"]) {
      phase=locale==="en" ? "en" : "zh";
      await page.goto(`/api/demo/locale?set=${locale}&next=%2Fm%2Fbank`);
      const basis=line.getByTestId("bank-suggestion-basis");
      await expect(basis).toContainText(locale==="en" ? "Basis when suggestion was created" : "建立建議時的依據");
      await expect(basis).toContainText(locale==="en" ? "Amount matched" : "金額相符");
      await expect(basis).toContainText(locale==="en" ? "Account last five digits matched" : "帳號末五碼相符");
      await expect(basis).toContainText(locale==="en" ? "Date gap: 2 days" : "日期相差 2 天");
      await expect(fallback.getByTestId("bank-suggestion-basis")).toContainText(locale==="en" ? "Stored basis unavailable" : "沒有可顯示的已儲存依據");
      const html=await page.content(); expect(!html.includes("B009-private-raw-marker") && !html.includes("01234")).toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
      await page.evaluate(()=>new Promise<void>(resolve=>{
        window.scrollTo(0,0);
        requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()));
      }));
      await page.screenshot({path:info.outputPath(`bank-basis-${locale}-${width}.png`),fullPage:true});
    }
    phase="reject";
    const suggestion=line.locator("form").filter({hasText:"配對建議"}); await suggestion.locator('input[name="reason"]').fill("Synthetic rejection"); await suggestion.getByRole("button",{name:"拒絕建議"}).click();
    await expect(line).not.toContainText("配對建議");
    phase="manual";
    const manual=line.locator("form").filter({hasText:"手動選擇"}); await manual.locator('select[name="paymentId"]').selectOption(payment); await manual.locator('input[name="reason"]').fill("Synthetic match");
    await manual.getByRole("button",{name:"配對款項"}).click(); await expect(line).toHaveCount(0);
    phase="readback";
    const checks=(await db.query(`SELECT (SELECT count(*)::int FROM app.b009_decisions WHERE org_id=$1 AND actor_id=$2 AND payment_id=$3 AND decision='match' AND reason='Synthetic match') AS matched,(SELECT count(*)::int FROM app.b009_decisions WHERE org_id=$1 AND actor_id=$2 AND payment_id=$3 AND decision='reject' AND reason='Synthetic rejection') AS rejected,(SELECT count(*)::int FROM payment_allocations WHERE payment_id=$3) AS allocations`,[ORG_ID,USERS.admin,payment])).rows[0];
    expect(checks).toEqual({matched:1,rejected:1,allocations:1}); expect(errors).toEqual([]);
  } catch { primary=phase; }
  if (saved) {
    try {
      await db.query("BEGIN");
      await db.query(`DELETE FROM platform_settings WHERE key='bank_matching'`);
      if (saved.control) await db.query(`INSERT INTO platform_settings(key,value,description,updated_at) VALUES ('bank_matching',$1::jsonb,$2,$3::timestamptz)`,[JSON.stringify(saved.control.value),saved.control.description,saved.control.updated_at]);
      await db.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,[ORG_ID,JSON.stringify(saved.flags)]);
      const controls=(await db.query<Control>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='bank_matching'`)).rows;
      const flags=(await db.query(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows;
      expect(JSON.stringify(controls)===JSON.stringify(saved.control ? [saved.control] : []) && flags.length===1 && JSON.stringify(flags[0].feature_flags)===JSON.stringify(saved.flags)).toBe(true);
      await db.query("COMMIT");
    } catch { restoration=true; try { await db.query("ROLLBACK"); } catch { /* retain restoration failure */ } }
  }
  try { await db.end(); } catch { restoration=true; }
  if (primary || restoration) {
    const categories=["page error","console error","server error","off-origin request"].map(category=>`${category}: ${errors.filter(item=>item===category).length}`).join(", ");
    throw new Error([primary ? `B009 local journey failed at ${primary}` : "",restoration ? "B009 control restoration failed" : "",categories].filter(Boolean).join("; "));
  }
});
