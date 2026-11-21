import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { GET as apiGET, POST } from "../app/api/m/units/[unitId]/staff-invite/[[...view]]/route";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffInvitePanel } from "../components/staff-invite/panel";
// Render the same React component from the guarded page-data endpoint.
async function GET(...args: Parameters<typeof apiGET>) {
  const response = await apiGET(...args);
  if (!response.ok || (await args[1].params).view?.[0] === "live") return response;
  const props = await response.json();
  return new Response(renderToStaticMarkup(React.createElement(StaffInvitePanel, { ...props, origin: "http://127.0.0.1" })), { status: response.status, headers: response.headers });
}
import { GET as oldGET, POST as oldPOST } from "../app/api/m/units/[unitId]/invite/route";
import { SESSION_COOKIE } from "./auth";
import { ORG_COOKIE, ENV_COOKIE } from "./org-scope";
import { buildStoredConsent } from "./consent";
import { query } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { getSession, sessionTokenHash } from "./session";
import { cloneTestDatabase } from "./test-database-clone";
import { acceptBind, currentInvite, hashInviteToken, listBindings } from "./unit-line-invite";
import { mutateStaffInvite, staffInviteData, staffInviteEntries, staffInviteVisible } from "./b040-staff-ui";

// Written for the full migrated local disposable clone; not run on this Mac.
// No migrations are applied here and every person/token is a synthetic fixture.
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let sessionToken = "";
mock.method(nextHeaders, "cookies", async () => ({ get(name: string) {
  const value = name === SESSION_COOKIE ? sessionToken : name === ORG_COOKIE ? ORG_ID : name === ENV_COOKIE ? "live" : name === "condola_locale" ? "en" : "";
  return value ? { value } : undefined;
} }));
mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/m/units", origin: "http://127.0.0.1" }));

test.before(async () => {
  clone = await cloneTestDatabase();
  assert.ok((await query("SELECT to_regclass('app.unit_invite_display') AS ready")).rows[0].ready, "run the existing migrations in the disposable test template first");
  await flag(true);
});
test.after(async () => { mock.restoreAll(); await clone?.cleanup(); });

