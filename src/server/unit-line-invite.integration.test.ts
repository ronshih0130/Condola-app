import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query, withClient } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { insertTestAuthSession } from "./test-auth-session";
import type { Session } from "./types";
import { GET as joinGet } from "../app/join/[token]/route";
import * as uli from "./unit-line-invite";
import {
  acceptBind,
  hashInviteToken,
  includeOnLease,
  inviteTokenBytes,
  issueInvite,
  landingHtml,
  listBindings,
  maskToken,
  newInviteToken,
  referrerHeaders,
  removeBinding,
  roleHomeFor,
  rotateInvite,
  tenantPortalView,
  unitLineInviteOn,
  UNIT_LINE_TOKEN_ATTEMPT_LIMIT,
} from "./unit-line-invite";

// B-033 unit_line_invite. Local disposable PostgreSQL clone only. All people and tokens are synthetic.
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;

test.before(async () => {
  clone = await cloneTestDatabase();
  await ensureMigration();
});
test.after(async () => {
  await clone?.cleanup();
});

test.beforeEach(async () => {
  await query(`DELETE FROM app.unit_invite_attempts`);
});

async function ensureMigration() {
  const present = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'unit_line_invite_on' LIMIT 1`,
  );
  if (present.rows[0]) return;
  const sql = readFileSync(new URL("../../supabase/migrations/20261110100000_unit_line_invite.sql", import.meta.url), "utf8");
  await withClient((client) => client.query(sql));
}

async function flag(on: boolean, orgId = ORG_ID) {
  await query(
    `INSERT INTO platform_settings(key, value) VALUES ('unit_line_invite', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(on ? { enabled: true, allowed_org_ids: [orgId] } : { enabled: false, allowed_org_ids: [] })],
  );
  if (on) {
    await query(
      `UPDATE organizations SET feature_flags = jsonb_set(coalesce(feature_flags, '{}'::jsonb), '{unit_line_invite}', 'true'::jsonb, true) WHERE id = $1`,
      [orgId],
    );
  } else {
    await query(
      `UPDATE organizations SET feature_flags = coalesce(feature_flags, '{}'::jsonb) - 'unit_line_invite'`,
    );
  }
}

async function session(userId: string, kind: Session["kind"], role: Session["role"], orgId = ORG_ID): Promise<Session> {
  const sessionId = await withClient((c) => insertTestAuthSession(c, userId));
  return {
    userId, sessionId, orgId, liveOrgId: orgId, kind, role, environment: "live",
    locale: "en", calendar: "gregorian", leaseId: null, email: "synthetic@example.test", name: "Synthetic",
  };
}
const admin = () => session(USERS.admin, "staff", "admin");

async function unitAndLease(orgId = ORG_ID) {
  const row = await query<{ unit_id: string; lease_id: string }>(
    `SELECT unit_id::text, id::text AS lease_id FROM leases WHERE org_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
    [orgId],
  );
  assert.ok(row.rows[0], "seed lease");
  return row.rows[0];
}

async function otherUnit(orgId: string, skipId: string) {
  const row = await query<{ id: string }>(
    `SELECT id::text FROM units WHERE org_id = $1 AND id <> $2 ORDER BY id LIMIT 1`,
    [orgId, skipId],
  );
  assert.ok(row.rows[0], "second seed unit");
  return row.rows[0].id;
}


async function clearBinds(unitId: string) {
  await query(`UPDATE app.unit_bindings SET status = 'unlinked', unbound_at = now()
    WHERE unit_id = $1 AND status IN ('pending','lease_linked')`, [unitId]);
}

function isFlow(err: unknown, key: string) {
  return err instanceof FlowError && err.key === key;
}

test("R-a1 token is 256-bit and 6-digit codes are rejected", async () => {
  await flag(true);
  assert.equal(inviteTokenBytes(newInviteToken()), 32);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  await assert.rejects(() => acceptBind({ orgId: ORG_ID, unitId: unit_id, token: "123456", lineSub: "line-a1" }),
    (err) => isFlow(err, "errors.invalid"));
});

test("R-a2 secrets store only the hash, never the raw token", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(await admin(), unit_id);
  const cols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'unit_invite_secrets'`,
  );
  const names = cols.rows.map((r) => r.column_name);
  assert.ok(!names.includes("token"));
  assert.ok(names.includes("token_hash"));
  const rows = await query<{ token_hash: string }>(`SELECT token_hash FROM app.unit_invite_secrets WHERE token_hash = $1`, [hashInviteToken(issued.token)]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].token_hash.length, 64);
  assert.notEqual(rows.rows[0].token_hash, issued.token);
});

