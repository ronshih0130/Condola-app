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
  acceptBindExisting,
  existingLoginHash,
  hashInviteToken,
  escapeHtml,
  INVITE_TOKEN_RE,
  includeOnLease,
  inviteTokenBytes,
  issueInvite,
  joinUrl,
  currentInvite,
  landingHtml,
  listBindings,
  listInvites,
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
import { handleStaffLive, handleStaffIssue, handleStaffRotate, handleAcceptExisting } from "./unit-line-invite-api";
import { ownerPropertyNames, ownerHome } from "./queries";

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
  if (!present.rows[0]) {
    const sql = readFileSync(new URL("../../supabase/migrations/20261110100000_unit_line_invite.sql", import.meta.url), "utf8");
    await withClient((client) => client.query(sql));
  }
  const seatCap = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM pg_trigger WHERE tgname = 'unit_bindings_seat_cap_guard' LIMIT 1`,
  );
  if (!seatCap.rows[0]) {
    const capSql = readFileSync(new URL("../../supabase/migrations/20261110110000_unit_line_invite_seat_cap.sql", import.meta.url), "utf8");
    await withClient((client) => client.query(capSql));
  }
  const display = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname = 'unit_invite_display' LIMIT 1`,
  );
  if (!display.rows[0]) {
    const displaySql = readFileSync(new URL("../../supabase/migrations/20261110120000_unit_invite_display.sql", import.meta.url), "utf8");
    await withClient((client) => client.query(displaySql));
  }
}

async function flag(on: boolean, orgId: string | string[] = ORG_ID) {
  const orgIds = Array.isArray(orgId) ? orgId : [orgId];
  await query(
    `INSERT INTO platform_settings(key, value) VALUES ('unit_line_invite', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(on ? { enabled: true, allowed_org_ids: orgIds } : { enabled: false, allowed_org_ids: [] })],
  );
  if (on) {
    for (const id of orgIds) {
      await query(
        `UPDATE organizations SET feature_flags = jsonb_set(coalesce(feature_flags, '{}'::jsonb), '{unit_line_invite}', 'true'::jsonb, true) WHERE id = $1`,
        [id],
      );
    }
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
  const res = await joinGet(new Request(`http://localhost/join/${token}`), { params: Promise.resolve({ token }) });
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
  const res = await joinGet(new Request(`http://localhost/join/${token}`), { params: Promise.resolve({ token }) });
  const body = await res.text();
  assert.ok(body.includes(`/join/${token}`));
});

