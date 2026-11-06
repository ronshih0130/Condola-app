import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { Client } from "pg";
import nextHeaders from "next/headers";
import EnterPage from "../app/auth/enter/page";
import { GET as enterGET } from "../app/api/auth/enter/route";
import { actionAcceptReconsent } from "./consent-actions";
import { actionSignIn } from "./auth-actions";
import { readSession } from "./session";
import { withClient, svc } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { approveVendorSharing, dispatchVendor, loadVendorJob, __setVendorLinkKillSwitchForTests } from "./vendor-repair";
import { rebindVendorAccount, claimVendorAccount, correctVendorJobAccount, inviteVendorAccount, syncVendorAccount, vendorAccountHistory, vendorAccountLinkEvents } from "./vendor-accounts";
import { hashVendorToken } from "./vendor-repair-rules";
import { GET, POST } from "../app/api/vendor-account/route";
import { GET as staffGET, POST as staffPOST } from "../app/api/vendor-account-staff/route";
import { buildStoredConsent } from "./consent";
import { signIn } from "./auth";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "http://127.0.0.1:43123";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID,
  role: "admin", kind: "staff", name: "Staff", email: "staff@example.test", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
const coast: Session = { ...admin, userId: USERS.coastAdmin, sessionId: randomUUID(), orgId: ORG2_ID, liveOrgId: ORG2_ID };
const tables = ["app.b026_vendor_account_invites", "app.b026_vendor_accounts", "app.b026_vendor_job_accounts", "app.b026_vendor_link_events",
  "public.contacts", "public.auth_sessions", "public.repair_vendor_jobs", "public.repair_vendor_secrets", "public.maintenance_tickets", "public.audit_log"];
