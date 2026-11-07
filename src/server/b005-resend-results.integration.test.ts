import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PortalResendResult } from "../components/portal-resend-result";
import { simulatedResult } from "../lib/portal-resend-state";
import { query, tx } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { portalResendControl, portalResendOn, resendPortalInvite } from "./portal-resend";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
const session: Session = { userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", kind: "staff", role: "admin", sessionId: randomUUID(), email: "", name: "", locale: "en", calendar: "gregorian", leaseId: null };
const scope = { orgId: ORG_ID, environment: "live" as const };
async function flags(value: unknown = { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] }, orgFlag: unknown = true) {
  await query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='INVITE_RESEND_RESULTS'`, [JSON.stringify(value)]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('INVITE_RESEND_RESULTS',$1::jsonb) WHERE id IN ($2,$3)`, [JSON.stringify(orgFlag), ORG_ID, ORG2_ID]);
}
async function fixture(orgId = ORG_ID) {
  const contact = randomUUID(), sourceId = randomUUID();
  await query(`INSERT INTO contacts(id,org_id,display_name,is_owner) VALUES($1,$2,'Synthetic resend',true)`, [contact, orgId]);
  await query(`INSERT INTO invitations(id,org_id,kind,contact_id,email,code_hash) VALUES($1,$2,'owner',$3,'private@example.invalid',$4)`, [sourceId, orgId, contact, randomUUID()]);
  return { sourceId, requestId: randomUUID() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function rows() {
  return (await query(`SELECT (SELECT count(*) FROM app.b005_resend_requests)::int AS requests,
    (SELECT count(*) FROM audit_log)::int AS audits,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invitations i) AS invitations`)).rows[0];
}
test.before(async () => { clone = await cloneTestDatabase(); });
test.beforeEach(async () => { await flags(); });
test.after(async () => { await clone?.cleanup(); });

test("strict flag OFF and malformed controls return disabled before any writes", async () => {
  const input = await fixture();
  let calls = 0;
  for (const [global, org] of [
    [{ enabled: false, allowed_org_ids: [ORG_ID] }, true],
    [{ enabled: "true", allowed_org_ids: [ORG_ID] }, true],
    [{ enabled: true, allowed_org_ids: ORG_ID }, true],
    [{ enabled: true, allowed_org_ids: [] }, true],
    [{ enabled: true, allowed_org_ids: [ORG_ID] }, "true"],
    [null, true],
  ] as const) {
    await flags(global, org);
    const before = await rows();
    assert.equal(portalResendOn(global, { INVITE_RESEND_RESULTS: org }, ORG_ID), false);
    assert.deepEqual(await resendPortalInvite(session, input, { transport: async () => { calls++; return "captured"; } }), simulatedResult("disabled"));
    assert.equal(await portalResendControl(session, randomUUID(), "owner"), null);
    assert.deepEqual(await rows(), before);
  }
  await query(`DELETE FROM platform_settings WHERE key='INVITE_RESEND_RESULTS'`);
  const before = await rows();
  assert.deepEqual(await resendPortalInvite(session, input), simulatedResult("disabled"));
  assert.deepEqual(await rows(), before);
  assert.equal(calls, 0);
  await query(`INSERT INTO platform_settings(key,value) VALUES('INVITE_RESEND_RESULTS','{}')`);
});

test("same request replays across calls; source/request/payload/generation conflicts never send twice", async () => {
  const input = await fixture(), other = await fixture();
  const started = deferred<void>(), transport = deferred<"captured">();
  let calls = 0;
  const deps = { timeoutMs: 5000, transport: () => { calls++; started.resolve(); return transport.promise; } };
  const a = resendPortalInvite(session, input, deps);
  await started.promise;
  const b = resendPortalInvite(session, { ...input }, deps);
  assert.deepEqual(await resendPortalInvite(session, { ...other, requestId: input.requestId }), simulatedResult("conflict"));
  assert.deepEqual(await resendPortalInvite(session, { ...input, requestId: randomUUID() }), simulatedResult("conflict"));
  transport.resolve("captured");
  assert.deepEqual(await a, simulatedResult("captured"));
  // Start a separate replay after settling too; no process cache can satisfy it.
  assert.deepEqual(await b, await a);
  assert.deepEqual(await resendPortalInvite(session, input), await a);
  await query(`UPDATE invitations SET email='changed@example.invalid' WHERE id=$1`, [input.sourceId]);
  assert.deepEqual(await resendPortalInvite(session, input), simulatedResult("conflict"));
  await query(`UPDATE invitations SET email='private@example.invalid' WHERE id=$1`, [input.sourceId]);
  await query(`UPDATE invitations SET created_at=created_at+interval '1 second' WHERE id=$1`, [input.sourceId]);
  assert.deepEqual(await resendPortalInvite(session, input), simulatedResult("conflict"));
  assert.deepEqual(await resendPortalInvite(session, { ...input, requestId: randomUUID() }), simulatedResult("conflict"));
  assert.equal(calls, 1);
});

test("unknown is terminal at the deadline even when transport later resolves", async () => {
  const input = await fixture();
  const started = deferred<void>(), transport = deferred<"accepted">();
  let signal: AbortSignal | undefined;
  const pending = resendPortalInvite(session, input, { timeoutMs: 200, transport: s => { signal = s; started.resolve(); return transport.promise; } });
  await started.promise;
  assert.deepEqual(await pending, simulatedResult("unknown"));
  assert.equal(signal?.aborted, true);
  transport.resolve("accepted");
  assert.deepEqual(await resendPortalInvite(session, input), simulatedResult("unknown"));
  const late = await tx(session.userId, client => client.query(`SELECT app.b005_resend_settle($1,$2,'accepted') AS status`, [ORG_ID, input.requestId]), scope);
  assert.equal(late.rows[0].status, "unknown");
  assert.deepEqual(await resendPortalInvite(session, { ...input, requestId: randomUUID() }), simulatedResult("conflict"));
  await query(`UPDATE invitations SET created_at=created_at+interval '1 second' WHERE id=$1`, [input.sourceId]);
  assert.deepEqual(await resendPortalInvite(session, { ...input, requestId: randomUUID() }), simulatedResult("conflict"));
});

test("lost worker claims expire durably without another transport call", async () => {
  const input = await fixture();
  await tx(session.userId, client => client.query(`SELECT * FROM app.b005_resend_claim($1,$2,$3,1)`, [ORG_ID, input.sourceId, input.requestId]), scope);
  let calls = 0;
  assert.deepEqual(await resendPortalInvite(session, input, { transport: async () => { calls++; return "accepted"; } }), simulatedResult("unknown"));
  assert.equal(calls, 0);
});

test("completed links and connected contacts bypass transport without resetting invitation state", async () => {
  for (const connectedContact of [false, true]) {
    const input = await fixture();
    if (connectedContact) {
      const userId = randomUUID();
      await query(`INSERT INTO auth.users(id,email,encrypted_password) VALUES($1,$2,'synthetic-ready')`, [userId, `${userId}@example.invalid`]);
      await query(`UPDATE contacts SET user_id=$1 WHERE id=(SELECT contact_id FROM invitations WHERE id=$2)`, [userId, input.sourceId]);
      await query(`UPDATE invitations SET expires_at=now()-interval '1 day' WHERE id=$1`, [input.sourceId]);
    } else {
      await query(`UPDATE invitations SET status='accepted',accepted_by=$1,accepted_at=now() WHERE id=$2`, [USERS.owner, input.sourceId]);
    }
    const before = await rows();
    let calls = 0;
    assert.deepEqual(await resendPortalInvite(session, input, { transport: async () => { calls++; throw Error("private token address"); } }), simulatedResult("already_connected"));
    assert.equal(calls, 0);
    assert.deepEqual(await rows(), before);
  }
});

test("rejection releases reservation; acceptance retains it; malformed identifiers write nothing", async () => {
  const input = await fixture();
  let calls = 0;
  const deps = { transport: async () => ++calls === 1 ? "rejected" : "accepted" };
  const before = await rows();
  assert.deepEqual(await resendPortalInvite(session, { ...input, requestId: "-".repeat(36) }, deps), simulatedResult("conflict"));
  assert.deepEqual(await rows(), before);
  assert.deepEqual(await resendPortalInvite(session, input, deps), simulatedResult("rejected"));
  assert.deepEqual(await resendPortalInvite(session, input, deps), simulatedResult("rejected"));
  await query(`UPDATE invitations SET created_at=created_at+interval '1 second' WHERE id=$1`, [input.sourceId]);
  const next = { ...input, requestId: randomUUID() };
  assert.deepEqual(await resendPortalInvite(session, next, deps), simulatedResult("accepted"));
  assert.deepEqual(await resendPortalInvite(session, next, deps), simulatedResult("accepted"));
  assert.deepEqual(await resendPortalInvite(session, { ...input, requestId: randomUUID() }, deps), simulatedResult("conflict"));
  assert.equal(calls, 2);
});

test("identity is canonical, different actors share the reservation, organizations remain independent", async () => {
  const input = await fixture();
  const first = await resendPortalInvite(session, input);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(await resendPortalInvite({ ...session, orgId: ORG_ID.toUpperCase(), userId: USERS.admin.toUpperCase() }, { sourceId: input.sourceId.toUpperCase(), requestId: input.requestId.toUpperCase() }), first);
  assert.deepEqual(await resendPortalInvite({ ...session, userId: USERS.manager, role: "manager" }, input), simulatedResult("conflict"));
  const other = await fixture(ORG2_ID);
  assert.deepEqual(await resendPortalInvite({ ...session, orgId: ORG2_ID, liveOrgId: ORG2_ID, userId: USERS.coastAdmin }, { ...other, requestId: input.requestId }), simulatedResult("captured"));
});

test("transport errors and unexpected values become private terminal unknown results", async () => {
  for (const transport of [async () => { throw Error("private transport token"); }, async () => ({ token: "private" })]) {
    const input = await fixture();
    const result = await resendPortalInvite(session, input, { transport });
    assert.deepEqual(result, simulatedResult("unknown"));
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.deepEqual(await resendPortalInvite(session, { ...input, requestId: randomUUID() }), simulatedResult("conflict"));
  }
});

test("unavailable invite, cross-org and non-admin/manager identities cannot reserve", async () => {
  const input = await fixture();
  const before = await rows();
  for (const actor of [USERS.accountant, USERS.maintenance, USERS.tenant, USERS.coastAdmin]) {
    // Even a forged server role cannot bypass the DB membership check.
    assert.deepEqual(await resendPortalInvite({ ...session, userId: actor }, input), simulatedResult("unavailable"));
  }
  assert.deepEqual(await resendPortalInvite({ ...session, kind: "owner" }, input), simulatedResult("unavailable"));
  const other = await fixture(ORG2_ID);
  const afterFixture = await rows();
  assert.deepEqual(await resendPortalInvite(session, other), simulatedResult("unavailable"));
  assert.deepEqual(await resendPortalInvite(session, { sourceId: randomUUID(), requestId: randomUUID() }), simulatedResult("unavailable"));
  assert.deepEqual(await rows(), afterFixture);
  assert.equal(afterFixture.requests, before.requests);
  await query(`UPDATE invitations SET status='revoked' WHERE id=$1`, [input.sourceId]);
  assert.deepEqual(await resendPortalInvite(session, input), simulatedResult("unavailable"));
});

test("private table ACL, terminal immutability, and OFF settlement enforce the boundary", async () => {
  const input = await fixture();
  const result = await resendPortalInvite(session, input);
  await assert.rejects(tx(session.userId, client => client.query(`SELECT * FROM app.b005_resend_requests`), scope));
  await assert.rejects(query(`UPDATE app.b005_resend_requests SET status='accepted' WHERE request_id=$1`, [input.requestId]), /immutable/);
  await assert.rejects(query(`DELETE FROM app.b005_resend_requests WHERE request_id=$1`, [input.requestId]), /immutable/);
  const privileges = await query(`SELECT has_table_privilege('service_role','app.b005_resend_requests','SELECT') AS direct,
    has_function_privilege('anon','app.b005_resend_claim(uuid,uuid,uuid,integer)','EXECUTE') AS anon`);
  assert.deepEqual(privileges.rows[0], { direct: false, anon: false });
  await flags({ enabled: false, allowed_org_ids: [ORG_ID] });
  const before = await rows();
  assert.deepEqual(await resendPortalInvite(session, input), simulatedResult("disabled"));
  const off = await tx(session.userId, client => client.query(`SELECT app.b005_resend_settle($1,$2,'rejected') AS status`, [ORG_ID, input.requestId]), scope);
  assert.equal(off.rows[0].status, "disabled");
  assert.deepEqual(await rows(), before);
  for (const locale of ["en", "zh-TW"] as const) for (const audience of ["owner", "tenant"] as const) {
    const html = renderToStaticMarkup(createElement(PortalResendResult, { result, locale, audience, company: "<Synthetic>" }));
    assert.ok(html.includes("&lt;Synthetic&gt;"));
    assert.ok(html.includes(locale === "en" ? "Simulation preview" : "模擬預覽"));
    assert.ok(html.includes(locale === "en" ? "delivery is not confirmed" : "尚未確認送達"));
  }
});


test("staff control uses the matching DB invitation and manager can capture", async () => {
  const input = await fixture();
  const contact = (await query(`SELECT contact_id FROM invitations WHERE id=$1`, [input.sourceId])).rows[0].contact_id;
  const control = await portalResendControl(session, contact, "owner");
  assert.equal(control?.id, input.sourceId);
  assert.deepEqual(Object.keys(control!).sort(), ["company", "id"]);
  assert.equal(await portalResendControl(session, contact, "tenant", randomUUID()), null);
  assert.deepEqual(await resendPortalInvite({ ...session, userId: USERS.manager, role: "manager" }, input), simulatedResult("captured"));
});
