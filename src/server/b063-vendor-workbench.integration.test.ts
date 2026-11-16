import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import React from "react";
import VendorAccountPage from "../app/vendor-account/page";
import VendorAccountPanel from "../app/vendor-account/panel";
import VendorJobsPage from "../app/vendor-account/jobs/page";
import VendorPaymentsPage from "../app/vendor-account/payments/page";
import { GET as openJob } from "../app/vendor-account/jobs/[jobId]/route";
import { GET as accountGET } from "../app/api/vendor-account/route";
import { VendorWorkbenchScreen } from "../components/v3/vendor/workbench-page";
import { buildStoredConsent } from "./consent";
import { svc, withClient } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { readSession } from "./session";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { claimVendorAccount, correctVendorJobAccount, inviteVendorAccount } from "./vendor-accounts";
import { approveVendorSharing, dispatchVendor, __setVendorLinkKillSwitchForTests } from "./vendor-repair";
import { vendorWorkbenchAccess, vendorWorkbenchJobToken, vendorWorkbenchView } from "./vendor-workbench";

// B-063 / VEN-14-AC1, AC3, AC7, AC8 on a cloned disposable database: the real B-026 and B-063 gateways, the
// real /vendor-account pages and the row opener. Run: CONDOLA_RLS_DISPOSABLE=YES DATABASE_URL=… (never staging).
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID,
  role: "admin", kind: "staff", name: "Staff", email: "staff@example.test", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const coast: Session = { ...admin, userId: USERS.coastAdmin, sessionId: randomUUID(), orgId: ORG2_ID, liveOrgId: ORG2_ID };
const sql = (q: string, values: unknown[] = []) => withClient(client => client.query(q, values));
const tables = ["app.b026_vendor_accounts", "app.b026_vendor_job_accounts", "app.b026_vendor_link_events", "app.b025_received_marks",
  "public.contacts", "public.auth_sessions", "public.repair_vendor_jobs", "public.maintenance_tickets", "public.vendor_documents", "public.audit_log"];