async function snapshot() {
  return withClient(async client => {
    const result: Record<string, string> = {};
    for (const table of tables) result[table] = (await client.query(`SELECT md5(coalesce(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) hash FROM ${table} r`)).rows[0].hash;
    return result;
  });
}
const sql = (q: string, values: unknown[] = []) => withClient(client => client.query(q, values));
function request(method: string, token?: string, body?: unknown) {
  return new Request(origin + "/api/vendor-account", { method, headers: { origin, "content-type": "application/json",
    ...(token ? { cookie: `condola_session=${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function flag(value: unknown, orgValue: unknown = true) {
  await sql("UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_account'", [JSON.stringify(value)]);
  await sql("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('vendor_account',$1::jsonb) WHERE id=$2", [JSON.stringify(orgValue), ORG_ID]);
}
const on = { enabled: true, allowed_org_ids: [ORG_ID] };
async function issue(contactId?: string, staff = admin) {
  const ticketId = randomUUID();
  await sql(`INSERT INTO maintenance_tickets(id,org_id,property_id,ticket_number,category,title,description,status)
    SELECT $1,$2,id,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),'plumbing','PRIVATE TITLE','PRIVATE DESCRIPTION','open' FROM properties WHERE org_id=$2 ORDER BY id LIMIT 1`, [ticketId, staff.orgId]);
  __setVendorLinkKillSwitchForTests(true);
  const job = await dispatchVendor(staff, ticketId, { vendorId: contactId, vendorName: contactId ? "" : `Account-${randomUUID()}`,
    vendorPhone: "0912111222", vendorTrade: "plumbing", contactWindow: "Monday" }, origin);
  __setVendorLinkKillSwitchForTests(true);
  try { await approveVendorSharing(staff, ticketId, job.jobId, { description: "Approved repair", attachmentIds: [] }); }
  finally { __setVendorLinkKillSwitchForTests(false); }
  const contact = (await sql("SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1", [job.jobId])).rows[0].vendor_contact_id as string;
  if (contactId) assert.equal(contact, contactId, "fixture must reuse the invited vendor contact");
  return { ...job, ticketId, contact, token: new URL(job.url).pathname.slice(3) };
}

test("B-026 account/job separation, V-12 and V-13", async t => {
  const clone = await cloneTestDatabase();
  const user = randomUUID(), other = randomUUID(), credential = randomUUID(), otherCredential = randomUUID(), staffCredential = randomUUID();
  try {
    await sql("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'vendor1@example.test',now()),($2,'vendor2@example.test',now())", [user, other]);
    for (const [id, userId, token] of [[admin.sessionId, admin.userId, staffCredential], [coast.sessionId, coast.userId, randomUUID()],
      [randomUUID(), user, credential], [randomUUID(), other, otherCredential]]) {
      await sql("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')", [id, userId, hash(token)]);
    }
    const consent = buildStoredConsent("portal");
    for (const principal of [user, admin.userId]) await sql("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [principal, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
    await sql("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}'::jsonb WHERE id=ANY($1::uuid[])", [[ORG_ID, ORG2_ID]]);
    __setVendorLinkKillSwitchForTests(true);
    const job = await issue();
    const closed = await issue(job.contact);
    const cancelled = await issue(job.contact);
    await sql("UPDATE maintenance_tickets SET status='closed' WHERE id=$1", [closed.ticketId]);
    await sql("UPDATE maintenance_tickets SET status='cancelled' WHERE id=$1", [cancelled.ticketId]);
    const unassigned = await issue();
    const foreign = await issue(undefined, coast);
    __setVendorLinkKillSwitchForTests(false);
    const legacy = JSON.stringify(await loadVendorJob(job.token));
    await flag(on);
    const invitation = await inviteVendorAccount(admin, job.contact, user);
    assert.equal(invitation.status, "invited");
    if (!invitation.invitation) throw new Error("fixture invitation missing");

    await t.test("OFF matrix is zero writes, including auth bookkeeping, with identical legacy bytes", async () => {
      for (const [value, orgValue] of [[{ enabled: false, allowed_org_ids: [ORG_ID] }, true],
        [{ enabled: "true", allowed_org_ids: [ORG_ID] }, true], [on, false], [on, "true"],
        [{ enabled: true, allowed_org_ids: [] }, true], [{ enabled: true, allowed_org_ids: {} }, true], [null, true], [{}, true]]) {
        await flag(value, orgValue);
        const before = await snapshot();
        assert.equal((await claimVendorAccount(credential, invitation.invitation!)).status, "disabled");
        assert.equal((await inviteVendorAccount(admin, job.contact, user)).status, "disabled");
        assert.equal((await correctVendorJobAccount(admin, job.jobId, null)).status, "disabled");
        assert.equal((await rebindVendorAccount(admin, job.contact, other)).status, "disabled");
        assert.deepEqual(await syncVendorAccount(credential), { linked: 0 });
        assert.deepEqual(await vendorAccountHistory(credential), { settings: [], jobs: [] });
        assert.equal((await GET(request("GET", credential))).status, 200);
        assert.equal((await POST(request("POST", credential, { action: "claim", invitation: invitation.invitation }))).status, 200);
        const staffRequest = new Request(origin + "/api/vendor-account-staff", { method: "POST",
          headers: { origin, cookie: `condola_session=${staffCredential}; condola_org=${ORG_ID}` },
          body: JSON.stringify({ action: "correct", jobId: job.jobId, userId: null }) });
        assert.equal((await staffPOST(staffRequest)).status, 200);
        assert.equal(JSON.stringify(await loadVendorJob(job.token)), legacy);
        assert.deepEqual(await snapshot(), before);
      }
      await sql("DELETE FROM platform_settings WHERE key='vendor_account'");
      const before = await snapshot();
      assert.equal((await claimVendorAccount(credential, invitation.invitation!)).status, "disabled");
      assert.deepEqual(await snapshot(), before);
      await sql("INSERT INTO platform_settings(key,value) VALUES('vendor_account',$1::jsonb)", [JSON.stringify(on)]);
      await flag(on);
    });
    await t.test("invitation is user-bound; token-only account/history/claim denied", async () => {
      const before = await snapshot();
      await assert.rejects(claimVendorAccount(otherCredential, invitation.invitation!));
      await assert.rejects(vendorAccountHistory(job.token));
      await assert.rejects(claimVendorAccount(job.token, invitation.invitation!));
      assert.equal((await GET(request("GET"))).status, 403);
      assert.equal((await GET(request("GET", job.token))).status, 403);
      assert.equal((await GET(request("GET", otherCredential))).status, 403, "current consent required");
      assert.equal((await POST(request("POST", job.token, { action: "claim", invitation: invitation.invitation }))).status, 403);
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("claim and login auto-link open jobs only, replay writes nothing", async () => {
      assert.equal((await claimVendorAccount(credential, invitation.invitation!)).status, "claimed");
      const view = await vendorAccountHistory(credential);
      assert.deepEqual(view.jobs.map(j => j.jobId), [job.jobId]);
      assert.equal(view.settings[0].contactId, job.contact);
      for (const forbidden of [closed.jobId, cancelled.jobId, unassigned.jobId, foreign.jobId, "PRIVATE", job.token]) assert.ok(!JSON.stringify(view).includes(forbidden));
      const before = await snapshot();
      await claimVendorAccount(credential, invitation.invitation!);
      assert.deepEqual(await syncVendorAccount(credential), { linked: 0 });
      assert.deepEqual(await snapshot(), before);
      const more = await issue(job.contact);
      assert.deepEqual(await syncVendorAccount(credential), { linked: 1 });
      await sql("UPDATE maintenance_tickets SET status='closed' WHERE id=$1", [more.ticketId]);
      const historyBefore = await snapshot();
      const history = await vendorAccountHistory(credential);
      assert.equal(history.jobs.find(j => j.jobId === more.jobId)?.readOnly, true);
      assert.deepEqual(await snapshot(), historyBefore, "closed history is write-free");
      await sql("UPDATE maintenance_tickets SET assigned_vendor_contact_id=NULL WHERE id=$1", [more.ticketId]);
      assert.ok(!(await vendorAccountHistory(credential)).jobs.some(j => j.jobId === more.jobId));
      await sql("UPDATE repair_vendor_jobs SET sharing_approved_at=NULL WHERE id=$1", [job.jobId]);
      assert.equal((await vendorAccountHistory(credential)).jobs.length, 0);
      await sql("UPDATE repair_vendor_jobs SET sharing_approved_at=clock_timestamp(),sharing_approved_by=$2,shared_description='Approved repair' WHERE id=$1", [job.jobId, admin.userId]);
    });
    await t.test("staff unlink suppresses re-link; correction and immutable trail, cross-org denied", async () => {
      assert.equal((await correctVendorJobAccount(admin, job.jobId, null)).status, "corrected");
      assert.deepEqual(await syncVendorAccount(credential), { linked: 0 });
      assert.ok(!(await vendorAccountHistory(credential)).jobs.some(j => j.jobId === job.jobId));
      assert.equal((await correctVendorJobAccount(admin, job.jobId, user)).status, "corrected");
      const before = await snapshot();
      assert.equal((await correctVendorJobAccount(admin, job.jobId, user)).status, "unchanged");
      await assert.rejects(correctVendorJobAccount(admin, foreign.jobId, user));
      await assert.rejects(correctVendorJobAccount(admin, job.jobId, other));
      await assert.rejects(inviteVendorAccount(admin, foreign.contact, user));
      assert.equal((await correctVendorJobAccount({ ...admin, orgId: ORG2_ID, liveOrgId: ORG2_ID }, foreign.jobId, null)).status, "disabled");
      const wrongEnvironment = await staffPOST(new Request(origin + "/api/vendor-account-staff", { method: "POST",
        headers: { origin, cookie: `condola_session=${staffCredential}; condola_org=${ORG_ID}; condola_env=sandbox` },
        body: JSON.stringify({ action: "correct", jobId: job.jobId, userId: null }) }));
      assert.notEqual(wrongEnvironment.status, 200, "sandbox context must never mutate the live job");
      assert.deepEqual(await snapshot(), before);
      const events = (await sql("SELECT reason,actor_id,previous_user_id,user_id FROM app.b026_vendor_link_events WHERE job_id=$1 ORDER BY created_at,id", [job.jobId])).rows;
      assert.deepEqual(events.map(e => e.reason), ["login_open_job", "staff_unlink", "staff_correct"]);
      const staffEvents = await vendorAccountLinkEvents(admin, job.jobId);
      assert.deepEqual(staffEvents.map(e => e.reason), events.map(e => e.reason));
      const response = await staffGET(new Request(origin + `/api/vendor-account-staff?jobId=${job.jobId}`, {
        headers: { cookie: `condola_session=${staffCredential}; condola_org=${ORG_ID}` } }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).length, 3);
      assert.equal(events[1].actor_id, admin.userId); assert.equal(events[1].previous_user_id, user); assert.equal(events[1].user_id, null);
      await assert.rejects(sql("UPDATE app.b026_vendor_link_events SET reason='staff_correct' WHERE job_id=$1", [job.jobId]));
      await assert.rejects(sql("DELETE FROM app.b026_vendor_link_events WHERE job_id=$1", [job.jobId]));
      await assert.rejects(svc(null, client => client.query("SELECT * FROM app.b026_vendor_accounts")));
    });
    await t.test("capability expires between resolver reads: no planner persistence or link", async () => {
      const expiring = await issue(job.contact);
      const original = Client.prototype.query;
      let resolverReads = 0;
      const spy = mock.method(Client.prototype, "query", async function(this: Client, ...args: unknown[]) {
        const text = String(args[0]);
        const result = await Reflect.apply(original, this, args);
        if (text.includes("FROM repair_vendor_secrets s") && text.includes("pg_catalog.sha256")) {
          resolverReads++;
          if (resolverReads === 1) await Reflect.apply(original, this, ["UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiring.jobId]]);
        }
        return result;
      });
      try {
        assert.deepEqual(await syncVendorAccount(credential), { linked: 0 });
        assert.equal(resolverReads, 1);
        assert.ok(spy.mock.calls.some(call => String(call.arguments[0]).includes("SELECT j.active,j.revoked_at,j.expires_at")));
        assert.ok(!spy.mock.calls.some(call => String(call.arguments[0]).includes("SELECT app.b026_link_vendor_job")));
      } finally { spy.mock.restore(); }
      assert.equal((await sql("SELECT count(*)::int n FROM app.b026_vendor_job_accounts WHERE job_id=$1", [expiring.jobId])).rows[0].n, 0);
      assert.equal((await sql("SELECT count(*)::int n FROM app.b026_vendor_link_events WHERE job_id=$1", [expiring.jobId])).rows[0].n, 0);
    });
    await t.test("real vendor password login routes to the account; new assigned jobs sync", async () => {
      const envKeys = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
      const saved = envKeys.map(key => [key, process.env[key]] as const);
      const fetchBefore = globalThis.fetch;
      try {
        for (const key of envKeys) process.env[key] = "";
        globalThis.fetch = async () => { throw new Error("External calls forbidden in local login test"); };
        await sql("UPDATE auth.users SET encrypted_password=crypt($2,gen_salt('bf')) WHERE id=$1", [user, "LocalFixturePassword42!"]);
        const login = await signIn("vendor1@example.test", "LocalFixturePassword42!", false, { ua: null, ip: null });
        assert.equal(login.ok, true);
        if (!login.ok) throw new Error("local login failed");
        assert.equal(login.destination, "vendor");
        const fresh = await issue(job.contact);
        const result = await POST(request("POST", login.token, { action: "sync" }));
        assert.equal(result.status, 200);
        assert.equal((await result.json()).linked, 1);
        const history = await GET(request("GET", login.token));
        assert.equal(history.status, 200);
        assert.ok((await history.json()).jobs.some((j: { jobId: string }) => j.jobId === fresh.jobId));
      } finally {
        globalThis.fetch = fetchBefore;
        for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    });
    await t.test("correct a mis-linked job after current assignment changes, preserving both actors", async () => {
      const wrong = await issue(job.contact);
      await syncVendorAccount(credential);
      const replacement = await inviteVendorAccount(admin, unassigned.contact, other);
      assert.ok(replacement.invitation);
      await claimVendorAccount(otherCredential, replacement.invitation);
      await sql("UPDATE maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1", [wrong.ticketId, unassigned.contact]);
      // Existing assignment triggers invalidate approval. Correct only to the current contact's accepted account.
      await sql("UPDATE repair_vendor_jobs SET vendor_contact_id=$2,active=true,revoked_at=NULL WHERE id=$1", [wrong.jobId, unassigned.contact]);
      __setVendorLinkKillSwitchForTests(true);
      try { await approveVendorSharing(admin, wrong.ticketId, wrong.jobId, { description: "Corrected assignment", attachmentIds: [] }); }
      finally { __setVendorLinkKillSwitchForTests(false); }
      assert.ok(!(await vendorAccountHistory(credential)).jobs.some(j => j.jobId === wrong.jobId));
      assert.equal((await correctVendorJobAccount(admin, wrong.jobId, other)).status, "corrected");
      assert.ok((await vendorAccountHistory(otherCredential)).jobs.some(j => j.jobId === wrong.jobId));
      const events = await vendorAccountLinkEvents(admin, wrong.jobId);
      assert.deepEqual(events.map(e => [e.reason,e.previousUserId,e.userId,e.actorId]),
        [["login_open_job",null,user,user],["staff_correct",user,other,admin.userId]]);
    });
    await t.test("staff rebinds the SAME contact, revokes every old invitation and removes former access", async () => {
      const wrong = await issue();
      await sql("UPDATE contacts SET user_id=$2 WHERE id=$1", [wrong.contact,user]);
      const first = await inviteVendorAccount(admin, wrong.contact, user);
      const spare = await inviteVendorAccount(admin, wrong.contact, user);
      assert.ok(first.invitation && spare.invitation);
      await claimVendorAccount(credential, first.invitation);
      const secondJob = await issue(wrong.contact);
      await syncVendorAccount(credential);
      const beforeDenied = await snapshot();
      await assert.rejects(rebindVendorAccount(admin, foreign.contact, other));
      await assert.rejects(rebindVendorAccount({ ...admin, userId: user }, wrong.contact, other));
      await assert.rejects(rebindVendorAccount(admin, wrong.contact, randomUUID()));
      assert.deepEqual(await snapshot(), beforeDenied);
      const response = await staffPOST(new Request(origin + "/api/vendor-account-staff", { method: "POST",
        headers: { origin, cookie: `condola_session=${staffCredential}; condola_org=${ORG_ID}` },
        body: JSON.stringify({ action: "rebind", contactId: wrong.contact, userId: other }) }));
      assert.equal(response.status, 200);
      const replacement = await response.json();
      assert.equal(replacement.status, "invited");
      for (const old of [first.invitation, spare.invitation]) await assert.rejects(claimVendorAccount(credential, old));
      assert.ok(!(await vendorAccountHistory(credential)).settings.some(c => c.contactId === wrong.contact));
      assert.ok(!(await vendorAccountHistory(credential)).jobs.some(j => [wrong.jobId,secondJob.jobId].includes(j.jobId)));
      await syncVendorAccount(credential);
      assert.equal((await sql("SELECT count(*)::int n FROM app.b026_vendor_job_accounts WHERE contact_id=$1 AND user_id IS NOT NULL", [wrong.contact])).rows[0].n, 0);
      await assert.rejects(claimVendorAccount(credential, replacement.invitation));
      await claimVendorAccount(otherCredential, replacement.invitation);
      assert.ok(!(await vendorAccountHistory(otherCredential)).jobs.some(j => j.jobId === wrong.jobId), "historical tombstones need explicit staff correction");
      assert.equal((await correctVendorJobAccount(admin, wrong.jobId, other)).status, "corrected");
      assert.ok((await vendorAccountHistory(otherCredential)).jobs.some(j => j.jobId === wrong.jobId));
      assert.equal((await sql("SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1", [wrong.jobId])).rows[0].vendor_contact_id, wrong.contact);
      assert.equal((await sql("SELECT assigned_vendor_contact_id FROM maintenance_tickets WHERE id=$1", [wrong.ticketId])).rows[0].assigned_vendor_contact_id, wrong.contact);
      assert.equal((await sql("SELECT user_id FROM contacts WHERE id=$1", [wrong.contact])).rows[0].user_id,other);
      const events = await vendorAccountLinkEvents(admin, wrong.jobId);
      assert.deepEqual(events.map(e => [e.reason,e.previousUserId,e.userId,e.actorId]),
        [["login_open_job",null,user,user],["staff_unlink",user,null,admin.userId],["staff_correct",null,other,admin.userId]]);
      const rebound = (await sql("SELECT * FROM app.b026_vendor_link_events WHERE contact_id=$1 AND reason='staff_rebind'", [wrong.contact])).rows;
      assert.equal(rebound.length, 1);
      assert.equal(rebound[0].previous_user_id, user); assert.equal(rebound[0].user_id, other); assert.equal(rebound[0].actor_id, admin.userId);
      const audits = (await sql("SELECT new_row FROM audit_log WHERE row_id=$1 AND event_type='vendor_account_rebound'", [wrong.contact])).rows;
      assert.equal(audits.length, 1);
      assert.ok(!JSON.stringify(audits).includes(replacement.invitation));
    });
    await t.test("missing/stale consent traverses the real login action, entry page and existing acceptance action", async () => {
      const envKeys = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
      const saved = envKeys.map(key => [key, process.env[key]] as const);
      const fetchSpy = mock.method(globalThis, "fetch", async () => { throw new Error("External calls forbidden"); });
      const jar = new Map<string,string>();
      let path = "/login";
      const cookieSpy = mock.method(nextHeaders, "cookies", async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key)! } : undefined,
        set: (key: string, value: string) => { jar.set(key,value); }, delete: (key: string) => { jar.delete(key); } }));
      const headerSpy = mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": path }));
      async function redirects(run: Promise<unknown>, location: string) {
        await assert.rejects(run, (e: unknown) => (e as { digest?: string }).digest === `NEXT_REDIRECT;replace;${location};307;`);
      }
      try {
        for (const key of envKeys) process.env[key] = "";
        for (const stale of [false,true]) {
          jar.clear(); path = "/login";
          const id = randomUUID(), email = `${id}@vendor.example.test`;
          await sql("INSERT INTO auth.users(id,email,email_confirmed_at,encrypted_password) VALUES($1,$2,now(),crypt($3,gen_salt('bf')))", [id,email,"LocalFixturePassword42!"]);
          if (stale) await sql("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,now(),'old','old','reconsent')", [id]);
          const assigned = await issue();
          const invite = await inviteVendorAccount(admin, assigned.contact, id);
          assert.ok(invite.invitation);
          const login = new FormData(); login.set("email",email); login.set("password","LocalFixturePassword42!"); login.set("next","https://evil.example/");
          await redirects(actionSignIn(login), "/auth/enter?next=%2Fvendor-account");
          const token = jar.get("condola_session")!;
          assert.ok(token);
          path = "/auth/enter";
          assert.equal(await readSession(), null, "vendor identity has no persona");
          const gate = "/consent?next=%2Fvendor-account";
          await redirects(EnterPage({ searchParams: Promise.resolve({ next: "/vendor-account" }) }),gate);
          assert.equal((await enterGET(new Request(origin+"/api/auth/enter?next=%2Fvendor-account"))).headers.get("location"),gate);
          assert.equal((await GET(request("GET",token))).status,403);
          assert.equal((await POST(request("POST",token,{ action: "claim", invitation: invite.invitation }))).status,403);
          const accept = new FormData(); accept.set("next","/vendor-account");
          path = "/consent";
          await redirects(actionAcceptReconsent(accept),gate+"&error=consent");
          accept.set("consent","on");
          await redirects(actionAcceptReconsent(accept),"/vendor-account");
          path = "/auth/enter";
          await redirects(EnterPage({ searchParams: Promise.resolve({ next: "/vendor-account" }) }),"/vendor-account");
          for (const unsafe of ["https://evil.example/", "//evil.example/", "/\\evil.example/"]) {
            await redirects(EnterPage({ searchParams: Promise.resolve({ next: unsafe }) }),"/auth/continue");
            accept.set("next",unsafe);
            await redirects(actionAcceptReconsent(accept),"/signup/firm");
          }
          assert.equal((await POST(request("POST",token,{ action: "claim", invitation: invite.invitation }))).status,200);
          assert.ok((await (await GET(request("GET",token))).json()).jobs.some((j: { jobId: string }) => j.jobId===assigned.jobId));
        }
      } finally {
        cookieSpy.mock.restore(); headerSpy.mock.restore(); fetchSpy.mock.restore();
        for (const [key,value] of saved) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
      }
    });
    await t.test("non-vendor OFF login has legacy query count, no service transaction and no B-026 function dependency", async () => {
      const envKeys = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
      const saved = envKeys.map(key => [key,process.env[key]] as const);
      const id=randomUUID(), email=`${id}@nonvendor.example.test`;
      await sql("INSERT INTO auth.users(id,email,email_confirmed_at,encrypted_password) VALUES($1,$2,now(),crypt($3,gen_salt('bf')))", [id,email,"LocalFixturePassword42!"]);
      await sql("ALTER FUNCTION app.b026_vendor_login_access(uuid) RENAME TO b026_vendor_login_access_unavailable");
      const fetchSpy=mock.method(globalThis,"fetch",async () => { throw new Error("External calls forbidden"); });
      try {
        for (const key of envKeys) process.env[key]="";
        for (const value of [{ enabled:false,allowed_org_ids:[ORG_ID] },{},null,{ enabled:"true",allowed_org_ids:[ORG_ID] },{ enabled:true,allowed_org_ids:{} }, "missing"]) {
          if (value === "missing") await sql("DELETE FROM platform_settings WHERE key='vendor_account'");
          else await flag(value);
          const original=Client.prototype.query;
          const statements: string[]=[];
          const spy=mock.method(Client.prototype,"query",function(this: Client,...args: unknown[]) {
            statements.push(String(args[0])); return Reflect.apply(original,this,args);
          });
          try {
            const result=await signIn(email,"LocalFixturePassword42!",false,{ ua:null,ip:null });
            assert.ok(result.ok); if (!result.ok) throw new Error("login failed");
            assert.equal(result.destination,"firm");
            assert.ok(!statements.some(q => /b026_|BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE/.test(q)));
            assert.equal(statements.length,10,"legacy no-persona login uses ten queries");
          } finally { spy.mock.restore(); }
        }
      } finally {
        fetchSpy.mock.restore();
        await sql("ALTER FUNCTION app.b026_vendor_login_access_unavailable(uuid) RENAME TO b026_vendor_login_access");
        await sql("INSERT INTO platform_settings(key,value) VALUES('vendor_account',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(on)]);
        await flag(on);
        for (const [key,value] of saved) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
      }
    });
    await t.test("request lock precedes ticket/jobs; expiry while waiting writes no link", async () => {
      const j = await issue(job.contact);
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      const observer = new Client({ connectionString: process.env.DATABASE_URL });
      let pending: Promise<{ rows: { linked: boolean }[] }> | undefined;
      try {
        await blocker.connect(); await observer.connect();
        await blocker.query("BEGIN");
        const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('b026/accounts/'||$1::text,0))", [ORG_ID]);
        pending = svc(null, client => client.query<{ linked: boolean }>("SELECT app.b026_link_vendor_job($1,$2) linked", [hash(credential), hashVendorToken(j.token)]));
        void pending.catch(() => {});
        const deadline = Date.now()+5000;
        let waiting = false;
        while (Date.now()<deadline) {
          waiting = (await observer.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event='advisory') waiting", [pid])).rows[0].waiting;
          if (waiting) break;
        }
        assert.ok(waiting);
        await blocker.query("SELECT id FROM maintenance_tickets WHERE id=$1 FOR UPDATE NOWAIT", [j.ticketId]);
        await blocker.query("SELECT id FROM repair_vendor_jobs WHERE ticket_id=$1 ORDER BY id FOR UPDATE NOWAIT", [j.ticketId]);
        await blocker.query("UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [j.jobId]);
        await blocker.query("COMMIT");
        assert.equal((await pending).rows[0].linked, false);
        assert.equal((await sql("SELECT count(*)::int n FROM app.b026_vendor_link_events WHERE job_id=$1", [j.jobId])).rows[0].n, 0);
      } finally {
        await blocker.query("ROLLBACK");
        try { await pending; } finally { await blocker.end(); await observer.end(); }
      }
    });
    await t.test("flag lock, expired session and stale capability fail closed at the gateway", async () => {
      const j = await issue(job.contact);
      await sql("UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [j.jobId]);
      const before = await snapshot();
      const linked = await svc(null, client => client.query("SELECT app.b026_link_vendor_job($1,$2) linked", [hash(credential), hashVendorToken(j.token)]));
      assert.equal(linked.rows[0].linked, false);
      assert.deepEqual(await snapshot(), before);
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("UPDATE platform_settings SET value=value WHERE key='vendor_account'");
        await assert.rejects(correctVendorJobAccount(admin, job.jobId, null), (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "55P03");
      } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
      await sql("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hash(credential)]);
      await assert.rejects(vendorAccountHistory(credential));
      assert.equal((await GET(request("GET", credential))).status, 403);
    });
    assert.match(readFileSync("src/server/vendor-link-rules.ts", "utf8"), /VENDOR_LINK_ENABLED = false/);
  } finally {
    __setVendorLinkKillSwitchForTests(false);
    await clone.cleanup();
  }
});
