import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeT } from "@/i18n";
import { errorText } from "@/i18n/errors";
import { POST } from "@/app/api/flows/[action]/route";
import { actionInvite as legacyActionInvite } from "./actions";
import { actionInvite, actionResendInvite } from "./auth-actions";
import { TEAM_INVITES_ENABLED, inviteStateMessageKey } from "./team-invites";

import { acceptTeamInvite, upsertInvitedUser, verifyPassword } from "./auth";
import type { Client } from "pg";

function redirectTarget(error: unknown) {
  const digest = typeof error === "object" && error && "digest" in error ? String((error as { digest?: string }).digest) : "";
  assert.match(digest, /^NEXT_REDIRECT;/);
  return digest.split(";").slice(2, -2).join(";");
}

test("team invite actions and the API refuse while invites are off", async () => {
  assert.equal(TEAM_INVITES_ENABLED, false);
  assert.equal(errorText(makeT("zh-TW"), "errors.teamInvitesSoon"), "即將開放");
  assert.equal(errorText(makeT("en"), "errors.teamInvitesSoon"), "Coming soon");

  const form = new FormData();
  form.set("email", "blocked.hire@example.com");
  form.set("name", "新人");
  form.set("role", "manager");
  const calls: string[] = [];
  const saved = global.fetch;
  global.fetch = async (input) => {
    calls.push(String(input));
    throw new Error("team invite must not send mail");
  };
  try {
    for (const invite of [actionInvite, legacyActionInvite]) {
      await assert.rejects(() => invite(form), (error: unknown) => {
        assert.equal(redirectTarget(error), "/m/team?error=errors.teamInvitesSoon");
        return true;
      });
    }
    const response = await POST(
      new Request("http://127.0.0.1/api/flows/inviteTeammate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "blocked.hire@example.com", role: "manager" }),
      }),
      { params: Promise.resolve({ action: "inviteTeammate" }) },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "errors.teamInvitesSoon" });
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = saved;
  }

  const auth = readFileSync(new URL("./auth-actions.ts", import.meta.url), "utf8");
  const authInvite = auth.slice(auth.indexOf("export async function actionInvite"), auth.indexOf("export async function actionResendInvite"));
  assert.ok(authInvite.indexOf("assertTeamInvitesEnabled()") < authInvite.indexOf("inviteMember("));
  const legacy = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  const legacyInvite = legacy.slice(legacy.indexOf("export async function actionInvite"), legacy.indexOf("export async function actionSetMeter"));
  assert.ok(legacyInvite.indexOf("assertTeamInvitesEnabled()") < legacyInvite.indexOf("inviteTeammate("));
  const route = readFileSync(new URL("../app/api/flows/[action]/route.ts", import.meta.url), "utf8");
  assert.match(route, /action === "inviteTeammate" && !TEAM_INVITES_ENABLED/);
  const guard = route.indexOf('action === "inviteTeammate" && !TEAM_INVITES_ENABLED');
  assert.ok(guard < route.indexOf("readSession()"));
  assert.ok(guard < route.indexOf("handler(session, body)"));

  const accept = auth.slice(auth.indexOf("export async function actionAccept"), auth.indexOf("export async function actionIssuePortalInvite"));
  assert.match(accept, /!TEAM_INVITES_ENABLED/);
  assert.ok(accept.indexOf('invite.kind === "team_member"') < accept.indexOf("acceptInvite("));
  const resend = auth.slice(auth.indexOf("export async function actionResendInvite"), auth.indexOf("export async function actionRevokeInvite"));
  assert.ok(resend.indexOf("assertTeamInvitesEnabled()") < resend.indexOf("resendInvite("));
});

test("resend refuses while team invites are off", async () => {
  assert.equal(TEAM_INVITES_ENABLED, false);
  const form = new FormData();
  form.set("invitationId", "10000000-0000-4000-8000-000000000099");
  await assert.rejects(() => actionResendInvite(form), (error: unknown) => {
    assert.equal(redirectTarget(error), "/m/team?error=errors.teamInvitesSoon");
    return true;
  });
});

test("team link copy preserves enabled errors and uses the real soon copy when disabled", () => {
  const t = makeT("zh-TW");
  for (const state of ["expired", "used", "revoked"]) {
    const key = `i_invite_${state}`;
    assert.equal(inviteStateMessageKey("team_member", state, true), key);
    assert.equal(t(inviteStateMessageKey("team_member", state, true)), t(key));
    assert.notEqual(t(key), key);
    assert.equal(t(inviteStateMessageKey("team_member", state, false)), t("i_team_invites_soon"));
  }
});

const INVITEE_ID = "20000000-0000-4000-8000-000000000099";

async function withInviteAuthEnv(run: () => Promise<void>, remote = true) {
  const keys = [
    "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  const savedFetch = global.fetch;
  try {
    for (const key of keys) delete process.env[key];
    if (remote) {
      process.env.SUPABASE_URL = "http://gotrue.test";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-service";
      process.env.SUPABASE_ANON_KEY = "unit-anon";
    }
    await run();
  } finally {
    global.fetch = savedFetch;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

function inviteClient(account?: { id: string; has_password: boolean; matches: boolean }) {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM invitations")) {
        return { rows: [{ id: INVITEE_ID, org_id: INVITEE_ID, role: "manager", email: "invitee@example.com" }] };
      }
      if (sql.includes("SELECT id::text")) return { rows: account ? [account] : [] };
      if (sql.includes("INSERT INTO auth.users")) return { rows: [{ id: INVITEE_ID }] };
      if (/^(BEGIN|ROLLBACK)$/.test(sql) || sql.includes("INSERT INTO profiles") || sql.includes("UPDATE auth.users")) {
        return { rows: [] };
      }
      throw new Error("Unexpected invitation query: " + sql);
    },
  } as unknown as Client;
  return { client, statements };
}