async function flag(on: boolean) {
  await query(`INSERT INTO platform_settings(key,value) VALUES('unit_line_invite',$1::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ enabled: on, allowed_org_ids: [ORG_ID, ORG2_ID] })]);
  await query(`UPDATE organizations SET feature_flags=coalesce(feature_flags,'{}'::jsonb)||jsonb_build_object('unit_line_invite',$1::boolean)
    WHERE id=ANY($2::uuid[])`, [on, [ORG_ID, ORG2_ID]]);
}
async function login(userId = USERS.admin as string) {
  sessionToken = randomUUID();
  await query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`, [userId, sessionTokenHash(sessionToken)]);
  const consent = buildStoredConsent("reconsent");
  await query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,
    [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  const session = await getSession();
  assert.equal(session.userId, userId); assert.equal(session.orgId, ORG_ID);
  return session;
}
async function fixture(orgId = ORG_ID) {
  const property = (await query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode)
    VALUES($1,$2,'TW','TWD','Asia/Taipei','whole_unit') RETURNING id::text`, [orgId, `B040 fixture ${randomUUID()}`])).rows[0].id;
  const unit = (await query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'3F','whole_unit') RETURNING id::text`, [orgId, property])).rows[0].id;
  const lease = (await query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$3,'active','2030-01-01','2030-12-31','TWD',10000) RETURNING id::text`, [orgId, property, unit])).rows[0].id;
  const contact = (await query<{ id: string }>(`INSERT INTO contacts(org_id,display_name,is_tenant) VALUES($1,'Same name',true) RETURNING id::text`, [orgId])).rows[0].id;
  await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [orgId, lease, contact]);
  return { property, unit, lease };
}
function get(unitId: string, view: string[] = []) {
  return GET(new Request(`http://127.0.0.1/m/units/${unitId}/invite/${view.join("/")}`), { params: Promise.resolve({ unitId, view }) });
}
function post(unitId: string, action: string, extra: [string, string][] = [], origin = "http://127.0.0.1") {
  return POST(new Request(`http://127.0.0.1/m/units/${unitId}/invite`, {
    method: "POST", headers: { origin, host: "127.0.0.1", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([["action", action], ...extra]),
  }), { params: Promise.resolve({ unitId }) });
}
async function bind(unitId: string, token: string) {
  return acceptBind({ orgId: ORG_ID, unitId, token, lineSub: `synthetic-${randomUUID()}`, enteredName: "Same name", displayName: "Fixture LINE" });
}

test("MGT-39 / MGT-51 / R-a4: issue → panel, repeat entry and print keep the same secret; headers on every token surface", async () => {
  const session = await login(); const f = await fixture();
  assert.equal((await get(f.unit)).status, 200);
  const first = await currentInvite(session, f.unit); assert.ok(first);
  const panel = await staffInviteData(session, f.unit);
  assert.equal(panel.invite?.path, first.path); assert.equal(panel.bindings.length, 0);
  assert.equal((await post(f.unit, "issue")).status, 303);
  assert.equal((await currentInvite(session, f.unit))?.token, first.token);
  for (const view of [[], ["qr"], ["print"], ["rotate"], ["tenants"], ["lease", f.lease], ["live"]]) {
    const response = await get(f.unit, view);
    assert.equal(response.status, 200, view.join("/"));
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const entries = await staffInviteEntries(session, [{ id: f.unit, kind: "whole_unit" }]);
  assert.equal(entries[0].unitId, f.unit); assert.ok(!JSON.stringify(entries).includes(first.token));
});

test("MGT-40 / MGT-50 / R-c3: rotate revokes the old secret and preserves bindings; remove frees a full seat without deleting data", async () => {
  const session = await login(); const f = await fixture();
  await post(f.unit, "issue"); const invite = await currentInvite(session, f.unit); assert.ok(invite);
  const joined: Awaited<ReturnType<typeof bind>>[] = [];
  for (let i = 0; i < 4; i++) joined.push(await bind(f.unit, invite.token));
  assert.equal((await post(f.unit, "rotate")).status, 303);
  const rotated = await currentInvite(session, f.unit); assert.ok(rotated); assert.notEqual(rotated.token, invite.token);
  const old = await query<{ revoked_at: Date | null }>(`SELECT revoked_at FROM app.unit_invite_secrets WHERE token_hash=$1`, [hashInviteToken(invite.token)]);
  assert.ok(old.rows[0].revoked_at);
  await assert.rejects(() => bind(f.unit, invite.token), e => e instanceof FlowError && e.key === "errors.revoked");
  assert.equal((await staffInviteData(session, f.unit)).bindings.length, 4);
  assert.doesNotMatch(await (await get(f.unit, ["qr"])).text(), /<svg/);
  assert.equal((await post(f.unit, "remove", [["bindingId", joined[0].bindingId]])).status, 303);
  assert.equal((await currentInvite(session, f.unit))?.bound, 3);
  assert.equal((await currentInvite(session, f.unit))?.token, rotated.token);
  const retained = (await listBindings(session, f.unit)).find(b => b.id === joined[0].bindingId);
  assert.equal(retained?.status, "unlinked");
  await bind(f.unit, rotated.token);
  assert.equal((await currentInvite(session, f.unit))?.bound, 4);
});

test("MGT-42 / R-b1 / R-b6: equal names never auto-match; only explicitly ticked pending bindings become parties", async () => {
  const session = await login(); const f = await fixture();
  await post(f.unit, "issue"); const invite = await currentInvite(session, f.unit); assert.ok(invite);
  const first = await bind(f.unit, invite.token), second = await bind(f.unit, invite.token);
  const before = (await listBindings(session, f.unit));
  assert.ok(before.every(b => b.status === "pending"));
  const page = await get(f.unit, ["lease", f.lease]); assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /\bchecked(?:=|\s|>)/);
  assert.equal((await post(f.unit, "include", [["leaseId", f.lease]])).status, 303);
  assert.ok((await listBindings(session, f.unit)).every(b => b.status === "pending"));
  assert.equal((await post(f.unit, "include", [["leaseId", f.lease], ["bindingIds", first.bindingId]])).status, 303);
  const after = await listBindings(session, f.unit);
  assert.equal(after.find(b => b.id === first.bindingId)?.status, "lease_linked");
  assert.equal(after.find(b => b.id === second.bindingId)?.status, "pending");
  const parties = await query<{ user_id: string }>(`SELECT c.user_id::text FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id WHERE lp.lease_id=$1`, [f.lease]);
  assert.ok(parties.rows.some(p => p.user_id === first.userId)); assert.ok(!parties.rows.some(p => p.user_id === second.userId));
});

test("MGT-48 / MGT-49 / MGT-52-AC3 / R-X-perm: maintenance and accountant receive 403 on every new HTTP surface and command", async () => {
  const f = await fixture();
  for (const user of [USERS.maintenance, USERS.accountant]) {
    const session = await login(user);
    assert.equal(await staffInviteVisible(session), false);
    for (const view of [[], ["qr"], ["print"], ["rotate"], ["tenants"], ["remove", randomUUID()], ["lease"], ["lease", f.lease], ["live"], ["rotated"], ["removed"], ["saved"]]) assert.equal((await get(f.unit, view)).status, 403);
    for (const action of ["issue", "rotate", "remove", "include"] as const) {
      assert.equal((await post(f.unit, action)).status, 403);
      await assert.rejects(() => mutateStaffInvite(session, f.unit, { action }), e => e instanceof FlowError && e.key === "errors.forbidden");
    }
    assert.equal((await oldGET(new Request(`http://127.0.0.1/api/m/units/${f.unit}/invite`), { params: Promise.resolve({ unitId: f.unit }) })).status, 403);
    for (const action of ["issue", "rotate"]) assert.equal((await oldPOST(new Request(`http://127.0.0.1/api/m/units/${f.unit}/invite`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }), { params: Promise.resolve({ unitId: f.unit }) })).status, 403);
  }
});