test("R-a3 seats 2-4 on the same invite succeed", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(await admin(), unit_id);
  for (const n of [2, 3, 4]) {
    const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: issued.token, lineSub: `line-a3-${n}-${randomUUID()}` });
    assert.ok(bound.bindingId);
  }
});

test("R-a3 same token is throttled on attempt N+1", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  await issueInvite(await admin(), unit_id);
  const unusedToken = newInviteToken();
  const ip = "192.0.2.80";
  for (let i = 0; i < UNIT_LINE_TOKEN_ATTEMPT_LIMIT; i++) {
    await assert.rejects(
      () => acceptBind({ orgId: ORG_ID, unitId: unit_id, token: unusedToken, lineSub: `line-a3-throttle-${i}-${randomUUID()}`, ip }),
      (err: unknown) => err instanceof FlowError && err.key !== "errors.rateLimited",
    );
  }
  await assert.rejects(
    () => acceptBind({ orgId: ORG_ID, unitId: unit_id, token: unusedToken, lineSub: `line-a3-throttle-final-${randomUUID()}`, ip }),
    (err: unknown) => err instanceof FlowError && err.key === "errors.rateLimited",
  );
  const other = await otherUnit(ORG_ID, unit_id);
  await clearBinds(other);
  const fresh = await issueInvite(await admin(), other);
  const ip2 = "192.0.2.81";
  for (const n of [1, 2, 3, 4]) {
    const bound = await acceptBind({ orgId: ORG_ID, unitId: other, token: fresh.token, lineSub: `line-a3-fresh-${n}-${randomUUID()}`, ip: ip2 });
    assert.ok(bound.bindingId);
  }
});

test("R-a4 landing GET sets Referrer-Policy no-referrer and Cache-Control no-store", async () => {
  const token = newInviteToken();
  const res = await joinGet(new Request(`http://localhost/join/${token}`), { params: { token } });
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const headers = referrerHeaders();
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(headers["Cache-Control"], "no-store");
});

test("R-a5 audit reason never contains the raw token", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(await admin(), unit_id);
  const rows = await query<{ reason: string | null; event_type: string }>(
    `SELECT reason, event_type FROM audit_log WHERE event_type = 'unit_line_issue' AND row_id = $1 ORDER BY id DESC LIMIT 1`,
    [unit_id],
  );
  assert.equal(rows.rows[0]?.event_type, "unit_line_issue");
  assert.equal(rows.rows[0]?.reason, maskToken(issued.token));
  assert.ok(!rows.rows[0]?.reason?.includes(issued.token));
});

test("R-a6 landing path is /join/{token} with no query token and no third-party script", async () => {
  const token = newInviteToken();
  const html = landingHtml({ token });
  assert.ok(html.includes(`/join/${token}`));
  assert.ok(!html.includes(`?token=`));
  assert.ok(!html.includes("<script src"));
  assert.ok(html.includes("TODO-R&D"));
  assert.ok(html.includes("等待管理方確認租約"));
  const res = await joinGet(new Request(`http://localhost/join/${token}`), { params: { token } });
  const body = await res.text();
  assert.ok(body.includes(`/join/${token}`));
});

test("R-a7 rotate invalidates the old token and keeps existing bindings", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const staff = await admin();
  const first = await issueInvite(staff, unit_id);
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: first.token, lineSub: `line-a7-${randomUUID()}` });
  const rotated = await rotateInvite(staff, unit_id);
  await assert.rejects(() => acceptBind({ orgId: ORG_ID, unitId: unit_id, token: first.token, lineSub: `line-a7b-${randomUUID()}` }),
    (err) => isFlow(err, "errors.revoked"));
  const rows = await query<{ status: string }>(`SELECT status FROM app.unit_bindings WHERE id = $1`, [bound.bindingId]);
  assert.equal(rows.rows[0].status, "pending");
  const next = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: rotated.token, lineSub: `line-a7c-${randomUUID()}` });
  assert.ok(next.bindingId);
});

