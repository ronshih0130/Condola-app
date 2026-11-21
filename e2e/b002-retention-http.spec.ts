import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decode as decodeJpeg } from "jpeg-js";
import { expect, request as playwrightRequest, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { acceptUploadBytes, decryptBytes, ENCRYPTION_KEY_REF, signPhotoToken } from "../src/server/id-crypto";
import { storeIdPhoto } from "../src/server/id-docs";
import { embedIdWatermarkMark } from "../src/lib/jpeg-size";
import { SAMPLE_JPEG_BASE64 } from "../src/lib/idv";
import type { Session } from "../src/server/types";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { ACCOUNTS, signIn } from "./session";

const ORIGIN = "http://127.0.0.1:43133";
const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
// Same private-config predicate as before: the dedicated local run must have
// DEMO_MODE / B002_PRIVATE_HTTP_CONFIG / a real CRON_SECRET / the ID_DOC_* keys.
const privateConfigMissing =
  process.env.DEMO_MODE !== "true" || process.env.B002_PRIVATE_HTTP_CONFIG !== "1" ||
  !process.env.CRON_SECRET || ["demo-cron", "not-the-local-cron-secret"].includes(process.env.CRON_SECRET) ||
  !process.env.ID_DOC_ENCRYPTION_KEY || !process.env.ID_DOC_HMAC_KEY || !process.env.ID_DOC_SIGNING_SECRET;
// ci-shadow is the self-hosted runner with no B002 private config. Match it by
// the exact workflow name only; hosted ubuntu CI never matches this string.
const underCiShadow = process.env.GITHUB_WORKFLOW === "CI shadow (self-hosted)";
if (privateConfigMissing) {
  if (underCiShadow) {
    // Explicit, report-visible skip instead of a module-load throw: this spec
    // needs the dedicated local private B002 config, which is absent here.
    test.skip(true, "B002 needs the dedicated local private B002 configuration, which is not present on the ci-shadow runner");
  } else {
    throw new Error("B002 requires the dedicated local private test configuration");
  }
}

class SafeDbError extends Error {
  constructor(readonly sqlstate: string | null) { super("B002 local database operation failed"); }
}
async function db<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  try { await client.connect(); return await fn(client); }
  catch (error) {
    const value = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
    throw new SafeDbError(typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) ? value : null);
  } finally { try { await client.end(); } catch { /* preserve the primary operation result */ } }
}

// APIRequestContext does not pass through page.route. All requests are built
// from this fixed origin and never follow a redirect, including error paths.
async function local(api: APIRequestContext, path: string, options: { method?: "GET" | "POST"; secret?: string } = {}): Promise<APIResponse> {
  const target = new URL(path, ORIGIN);
  if (target.origin !== ORIGIN) throw new Error("B002 local request rejected");
  try {
    return await api.fetch(target.href, { method: options.method ?? "GET", headers: options.secret ? { "x-cron-secret": options.secret } : {}, maxRedirects: 0, timeout: 15_000 });
  } catch { throw new Error("B002 local HTTP request failed"); }
}
async function photo(api: APIRequestContext, token: string) {
  return local(api, `/api/id-documents/photo?token=${encodeURIComponent(token)}`);
}
async function denied(response: APIResponse) {
  expect(response.status()).toBe(404);
  expect((await response.body()).byteLength).toBe(0);
}
async function storedState() {
  const state = await db(async client => (await client.query<{ value: unknown }>(`SELECT jsonb_build_object(
    'docs', (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM identity_documents d),
    'photos', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM identity_document_photos p),
    'originals', (SELECT coalesce(jsonb_agg(jsonb_build_array(o.bucket,o.path,o.byte_size,encode(sha256(o.ciphertext),'hex')) ORDER BY o.bucket,o.path),'[]'::jsonb) FROM id_document_objects o),
    'watermarks', (SELECT coalesce(jsonb_agg(jsonb_build_array(w.bucket,w.path,w.byte_size,encode(sha256(w.ciphertext),'hex')) ORDER BY w.bucket,w.path),'[]'::jsonb) FROM id_document_wm_objects w),
    'slots', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.user_id,s.lease_id,s.slot),'[]'::jsonb) FROM id_upload_slots s)
  ) AS value`)).rows[0].value);
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
async function downloadAudits(documentId: string) {
  return db(async client => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM identity_document_access_log WHERE document_id=$1 AND purpose='download'`, [documentId])).rows[0].n);
}
async function summaryCount() {
  return db(async client => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE event_type='id_purge_run'`)).rows[0].n);
}

