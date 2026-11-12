import assert from "node:assert/strict";
import test from "node:test";
import { inviteMember } from "./auth";
import { quoteMonthly } from "./billing";
import { query } from "./db";
import { FlowError } from "./errors";
import { loadPriceInputs, setFirmOverride, clearFirmOverride } from "./partners";
import { goLiveLocked } from "./platform";
import { confirmSignupToken, createFirm, signupLinksExposed, startSignup } from "./signup";
import type { Session } from "./types";

const meta = { ua: "signup-test", ip: "127.0.0.1" };

function staff(userId: string, orgId: string, environment: "live" | "sandbox", email: string): Session {
  return {
    userId,
    sessionId: "signup-test",
    email,
    name: "Signup",
    kind: "staff",
    role: "admin",
    orgId,
    liveOrgId: orgId,
    environment,
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

test("self-serve signup confirms email, seeds test mode, and prices ANJU2026", { timeout: 180_000 }, async () => {
  const savedEnv = process.env.CONDOLA_ENV;
  const savedUrl = process.env.SUPABASE_URL;
  delete process.env.CONDOLA_ENV;
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const stamp = Date.now().toString(36);
  const email = `self.${stamp}@example.com`;
  const other = `firm.${stamp}@example.com`;
  const orgs: string[] = [];
  const users: string[] = [];
  try {
    assert.equal(signupLinksExposed(), true);
    const seeded = await query<{ standard_price: number; free_units: number }>(
      `SELECT standard_price, free_units FROM partner_codes WHERE code = 'ANJU2026' AND active`,
    );
    assert.equal(seeded.rows[0]?.standard_price, 20);
    assert.equal(seeded.rows[0]?.free_units, 4);
    assert.equal(await goLiveLocked(), false);

    const first = await startSignup({
      email,
      password: "Fresh1234",
      confirm: "Fresh1234",
      partnerCode: "ANJU2026",
      origin: "http://127.0.0.1:43123",
      meta,
      consent: true,
    });
    assert.equal(first.ok, true);
    if (!first.ok || first.status !== "verify" || !first.devToken) throw new Error("expected a local confirm link");
    const again = await startSignup({
      email,
      password: "Fresh1234",
      confirm: "Fresh1234",
      partnerCode: "NOPE",
      origin: "http://127.0.0.1:43123",
      meta,
      consent: true,
    });
    assert.equal(again.ok, true);
    if (!again.ok || again.status !== "verify" || !again.devToken) throw new Error("expected a rotated confirm link");
    assert.notEqual(again.devToken, first.devToken);
    const stale = await confirmSignupToken(first.devToken, meta);
    assert.equal(stale.ok, false);
    const confirmed = await confirmSignupToken(again.devToken, meta);
    assert.equal(confirmed.ok, true);

    const wrong = await startSignup({
      email,
      password: "Other1234",
      confirm: "Other1234",
      partnerCode: "",
      origin: "http://127.0.0.1:43123",
      meta,
      consent: true,
    });
    assert.equal(wrong.ok, false);
    if (wrong.ok) throw new Error("duplicate");
    assert.equal(wrong.error, "duplicate");

    const created = await createFirm({
      userId: (await query<{ id: string }>(`SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`, [email])).rows[0].id,
      email,
      kind: "self",
      name: "",
      contactName: "測試屋主",
      phone: "0912000000",
      partnerCode: "ANJU2026",
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("firm");
    orgs.push(created.orgId);
    users.push((await query<{ id: string }>(`SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`, [email])).rows[0].id);
    assert.equal(created.name, `self.${stamp} 的租屋`);
    assert.equal(created.dupName, false);
    assert.equal(created.codeApplied, true);

    const member = await query<{ role: string; billing: boolean }>(
      `SELECT role::text, is_billing_owner AS billing FROM org_members WHERE org_id = $1`,
      [created.orgId],
    );
    assert.equal(member.rows[0].role, "admin");
    assert.equal(member.rows[0].billing, true);
    const sandbox = await query<{ id: string; loaded: Date | null; props: number }>(
      `SELECT s.id::text, s.sample_loaded_at AS loaded,
              (SELECT count(*)::int FROM properties p WHERE p.org_id = s.id) AS props
         FROM organizations s WHERE s.id = $1`,
      [created.sandboxId],
    );
    assert.ok(sandbox.rows[0].loaded);
    assert.ok(sandbox.rows[0].props > 0);
    const liveMode = await query<{ env: string; started: Date | null }>(
      `SELECT environment::text AS env, live_started_at AS started FROM organizations WHERE id = $1`,
      [created.orgId],
    );
    assert.equal(liveMode.rows[0].env, "live");
    assert.equal(liveMode.rows[0].started, null);

    const price = await loadPriceInputs(created.orgId);
    const quoted = quoteMonthly({ units: 600, tier: "standard", cycle: "month", now: new Date(), override: price.override, snapshot: price.snapshot });
    assert.equal(quoted.monthly, 11920);
    assert.equal(quoteMonthly({ units: 200, tier: "standard", cycle: "month", now: new Date(), snapshot: price.snapshot }).monthly, 3920);

    await setFirmOverride(users[0], created.orgId, 10);
    const overridden = await loadPriceInputs(created.orgId);
    const manual = quoteMonthly({ units: 600, tier: "standard", cycle: "month", now: new Date(), override: overridden.override, snapshot: overridden.snapshot });
    assert.equal(manual.source, "override");
    assert.equal(manual.monthly, 5960);
    await clearFirmOverride(users[0], created.orgId);

    const events = await query<{ event_type: string }>(
      `SELECT event_type FROM funnel_events WHERE user_id = $1 ORDER BY created_at`,
      [users[0]],
    );
    const names = events.rows.map((row) => row.event_type);
    assert.ok(names.includes("signup_started"));
    assert.ok(names.includes("email_confirmed"));
    assert.ok(names.includes("firm_created"));

    const duplicate = await startSignup({
      email,
      password: "Fresh1234",
      confirm: "Fresh1234",
      partnerCode: "",
      origin: "http://127.0.0.1:43123",
      meta,
      consent: true,
    });
    assert.equal(duplicate.ok, false);

    const previousTeamInvitesOrgAllowlist = process.env.TEAM_INVITES_ORG_ALLOWLIST;
    try {
      delete process.env.TEAM_INVITES_ORG_ALLOWLIST;
      await assert.rejects(
        () => inviteMember(staff(users[0], created.orgId, "live", email), { email: `extra.${stamp}@example.com`, name: "多的人", role: "manager" }),
        (error: unknown) => error instanceof FlowError && error.key === "errors.teamInvitesSoon",
      );
      await assert.rejects(
        () => inviteMember(staff(users[0], created.sandboxId, "sandbox", email), {
          email: `sand.${stamp}@example.com`,
          name: "測試邀請",
          role: "manager",
        }),
        (error: unknown) => error instanceof FlowError && error.key === "errors.teamInvitesSoon",
      );

      process.env.TEAM_INVITES_ORG_ALLOWLIST = `${created.orgId},${created.sandboxId}`;
      await assert.rejects(
        () => inviteMember(staff(users[0], created.orgId, "live", email), { email: `extra.${stamp}@example.com`, name: "多的人", role: "manager" }),
        (error: unknown) => error instanceof FlowError && error.key === "errors.seatLimit",
      );
      await assert.rejects(
        () => inviteMember(staff(users[0], created.sandboxId, "sandbox", email), {
          email: `sand.${stamp}@example.com`,
          name: "測試邀請",
          role: "manager",
        }),
        (error: unknown) => error instanceof FlowError && error.key === "errors.teamInvitesSoon",
      );
    } finally {
      if (previousTeamInvitesOrgAllowlist === undefined) {
        delete process.env.TEAM_INVITES_ORG_ALLOWLIST;
      } else {
        process.env.TEAM_INVITES_ORG_ALLOWLIST = previousTeamInvitesOrgAllowlist;
      }
    }

    const secondStart = await startSignup({
      email: other,
      password: "Fresh1234",
      confirm: "Fresh1234",
      partnerCode: "NOT-A-CODE",
      origin: "http://127.0.0.1:43123",
      meta,
      consent: true,
    });
    if (!secondStart.ok || secondStart.status !== "verify" || !secondStart.devToken) throw new Error("second verify");
    await confirmSignupToken(secondStart.devToken, meta);
    const secondId = (await query<{ id: string }>(`SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`, [other])).rows[0].id;
    users.push(secondId);
    const dupFirm = await createFirm({
      userId: secondId,
      email: other,
      kind: "firm",
      name: created.name,
      contactName: "另一位",
      phone: "",
      partnerCode: "NOT-A-CODE",
    });
    assert.equal(dupFirm.ok, true);
    if (!dupFirm.ok) throw new Error("dup");
    orgs.push(dupFirm.orgId);
    assert.equal(dupFirm.dupName, true);
    assert.equal(dupFirm.codeApplied, false);
    assert.equal(dupFirm.codeIgnored, true);
    const flag = await query<{ dup: boolean }>(`SELECT dup_name_flag AS dup FROM organizations WHERE id = $1`, [dupFirm.orgId]);
    assert.equal(flag.rows[0].dup, true);
  } finally {
    await query(`UPDATE platform_settings SET value = 'false'::jsonb WHERE key = 'go_live_lock'`).catch(() => undefined);
    if (savedEnv == null) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = savedEnv;
    if (savedUrl == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedUrl;
    if (orgs.length) {
      await query(`DELETE FROM organizations WHERE id = ANY($1::uuid[]) OR live_org_id = ANY($1::uuid[])`, [orgs]).catch(() => undefined);
    }
    if (users.length) {
      await query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]).catch(() => undefined);
    }
  }
});

test("an expired unused signup verification cannot confirm", { timeout: 180_000 }, async () => {
  const savedEnv = process.env.CONDOLA_ENV;
  const savedUrl = process.env.SUPABASE_URL;
  const savedPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.CONDOLA_ENV;
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const stamp = Date.now().toString(36);
  const email = `expired.${stamp}@example.com`;
  const users: string[] = [];
  try {
    assert.equal(signupLinksExposed(), true);
    const started = await startSignup({
      email,
      password: "Fresh1234",
      confirm: "Fresh1234",
      partnerCode: "",
      origin: "http://127.0.0.1:43123",
      meta,
      consent: true,
    });
    assert.equal(started.ok, true);
    if (!started.ok || started.status !== "verify" || !started.devToken) throw new Error("expected a local confirm link");

    const found = await query<{ id: string }>(`SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`, [email]);
    const userId = found.rows[0]?.id;
    assert.ok(userId);
    users.push(userId);

    const expired = await query(
      `UPDATE signup_verifications SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    );
    assert.equal(expired.rowCount, 1);

    const confirmed = await confirmSignupToken(started.devToken, meta);
    assert.equal(confirmed.ok, false);
    if (confirmed.ok) throw new Error("expected an expired confirmation");
    assert.equal(confirmed.error, "expired");
  } finally {
    if (savedEnv === undefined) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = savedEnv;
    if (savedUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedUrl;
    if (savedPublicUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = savedPublicUrl;
    if (users.length) {
      await query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]).catch(() => undefined);
    }
  }
});
