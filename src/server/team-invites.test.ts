import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeT } from "@/i18n";
import { errorText } from "@/i18n/errors";
import { POST } from "@/app/api/flows/[action]/route";
import { TEAM_INVITES_ENABLED, assertTeamInvitesAllowed, inviteStateMessageKey } from "./team-invites";
import { acceptTeamInvite, upsertInvitedUser, verifyPassword } from "./auth";
import type { Client } from "pg";

function before(source: string, first: string, second: string) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a >= 0, `Missing ${first}`);
  assert.ok(b > a, `${first} must precede ${second}`);
}

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("team invite guards use the session or invitation org at every entry point", () => {
  assert.equal(TEAM_INVITES_ENABLED, false);
  assert.equal(errorText(makeT("zh-TW"), "errors.teamInvitesSoon"), "即將開放");
  assert.equal(errorText(makeT("en"), "errors.teamInvitesSoon"), "Coming soon");

  const authActions = source("./auth-actions.ts");
  const legacy = source("./actions.ts");
  for (const [text, start, end, call] of [
    [authActions, "export async function actionInvite(", "export async function actionResendInvite(", "inviteMember("],
    [authActions, "export async function actionResendInvite(", "export async function actionRevokeInvite(", "resendInvite("],
    [legacy, "export async function actionInvite(", "export async function actionSetMeter(", "inviteTeammate("],
  ]) {
    const startIndex = text.indexOf(start);
    assert.ok(startIndex >= 0);
    const endIndex = text.indexOf(end, startIndex + start.length);
    const body = text.slice(startIndex, endIndex < 0 ? undefined : endIndex);
    before(body, "getSession()", "assertTeamInvitesAllowed(session.orgId)");
    before(body, "assertTeamInvitesAllowed(session.orgId)", call);
  }

  const route = source("../app/api/flows/[action]/route.ts");
  before(route, "!teamInviteAllowlistConfigured()", "readSession()");
  before(route, "readSession()", "teamInvitesAllowedForOrg(session?.orgId)");
  before(route, "teamInvitesAllowedForOrg(session?.orgId)", "handler(session, body)");
  before(route, "teamInvitesAllowedForOrg(session?.orgId)", "if (!session)");

  const accept = authActions.slice(authActions.indexOf("export async function actionAccept("));
  before(accept, "teamInvitesAllowedForOrg(invite.orgId)", "acceptInvite(");
  assert.match(accept, /result\.error === "soon"/);

  const auth = source("./auth.ts");
  const teamAccept = auth.slice(auth.indexOf("export async function acceptTeamInvite("));
  before(teamAccept, "teamInvitesAllowedForOrg(row.org_id)", "upsertInvitedUser(");
  for (const name of ["inviteMember", "resendInvite"]) {
    const body = auth.slice(auth.indexOf(`export async function ${name}(`));
    before(body, 'assertPerm(session, "team.manage")', "assertTeamInvitesAllowed(session.orgId)");
    before(body, "assertTeamInvitesAllowed(session.orgId)", "await query");
  }
  const domain = source("./domain.ts");
  const teammate = domain.slice(domain.indexOf("export async function inviteTeammate("));
  before(teammate, 'assertStaff(session, ["admin"])', "assertTeamInvitesAllowed(session.orgId)");
  before(teammate, "assertTeamInvitesAllowed(session.orgId)", "await tx(");

  const teamPage = source("../app/m/team/page.tsx");
  assert.match(teamPage, /const invitesOpen = teamInvitesAllowedForOrg\(session\.orgId\)/);
  assert.match(teamPage, /\{invitesOpen \? \(/);
  assert.match(teamPage, /\{!invitesOpen \? \(/);
  const acceptPage = source("../app/accept/[token]/page.tsx");
  assert.match(acceptPage, /teamInvitesAllowedForOrg\("orgId" in invite \? invite\.orgId \?\? null : null\)/);
  assert.match(acceptPage, /inviteStateMessageKey\(invite\.kind, invite\.state, invitesOpen\)/);
  assert.match(acceptPage, /!invitesOpen \? \(/);
});

test("empty config refuses invites and unauthenticated API probes without sending mail", async () => {
  const previous = process.env.TEAM_INVITES_ORG_ALLOWLIST;
  const savedFetch = global.fetch;
  const calls: string[] = [];
  try {
    delete process.env.TEAM_INVITES_ORG_ALLOWLIST;
    global.fetch = async (input) => {
      calls.push(String(input));
      throw new Error("Must not send mail");
    };
    assert.throws(() => assertTeamInvitesAllowed(INVITEE_ID), { key: "errors.teamInvitesSoon" });
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
    global.fetch = savedFetch;
    if (previous === undefined) delete process.env.TEAM_INVITES_ORG_ALLOWLIST;
    else process.env.TEAM_INVITES_ORG_ALLOWLIST = previous;
  }
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
    "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "TEAM_INVITES_ORG_ALLOWLIST",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  const savedFetch = global.fetch;
  try {
    for (const key of keys) delete process.env[key];
    process.env.TEAM_INVITES_ORG_ALLOWLIST = INVITEE_ID;
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
