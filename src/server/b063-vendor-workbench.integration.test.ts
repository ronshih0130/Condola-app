import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import VendorAccountPage from "../app/vendor-account/page";
import VendorAccountPanel from "../app/vendor-account/panel";
import VendorJobsPage from "../app/vendor-account/jobs/page";
import VendorPaymentsPage from "../app/vendor-account/payments/page";
import VendorWorkbenchAccountPage from "../app/vendor-account/account/page";
import { GET as openJob } from "../app/vendor-account/jobs/[jobId]/route";
import { GET as accountGET } from "../app/api/vendor-account/route";
import { VendorWorkbenchScreen } from "../components/v3/vendor/workbench-page";
import { VendorNoPerm } from "../components/v3/vendor/workbench";
import { VendorShellV3 } from "../components/v3/vendor/workbench-shell";
import { buildStoredConsent } from "./consent";
import { svc, withClient } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { readSession } from "./session";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { claimVendorAccount, correctVendorJobAccount, inviteVendorAccount } from "./vendor-accounts";
import { approveVendorSharing, dispatchVendor, __setVendorLinkKillSwitchForTests } from "./vendor-repair";
import { hashVendorToken } from "./vendor-repair-rules";
import { vendorWorkbenchAccess, vendorWorkbenchJobOpen, vendorWorkbenchView } from "./vendor-workbench";

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
  "public.contacts", "public.auth_sessions", "public.repair_vendor_jobs", "public.repair_vendor_secrets", "public.maintenance_tickets",
  "public.organizations", "public.properties", "public.platform_settings", "public.vendor_profiles", "public.vendor_document_grants",
  "public.vendor_documents", "public.audit_log"];
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
const LOGIN = "/login?next=%2Fvendor-account";
/** The opener's outcome: a redirect location (the job page, sign-in, or the sibling route's B1-NOPERM) or 404. */
async function opened(credential: string | null, jobId: string, org = ORG_ID) {
  const response = await open(credential, jobId, org);
  assert.equal(await response.text(), "", "the opener never writes a body");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response.status === 404 ? "404" : `${response.status} ${response.headers.get("location")}`;
}