test("PLT-23 / R-X-leak: cross-org unit, other-unit binding/lease and forged body org are forbidden", async () => {
  await login(); const otherOrg = await fixture(ORG2_ID); const a = await fixture(), b = await fixture();
  for (const view of [[], ["qr"], ["print"], ["tenants"], ["live"], ["lease"]]) assert.equal((await get(otherOrg.unit, view)).status, 403);
  for (const action of ["issue", "rotate", "remove", "include"]) assert.equal((await post(otherOrg.unit, action, [["orgId", ORG2_ID]])).status, 403);
  const session = await getSession(); await post(b.unit, "issue");
  const invite = await currentInvite(session, b.unit); assert.ok(invite); const bound = await bind(b.unit, invite.token);
  assert.equal((await post(a.unit, "remove", [["bindingId", bound.bindingId]])).status, 403);
  assert.equal((await post(a.unit, "include", [["leaseId", b.lease], ["bindingIds", bound.bindingId]])).status, 403);
  assert.equal((await get(a.unit, ["lease", b.lease])).status, 403);
  // Supplying another org never changes the session's authority.
  assert.equal((await post(a.unit, "issue", [["orgId", ORG2_ID]])).status, 303);
  const ownInvite = await currentInvite(session, a.unit); assert.ok(ownInvite);
  const ownBinding = await bind(a.unit, ownInvite.token);
  assert.equal((await post(a.unit, "include", [["leaseId", b.lease], ["bindingIds", ownBinding.bindingId]])).status, 403);
  assert.equal((await post(a.unit, "rotate", [], "https://untrusted.invalid")).status, 403);
});

test("PLT-23 / FLAG-OFF: no U0 entry or new routes; direct mutations cannot issue", async () => {
  const session = await login(); const f = await fixture(); await flag(false);
  try {
    assert.equal(await staffInviteVisible(session), false);
    assert.deepEqual(await staffInviteEntries(session, [{ id: f.unit, kind: "whole_unit" }]), []);
    for (const view of [[], ["qr"], ["print"], ["tenants"], ["live"], ["lease"]]) assert.equal((await get(f.unit, view)).status, 404);
    for (const action of ["issue", "rotate", "remove", "include"]) assert.equal((await post(f.unit, action)).status, 404);
  } finally { await flag(true); }
});


test("MGT-39 / R-a4: manager native no-referrer confirmation works only with same-origin navigation metadata", async () => {
  const session = await login(USERS.manager); const f = await fixture();
  const call = (site: string) => POST(new Request(`http://127.0.0.1/m/units/${f.unit}/invite`, {
    method: "POST", headers: { origin: "null", host: "127.0.0.1", "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action: "issue" }),
  }), { params: Promise.resolve({ unitId: f.unit }) });
  assert.equal((await call("cross-site")).status, 403);
  assert.equal(await currentInvite(session, f.unit), null);
  assert.equal((await call("same-origin")).status, 303);
  assert.ok(await currentInvite(session, f.unit));
});