test("R-a8 five concurrent accepts on one token yield four seats and one seat_cap", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const freeUnit = await otherUnit(ORG_ID, unit_id);
  await clearBinds(freeUnit);
  const token = (await issueInvite(await admin(), freeUnit)).token;
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      acceptBind({ orgId: ORG_ID, unitId: freeUnit, token, lineSub: `line-a8-${i}-${randomUUID()}` }),
    ),
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  const cap = results.filter((r) => r.status === "rejected" && isFlow(r.reason, "errors.seat_cap"));
  assert.equal(ok.length, 4);
  assert.equal(cap.length, 1);
  const count = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.unit_bindings WHERE unit_id = $1 AND status IN ('pending','lease_linked')`,
    [freeUnit],
  );
  assert.equal(count.rows[0].n, 4);
});

test("R-b1 manager must tick bound tenants; until then 等待管理方確認租約 and no pay/id/repair", async () => {
  await flag(true);
  const { unit_id, lease_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(await admin(), unit_id);
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: issued.token, lineSub: `line-b1-${randomUUID()}`, enteredName: "合成租客" });
  const pending = await tenantPortalView(ORG_ID, bound.userId);
  assert.equal(pending.viewLeaseLabel, "等待管理方確認租約");
  assert.equal(pending.showPay, false);
  assert.equal(pending.showId, false);
  assert.equal(pending.showRepair, false);
  const parties = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM lease_parties lp JOIN app.unit_bindings b ON b.contact_id = lp.contact_id WHERE b.id = $1`,
    [bound.bindingId],
  );
  assert.equal(parties.rows[0].n, 0);
  await includeOnLease(await admin(), lease_id, unit_id, [bound.bindingId]);
  const linked = await tenantPortalView(ORG_ID, bound.userId);
  assert.equal(linked.showPay, true);
  assert.equal(linked.showId, true);
  assert.equal(linked.showRepair, true);
  const status = await query<{ status: string }>(`SELECT status FROM app.unit_bindings WHERE id = $1`, [bound.bindingId]);
  assert.equal(status.rows[0].status, "lease_linked");
});

test("R-b2 pending binder has no payment, ID-document, or repair entry points", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(await admin(), unit_id);
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: issued.token, lineSub: `line-b2-${randomUUID()}` });
  const view = await tenantPortalView(ORG_ID, bound.userId);
  assert.equal(view.showPay, false);
  assert.equal(view.showId, false);
  assert.equal(view.showRepair, false);
  assert.equal(view.showMessages, false);
});

test("R-b3 removing a binding frees a seat for a fifth tenant", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const freeUnit = await otherUnit(ORG_ID, unit_id);
  await clearBinds(freeUnit);
  const staff = await admin();
  const token = (await issueInvite(staff, freeUnit)).token;
  const binds = [];
  for (let i = 0; i < 4; i++) {
    binds.push(await acceptBind({ orgId: ORG_ID, unitId: freeUnit, token, lineSub: `line-b3-${i}-${randomUUID()}` }));
  }
  await removeBinding(staff, binds[0].bindingId);
  const fifth = await acceptBind({ orgId: ORG_ID, unitId: freeUnit, token, lineSub: `line-b3-5-${randomUUID()}` });
  assert.ok(fifth.bindingId);
  const count = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.unit_bindings WHERE unit_id = $1 AND status IN ('pending','lease_linked')`,
    [freeUnit],
  );
  assert.equal(count.rows[0].n, 4);
});

test("R-b4 the same LINE identity cannot bind two users on one unit", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const token = (await issueInvite(await admin(), unit_id)).token;
  const lineSub = `line-b4-${randomUUID()}`;
  await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub });
  await assert.rejects(() => acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub, userId: USERS.tenant }),
    (err) => isFlow(err, "errors.identity_conflict"));
});

test("R-b5 staff members cannot bind; one LINE cannot hold two units (C-12)", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const staff = await admin();
  const token = (await issueInvite(staff, unit_id)).token;
  await assert.rejects(() => acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-b5-${randomUUID()}`, userId: USERS.admin }),
    (err) => isFlow(err, "errors.staff_conflict"));
  const lineSub = `line-b5-multi-${randomUUID()}`;
  await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub });
  const unit2 = await otherUnit(ORG_ID, unit_id);
  await clearBinds(unit2);
  const token2 = (await issueInvite(staff, unit2)).token;
  await assert.rejects(() => acceptBind({ orgId: ORG_ID, unitId: unit2, token: token2, lineSub }),
    (err) => isFlow(err, "errors.multi_unit"));
});