async function snapshot() {
  return withClient(async client => {
    const result: Record<string, string> = {};
    for (const table of tables) result[table] = (await client.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) hash FROM ${table} r`)).rows[0].hash;
    return result;
  });
}
async function issue(contactId?: string, staff = admin) {
  const ticketId = randomUUID();
  await sql(`INSERT INTO maintenance_tickets(id,org_id,property_id,ticket_number,category,title,description,status)
    SELECT $1,$2,id,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),'plumbing','PRIVATE TITLE','PRIVATE DESCRIPTION','open' FROM properties WHERE org_id=$2 AND archived_at IS NULL ORDER BY id LIMIT 1`, [ticketId, staff.orgId]);
  const job = await dispatchVendor(staff, ticketId, { vendorId: contactId, vendorName: contactId ? "" : `Workbench-${randomUUID()}`,
    vendorPhone: "0912111222", vendorTrade: "plumbing", contactWindow: "Monday" }, origin);
  await approveVendorSharing(staff, ticketId, job.jobId, { description: "Shared repair", attachmentIds: [] });
  const contact = (await sql("SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1", [job.jobId])).rows[0].vendor_contact_id as string;
  if (contactId) assert.equal(contact, contactId, "fixture must reuse the vendor contact");
  return { ...job, ticketId, contact, token: new URL(job.url).pathname.slice(3) };
}
async function vendorAccountGate(orgs: string[]) {
  await sql("UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_account'", [JSON.stringify({ enabled: true, allowed_org_ids: orgs })]);
  await sql("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_account\":true}'::jsonb WHERE id=ANY($1::uuid[])", [orgs]);
}
async function workbench(org: string, value: unknown, brand: { v2?: unknown; v3?: unknown } = { v2: true, v3: true }) {
  await sql(`UPDATE organizations SET feature_flags=(feature_flags-'vendor_workbench'-'brand_v2'-'brand_v3')
    ||jsonb_strip_nulls(jsonb_build_object('vendor_workbench',$2::jsonb,'brand_v2',$3::jsonb,'brand_v3',$4::jsonb)) WHERE id=$1`,
  [org, JSON.stringify(value ?? null), JSON.stringify(brand.v2 ?? null), JSON.stringify(brand.v3 ?? null)]);
}
const gateway = (credential: string, org: string) => svc(null, async client =>
  (await client.query<{ result: { jobId: string; property: string; currency: string | null; waitingMinor: string | null; openable: boolean }[] }>(
    "SELECT app.b063_vendor_workbench($1,$2) AS result", [hash(credential), org])).rows[0].result);
const open = (credential: string | null, jobId: string, org = ORG_ID) => openJob(new Request(`${origin}/vendor-account/jobs/${jobId}`, {
  headers: credential ? { cookie: `condola_session=${credential}; condola_org=${org}` } : {} }), { params: Promise.resolve({ jobId }) });

test("B-063 vendor workbench: own linked jobs only, amounts waiting, denial matrix, OFF parity", async t => {
  const clone = await cloneTestDatabase();
  const user = randomUUID(), other = randomUUID(), credential = randomUUID(), otherCredential = randomUUID();
  const brandEnv = process.env.BRAND_V2;
  const jar = new Map<string, string>(); let path = "/vendor-account";
  const cookieSpy = mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined,
    set: () => {}, delete: () => {}, has: (key: string) => jar.has(key), getAll: () => [] }) as never);
  const headerSpy = mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": path }) as never);
  try {
    delete process.env.BRAND_V2;
    await sql("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'workbench1@example.test',now()),($2,'workbench2@example.test',now())", [user, other]);
    for (const [userId, token] of [[admin.userId, randomUUID()], [user, credential], [other, otherCredential]])
      await sql("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [randomUUID(), userId, hash(token)]);
    const consent = buildStoredConsent("portal");
    for (const principal of [user, other]) await sql("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [principal, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
    await sql("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}'::jsonb WHERE id=ANY($1::uuid[])", [[ORG_ID, ORG2_ID]]);
    __setVendorLinkKillSwitchForTests(true);
    const visit = await issue();
    const working = await issue(visit.contact);
    const billed = await issue(visit.contact);
    const tombstoned = await issue(visit.contact);
    const stranger = await issue();
    const foreign = await issue(undefined, coast);
    __setVendorLinkKillSwitchForTests(false);
    await vendorAccountGate([ORG_ID, ORG2_ID]);
    for (const [contact, principal, session] of [[visit.contact, user, credential], [stranger.contact, other, otherCredential]]) {
      const invite = await inviteVendorAccount(admin, contact, principal);
      assert.equal((await claimVendorAccount(session, invite.invitation!)).status, "claimed");
    }
    const foreignInvite = await inviteVendorAccount(coast, foreign.contact, other);
    assert.equal((await claimVendorAccount(otherCredential, foreignInvite.invitation!)).status, "claimed");
    await sql("UPDATE maintenance_tickets SET status='in_progress' WHERE id=$1", [working.ticketId]);
    // Vendor reported NT$1,200 and the company confirmed it (as confirmVendorCost: the ticket closes with that final cost).
    await sql("UPDATE repair_vendor_jobs SET reported_at=now(),reported_cost_minor=120000,confirmed_at=now(),confirmed_by=$2 WHERE id=$1", [billed.jobId, USERS.admin]);
    await sql("UPDATE maintenance_tickets SET status='closed',currency='TWD',final_cost_minor=120000 WHERE id=$1", [billed.ticketId]);
    // Reported but not yet confirmed by the company: not a recorded amount owed.
    await sql("UPDATE repair_vendor_jobs SET reported_at=now(),reported_cost_minor=99900 WHERE id=$1", [working.jobId]);
    assert.equal((await correctVendorJobAccount(admin, tombstoned.jobId, null)).status, "corrected");
    const company = (await sql("SELECT name FROM organizations WHERE id=$1", [ORG_ID])).rows[0].name as string;
    const vendorName = (await sql("SELECT display_name FROM contacts WHERE id=$1", [visit.contact])).rows[0].display_name as string;
    const property = (await sql("SELECT p.name FROM maintenance_tickets t JOIN properties p ON p.id=t.property_id WHERE t.id=$1", [visit.ticketId])).rows[0].name as string;

    await t.test("OFF matrix: no workbench, an empty gateway, the B-026 page and zero writes", async () => {
      const legacy = await (await accountGET(new Request(`${origin}/api/vendor-account`, { headers: { cookie: `condola_session=${credential}` } }))).text();
      for (const [value, brand] of [[undefined, { v2: true, v3: true }], [false, { v2: true, v3: true }], ["true", { v2: true, v3: true }], [1, { v2: true, v3: true }],
        [true, { v2: true, v3: false }], [true, { v2: true, v3: "true" }], [true, { v2: false, v3: true }], [true, {}]] as const) {
        await workbench(ORG_ID, value, brand);
        const before = await snapshot();
        assert.deepEqual(await vendorWorkbenchAccess(credential, ORG_ID), { state: "off" }, JSON.stringify([value, brand]));
        if (value !== true) assert.deepEqual(await gateway(credential, ORG_ID), []);
        assert.equal((await open(credential, visit.jobId)).status, 404);
        jar.set("condola_session", credential); jar.set("condola_org", ORG_ID); path = "/vendor-account";
        const element = await VendorAccountPage();
        assert.equal(element.type, VendorAccountPanel); assert.deepEqual(element.props, {});
        path = "/vendor-account/jobs";
        await assert.rejects(VendorJobsPage(), (e: unknown) => (e as { digest?: string }).digest === "NEXT_HTTP_ERROR_FALLBACK;404");
        assert.equal(await (await accountGET(new Request(`${origin}/api/vendor-account`, { headers: { cookie: `condola_session=${credential}` } }))).text(), legacy);
        assert.deepEqual(await snapshot(), before);
      }
      // The B-026 gate OFF: no vendor account is visible at all.
      await workbench(ORG_ID, true);
      await sql("UPDATE platform_settings SET value='{\"enabled\":false,\"allowed_org_ids\":[]}'::jsonb WHERE key='vendor_account'");
      assert.deepEqual(await vendorWorkbenchAccess(credential, ORG_ID), { state: "other" });
      assert.deepEqual(await gateway(credential, ORG_ID), []);
      path = "/vendor-account"; assert.equal((await VendorAccountPage()).type, VendorAccountPanel);
      await vendorAccountGate([ORG_ID, ORG2_ID]);
    });

    await workbench(ORG_ID, true);
    await t.test("VEN-14-AC1/AC3: ON shows only this account's confirmed links in this organization", async () => {
      const access = await vendorWorkbenchAccess(credential, ORG_ID);
      assert.deepEqual(access, { state: "on", scope: { orgId: ORG_ID, name: vendorName.trim(), company } });
      assert.deepEqual(await vendorWorkbenchAccess(credential, undefined), access, "one organization needs no cookie");
      const before = await snapshot();
      const view = await vendorWorkbenchView(credential, ORG_ID, "zh-TW");
      assert.equal(view.status, "ready"); if (view.status !== "ready") return;
      assert.deepEqual(view.jobs.map(row => [row.jobId, row.status]).sort(), [[visit.jobId, "visit"], [working.jobId, "working"]].sort());
      assert.deepEqual(view.payments.map(row => [row.jobId, row.amount]), [[billed.jobId, "NT$1,200"]]);
      for (const row of [...view.jobs, ...view.payments]) {
        assert.equal(row.property, property); assert.equal(row.item, "Shared repair");
        assert.equal(row.href, `/vendor-account/jobs/${row.jobId}`);
      }
      const text = JSON.stringify(view);
      for (const forbidden of [tombstoned.jobId, stranger.jobId, foreign.jobId, "PRIVATE", visit.token, billed.token, credential]) assert.ok(!text.includes(forbidden), forbidden);
      const rows = await gateway(credential, ORG_ID);
      assert.deepEqual(rows.map(row => row.jobId).sort(), [visit.jobId, working.jobId, billed.jobId].sort(), "the gateway admits exactly the confirmed links");
      assert.ok(!JSON.stringify(rows).includes(visit.token));
      assert.deepEqual(await snapshot(), before, "reads write nothing");
      jar.set("condola_session", credential); jar.delete("condola_org"); path = "/vendor-account";
      const home = await VendorAccountPage();
      assert.equal(home.type, VendorWorkbenchScreen); assert.equal((home.props as { screen: string }).screen, "home");
      path = "/vendor-account/payments";
      const payments = await VendorPaymentsPage();
      assert.equal((payments as React.ReactElement).type, VendorWorkbenchScreen);
      assert.equal(await readSession(), null, "workbench routes provision no persona and touch no session");
    });

    await t.test("Denials: other vendor, other organization, tombstoned link, token-only session", async () => {
      const otherView = await vendorWorkbenchView(otherCredential, ORG_ID, "zh-TW");
      assert.equal(otherView.status, "ready"); if (otherView.status !== "ready") return;
      assert.deepEqual(otherView.jobs.map(row => row.jobId), [stranger.jobId]);
      assert.deepEqual(otherView.payments, []);
      // The other vendor also has an account in ORG2: it sees ORG2's job only where ORG2's workbench is open.
      assert.deepEqual(await gateway(otherCredential, ORG2_ID), []);
      await workbench(ORG2_ID, true);
      assert.deepEqual((await gateway(otherCredential, ORG2_ID)).map(row => row.jobId), [foreign.jobId]);
      assert.deepEqual(await gateway(credential, ORG2_ID), [], "no account in ORG2: nothing, even with ORG2's workbench open");
      assert.deepEqual(await vendorWorkbenchAccess(otherCredential, undefined), { state: "off" }, "two organizations and no current one");
      assert.equal((await vendorWorkbenchAccess(otherCredential, ORG2_ID)).state, "on");
      await workbench(ORG2_ID, undefined, {});
      // A job token is never an account credential (VEN-14-AC7).
      await assert.rejects(gateway(visit.token, ORG_ID), (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "42501");
      assert.deepEqual(await vendorWorkbenchAccess(visit.token, ORG_ID), { state: "anonymous" });
      jar.set("condola_session", visit.token); path = "/vendor-account/jobs";
      await assert.rejects(VendorJobsPage(), (e: unknown) => String((e as { digest?: string }).digest).startsWith("NEXT_REDIRECT;replace;/login?next=%2Fvendor-account;"));
      jar.delete("condola_session");
      await assert.rejects(VendorJobsPage(), (e: unknown) => String((e as { digest?: string }).digest).startsWith("NEXT_REDIRECT;replace;/login?next=%2Fvendor-account;"));
      for (const [session, jobId, why] of [[visit.token, visit.jobId, "token-only"], [null, visit.jobId, "no session"], [credential, stranger.jobId, "another vendor's job"],
        [credential, foreign.jobId, "another organization's job"], [credential, tombstoned.jobId, "tombstoned link"], [otherCredential, visit.jobId, "other vendor"],
        [credential, randomUUID(), "unknown job"], [credential, "not-a-uuid", "malformed"]] as const) {
        const response = await open(session, jobId);
        assert.equal(response.status, 404, why); assert.equal(await response.text(), "", why);
        assert.equal(response.headers.get("location"), null, why);
      }
      assert.equal(await vendorWorkbenchJobToken(credential, ORG_ID, tombstoned.jobId), null);
    });

    await t.test("Row 查看 opens that job's existing page", async () => {
      const before = await snapshot();
      const response = await open(credential, visit.jobId);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), `/v/${visit.token}`);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal((await open(credential, billed.jobId)).headers.get("location"), `/v/${billed.token}`);
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("Amounts waiting: the confirmed reported cost minus the vendor's own received marks; zero once a receipt is issued", async () => {
      const profile = (await sql(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164)
        VALUES($1,$2,'B063','individual','Workbench vendor','+886912111222') RETURNING id`, [ORG_ID, visit.contact])).rows[0].id as string;
      const grant = (await sql(`INSERT INTO vendor_document_grants(org_id,ticket_id,job_id,vendor_profile_id,token_hash,buyer_selection,expires_at,created_by)
        VALUES($1,$2,$3,$4,$5,'{"kind":"company","name":"Fixture"}',now()+interval '1 day',$6) RETURNING id`, [ORG_ID, billed.ticketId, billed.jobId, profile, hash(randomUUID()), USERS.admin])).rows[0].id as string;
      const mark = (amount: number) => sql("INSERT INTO app.b025_received_marks(org_id,ticket_id,vendor_profile_id,grant_id,amount_minor,request_id) VALUES($1,$2,$3,$4,$5,$6)",
        [ORG_ID, billed.ticketId, profile, grant, amount, randomUUID()]);
      const waiting = async () => {
        const view = await vendorWorkbenchView(credential, ORG_ID, "zh-TW");
        assert.equal(view.status, "ready");
        return view.status === "ready" ? view.payments.map(row => row.amount) : null;
      };
      assert.deepEqual(await waiting(), ["NT$1,200"]);
      await mark(500); assert.deepEqual(await waiting(), ["NT$700"]);
      // Another vendor profile's marks on the same ticket never count.
      const strangerProfile = (await sql(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164)
        VALUES($1,$2,'B063X','individual','Other vendor','+886912111223') RETURNING id`, [ORG_ID, stranger.contact])).rows[0].id as string;
      const strangerGrant = (await sql(`INSERT INTO vendor_document_grants(org_id,ticket_id,job_id,vendor_profile_id,token_hash,buyer_selection,expires_at,created_by)
        VALUES($1,$2,$3,$4,$5,'{"kind":"company","name":"Fixture"}',now()+interval '1 day',$6) RETURNING id`, [ORG_ID, billed.ticketId, stranger.jobId, strangerProfile, hash(randomUUID()), USERS.admin])).rows[0].id as string;
      await sql("INSERT INTO app.b025_received_marks(org_id,ticket_id,vendor_profile_id,grant_id,amount_minor,request_id) VALUES($1,$2,$3,$4,700,$5)",
        [ORG_ID, billed.ticketId, strangerProfile, strangerGrant, randomUUID()]);
      assert.deepEqual(await waiting(), ["NT$700"]);
      await mark(700); assert.deepEqual(await waiting(), [], "fully received: no 待收款 row, never NT$0");
      await sql("UPDATE repair_vendor_jobs SET reported_cost_minor=200000 WHERE id=$1", [billed.jobId]);
      assert.deepEqual(await waiting(), ["NT$800"]);
      await sql("UPDATE maintenance_tickets SET final_cost_minor=900000 WHERE id=$1", [billed.ticketId]);
      assert.deepEqual(await waiting(), ["NT$800"], "the ticket's own figure is not the vendor's amount");
      await sql(`INSERT INTO vendor_documents(org_id,vendor_profile_id,ticket_id,kind,seq,doc_no,buyer,items,total_minor,idempotency_key)
        VALUES($1,$2,$3,'receipt',1,'B063-1','{}','[]',2000,$4)`, [ORG_ID, profile, billed.ticketId, randomUUID()]);
      assert.deepEqual(await waiting(), [], "an issued receipt closes the amount");
      await sql("UPDATE vendor_documents SET status='voided',voided_at=now(),void_reason='Fixture' WHERE ticket_id=$1 AND vendor_profile_id=$2", [billed.ticketId, profile]);
      assert.deepEqual(await waiting(), ["NT$800"], "a voided receipt does not");
      await sql("UPDATE repair_vendor_jobs SET confirmed_at=NULL,confirmed_by=NULL WHERE id=$1", [billed.jobId]);
      assert.deepEqual(await waiting(), [], "not confirmed by the company: nothing waiting");
    });
  } finally {
    cookieSpy.mock.restore(); headerSpy.mock.restore();
    if (brandEnv === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = brandEnv;
    __setVendorLinkKillSwitchForTests(false);
    await clone.cleanup();
  }
});
