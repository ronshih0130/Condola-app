import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { readPhotoToken, signPhotoToken } from "../src/server/id-crypto";
import { PRIVACY_VERSION, TERMS_VERSION } from "../src/server/legal-versions";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";
const ORIGIN = "http://127.0.0.1:43123";
async function db<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}
async function record(userId: string, stale = false) {
  await db((client) => client.query(
    // Explicitly advance beyond all previous records; no DELETE bypass.
    "INSERT INTO public.consents (user_id, accepted_at, terms_version, privacy_version, source, recorded_at) SELECT $1, clock_timestamp(), $2, $3, 'reconsent', greatest(clock_timestamp(), coalesce(max(recorded_at) + interval '1 millisecond', clock_timestamp())) FROM public.consents WHERE user_id = $1",
    [userId, stale ? "old" : TERMS_VERSION, stale ? "old" : PRIVACY_VERSION],
  ));
}
async function fixture(kind: "staff" | "tenant") {
  return db(async (client) => {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const email = id + "@enforcement.example.com";
    const org = await client.query<{ id: string }>(
      "SELECT id::text FROM organizations WHERE name = '松信住宅管理' AND environment = 'live'");
    const orgId = org.rows[0]?.id;
    expect(orgId).toBeTruthy();
    await client.query("INSERT INTO auth.users (id, email, email_confirmed_at, role, aud) VALUES ($1, $2, now(), 'authenticated', 'authenticated')", [id, email]);
    await client.query("INSERT INTO profiles (id, display_name, email, locale) VALUES ($1, 'Consent Enforcement', $2, 'en')", [id, email]);
    let contactId: string | null = null;
    if (kind === "staff") {
      await client.query("INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')", [orgId, id]);
    } else {
      const contact = await client.query<{ id: string }>(
        "INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, locale) VALUES ($1, $2, true, 'Consent Tenant', $3, 'en') RETURNING id::text", [orgId, id, email]);
      contactId = contact.rows[0].id;
      const lease = await client.query<{ id: string }>(
        "SELECT l.id::text FROM leases l WHERE l.org_id = $1 AND l.status IN ('active', 'pending_signature') AND EXISTS (SELECT 1 FROM message_threads mt WHERE mt.lease_id = l.id) LIMIT 1", [orgId]);
      expect(lease.rows[0]).toBeTruthy();
      await client.query("INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1, $2, $3, 'co_tenant')", [orgId, lease.rows[0].id, contactId]);
      await client.query("INSERT INTO thread_participants (org_id, thread_id, contact_id) SELECT $1, id, $2 FROM message_threads WHERE lease_id = $3", [orgId, contactId, lease.rows[0].id]);
    }
    await client.query("INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [id, createHash("sha256").update(token).digest("hex")]);
    return { id, token, orgId, contactId, email };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function session(page: Page, user: Fixture) {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: "condola_session", value: user.token, url: ORIGIN, httpOnly: true, sameSite: "Lax" },
    { name: "condola_env", value: "live", url: ORIGIN },
    { name: "condola_org", value: user.orgId, url: ORIGIN },
  ]);
}
async function cleanup(user: Fixture) {
  await db(async (client) => {
    if (user.contactId) {
      await client.query("DELETE FROM lease_parties WHERE contact_id = $1", [user.contactId]);
      await client.query("DELETE FROM contacts WHERE id = $1", [user.contactId]);
    }
    await client.query("DELETE FROM org_members WHERE user_id = $1", [user.id]);
    await client.query("DELETE FROM profiles WHERE id = $1", [user.id]);
    // The FK cascade is the sole permitted evidence deletion.
    await client.query("DELETE FROM auth.users WHERE id = $1", [user.id]);
  });
}
async function snapshot(orgId: string) {
  return db(async (client) => {
    const result: Record<string, unknown> = {};
    for (const table of ["properties", "payments", "import_jobs", "invitations", "messages", "identity_documents", "identity_document_photos", "ticket_attachments", "files", "audit_log", "ledger_transactions"]) {
      result[table] = (await client.query(
        "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) AS rows FROM " + table + " t WHERE org_id = $1", [orgId])).rows[0].rows;
    }
    return result;
  });
}
for (const stale of [false, true]) {
  test((stale ? "stale" : "missing") + " table consent blocks business APIs and file bytes", async ({ page }) => {
    const user = await fixture("staff");
    try {
      if (stale) await record(user.id, true);
      await session(page, user);
      const ids = await db(async (client) => ({
        lease: (await client.query("SELECT id::text FROM leases WHERE org_id = $1 LIMIT 1", [user.orgId])).rows[0].id as string,
        // Select a real front photo through the same viewer ACL as photo GET.
        // id_photo_gate is read-only: it neither decrypts nor records a download.
        document: (await client.query(
          "SELECT g.document_id::text AS id FROM identity_documents d CROSS JOIN LATERAL public.id_photo_gate($1, $2, d.id, $3, 'live') g WHERE d.org_id = $3::uuid AND 'front' = ANY(g.slots) LIMIT 1",
          [createHash("sha256").update(user.token).digest("hex"), user.id, user.orgId],
        )).rows[0]?.id as string,
        statement: (await client.query("SELECT id::text FROM owner_statements WHERE org_id = $1 LIMIT 1", [user.orgId])).rows[0].id as string,
      }));
      expect(ids.document, "viewer must be authorized for a stored front photo").toBeTruthy();
      const photoToken = signPhotoToken({
        documentId: ids.document, userId: user.id, slot: "front", exp: Date.now() + 60_000,
      });
      expect(readPhotoToken(photoToken), "photo token must be valid before testing consent").not.toBeNull();
      const before = await snapshot(user.orgId);
      const routes: [string, string][] = [
        ["POST", "/api/flows/createProperty"], ["POST", "/api/flows/confirmPayment"],
        ["POST", "/api/import"], ["GET", "/api/export"],
        ["GET", "/api/pdf/leases/" + ids.lease], ["GET", "/api/pdf/statements/" + ids.statement],
        ["GET", "/m/leases/" + ids.lease + "/signed"], ["GET", "/m/reports/export"],
        ["GET", "/api/tickets/photos/" + randomUUID()],
        ["POST", "/api/tickets/photos/sign"], ["POST", "/api/tickets/photos/confirm"],
        ["GET", "/api/id-documents/photo?token=" + encodeURIComponent(photoToken)],
        ["POST", "/api/id-documents/photo"], ["POST", "/api/id-documents/finalize"],
        ["DELETE", "/api/id-documents/finalize"],
      ];
      for (const [method, url] of routes) {
        // Invalid JSON must not get as far as parsing, signing or writing.
        const response = await page.request.fetch(url, { method, data: method === "GET" ? undefined : "invalid-json" });
        expect(response.status(), method + " " + url).toBe(403);
        expect(await response.json()).toEqual({ ok: false, error: "errors.consentRequired" });
        expect(response.headers()["cache-control"]).toBe("private, no-store");
        expect(response.headers()["content-type"]).toContain("application/json");
      }
      const invalidPhoto = await page.request.get("/api/id-documents/photo?token=invalid");
      expect(invalidPhoto.status()).toBe(404);
      expect((await invalidPhoto.body()).length).toBe(0);
      expect(await snapshot(user.orgId)).toEqual(before);
      for (const url of ["/terms", "/privacy", "/api/version"]) {
        expect((await page.request.get(url)).ok(), url).toBeTruthy();
      }
      await page.goto("/m");
      await expect(page).toHaveURL(/\/consent\?next=/);
      await page.getByTestId("consent-check").check();
      await page.getByTestId("consent-submit").click();
      await expect(page).toHaveURL(/\/m(?:\?|$)/);
      expect((await page.request.get("/api/export")).ok()).toBeTruthy();
      await record(user.id, true);
      expect((await page.request.post("/api/auth/sign-out", { maxRedirects: 0 })).status()).toBeLessThan(400);
    } finally { await cleanup(user); }
  });
}
for (const kind of ["staff", "tenant"] as const) {
  test(kind + " rendered actions and open-tab navigation recheck table consent", async ({ page }) => {
    const user = await fixture(kind);
    const portal = kind === "tenant";
    const home = portal ? "/t" : "/m";
    const formPage = portal ? "/t/messages" : "/m/team";
    const gate = portal ? /\/consent\/portal\?next=/ : /\/consent\?next=/;
    try {
      await record(user.id);
      await session(page, user);
      await page.goto(formPage);
      const field = portal ? page.locator('textarea[name="body"]') : page.getByTestId("invite-email");
      await expect(field).toBeVisible();
      await field.fill(portal ? "must not be written " + user.id : "blocked." + user.email);
      if (!portal) await page.getByTestId("invite-name").fill("Blocked Invite");
      const before = await snapshot(user.orgId);
      await record(user.id, true);
      // Submit the existing browser form with Next's actual action transport.
      await field.locator("xpath=ancestor::form").locator('button[type="submit"]').click();
      await expect(page).toHaveURL(gate);
      expect(await snapshot(user.orgId)).toEqual(before);
      await page.getByTestId("consent-check").check();
      await page.getByTestId("consent-submit").click();
      await expect(page).toHaveURL(new RegExp(formPage + "(?:\\?|$)"));

      await page.goto(home);
      const destination = portal ? "/t/messages" : "/m/properties";
      const link = page.locator('a[href="' + destination + '"]').first();
      await expect(link).toBeVisible();
      // Warm destination RSC output, then test a real client-side navigation.
      await link.hover();
      await record(user.id, true);
      await link.click();
      await expect(page).toHaveURL(gate);
      await page.getByTestId("consent-check").check();
      await page.getByTestId("consent-submit").click();
      await expect(page).toHaveURL(new RegExp(destination + "(?:\\?|$)"));
    } finally { await cleanup(user); }
  });
}
