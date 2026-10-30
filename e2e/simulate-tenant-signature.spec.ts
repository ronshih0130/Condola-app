import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { ORG_ID, USERS } from "../src/server/ids";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { resetDemo } from "./session";

const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
if (process.env.DEMO_MODE !== "true") throw new Error("Disposable demo mode required");
async function db<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}
async function createSyntheticLease(page: Page, tag: string) {
  const token = randomUUID();
  const property = await page.request.post("/api/flows/createProperty", { data: {
    name: `B001 ${tag} ${token}`, city: "台北市", district: "大安區", street: `測試路 ${token}`, currency: "TWD",
    ownerMode: "new", ownerName: "Synthetic owner", ownerPhone: "0912000888", ownerEmail: `${token}@example.invalid`,
    canViewTenantPhone: false, unitLabel: "1", floor: "1", rentalMode: "by_room",
    rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
  } });
  expect(property.ok()).toBe(true);
  const propertyResult = await property.json();
  const lease = await page.request.post("/api/flows/createLease", { data: {
    roomId: propertyResult.result.roomIds[0], tenantName: `Synthetic ${tag}`, tenantPhone: "0912345678",
    tenantEmail: `tenant.${token}@example.invalid`, lineUserId: "", startDate: "2027-01-01", endDate: "2027-12-31",
    rentMajor: 10000, depositMonths: 2, depositReason: "", dueDay: 5, splitMethod: "even", periodStart: "2027-01-01",
    periodEnd: "2027-01-31", billTotalMajor: null, usageKwh: null, rateMajor: null, rateSource: "bill_average", overrideReason: "", subUsages: [],
  } });
  expect(lease.ok()).toBe(true);
  return (await lease.json()).result.leaseId as string;
}

for (const width of [390, 1280]) test(`simulation is limited to the selected sandbox at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if ((url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
    else { errors.push("unexpected external request"); await route.abort(); }
  });
  await resetDemo(page);
  const liveLease = await createSyntheticLease(page, "live");
  expect((await page.request.post("/api/demo/id-sample", { data: { leaseId: liveLease } })).ok()).toBe(true);
  await page.goto(`/m/leases/${liveLease}?tab=sign`);
  await expect(page.getByTestId("simulate-tenant-sign")).toHaveCount(0);
  const before = await db(async client => (await client.query(`SELECT status::text, (SELECT count(*)::int FROM lease_signature_events e JOIN lease_signatures s ON s.id=e.signature_id WHERE s.lease_id=l.id) AS events, (SELECT count(*)::int FROM invoices i WHERE i.lease_id=l.id) AS invoices FROM leases l WHERE id=$1`, [liveLease])).rows[0]);
  const auditBefore = await db(async client => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND actor_user_id=$2 AND event_type='tenant_signature_simulation_denied'`, [ORG_ID, USERS.admin])).rows[0].n);
  const denied = await page.request.post("/api/flows/simulateTenantSignature", { data: { leaseId: liveLease } });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ ok: false, error: "errors.forbidden" });
  expect(await db(async client => (await client.query(`SELECT status::text, (SELECT count(*)::int FROM lease_signature_events e JOIN lease_signatures s ON s.id=e.signature_id WHERE s.lease_id=l.id) AS events, (SELECT count(*)::int FROM invoices i WHERE i.lease_id=l.id) AS invoices FROM leases l WHERE id=$1`, [liveLease])).rows[0])).toEqual(before);
  expect(await db(async client => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND actor_user_id=$2 AND event_type='tenant_signature_simulation_denied'`, [ORG_ID, USERS.admin])).rows[0].n)).toBe(auditBefore + 1);
  await page.screenshot({ path: testInfo.outputPath("formal-sign.png"), fullPage: true });
  await page.goto("/api/env?set=sandbox&next=/m");
  await expect(page.getByTestId("env-banner")).toBeVisible();
  const sandboxLease = await createSyntheticLease(page, "sandbox");
  expect((await page.request.post("/api/demo/id-sample", { data: { leaseId: sandboxLease } })).ok()).toBe(true);
  await page.goto(`/m/leases/${sandboxLease}?tab=sign`);
  await expect(page.getByTestId("simulate-tenant-sign")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sandbox-sign.png"), fullPage: true });
  await page.getByTestId("simulate-tenant-sign").click();
  await expect(page.getByTestId("simulate-tenant-sign")).toHaveCount(0);
  const event = await db(async client => (await client.query(`SELECT e.actor_user_id::text AS actor,e.details->>'origin' AS origin,s.consent_text_key AS consent FROM lease_signature_events e JOIN lease_signatures s ON s.id=e.signature_id WHERE s.lease_id=$1 AND e.event='signed' ORDER BY e.id`, [sandboxLease])).rows);
  expect(event).toEqual([{ actor: USERS.admin, origin: "sandbox_simulation", consent: null }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