test("B-063 vendor workbench: own linked jobs only, amounts waiting, denial matrix, OFF parity", async t => {
  const clone = await cloneTestDatabase();
  const user = randomUUID(), other = randomUUID(), credential = randomUUID(), otherCredential = randomUUID(), staffCredential = randomUUID();
  const brandEnv = process.env.BRAND_V2;
  const jar = new Map<string, string>(); let path = "/vendor-account";
  const cookieSpy = mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined,
    set: () => {}, delete: () => {}, has: (key: string) => jar.has(key), getAll: () => [] }) as never);
  const headerSpy = mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": path }) as never);
  // App pages use the automatic JSX runtime under Next; tsx compiles them with the classic one here.
  const runtime = globalThis as typeof globalThis & { React?: typeof React }; const previousReact = runtime.React; runtime.React = React;
  /** Every workbench route for one cookie jar: panel (B-026 page), screen (workbench), noperm, 404 or a redirect. */
  async function routes(session: string | null, org: string | null = ORG_ID) {
    if (session) jar.set("condola_session", session); else jar.delete("condola_session");
    if (org) jar.set("condola_org", org); else jar.delete("condola_org");
    const outcome = async (route: string, page: () => Promise<React.ReactNode>) => {
      path = route;
      try {
        const element = await page() as React.ReactElement;
        // OFF and B1-NOPERM render to HTML: the B-026 page must be byte-identical to the pre-B-063 page body
        // (`return <VendorAccountPanel />`), and B1-NOPERM must carry its approved content.
        if (element.type === VendorAccountPanel || element.type === VendorNoPerm) {
          const html = renderToStaticMarkup(element);
          if (html === legacyHtml) return "panel";
          if (html.includes('data-testid="vendor-noperm"') && html.includes('data-v3-illustration="26"')
            && html.includes("你目前的角色看不到這一頁，需要的話請公司管理員幫你開。") && html.includes(">回到首頁</a>")) return "noperm";
          return `unexpected html ${html.slice(0, 120)}`;
        }
        // The ON screen streams async server content (RSC only), so it is identified by its component.
        return element.type === VendorWorkbenchScreen || element.type === VendorShellV3 ? "screen" : "other";
      } catch (error) {
        const digest = String((error as { digest?: string }).digest);
        if (digest === "NEXT_HTTP_ERROR_FALLBACK;404") return "404";
        const redirect = /^NEXT_REDIRECT;replace;([^;]+);307;$/.exec(digest);
        if (redirect) return `redirect ${redirect[1]}`;
        throw error;
      }
    };
    return { home: await outcome("/vendor-account", VendorAccountPage), jobs: await outcome("/vendor-account/jobs", VendorJobsPage),
      payments: await outcome("/vendor-account/payments", VendorPaymentsPage), account: await outcome("/vendor-account/account", VendorWorkbenchAccountPage) };
  }
  const legacyHtml = renderToStaticMarkup(React.createElement(VendorAccountPanel));
  assert.match(legacyHtml, /<h1>廠商帳號<\/h1>/);
  const OFF = { home: "panel", jobs: "404", payments: "404", account: "404" };
  const NOPERM = { home: "panel", jobs: "noperm", payments: "noperm", account: "noperm" };
  const SIGN_IN = { home: "panel", jobs: `redirect ${LOGIN}`, payments: `redirect ${LOGIN}`, account: `redirect ${LOGIN}` };
  const ON = { home: "screen", jobs: "screen", payments: "screen", account: "screen" };
  try {
    delete process.env.BRAND_V2;
    await sql("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'workbench1@example.test',now()),($2,'workbench2@example.test',now())", [user, other]);
    // Staff dispatch checks the actor's live auth session, so the staff fixtures use their own session ids. The
    // admin's session also gets a cookie credential: a signed-in non-vendor for the B1-NOPERM matrix.
    for (const [id, userId, token] of [[admin.sessionId, admin.userId, staffCredential], [coast.sessionId, coast.userId, randomUUID()],
      [randomUUID(), user, credential], [randomUUID(), other, otherCredential]])
      await sql("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [id, userId, hash(token)]);
    const consent = buildStoredConsent("portal");
    for (const principal of [user, other, admin.userId]) await sql("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [principal, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
    await sql("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}'::jsonb WHERE id=ANY($1::uuid[])", [[ORG_ID, ORG2_ID]]);
    __setVendorLinkKillSwitchForTests(true);
    const visit = await issue();
    const working = await issue(visit.contact);
    const billed = await issue(visit.contact);
    const tombstoned = await issue(visit.contact);
    const expiring = await issue(visit.contact);
    const stranger = await issue();
    const foreign = await issue(undefined, coast);
    __setVendorLinkKillSwitchForTests(false);
    const fixtures = [visit, working, billed, tombstoned, expiring, stranger, foreign];
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

    await t.test("OFF matrix: no workbench on any route, an empty gateway, the B-026 page and zero writes", async () => {
      const legacy = await (await accountGET(new Request(`${origin}/api/vendor-account`, { headers: { cookie: `condola_session=${credential}` } }))).text();
      for (const [value, brand] of [[undefined, { v2: true, v3: true }], [false, { v2: true, v3: true }], ["true", { v2: true, v3: true }], [1, { v2: true, v3: true }],
        [true, { v2: true, v3: false }], [true, { v2: true, v3: "true" }], [true, { v2: false, v3: true }], [true, {}]] as const) {
        await workbench(ORG_ID, value, brand);
        const label = JSON.stringify([value, brand]);
        const before = await snapshot();
        assert.deepEqual(await vendorWorkbenchAccess(credential, ORG_ID), { state: "off" }, label);
        if (value !== true) assert.deepEqual(await gateway(credential, ORG_ID), [], label);
        assert.deepEqual(await routes(credential), OFF, label);
        assert.deepEqual(await routes(credential, null), OFF, label);
        assert.equal(await opened(credential, visit.jobId), "404", label);
        assert.equal(await (await accountGET(new Request(`${origin}/api/vendor-account`, { headers: { cookie: `condola_session=${credential}` } }))).text(), legacy);
        assert.deepEqual(await snapshot(), before, label);
      }
      // PR-032 (a): the B-026 gate OFF (platform setting, or the org flag) makes the workbench OFF for everyone:
      // every new route and the opener 404, /vendor-account is the B-026 page, with vendor_workbench and brand_v3 ON.
      await workbench(ORG_ID, true);
      for (const gateOff of ["platform", "org"] as const) {
        if (gateOff === "platform") await sql("UPDATE platform_settings SET value='{\"enabled\":false,\"allowed_org_ids\":[]}'::jsonb WHERE key='vendor_account'");
        else await sql("UPDATE organizations SET feature_flags=feature_flags-'vendor_account' WHERE id=ANY($1::uuid[])", [[ORG_ID, ORG2_ID]]);
        const before = await snapshot();
        for (const session of [credential, staffCredential, visit.token, null]) {
          assert.deepEqual(await vendorWorkbenchAccess(session ?? undefined, ORG_ID), { state: "off" }, `${gateOff}: ${session}`);
          assert.deepEqual(await routes(session), OFF, `${gateOff}: ${session}`);
          assert.deepEqual(await routes(session, null), OFF, `${gateOff}: ${session}, no org cookie`);
          for (const job of [visit, billed, stranger]) assert.equal(await opened(session, job.jobId), "404", `${gateOff}: ${session} ${job.jobId}`);
        }
        assert.deepEqual(await gateway(credential, ORG_ID), []);
        assert.deepEqual(await snapshot(), before, gateOff);
        await vendorAccountGate([ORG_ID, ORG2_ID]);
      }
    });

    await workbench(ORG_ID, true);
    await t.test("An expired link is shown before expiry and excluded after it, by the gateway, the view and the opener", async () => {
      const preExpiry = await snapshot();
      assert.ok((await gateway(credential, ORG_ID)).some(row => row.jobId === expiring.jobId && row.openable));
      const live = await vendorWorkbenchView(credential, ORG_ID, "zh-TW");
      assert.ok(live.status === "ready" && live.jobs.some(row => row.jobId === expiring.jobId && row.href));
      assert.equal(await opened(credential, expiring.jobId), `303 /v/${expiring.token}`);
      assert.deepEqual(await snapshot(), preExpiry, "the positive controls write nothing");
      await sql("UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiring.jobId]);
      const before = await snapshot();
      assert.ok(!(await gateway(credential, ORG_ID)).some(row => row.jobId === expiring.jobId));
      const view = await vendorWorkbenchView(credential, ORG_ID, "zh-TW");
      assert.equal(view.status, "ready");
      assert.ok(!JSON.stringify(view).includes(expiring.jobId));
      assert.equal(await opened(credential, expiring.jobId), "404");
      assert.deepEqual(await vendorWorkbenchJobOpen(credential, ORG_ID, expiring.jobId), { state: "missing" });
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("VEN-14-AC1/AC3: ON shows only this account's confirmed links in this organization; reads and renders write nothing", async () => {
      const before = await snapshot();
      const access = await vendorWorkbenchAccess(credential, ORG_ID);
      assert.deepEqual(access, { state: "on", scope: { orgId: ORG_ID, name: vendorName.trim(), company } });
      assert.deepEqual(await vendorWorkbenchAccess(credential, undefined), access, "one organization needs no cookie");
      const view = await vendorWorkbenchView(credential, ORG_ID, "zh-TW");
      assert.equal(view.status, "ready"); if (view.status !== "ready") return;
      assert.deepEqual(view.jobs.map(row => [row.jobId, row.status]).sort(), [[visit.jobId, "visit"], [working.jobId, "working"]].sort());
      assert.deepEqual(view.payments.map(row => [row.jobId, row.amount]), [[billed.jobId, "NT$1,200"]]);
      for (const row of [...view.jobs, ...view.payments]) {
        assert.equal(row.property, property); assert.equal(row.item, "Shared repair");
        assert.equal(row.href, `/vendor-account/jobs/${row.jobId}`);
      }
      const text = JSON.stringify(view);
      for (const forbidden of [tombstoned.jobId, expiring.jobId, stranger.jobId, foreign.jobId, "PRIVATE", credential, ...fixtures.map(f => f.token)]) assert.ok(!text.includes(forbidden), forbidden);
      const rows = await gateway(credential, ORG_ID);
      assert.deepEqual(rows.map(row => row.jobId).sort(), [visit.jobId, working.jobId, billed.jobId].sort(), "the gateway admits exactly the confirmed, live links");
      // The raw gateway output carries no token, link or hash of any issued job, in any row.
      const raw = JSON.stringify(rows);
      for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), ["currency", "jobId", "openable", "property", "waitingMinor"]);
        for (const key of Object.keys(row)) assert.doesNotMatch(key, /token|url|secret|hash|link/i);
        for (const value of Object.values(row)) assert.ok(typeof value !== "string" || !/\/v\/|^[A-Za-z0-9_-]{43,}$/.test(value), String(value));
      }
      for (const fixture of fixtures) {
        assert.ok(!raw.includes(fixture.token), fixture.jobId); assert.ok(!raw.includes(hashVendorToken(fixture.token)), fixture.jobId);
        assert.ok(!raw.includes(fixture.url), fixture.jobId);
      }
      assert.deepEqual(await routes(credential), ON);
      assert.deepEqual(await routes(credential, null), ON);
      jar.set("condola_session", credential); path = "/vendor-account/payments";
      assert.equal(await readSession(), null, "workbench routes provision no persona and touch no session");
      assert.deepEqual(await snapshot(), before, "reads and page renders write nothing");
    });

    await t.test("Signed-in non-vendor (staff account session): B1-NOPERM on every workbench route, the opener included", async () => {
      const before = await snapshot();
      assert.deepEqual(await vendorWorkbenchAccess(staffCredential, ORG_ID), { state: "other" });
      assert.deepEqual(await gateway(staffCredential, ORG_ID), []);
      assert.deepEqual(await routes(staffCredential), NOPERM);
      for (const job of [visit, billed, stranger]) assert.equal(await opened(staffCredential, job.jobId), "303 /vendor-account/jobs", job.jobId);
      assert.deepEqual(await vendorWorkbenchJobOpen(staffCredential, ORG_ID, visit.jobId), { state: "noperm" });
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("Denials with both organizations ON: other vendor, other organization, forged org cookie, tombstoned link, token-only session", async () => {
      await workbench(ORG2_ID, true);
      try {
        const before = await snapshot();
        const otherView = await vendorWorkbenchView(otherCredential, ORG_ID, "zh-TW");
        assert.equal(otherView.status, "ready"); if (otherView.status !== "ready") return;
        assert.deepEqual(otherView.jobs.map(row => row.jobId), [stranger.jobId]);
        assert.deepEqual(otherView.payments, []);
        assert.deepEqual((await gateway(otherCredential, ORG2_ID)).map(row => row.jobId), [foreign.jobId]);
        assert.deepEqual(await gateway(credential, ORG2_ID), [], "no account in ORG2: nothing, with ORG2's workbench open");
        assert.deepEqual(await vendorWorkbenchAccess(otherCredential, undefined), { state: "off" }, "two organizations and no current one");
        assert.equal((await vendorWorkbenchAccess(otherCredential, ORG2_ID)).state, "on");
        assert.deepEqual(await vendorWorkbenchAccess(credential, ORG2_ID), await vendorWorkbenchAccess(credential, ORG_ID), "a forged org cookie is ignored");
        // A job token is never an account credential (VEN-14-AC7): every route sends it to the vendor sign-in.
        await assert.rejects(gateway(visit.token, ORG_ID), (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "42501");
        assert.deepEqual(await vendorWorkbenchAccess(visit.token, ORG_ID), { state: "anonymous" });
        assert.deepEqual(await routes(visit.token), SIGN_IN);
        assert.deepEqual(await routes(null, null), SIGN_IN);
        for (const [session, jobId, org, expected, why] of [
          [visit.token, visit.jobId, ORG_ID, `303 ${LOGIN}`, "token-only"], [null, visit.jobId, ORG_ID, `303 ${LOGIN}`, "no session"],
          [credential, stranger.jobId, ORG_ID, "404", "another vendor's job"],
          [credential, foreign.jobId, ORG_ID, "404", "another organization's job"],
          [credential, foreign.jobId, ORG2_ID, "404", "another organization's job, forged condola_org"],
          [otherCredential, foreign.jobId, ORG_ID, "404", "own ORG2 job while the current organization is ORG_ID"],
          [otherCredential, stranger.jobId, ORG2_ID, "404", "own ORG_ID job while the current organization is ORG2"],
          [otherCredential, visit.jobId, ORG_ID, "404", "other vendor"], [otherCredential, visit.jobId, ORG2_ID, "404", "other vendor, ORG2 scope"],
          [credential, tombstoned.jobId, ORG_ID, "404", "tombstoned link"], [credential, expiring.jobId, ORG_ID, "404", "expired link"],
          [credential, randomUUID(), ORG_ID, "404", "unknown job"], [credential, "not-a-uuid", ORG_ID, "404", "malformed"],
          // Positive controls with the same flags: the denials above come from authorization, not from OFF.
          [otherCredential, foreign.jobId, ORG2_ID, `303 /v/${foreign.token}`, "own ORG2 job, ORG2 current"],
          [otherCredential, stranger.jobId, ORG_ID, `303 /v/${stranger.token}`, "own ORG_ID job, ORG_ID current"],
          [credential, visit.jobId, ORG2_ID, `303 /v/${visit.token}`, "own job; the forged cookie falls back to the only account"],
        ] as const) assert.equal(await opened(session, jobId, org), expected, why);
        assert.deepEqual(await vendorWorkbenchJobOpen(credential, ORG_ID, tombstoned.jobId), { state: "missing" });
        assert.deepEqual(await snapshot(), before, "denials write nothing");
      } finally { await workbench(ORG2_ID, undefined, {}); }
    });

    await t.test("Row 查看 opens that job's existing page", async () => {
      const before = await snapshot();
      const response = await open(credential, visit.jobId);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), `/v/${visit.token}`);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(await opened(credential, billed.jobId), `303 /v/${billed.token}`);
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("Amounts waiting: the confirmed reported cost minus the vendor's own received marks; zero once a receipt is issued", async () => {
      const profile = (await sql(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,phone_e164)
        VALUES($1,$2,'B063','individual','Workbench vendor','+886912111222') RETURNING id`, [ORG_ID, visit.contact])).rows[0].id as string;
      const grant = (await sql(`INSERT INTO vendor_document_grants(org_id,ticket_id,job_id,vendor_profile_id,token_hash,buyer_selection,expires_at,created_by)
        VALUES($1,$2,$3,$4,$5,'{"kind":"company","name":"Fixture"}',now()+interval '1 day',$6) RETURNING id`, [ORG_ID, billed.ticketId, billed.jobId, profile, hash(randomUUID()), USERS.admin])).rows[0].id as string;
      const mark = (amount: number) => sql("INSERT INTO app.b025_received_marks(org_id,ticket_id,vendor_profile_id,grant_id,amount_minor,request_id) VALUES($1,$2,$3,$4,$5,$6)",
        [ORG_ID, billed.ticketId, profile, grant, amount, randomUUID()]);
      // Every amount read is bracketed: the reader and the gateway write nothing.
      const waiting = async () => {
        const before = await snapshot();
        const view = await vendorWorkbenchView(credential, ORG_ID, "zh-TW");
        assert.equal(view.status, "ready");
        assert.deepEqual(await snapshot(), before, "the amount read writes nothing");
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
    runtime.React = previousReact;
    cookieSpy.mock.restore(); headerSpy.mock.restore();
    if (brandEnv === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = brandEnv;
    __setVendorLinkKillSwitchForTests(false);
    await clone.cleanup();
  }
});