test("TEN-19-AC3 / R-a6 join GET with a script path returns the generic page and sets CSP", async () => {
  for (const payload of ['"><script>alert(1)</script>', 'qa"><b>qaxss']) {
    const res = await joinGet(
      new Request(`http://localhost/join/${encodeURIComponent(payload)}`),
      { params: Promise.resolve({ token: payload }) },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    const body = await res.text();
    // The raw payload must not reflect into the same-origin page in any form.
    assert.ok(!body.includes("<script>"));
    assert.ok(!body.includes("<b>qaxss"));
    assert.ok(!body.includes(payload));
    assert.ok(!body.includes(`href="/join/${payload}`));
    const csp = res.headers.get("Content-Security-Policy");
    assert.ok(csp && csp.includes("default-src 'none'"));
    assert.ok(!csp.includes("unsafe-inline"));
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    // R-a4 headers still present via joinLandingHeaders().
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }
});

test("TEN-19-AC3 / R-a6 join GET enforces INVITE_TOKEN_RE boundaries", async () => {
  const invalid = [
    "",
    "A".repeat(42),
    "A".repeat(44),
    "A".repeat(42) + ".",
    "A".repeat(42) + "/",
    "A".repeat(42) + " ",
    "123456",
    "好".repeat(43),
  ];
  for (const token of invalid) {
    assert.equal(INVITE_TOKEN_RE.test(token), false);
    const res = await joinGet(
      new Request("http://localhost/join/x"),
      { params: Promise.resolve({ token }) },
    );
    assert.equal(res.status, 200);
    const body = await res.text();
    if (token.length > 0) assert.ok(!body.includes(token));
    assert.ok(!body.includes(`/join/${token}"`));
    assert.ok(!body.includes("<script"));
  }

  const valid = newInviteToken();
  assert.equal(INVITE_TOKEN_RE.test(valid), true);
  const res = await joinGet(
    new Request(`http://localhost/join/${valid}`),
    { params: Promise.resolve({ token: valid }) },
  );
  assert.equal(res.status, 200);
  const body = await res.text();
  // Valid charset needs no escaping, so the escaped token equals the token.
  assert.ok(body.includes(`<a href="/join/${escapeHtml(valid)}">continue</a>`));
  assert.ok(body.includes(`/join/${valid}`));
  // The route looks up nothing: firm stays default and unit stays empty, so
  // there is no org/unit leak on the public landing page.
  assert.ok(body.includes("<h1>Condola</h1>"));
  assert.ok(body.includes("<p></p>"));
});

test("public join GET with invalid, expired, or revoked tokens leaks no org, unit, or name", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(await admin(), unit_id);
  const meta = await query<{ org_name: string; property_name: string; unit_label: string }>(
    `SELECT o.name AS org_name, p.name AS property_name, u.label AS unit_label
       FROM units u
       JOIN organizations o ON o.id = u.org_id
       JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`,
    [unit_id],
  );
  assert.ok(meta.rows[0], "seed unit metadata");
  const people = await query<{ display_name: string }>(
    `SELECT display_name FROM contacts WHERE org_id = $1 AND archived_at IS NULL AND display_name IS NOT NULL`,
    [ORG_ID],
  );
  const forbidden = [
    meta.rows[0].org_name,
    meta.rows[0].property_name,
    meta.rows[0].unit_label,
    ...people.rows.map((r) => r.display_name),
  ].filter((s) => s && s.trim().length > 1);

  async function assertNoLeak(token: string, label: string) {
    const res = await joinGet(new Request(`http://localhost/join/${token}`), { params: Promise.resolve({ token }) });
    assert.equal(res.status, 200, label);
    const rawHtml = await res.text();
    // FU-RLS-3F / report rls-3f-flake-1112.md: "3F" is a seed unit label for the
    // first ORG_ID unit, and a well-formed base64url token can itself contain "3F"
    // (P ~ 1%). GET does not look up the invite — landingHtml only reflects the raw
    // token into <a href="/join/${token}">. So strip every occurrence of the raw
    // token from a copy of the HTML before the leak check; a token that is not
    // reflected (invalid, non-base64url) simply leaves the HTML unchanged. The leak
    // check below is unchanged and still runs on the stripped copy.
    const html = token.length > 0 ? rawHtml.split(token).join("") : rawHtml;
    for (const s of forbidden) {
      assert.equal(html.includes(s), false, `${label} leaked ${JSON.stringify(s)}`);
    }
    assert.equal(/松信|海岸|信義|大安|Oakland|張雅文|王小美|陳建宏|林秀英/u.test(html), false, `${label} leaked a seed name`);
  }

  await assertNoLeak("not-a-real-token", "invalid");
  await assertNoLeak(issued.token, "issued (GET must not look up the invite)");
  // Regression: a well-formed 43-char base64url token that definitely contains the
  // "3F" seed unit label must not register as a leak (FU-RLS-3F). No DB needed.
  const base = newInviteToken();
  const synthetic3F = (base.slice(0, 20) + "3F" + base.slice(20)).slice(0, 43);
  assert.equal(INVITE_TOKEN_RE.test(synthetic3F), true);
  assert.ok(synthetic3F.includes("3F"));
  await assertNoLeak(synthetic3F, "synthetic token containing 3F");
  await query(`UPDATE app.unit_invite_secrets SET expires_at = now() - interval '1 day' WHERE token_hash = $1`, [hashInviteToken(issued.token)]);
  await assertNoLeak(issued.token, "expired");
  await query(`UPDATE app.unit_invite_secrets SET expires_at = now() + interval '14 days', revoked_at = now() WHERE token_hash = $1`, [hashInviteToken(issued.token)]);
  await assertNoLeak(issued.token, "revoked");
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

test("MGT-40-AC3 / R-a8 issue revokes earlier live secrets; only one live secret per unit", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  const freeUnit = await otherUnit(ORG_ID, unit_id);
  await clearBinds(freeUnit);

  const first = (await issueInvite(await admin(), freeUnit)).token;
  const second = (await issueInvite(await admin(), freeUnit)).token;

  await assert.rejects(
    acceptBind({ orgId: ORG_ID, unitId: freeUnit, token: first, lineSub: `line-revoked-${randomUUID()}` }),
    (err: unknown) => isFlow(err, "errors.revoked"),
  );

  const bound = await acceptBind({
    orgId: ORG_ID,
    unitId: freeUnit,
    token: second,
    lineSub: `line-live-${randomUUID()}`,
  });
  assert.ok(bound.bindingId);

  const live = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.unit_invite_secrets WHERE unit_id = $1 AND revoked_at IS NULL`,
    [freeUnit],
  );
  assert.equal(live.rows[0].n, 1);

  const dupHash = hashInviteToken(newInviteToken());
  await assert.rejects(
    query(
      `INSERT INTO app.unit_invite_secrets (org_id, unit_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '14 days')`,
      [ORG_ID, freeUnit, dupHash],
    ),
    (err: unknown) => err instanceof Error && ((err as { code?: string }).code === "23505" || /duplicate key|unique/i.test(err.message)),
  );

  await clearBinds(freeUnit);
});

test("TEN-20-AC3 / R-a8 five concurrent accepts across two secrets yield at most four seats and DB seat_cap", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  const freeUnit = await otherUnit(ORG_ID, unit_id);

  const run = async () => {
    await clearBinds(freeUnit);
    await query(`UPDATE app.unit_invite_secrets SET revoked_at = now() WHERE unit_id = $1 AND revoked_at IS NULL`, [freeUnit]);
    const tokenA = (await issueInvite(await admin(), freeUnit)).token;
    const tokenB = newInviteToken();
    const hashB = hashInviteToken(tokenB);
    await query(`DROP INDEX IF EXISTS app.unit_invite_secrets_one_live_per_unit`);
    try {
      await query(
        `INSERT INTO app.unit_invite_secrets (org_id, unit_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '14 days')`,
        [ORG_ID, freeUnit, hashB],
      );
      const tokens = [tokenA, tokenA, tokenA, tokenB, tokenB];
      const results = await Promise.allSettled(
        tokens.map((t, i) =>
          acceptBind({ orgId: ORG_ID, unitId: freeUnit, token: t, lineSub: `line-split-${i}-${randomUUID()}` }),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const cap = results.filter((r) => r.status === "rejected" && isFlow((r as PromiseRejectedResult).reason, "errors.seat_cap")).length;
      const count = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.unit_bindings WHERE unit_id = $1 AND status IN ('pending','lease_linked')`,
        [freeUnit],
      );
      return { ok, cap, count: count.rows[0].n };
    } finally {
      await query(
        `UPDATE app.unit_invite_secrets SET revoked_at = now()
          WHERE unit_id = $1 AND revoked_at IS NULL
            AND id NOT IN (
              SELECT id FROM app.unit_invite_secrets
               WHERE unit_id = $1 AND revoked_at IS NULL
               ORDER BY created_at DESC, id DESC LIMIT 1
            )`,
        [freeUnit],
      );
      await query(
        `CREATE UNIQUE INDEX IF NOT EXISTS unit_invite_secrets_one_live_per_unit
           ON app.unit_invite_secrets (org_id, unit_id) WHERE revoked_at IS NULL`,
      );
    }
  };

  let r = await run();
  if (!(r.ok === 4 && r.cap === 1 && r.count === 4)) {
    r = await run();
  }
  assert.equal(r.ok, 4);
  assert.equal(r.cap, 1);
  assert.equal(r.count, 4);

  await clearBinds(freeUnit);
});