test("R-b6 an entered name matching a lease party does not auto-add the binder to the lease", async () => {
  await flag(true);
  const { unit_id, lease_id } = await unitAndLease();
  await clearBinds(unit_id);
  const existing = await query<{ display_name: string }>(
    `SELECT c.display_name FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id WHERE lp.lease_id = $1 LIMIT 1`,
    [lease_id],
  );
  const name = existing.rows[0]?.display_name ?? "張雅文";
  const before = await query<{ n: number }>(`SELECT count(*)::int AS n FROM lease_parties WHERE lease_id = $1`, [lease_id]);
  const token = (await issueInvite(await admin(), unit_id)).token;
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-b6-${randomUUID()}`, enteredName: name });
  const after = await query<{ n: number }>(`SELECT count(*)::int AS n FROM lease_parties WHERE lease_id = $1`, [lease_id]);
  assert.equal(after.rows[0].n, before.rows[0].n);
  const status = await query<{ status: string }>(`SELECT status FROM app.unit_bindings WHERE id = $1`, [bound.bindingId]);
  assert.equal(status.rows[0].status, "pending");
});

test("R-c1 removeBinding revokes the tenant's auth sessions", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const token = (await issueInvite(await admin(), unit_id)).token;
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-c1-${randomUUID()}` });
  await withClient((c) => insertTestAuthSession(c, bound.userId));
  await removeBinding(await admin(), bound.bindingId);
  const sessions = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [bound.userId],
  );
  assert.equal(sessions.rows[0].n, 0);
  const revoked = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL`,
    [bound.userId],
  );
  assert.ok(revoked.rows[0].n >= 1);
});

test("R-c2 email-less minted accounts can be removed without reauth_required", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const token = (await issueInvite(await admin(), unit_id)).token;
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-c2-${randomUUID()}` });
  const staff = await admin();
  await assert.doesNotReject(() => removeBinding(staff, bound.bindingId));
  const user = await query<{ encrypted_password: string | null }>(
    `SELECT encrypted_password FROM auth.users WHERE id = $1`,
    [bound.userId],
  );
  const pw = user.rows[0]?.encrypted_password;
  assert.ok(pw == null || pw.trim() === "");
});

test("R-c3 rotate does not drop bindings; remove does not revoke the invite secret", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const staff = await admin();
  const first = await issueInvite(staff, unit_id);
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: first.token, lineSub: `line-c3-${randomUUID()}` });
  await rotateInvite(staff, unit_id);
  const still = await query<{ status: string }>(`SELECT status FROM app.unit_bindings WHERE id = $1`, [bound.bindingId]);
  assert.equal(still.rows[0].status, "pending");
  const live = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.unit_invite_secrets WHERE unit_id = $1 AND revoked_at IS NULL`,
    [unit_id],
  );
  assert.ok(live.rows[0].n >= 1);
  await removeBinding(staff, bound.bindingId);
  const after = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.unit_invite_secrets WHERE unit_id = $1 AND revoked_at IS NULL`,
    [unit_id],
  );
  assert.equal(after.rows[0].n, live.rows[0].n);
});

test("R-c4 issue, bind, and remove each write an audit row without the raw token", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const staff = await admin();
  const issued = await issueInvite(staff, unit_id);
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: issued.token, lineSub: `line-c4-${randomUUID()}` });
  await removeBinding(staff, bound.bindingId);
  const rows = await query<{ event_type: string; reason: string | null }>(
    `SELECT event_type, reason FROM audit_log WHERE event_type IN ('unit_line_issue','unit_line_bound','unit_line_remove')
      AND (row_id = $1 OR row_id = $2)`,
    [unit_id, bound.bindingId],
  );
  const types = new Set(rows.rows.map((r) => r.event_type));
  assert.ok(types.has("unit_line_issue"));
  assert.ok(types.has("unit_line_bound"));
  assert.ok(types.has("unit_line_remove"));
  for (const row of rows.rows) {
    assert.ok(!row.reason || !row.reason.includes(issued.token));
  }
});

test("R-c5 remove unlinks the binding row and does not cascade-delete the unit or contact", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const token = (await issueInvite(await admin(), unit_id)).token;
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-c5-${randomUUID()}` });
  const contact = await query<{ contact_id: string }>(`SELECT contact_id::text FROM app.unit_bindings WHERE id = $1`, [bound.bindingId]);
  await removeBinding(await admin(), bound.bindingId);
  const row = await query<{ status: string }>(`SELECT status FROM app.unit_bindings WHERE id = $1`, [bound.bindingId]);
  assert.equal(row.rows[0].status, "unlinked");
  const unit = await query<{ n: number }>(`SELECT count(*)::int AS n FROM units WHERE id = $1`, [unit_id]);
  assert.equal(unit.rows[0].n, 1);
  const contacts = await query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE id = $1`, [contact.rows[0].contact_id]);
  assert.equal(contacts.rows[0].n, 1);
});