test("team login creation uses GoTrue admin and can subsequently use the password grant", async () => {
  await withInviteAuthEnv(async () => {
    const { client, statements } = inviteClient();
    let created = false;
    global.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(input) === "http://gotrue.test/auth/v1/admin/users") {
        assert.equal(init?.method, "POST");
        assert.deepEqual(body, { email: "invitee@example.com", password: "Fresh1234", email_confirm: true });
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer unit-service");
        assert.equal(new Headers(init?.headers).get("apikey"), "unit-service");
        created = true;
        return Response.json({ id: INVITEE_ID });
      }
      assert.equal(String(input), "http://gotrue.test/auth/v1/token?grant_type=password");
      assert.equal(init?.method, "POST");
      assert.equal(created, true);
      assert.deepEqual(body, { email: "invitee@example.com", password: "Fresh1234" });
      return Response.json({ user: { id: INVITEE_ID } });
    };
    assert.equal(await upsertInvitedUser(client, "invitee@example.com", "新人", "Fresh1234"), INVITEE_ID);
    assert.equal(await verifyPassword("invitee@example.com", "Fresh1234"), INVITEE_ID);
    assert.equal(statements.some((sql) => /INSERT INTO auth\.users|UPDATE auth\.users/.test(sql)), false);
    assert.equal(statements.some((sql) => sql.includes("INSERT INTO profiles")), true);
  });
});

test("existing passwords must match and are never overwritten", async () => {
  await withInviteAuthEnv(async () => {
    global.fetch = async () => { throw new Error("Must not change an existing password"); };
    const wrong = inviteClient({ id: INVITEE_ID, has_password: true, matches: false });
    assert.deepEqual(
      await acceptTeamInvite(wrong.client, "token", "新人", "Wrong1234", { ua: null, ip: null }),
      { ok: false, error: "auth", kind: "team_member" },
    );
    assert.equal(wrong.statements.at(-1), "ROLLBACK");
    assert.equal(wrong.statements.some((sql) => /^\s*(INSERT|UPDATE)\b/.test(sql)), false);
    const right = inviteClient({ id: INVITEE_ID, has_password: true, matches: true });
    assert.equal(await upsertInvitedUser(right.client, "invitee@example.com", "新人", "Fresh1234"), INVITEE_ID);
    assert.equal(right.statements.some((sql) => sql.includes("UPDATE auth.users")), false);
  });
});

test("an existing passwordless login is updated through GoTrue", async () => {
  await withInviteAuthEnv(async () => {
    const { client, statements } = inviteClient({ id: INVITEE_ID, has_password: false, matches: false });
    global.fetch = async (input, init) => {
      assert.equal(String(input), `http://gotrue.test/auth/v1/admin/users/${INVITEE_ID}`);
      assert.equal(init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        email: "invitee@example.com", password: "Fresh1234", email_confirm: true,
      });
      return Response.json({ user: { id: INVITEE_ID } });
    };
    assert.equal(await upsertInvitedUser(client, "invitee@example.com", "新人", "Fresh1234"), INVITEE_ID);
    assert.equal(statements.some((sql) => /INSERT INTO auth\.users|UPDATE auth\.users/.test(sql)), false);
  });
});

test("GoTrue failures roll back acceptance without SQL fallback or consuming the invite", async () => {
  await withInviteAuthEnv(async () => {
    for (const mode of ["http", "network", "body", "missing-key", "wrong-id"]) {
      const existing = mode === "wrong-id" ? { id: INVITEE_ID, has_password: false, matches: false } : undefined;
      const { client, statements } = inviteClient(existing);
      process.env.SUPABASE_SERVICE_ROLE_KEY = mode === "missing-key" ? "" : "unit-service";
      global.fetch = async () => {
        if (mode === "network") throw new Error("network");
        if (mode === "missing-key") assert.fail("Missing service key must fail before fetch");
        if (mode === "wrong-id") return Response.json({ id: "different-user" });
        return mode === "http" ? Response.json({}, { status: 503 }) : Response.json({});
      };
      assert.deepEqual(
        await acceptTeamInvite(client, "token", "新人", "Fresh1234", { ua: null, ip: null }),
        { ok: false, error: "failed", kind: "team_member" },
      );
      assert.equal(statements.at(-1), "ROLLBACK");
      assert.equal(statements.includes("COMMIT"), false);
      assert.equal(statements.some((sql) => /^\s*(INSERT|UPDATE)\b/.test(sql)), false);
    }
  });
});

test("without a Supabase URL, team provisioning retains the local stub", async () => {
  await withInviteAuthEnv(async () => {
    global.fetch = async () => { throw new Error("Local stub must not fetch"); };
    for (const account of [undefined, { id: INVITEE_ID, has_password: false, matches: false }]) {
      const { client, statements } = inviteClient(account);
      assert.equal(await upsertInvitedUser(client, "invitee@example.com", "新人", "Fresh1234"), INVITEE_ID);
      assert.equal(statements.some((sql) => sql.includes(account ? "UPDATE auth.users" : "INSERT INTO auth.users")), true);
    }
  }, false);
});