test("TEN-20-AC3 / R-a8 seat cap is enforced by the unit_bindings trigger on direct insert", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  const freeUnit = await otherUnit(ORG_ID, unit_id);
  await clearBinds(freeUnit);

  for (let i = 0; i < 4; i++) {
    await query(
      `INSERT INTO app.unit_bindings (org_id, unit_id, user_id, line_identity_hash, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [ORG_ID, freeUnit, randomUUID(), `direct-${i}-${randomUUID()}`],
    );
  }

  await assert.rejects(
    query(
      `INSERT INTO app.unit_bindings (org_id, unit_id, user_id, line_identity_hash, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [ORG_ID, freeUnit, randomUUID(), `direct-5-${randomUUID()}`],
    ),
    (err: unknown) => err instanceof Error && /seat_cap/.test(err.message),
  );

  const count = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.unit_bindings WHERE unit_id = $1 AND status IN ('pending','lease_linked')`,
    [freeUnit],
  );
  assert.equal(count.rows[0].n, 4);

  await clearBinds(freeUnit);
});

test("R-b1 manager must tick bound tenants; until then 等待管理方確認租約 and no pay/id/repair", async () => {
  await flag(true);
  const { unit_id, lease_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(await admin(), unit_id);
  const bound = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: issued.token, lineSub: `line-b1-${randomUUID()}`, enteredName: "合成租客" });
  const pending = await tenantPortalView(ORG_ID, bound.userId, unit_id);
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
  const linked = await tenantPortalView(ORG_ID, bound.userId, unit_id);
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
  const view = await tenantPortalView(ORG_ID, bound.userId, unit_id);
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

test("R-b5 staff+tenant same org is identity_conflict", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const token = (await issueInvite(await admin(), unit_id)).token;
  await assert.rejects(
    () => acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub: `line-b5-${randomUUID()}`, userId: USERS.admin }),
    (err) => isFlow(err, "errors.identity_conflict"),
  );
});

test("R-b5 one LINE may bind two units", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const staff = await admin();
  const token = (await issueInvite(staff, unit_id)).token;
  const lineSub = `line-b5-multi-${randomUUID()}`;
  const bound1 = await acceptBind({ orgId: ORG_ID, unitId: unit_id, token, lineSub });
  const unit2 = await otherUnit(ORG_ID, unit_id);
  await clearBinds(unit2);
  const token2 = (await issueInvite(staff, unit2)).token;
  const bound2 = await acceptBind({ orgId: ORG_ID, unitId: unit2, token: token2, lineSub });
  assert.equal(bound1.userId, bound2.userId);
  const rows = await query(
    `SELECT unit_id FROM app.unit_bindings
      WHERE user_id = $1 AND unit_id IN ($2, $3) AND status IN ('pending','lease_linked')`,
    [bound1.userId, unit_id, unit2],
  );
  assert.equal(rows.rows.length, 2);
});

test("R-b5 staff in org A may be tenant in org B", async () => {
  await flag(true, [ORG_ID, ORG2_ID]);
  const { unit_id } = await unitAndLease(ORG2_ID);
  await clearBinds(unit_id);
  const staff = await session(USERS.coastAdmin, "staff", "admin", ORG2_ID);
  const token = (await issueInvite(staff, unit_id)).token;
  const bound = await acceptBind({
    orgId: ORG2_ID,
    unitId: unit_id,
    token,
    lineSub: `line-b5-crossorg-${randomUUID()}`,
    userId: USERS.maintenance,
  });
  assert.equal(bound.userId, USERS.maintenance);
});

test("T-R-b5 one LINE is tenant on A1 (linked) + B1 (pending) and owner of P; scopes do not bleed", async () => {
  // A1 is 2F 大安和平, not the unitAndLease() row on 信義松仁 (P, owned by USERS.owner).
  // Look up by name: seed.ts assigns fresh UUIDs on each db:reset (including CI).
  const a1 = await query<{ unit_id: string; lease_id: string }>(
    `SELECT u.id::text AS unit_id, l.id::text AS lease_id
       FROM units u
       JOIN properties p ON p.id = u.property_id
       JOIN leases l ON l.unit_id = u.id AND l.org_id = u.org_id AND l.status = 'active'
      WHERE p.name = '大安和平' AND u.label = '2F' AND u.org_id = $1
      ORDER BY l.created_at
      LIMIT 1`,
    [ORG_ID],
  );
  assert.ok(a1.rows[0], "seed A1 2F 大安和平");
  const A1 = a1.rows[0].unit_id;
  const A1_LEASE = a1.rows[0].lease_id;
  await flag(true, [ORG_ID, ORG2_ID]);
  const { unit_id: B1 } = await unitAndLease(ORG2_ID);
  await clearBinds(A1);
  await clearBinds(B1);

  const lineSub = `line-trb5-${randomUUID()}`;
  const empty = (v: { viewLeaseLabel: string; showPay: boolean; showId: boolean; showRepair: boolean; showMessages: boolean }) =>
    v.viewLeaseLabel === "" && !v.showPay && !v.showId && !v.showRepair && !v.showMessages;

  const adminSess = await admin();
  const tokenA = (await issueInvite(adminSess, A1)).token;
  const boundA = await acceptBind({ orgId: ORG_ID, unitId: A1, token: tokenA, lineSub, userId: USERS.owner });
  const coastSess = await session(USERS.coastAdmin, "staff", "admin", ORG2_ID);
  const tokenB = (await issueInvite(coastSess, B1)).token;
  const boundB = await acceptBind({ orgId: ORG2_ID, unitId: B1, token: tokenB, lineSub, userId: USERS.owner });
  assert.equal(boundA.userId, USERS.owner);
  assert.equal(boundB.userId, USERS.owner);
  await includeOnLease(adminSess, A1_LEASE, A1, [boundA.bindingId]);

  const a1View = await tenantPortalView(ORG_ID, USERS.owner, A1);
  assert.equal(a1View.viewLeaseLabel, "lease");
  assert.equal(a1View.showPay, true);
  assert.equal(a1View.showId, true);
  assert.equal(a1View.showRepair, true);
  assert.equal(a1View.showMessages, true);
  const b1View = await tenantPortalView(ORG2_ID, USERS.owner, B1);
  assert.equal(b1View.viewLeaseLabel, "等待管理方確認租約");
  assert.equal(b1View.showPay, false);
  assert.equal(b1View.showId, false);
  assert.equal(b1View.showRepair, false);
  assert.equal(b1View.showMessages, false);

  const ownerSess = await session(USERS.owner, "owner", null, ORG_ID);
  const names = await ownerPropertyNames(ownerSess);
  assert.ok(names.some((n) => n.name === "信義松仁"));
  assert.ok(!names.some((n) => n.name === "大安和平"));
  assert.ok(!names.some((n) => n.name === "Oakland 12th"));
  const home = await ownerHome(ownerSess);
  assert.ok(!home.some((row) => row.unit_label === "2F"));

  await assert.rejects(async () => ownerPropertyNames(await session(USERS.owner, "tenant", null, ORG_ID)));

  assert.ok(empty(await tenantPortalView(ORG2_ID, USERS.owner, A1)));
  assert.ok(empty(await tenantPortalView(ORG_ID, USERS.owner, B1)));
  const namesOrg2 = await ownerPropertyNames(await session(USERS.owner, "owner", null, ORG2_ID));
  assert.ok(!namesOrg2.some((n) => n.name === "信義松仁"));

  // (6) before removing A1, so the user is still a tenant in both orgs.
  await assert.rejects(
    () => query(
      `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'manager', 'active')`,
      [ORG_ID, USERS.owner],
    ),
    (err: unknown) => /identity_conflict/.test(err instanceof Error ? err.message : String(err)),
  );
  await assert.rejects(
    () => query(
      `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'manager', 'active')`,
      [ORG2_ID, USERS.owner],
    ),
    (err: unknown) => /identity_conflict/.test(err instanceof Error ? err.message : String(err)),
  );

  await withClient((c) => insertTestAuthSession(c, USERS.owner));
  await removeBinding(adminSess, boundA.bindingId);
  assert.ok(empty(await tenantPortalView(ORG_ID, USERS.owner, A1)));
  const b1Still = await tenantPortalView(ORG2_ID, USERS.owner, B1);
  assert.equal(b1Still.viewLeaseLabel, "等待管理方確認租約");
  const namesAfter = await ownerPropertyNames(ownerSess);
  assert.ok(namesAfter.some((n) => n.name === "信義松仁"));
  const sess = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
    [USERS.owner],
  );
  assert.ok(sess.rows[0].n >= 1);
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
  const view = await tenantPortalView(ORG_ID, bound.userId, unit_id);
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
  const otherView = await tenantPortalView(ORG2_ID, bound.userId, unit_id);
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


test("MGT-51-AC2 / TEN-29-AC1 issueInvite writes a 43-char display token; currentInvite.path equals joinUrl(token) and /join/<token>; listInvites has no raw token", async () => {
  await flag(true);
  const staff = await admin();
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(staff, unit_id);
  assert.equal(issued.token.length, 43);

  const disp = await query<{ token: string }>(
    `SELECT d.token FROM app.unit_invite_display d
       JOIN app.unit_invite_secrets s ON s.id = d.secret_id
      WHERE s.org_id = $1 AND s.unit_id = $2 AND s.revoked_at IS NULL`,
    [ORG_ID, unit_id],
  );
  assert.equal(disp.rows.length, 1);
  assert.equal(disp.rows[0].token, issued.token);
  assert.equal(disp.rows[0].token.length, 43);

  const cur = await currentInvite(staff, unit_id);
  assert.ok(cur);
  assert.equal(cur.token, issued.token);
  assert.equal(cur.cap, 4);
  assert.equal(joinUrl(issued.token), `/join/${issued.token}`);
  assert.equal(cur.path, joinUrl(issued.token));
  assert.equal(cur.path, `/join/${issued.token}`);

  const listed = await listInvites(staff, unit_id);
  assert.equal(JSON.stringify(listed).includes(issued.token), false);

  const cols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'unit_invite_secrets' AND column_name = 'token'`,
  );
  assert.equal(cols.rows.length, 0);
});