test("R-X-money a pending binder cannot see payment entry points", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const token = (await issueInvite(await admin(), unit_id)).token;
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-xm-${randomUUID()}` });
  const view = await tenantPortalView(ORG_ID, bound.userId);
  assert.equal(view.showPay, false);
});

test("R-X-perm accountant and maintenance cannot manage invites; accountant home is /m/payments only when the flag is on", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const accountant = await session(USERS.accountant, "staff", "accountant");
  const maintenance = await session(USERS.maintenance, "staff", "maintenance");
  await assert.rejects(() => issueInvite(accountant, unit_id), (err) => isFlow(err, "errors.forbidden"));
  await assert.rejects(() => listBindings(accountant, unit_id), (err) => isFlow(err, "errors.forbidden"));
  await assert.rejects(() => issueInvite(maintenance, unit_id), (err) => isFlow(err, "errors.forbidden"));
  assert.equal(roleHomeFor("staff", "accountant", true), "/m/payments");
  assert.equal(roleHomeFor("staff", "accountant", false), "/m");
});

test("R-X-leak bindings and portal view do not leak across orgs", async () => {
  await flag(true, ORG_ID);
  const { unit_id } = await unitAndLease(ORG_ID);
  await clearBinds(unit_id);
  const token = (await issueInvite(await admin(), unit_id)).token;
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-xl-${randomUUID()}` });
  const listed = await listBindings(await admin(), unit_id);
  assert.ok(listed.every((row) => String(row.org_id) === ORG_ID));
  const otherView = await tenantPortalView(ORG2_ID, bound.userId);
  assert.equal(otherView.viewLeaseLabel, "");
  assert.equal(otherView.showPay, false);
});

test("R-X-expiry an expired invite is rejected", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(await admin(), unit_id);
  await query(`UPDATE app.unit_invite_secrets SET expires_at = now() - interval '1 day' WHERE token_hash = $1`, [hashInviteToken(issued.token)]);
  await assert.rejects(() => acceptBind({ orgId: ORG_ID, unitId: unit_id, token: issued.token, lineSub: `line-xe-${randomUUID()}` }),
    (err) => isFlow(err, "errors.expired"));
});

test("FLAG-OFF issue and accept are hidden when the flag is off", async () => {
  await flag(false);
  assert.equal(await unitLineInviteOn(ORG_ID), false);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const staff = await admin();
  await assert.rejects(() => issueInvite(staff, unit_id), (err) => isFlow(err, "errors.notFound"));
  await assert.rejects(() => acceptBind({ orgId: ORG_ID, unitId: unit_id, token: newInviteToken(), lineSub: "line-off" }),
    (err) => isFlow(err, "errors.notFound"));
  assert.equal(roleHomeFor("staff", "accountant", false), "/m");
  await flag(true);
});

test("OUT-0 bind and remove do not write email_log rows", async () => {
  await flag(true);
  const before = await query<{ n: number }>(`SELECT count(*)::int AS n FROM email_log`);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const staff = await admin();
  const token = (await issueInvite(staff, unit_id)).token;
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-out-${randomUUID()}` });
  await removeBinding(staff, bound.bindingId);
  const after = await query<{ n: number }>(`SELECT count(*)::int AS n FROM email_log`);
  assert.equal(after.rows[0].n, before.rows[0].n);
  const src = readFileSync(new URL("./unit-line-invite.ts", import.meta.url), "utf8") + readFileSync(new URL("../app/join/[token]/route.ts", import.meta.url), "utf8");
  assert.equal(/twilio|mitake|every8d|sms\s*otp|sendSms/i.test(src), false);
});

test("R-recovery no self-service recoverBinding; manager unlinks, rotates, and the tenant rebinds with a new LINE", async () => {
  await flag(true);
  assert.ok(!("recoverBinding" in uli));
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const staff = await admin();
  const first = await issueInvite(staff, unit_id);
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: first.token, lineSub: `line-rec-old-${randomUUID()}` });
  await removeBinding(staff, bound.bindingId);
  const rotated = await rotateInvite(staff, unit_id);
  const again = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: rotated.token, lineSub: `line-rec-new-${randomUUID()}` });
  assert.ok(again.bindingId);
  assert.notEqual(again.bindingId, bound.bindingId);
  const old = await query<{ status: string }>(`SELECT status FROM app.unit_bindings WHERE id = $1`, [bound.bindingId]);
  assert.equal(old.rows[0].status, "unlinked");
});