test("private photo lifecycle and OFF/dry-run scheduler are non-destructive", async ({ page }, info) => {
  if (!info.config.configFile?.endsWith("/e2e/b002-retention-http-playwright.config.ts") || info.project.use.trace !== "off" || info.project.use.video !== "off" || info.project.use.screenshot !== "off" || info.config.reporter.length !== 1 || info.config.reporter[0][0] !== "line") {
    throw new Error("B002 private test must use its dedicated configuration");
  }
  let phase = "setup";
  let savedMode: { value: unknown; description: string | null; updated_at: string } | undefined;
  let mayRestoreOff = false;
  let primaryFailure: string | null = null;
  let restoreFailed = false;
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", message => { if (message.type() === "error") errors.push("console error"); });
  page.on("response", response => { if (response.status() >= 500) errors.push("server error"); });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN) await route.continue();
    else { errors.push("off-origin browser request"); await route.abort(); }
  });
  try {
    phase = "read initial mode";
    savedMode = await db(async client => (await client.query<{ value: unknown; description: string | null; updated_at: string }>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='ID_PURGE_ENABLED'`)).rows[0]);
    phase = "validate initial mode";
    expect(savedMode === undefined || savedMode.value === "off").toBe(true);
    mayRestoreOff = true;
    phase = "establish local OFF mode";
    await db(async client => { await client.query(`INSERT INTO platform_settings(key,value) VALUES('ID_PURGE_ENABLED','"off"'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`); });
    phase = "first admin login";
    await signIn(page, ACCOUNTS.admin);
    phase = "demo reset";
    const reset = await local(page.request, "/api/demo/reset", { method: "POST" });
    expect(reset.status()).toBe(200);
    phase = "second admin login";
    await signIn(page, ACCOUNTS.admin);
    // Prepare the actual linked sandbox before the no-mutation baselines;
    // later environment-switch denial must not seed unrelated sample rows.
    phase = "initial sandbox selection";
    await page.goto("/api/env?set=sandbox&next=/m");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    phase = "initial live selection";
    await page.goto("/api/env?set=live&next=/m");
    async function createFixture(pending = false) { return db(async client => {
      const property = randomUUID(), unit = randomUUID(), lease = randomUUID(), contact = randomUUID();
      phase = "fixture property";
      await client.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'B002 synthetic','TW','TWD','Asia/Taipei')`, [property, ORG_ID]);
      phase = "fixture unit";
      await client.query(`INSERT INTO units(id,org_id,property_id,label) VALUES($1,$2,$3,'B002')`, [unit, ORG_ID, property]);
      phase = "fixture contact";
      await client.query(`INSERT INTO contacts(id,org_id,is_tenant,display_name) VALUES($1,$2,true,'B002 synthetic tenant')`, [contact, ORG_ID]);
      phase = "fixture lease";
      await client.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,status,esign_status,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor,created_by)
        VALUES($1,$2,$3,$4,$4,$6::lease_status,$7::esign_status,(timezone('Asia/Taipei',now()))::date-500,(timezone('Asia/Taipei',now()))::date+120,'TWD',0,0,$5)`, [lease, ORG_ID, property, unit, USERS.admin, pending ? 'pending_signature' : 'active', pending ? 'not_sent' : 'fully_signed']);
      phase = "fixture party";
      await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [ORG_ID, lease, contact]);
      phase = "fixture provenance";
      const origin = (await client.query<{ known: boolean }>(`SELECT id_retention_auto_end IS FALSE AS known FROM leases WHERE id=$1`, [lease])).rows[0];
      expect(origin.known).toBe(true);
      return { lease, contact };
    }); }
    const fixture = await createFixture();
    const expiredFixture = await createFixture();
    phase = "synthetic photo setup";
    for (const item of [fixture, expiredFixture]) {
      let upload: APIResponse;
      try { upload = await page.request.post(`${ORIGIN}/api/demo/id-sample`, { data: { leaseId: item.lease }, maxRedirects: 0, timeout: 15_000 }); }
      catch { throw new Error("B002 local upload request failed"); }
      expect(upload.status()).toBe(200);
    }
    const expiredDocument = await db(async client => {
      await client.query(`UPDATE leases SET end_date=(timezone('Asia/Taipei',now()))::date-120 WHERE id=$1 AND org_id=$2`, [expiredFixture.lease, ORG_ID]);
      return (await client.query<{ id: string; eligible: boolean }>(`SELECT d.id::text,l.id_retention_auto_end IS FALSE AND l.start_date<l.end_date AND public.id_document_delete_after(d.lease_id,d.org_id,d.created_at)<=(timezone('Asia/Taipei',now()))::date AS eligible FROM identity_documents d JOIN leases l ON l.id=d.lease_id WHERE d.org_id=$1 AND d.lease_id=$2 AND d.contact_id=$3 AND d.deleted_at IS NULL`, [ORG_ID, expiredFixture.lease, expiredFixture.contact])).rows;
    });
    expect(expiredDocument.length).toBe(1);
    expect(expiredDocument[0].eligible).toBe(true);
    const document = await db(async client => (await client.query<{ id: string; future: boolean }>(`SELECT d.id::text,public.id_document_delete_after(d.lease_id,d.org_id,d.created_at)>(timezone('Asia/Taipei',now()))::date AS future FROM identity_documents d WHERE d.org_id=$1 AND d.lease_id=$2 AND d.contact_id=$3 AND d.deleted_at IS NULL`, [ORG_ID, fixture.lease, fixture.contact])).rows);
    expect(document.length).toBe(1);
    expect(document[0].future).toBe(true);
    const material = await db(async client => (await client.query<{ photos: number; originals: number; watermarks: number }>(`SELECT count(*)::int AS photos,count(o.path)::int AS originals,count(w.path)::int AS watermarks FROM identity_document_photos p LEFT JOIN id_document_objects o ON o.bucket=p.storage_bucket AND o.path=p.storage_path LEFT JOIN id_document_wm_objects w ON w.bucket=p.storage_bucket AND w.path=p.storage_path||'.wm' WHERE p.document_id=$1`, [document[0].id])).rows[0]);
    expect(material.photos === 3 && material.originals === 3 && material.watermarks === 3).toBe(true);
    const validUntil = Date.now() + 10 * 60_000;
    const validToken = signPhotoToken({ documentId: document[0].id, slot: "front", userId: USERS.admin, exp: validUntil });
    const expiredToken = signPhotoToken({ documentId: document[0].id, slot: "front", userId: USERS.admin, exp: Date.now() - 60_000 });
    const expiredObjectToken = signPhotoToken({ documentId: expiredDocument[0].id, slot: "front", userId: USERS.admin, exp: validUntil });
    phase = "positive photo";
    const priorDownloads = await downloadAudits(document[0].id);
    const good = await photo(page.request, validToken);
    expect(good.status()).toBe(200);
    expect(good.headers()["content-type"]).toContain("image/jpeg");
    expect(good.headers()["cache-control"]).toBe("private, no-store");
    expect(good.headers()["x-content-type-options"]).toBe("nosniff");
    const bytes = await good.body();
    expect(bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9).toBe(true);
    const decoded = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 64, maxResolutionInMP: 8 });
    expect(decoded.width > 0 && decoded.height > 0 && decoded.data.length === decoded.width * decoded.height * 4).toBe(true);
    await expect.poll(() => downloadAudits(document[0].id)).toBe(priorDownloads + 1);
    const afterPositive = await storedState();
    const positiveAudit = await downloadAudits(document[0].id);
    const expiredAudit = await downloadAudits(expiredDocument[0].id);
    phase = "photo denials";
    await denied(await photo(page.request, expiredToken));
    await denied(await photo(page.request, expiredObjectToken));
    const anonymous = await playwrightRequest.newContext({ baseURL: ORIGIN });
    try { await denied(await photo(anonymous, expiredToken)); await denied(await photo(anonymous, validToken)); }
    finally { await anonymous.dispose(); }
    // Separate real staff session with no consent; no fabricated consent row.
    const noConsentToken = randomBytes(32).toString("hex");
    const noConsentUser = await db(async client => {
      const user = (await client.query<{ id: string }>(`SELECT app.provision_portal_user($1,'B002 synthetic staff',NULL)::text AS id`, [`b002-${randomUUID()}@example.invalid`])).rows[0].id;
      await client.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'manager','active')`, [ORG_ID, user]);
      await client.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '15 minutes')`, [user, createHash("sha256").update(noConsentToken).digest("hex")]);
      return user;
    });
    const noConsent = await playwrightRequest.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { cookie: `condola_session=${noConsentToken}` } });
    try {
      const result = await photo(noConsent, signPhotoToken({ documentId: document[0].id, slot: "front", userId: noConsentUser, exp: validUntil }));
      expect(result.status()).toBe(403);
      expect((await result.json()).error).toBe("errors.consentRequired");
      expect(result.headers()["cache-control"]).toBe("private, no-store");
    } finally { await noConsent.dispose(); }
    await signIn(page, ACCOUNTS.manager);
    await denied(await photo(page.request, validToken));
    await signIn(page, ACCOUNTS.admin);
    await page.goto("/api/env?set=sandbox&next=/m");
    await expect(page.getByTestId("env-banner")).toBeVisible();
    await denied(await photo(page.request, validToken));
    await page.goto("/api/env?set=live&next=/m");
    expect(JSON.stringify(await storedState()) === JSON.stringify(afterPositive)).toBe(true);
    expect(await downloadAudits(document[0].id)).toBe(positiveAudit);
    expect(await downloadAudits(expiredDocument[0].id)).toBe(expiredAudit);
    // Prove the same link and this exact current session work immediately
    // before the policy change; no auth or environment change follows.
    const goodAgain = await photo(page.request, validToken);
    expect(goodAgain.status()).toBe(200);
    expect(goodAgain.headers()["content-type"]).toContain("image/jpeg");
    expect(goodAgain.headers()["cache-control"]).toBe("private, no-store");
    expect(goodAgain.headers()["x-content-type-options"]).toBe("nosniff");
    const decodedAgain = decodeJpeg(await goodAgain.body(), { useTArray: true, maxMemoryUsageInMB: 64, maxResolutionInMP: 8 });
    expect(decodedAgain.width > 0 && decodedAgain.height > 0 && decodedAgain.data.length === decodedAgain.width * decodedAgain.height * 4).toBe(true);
    await expect.poll(() => downloadAudits(document[0].id)).toBe(positiveAudit + 1);
    expect(JSON.stringify(await storedState()) === JSON.stringify(afterPositive)).toBe(true);
    phase = "retention date change";
    const dateFacts = await db(async client => {
      await client.query(`UPDATE leases SET end_date=(timezone('Asia/Taipei',now()))::date-120 WHERE id=$1 AND org_id=$2`, [fixture.lease, ORG_ID]);
      return (await client.query<{ ok: boolean }>(`SELECT l.id_retention_auto_end IS FALSE AND l.start_date<l.end_date AND public.id_document_delete_after(d.lease_id,d.org_id,d.created_at)<=(timezone('Asia/Taipei',now()))::date AND d.delete_after=public.id_document_delete_after(d.lease_id,d.org_id,d.created_at) AS ok FROM leases l JOIN identity_documents d ON d.lease_id=l.id WHERE l.id=$1 AND d.id=$2`, [fixture.lease, document[0].id])).rows[0];
    });
    expect(dateFacts.ok).toBe(true);
    const beforeDeniedObject = await storedState();
    expect(Date.now() < validUntil).toBe(true);
    await denied(await photo(page.request, validToken));
    expect(JSON.stringify(await storedState()) === JSON.stringify(beforeDeniedObject)).toBe(true);
    expect(await downloadAudits(document[0].id)).toBe(positiveAudit + 1);
    phase = "staged upload fixture";
    // Fixture setup uses the real staging helper, not an HTTP upload. Its
    // replacement DELETE must encounter no existing slot for this new subject.
    const pending = await createFixture(true);
    phase = "staged upload fixture";
    const tenant = await db(async client => {
      const user = (await client.query<{ id: string }>(`SELECT app.provision_portal_user($1,'B002 synthetic tenant',NULL)::text AS id`, [`slot-${randomUUID()}@example.invalid`])).rows[0].id;
      await client.query(`UPDATE contacts SET user_id=$1 WHERE id=$2 AND org_id=$3`, [user, pending.contact, ORG_ID]);
      const empty = (await client.query<{ docs: number; slots: number }>(`SELECT (SELECT count(*)::int FROM identity_documents WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3 AND deleted_at IS NULL) AS docs,(SELECT count(*)::int FROM id_upload_slots WHERE user_id=$4 AND lease_id=$2) AS slots`, [ORG_ID, pending.lease, pending.contact, user])).rows[0];
      expect(empty.docs === 0 && empty.slots === 0).toBe(true);
      return user;
    });
    const marked = embedIdWatermarkMark(Buffer.from(SAMPLE_JPEG_BASE64, "base64"));
    if (!marked) throw new Error("B002 sample mark unavailable");
    const prepared = acceptUploadBytes(marked, "image/jpeg");
    if (!prepared) throw new Error("B002 sample image invalid");
    const tenantSession: Session = { userId: tenant, sessionId: randomUUID(), email: "synthetic@example.invalid", name: "Synthetic tenant", kind: "tenant", role: null, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: pending.lease };
    await storeIdPhoto(tenantSession, { leaseId: pending.lease, slot: "front", mime: "image/jpeg", bytes: marked });
    const staged = await db(async client => {
      const result = await client.query<{ document_id: string; ciphertext: Buffer; sha256: string; plain_size: string }>(`SELECT document_id::text,ciphertext,sha256,plain_size::text FROM id_upload_slots WHERE user_id=$1 AND lease_id=$2 AND slot='front'`, [tenant, pending.lease]);
      expect(result.rows.length).toBe(1);
      await client.query(`UPDATE id_upload_slots SET created_at=clock_timestamp()-interval '25 hours' WHERE user_id=$1 AND lease_id=$2 AND slot='front'`, [tenant, pending.lease]);
      return result.rows[0];
    });
    expect(staged.sha256 === createHash("sha256").update(staged.ciphertext).digest("hex") && staged.plain_size === String(prepared.bytes.length)).toBe(true);
    const decrypted = await decryptBytes(staged.ciphertext, { orgId: ORG_ID, documentId: staged.document_id, slot: "front" }, ENCRYPTION_KEY_REF);
    expect(decrypted.equals(prepared.bytes)).toBe(true);
    const staleSlot = await db(async client => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM id_upload_slots WHERE user_id=$1 AND lease_id=$2 AND document_id=$3 AND slot='front' AND created_at<now()-interval '24 hours'`, [tenant, pending.lease, staged.document_id])).rows[0].n);
    expect(staleSlot).toBe(1);
    phase = "scheduler OFF and dry run";
    const baseline = await storedState();
    let auditCount = await summaryCount();
    await denied(await local(page.request, "/api/cron/purge-id-documents", { method: "POST" }));
    await denied(await local(page.request, "/api/cron/purge-id-documents", { method: "POST", secret: "not-the-local-cron-secret" }));
    for (const mode of ["off", "missing", "invalid"]) {
      await db(async client => {
        if (mode === "missing") await client.query(`DELETE FROM platform_settings WHERE key='ID_PURGE_ENABLED'`);
        else await client.query(`INSERT INTO platform_settings(key,value) VALUES('ID_PURGE_ENABLED',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(mode === "off" ? "off" : { enabled: true })]);
      });
      for (const suffix of ["", "?dry_run=1"]) {
        const res = await local(page.request, `/api/cron/purge-id-documents${suffix}`, { method: "POST", secret: process.env.CRON_SECRET });
        expect(res.status()).toBe(200);
        const result = await res.json();
        expect(result.disabled === true && result.mode === "off" && result.documents === 0 && result.wouldDelete === 0 && result.removed === 0 && result.files === 0 && result.storageFailed === 0 && result.uploadSlotsDeleted === 0 && result.uploadSlotsWouldDelete === 0 && result.batches === 0 && Object.keys(result.byBucket).length === 0).toBe(true);
        expect(await summaryCount()).toBe(auditCount);
        expect(JSON.stringify(await storedState()) === JSON.stringify(baseline)).toBe(true);
      }
    }
    await db(async client => { await client.query(`UPDATE platform_settings SET value='"dry_run"'::jsonb WHERE key='ID_PURGE_ENABLED'`); });
    const expected = await db(async client => (await client.query<{ documents: number; slots: number }>(`SELECT (SELECT count(DISTINCT document_id)::int FROM public.preview_due_identity_documents(500)) AS documents,(SELECT count(*)::int FROM id_upload_slots WHERE created_at < now()-interval '24 hours') AS slots`)).rows[0]);
    expect(expected.documents >= 1 && expected.slots >= 1).toBe(true);
    for (const suffix of ["", "?dry_run=1"]) {
      const res = await local(page.request, `/api/cron/purge-id-documents${suffix}`, { method: "POST", secret: process.env.CRON_SECRET });
      expect(res.status()).toBe(200);
      const result = await res.json();
      expect(result.disabled === false && result.mode === "dry_run" && result.dryRun === true && result.wouldDelete === expected.documents && result.uploadSlotsWouldDelete === expected.slots && result.documents === 0 && result.removed === 0 && result.files === 0 && result.storageFailed === 0 && result.uploadSlotsDeleted === 0 && result.batches === 1).toBe(true);
      expect(await summaryCount()).toBe(++auditCount);
      const summary = await db(async client => (await client.query<{ value: { mode?: string; would_delete?: number; upload_slots_would_delete?: number } }>(`SELECT new_row AS value FROM audit_log WHERE event_type='id_purge_run' ORDER BY id DESC LIMIT 1`)).rows[0].value);
      expect(summary.mode === "dry_run" && summary.would_delete === expected.documents && summary.upload_slots_would_delete === expected.slots).toBe(true);
      expect(JSON.stringify(await storedState()) === JSON.stringify(baseline)).toBe(true);
    }
    phase = "fixed policy display";
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/m/settings");
      await expect(page.getByTestId("idv-retain-days")).toContainText("90");
      await expect(page.locator('input[name="id_doc_retention_days"]')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`settings-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await signIn(page, ACCOUNTS.manager);
    await page.goto("/m/settings");
    await expect(page).toHaveURL(/\/m\/noperm\?need=settings\.edit$/);
    await expect(page.getByTestId("forbidden")).toBeVisible();
    await expect(page.getByTestId("idv-retain-days")).toHaveCount(0);
    expect(errors.length).toBe(0);
  } catch (error) {
    // Never include request URLs, cookies, token material, SQL parameters or IDs.
    const code = error instanceof SafeDbError ? error.sqlstate : null;
    primaryFailure = `${phase}${code ? ` (SQLSTATE ${code})` : ""}`;
  } finally {
    if (mayRestoreOff) {
      const modeToRestore = savedMode;
      try {
        await db(async client => {
          if (modeToRestore) {
            await client.query(`INSERT INTO platform_settings(key,value,description,updated_at) VALUES('ID_PURGE_ENABLED',$1::jsonb,$2,$3::timestamptz) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,description=EXCLUDED.description,updated_at=EXCLUDED.updated_at`, [JSON.stringify(modeToRestore.value), modeToRestore.description, modeToRestore.updated_at]);
          } else {
            await client.query(`DELETE FROM platform_settings WHERE key='ID_PURGE_ENABLED'`);
          }
          const restored = (await client.query<{ value: unknown; description: string | null; updated_at: string }>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='ID_PURGE_ENABLED'`)).rows[0];
          if (JSON.stringify(restored ?? null) !== JSON.stringify(modeToRestore ?? null)) throw new Error("B002 mode restoration failed");
        });
      } catch { restoreFailed = true; }
    }
  }
  if (primaryFailure || restoreFailed) {
    throw new Error(`B002 local proof failed${primaryFailure ? ` during ${primaryFailure}` : ""}${restoreFailed ? "; mode restoration failed" : ""}`);
  }
});