test("MGT-51-AC2 rotateInvite replaces the display token and the revoke trigger drops the old row", async () => {
  await flag(true);
  const staff = await admin();
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const first = await issueInvite(staff, unit_id);
  const second = await rotateInvite(staff, unit_id);
  assert.notEqual(second.token, first.token);

  const cur = await currentInvite(staff, unit_id);
  assert.ok(cur);
  assert.equal(cur.token, second.token);

  const disp = await query<{ token: string }>(
    `SELECT d.token FROM app.unit_invite_display d
       JOIN app.unit_invite_secrets s ON s.id = d.secret_id
      WHERE s.org_id = $1 AND s.unit_id = $2`,
    [ORG_ID, unit_id],
  );
  assert.equal(disp.rows.length, 1);
  assert.equal(disp.rows[0].token, second.token);

  const old = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM app.unit_invite_display WHERE token = $1`,
    [first.token],
  );
  assert.equal(old.rows.length, 0);
});

test("MGT-51-AC2 currentInvite is null when no live invite; FLAG-OFF currentInvite is notFound and writes no display row", async () => {
  await flag(true);
  const staff = await admin();
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  await query(`UPDATE app.unit_invite_secrets SET revoked_at = now() WHERE unit_id = $1 AND revoked_at IS NULL`, [unit_id]);
  assert.equal(await currentInvite(staff, unit_id), null);

  const before = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.unit_invite_display d
       JOIN app.unit_invite_secrets s ON s.id = d.secret_id
      WHERE s.org_id = $1 AND s.unit_id = $2`,
    [ORG_ID, unit_id],
  );
  await flag(false);
  await assert.rejects(() => currentInvite(staff, unit_id), (err) => isFlow(err, "errors.notFound"));
  await assert.rejects(() => issueInvite(staff, unit_id), (err) => isFlow(err, "errors.notFound"));
  const after = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app.unit_invite_display d
       JOIN app.unit_invite_secrets s ON s.id = d.secret_id
      WHERE s.org_id = $1 AND s.unit_id = $2`,
    [ORG_ID, unit_id],
  );
  assert.equal(after.rows[0].n, before.rows[0].n);
  await flag(true);
});

test("MGT-51-AC2 accountant and maintenance cannot call currentInvite", async () => {
  await flag(true);
  const { unit_id } = await unitAndLease();
  const accountant = await session(USERS.accountant, "staff", "accountant");
  await assert.rejects(() => currentInvite(accountant, unit_id), (err) => isFlow(err, "errors.forbidden"));
  const maintenance = await session(USERS.maintenance, "staff", "maintenance");
  await assert.rejects(() => currentInvite(maintenance, unit_id), (err) => isFlow(err, "errors.forbidden"));
});


async function jsonOf(res: { status: number; json: () => Promise<unknown> }) {
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test("TEN-29-AC2 landing copy has no 用 Email 建立 signup entry", () => {
  assert.equal(landingHtml({}).includes("用 Email 建立"), false);
  assert.equal(landingHtml({ token: "A".repeat(43) }).includes("用 Email 建立"), false);
});

test("TEN-29-AC2 / R-a8 acceptBindExisting occupies one seat on the same 4-cap", async () => {
  await flag(true);
  const staff = await admin();
  const { unit_id } = await unitAndLease();
  const unitId = await otherUnit(ORG_ID, unit_id);
  await clearBinds(unitId);
  const issued = await issueInvite(staff, unitId);

  for (let i = 0; i < 3; i++) {
    await acceptBind({
      orgId: ORG_ID,
      unitId,
      token: issued.token,
      lineSub: `line-existing-${i}-${randomUUID()}`,
      displayName: `LINE ${i}`,
    });
  }

  const bound = await acceptBindExisting({
    orgId: ORG_ID,
    unitId,
    token: issued.token,
    userId: USERS.tenant,
    displayName: "既有帳號",
  });
  assert.equal(bound.userId, USERS.tenant);

  const rows = await listBindings(staff, unitId);
  const occupied = rows.filter((b) => b.status === "pending" || b.status === "lease_linked");
  assert.equal(occupied.length, 4);
  const cur = await currentInvite(staff, unitId);
  assert.ok(cur);
  assert.equal(cur.bound, 4);

  const hashed = await query<{ line_identity_hash: string }>(
    `SELECT line_identity_hash FROM app.unit_bindings
      WHERE user_id = $1 AND unit_id = $2 AND status IN ('pending','lease_linked')`,
    [USERS.tenant, unitId],
  );
  assert.equal(hashed.rows.length, 1);
  assert.equal(hashed.rows[0].line_identity_hash, existingLoginHash(USERS.tenant));

  await assert.rejects(
    () => acceptBind({ orgId: ORG_ID, unitId, token: issued.token, lineSub: `line-fifth-${randomUUID()}` }),
    (err: unknown) => isFlow(err, "errors.seat_cap"),
  );
  await assert.rejects(
    () => acceptBindExisting({ orgId: ORG_ID, unitId, token: issued.token, userId: USERS.tenant2 }),
    (err: unknown) => isFlow(err, "errors.seat_cap"),
  );
});

test("TEN-29-AC2 / R-b5 acceptBindExisting staff same org is identity_conflict; flag off is notFound", async () => {
  await flag(true);
  const staff = await admin();
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(staff, unit_id);

  await assert.rejects(
    () => acceptBindExisting({ orgId: ORG_ID, unitId: unit_id, token: issued.token, userId: USERS.admin }),
    (err: unknown) => isFlow(err, "errors.identity_conflict"),
  );

  await flag(false);
  await assert.rejects(
    () => acceptBindExisting({ orgId: ORG_ID, unitId: unit_id, token: issued.token, userId: USERS.tenant }),
    (err: unknown) => isFlow(err, "errors.notFound"),
  );
  await flag(true);
});

test("TEN-29-AC2 handleAcceptExisting binds the logged-in tenant", async () => {
  await flag(true);
  const staff = await admin();
  const { unit_id } = await unitAndLease();
  const unitId = await otherUnit(ORG_ID, unit_id);
  await clearBinds(unitId);
  const issued = await issueInvite(staff, unitId);

  const tenantSess = await session(USERS.tenant, "tenant", null);
  const { status, body } = await jsonOf(await handleAcceptExisting(tenantSess, { token: issued.token, orgId: ORG_ID, unitId }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const result = body.result as { userId?: string };
  assert.equal(result.userId, USERS.tenant);

  const out = await jsonOf(await handleAcceptExisting(null, { token: issued.token }));
  assert.equal(out.status, 401);
  assert.deepEqual(Object.keys(out.body).sort(), ["error", "ok"]);
});

test("MGT-52-AC3 / R-X-perm accountant and maintenance get 403 from live, issue, and rotate with no token or bindings", async () => {
  await flag(true);
  const staff = await admin();
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  const issued = await issueInvite(staff, unit_id);
  await acceptBind({ orgId: ORG_ID, unitId: unit_id, token: issued.token, lineSub: `line-perm-${randomUUID()}`, displayName: "T" });

  const denied = [
    await session(USERS.accountant, "staff", "accountant"),
    await session(USERS.maintenance, "staff", "maintenance"),
  ];
  const handlers = [handleStaffLive, handleStaffIssue, handleStaffRotate];
  for (const sess of denied) {
    for (const handler of handlers) {
      const { status, body } = await jsonOf(await handler(sess, unit_id));
      assert.equal(status, 403);
      assert.equal(body.ok, false);
      assert.equal(body.error, "errors.forbidden");
      assert.deepEqual(Object.keys(body), ["ok", "error"]);
      const text = JSON.stringify(body);
      assert.equal(text.includes(issued.token), false);
      assert.equal(text.includes("bindings"), false);
      assert.equal(text.includes("display_name"), false);
      assert.equal(text.includes("/join/"), false);
    }
  }

  const live = await jsonOf(await handleStaffLive(staff, unit_id));
  assert.equal(live.status, 200);
  assert.equal(live.body.ok, true);
  assert.ok((live.body.bound as number) >= 1);
  assert.equal(live.body.cap, 4);
  assert.ok(Array.isArray(live.body.bindings));
  assert.equal("token" in live.body, false);
  assert.equal("path" in live.body, false);
  assert.equal(JSON.stringify(live.body).includes(issued.token), false);

  const issuedAgain = await jsonOf(await handleStaffIssue(staff, unit_id));
  assert.equal(issuedAgain.status, 200);
  const again = issuedAgain.body.result as { token?: string };
  assert.equal(again.token, issued.token);
});

test("MGT-52-AC3 FLAG-OFF staff live/issue/rotate are 404", async () => {
  await flag(true);
  const staff = await admin();
  const { unit_id } = await unitAndLease();
  await clearBinds(unit_id);
  await issueInvite(staff, unit_id);

  await flag(false);
  for (const handler of [handleStaffLive, handleStaffIssue, handleStaffRotate]) {
    const { status, body } = await jsonOf(await handler(staff, unit_id));
    assert.equal(status, 404);
    assert.equal(body.error, "errors.notFound");
    assert.equal("token" in body, false);
    assert.equal("result" in body, false);
  }
  await flag(true);
});
