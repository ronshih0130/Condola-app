import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import nextHeaders from "next/headers";
import { Client } from "pg";
import { buildStoredConsent } from "./consent";
import { makeT } from "@/i18n";
import { errorText } from "@/i18n/errors";
import { POST } from "@/app/api/flows/[action]/route";
import { TEAM_INVITES_ENABLED, assertTeamInvitesAllowed, inviteStateMessageKey } from "./team-invites";
import { acceptTeamInvite, hashInviteToken, upsertInvitedUser, verifyPassword } from "./auth";

function before(source: string, first: string, second: string) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  assert.ok(a >= 0, `Missing ${first}`);
  assert.ok(b > a, `${first} must precede ${second}`);
}

// Exercise the real consent/session lookup with a current live staff identity.
// Only session reads and its last-active update are allowed; no domain SQL runs.
test.beforeEach(() => {
  mock.method(nextHeaders, "cookies", async () => ({
    get: (name: string) => name === "condola_session" ? { value: "unit-session" } : undefined,
  }));
  mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/m/team" }));
  mock.method(Client.prototype, "connect", async () => {});
  mock.method(Client.prototype, "end", async () => {});
  mock.method(Client.prototype, "query", async (sql: string) => {
    if (sql.includes("FROM auth_sessions s")) return { rows: [{
      session_id: "unit-session", user_id: "unit-user", name: "Unit Staff",
      email: "staff@example.com", consent: buildStoredConsent("reconsent"),
    }] };
    if (sql.includes("UPDATE auth_sessions")) return { rows: [] };
    if (sql.includes("FROM org_members m")) return { rows: [{
      org_id: "unit-org", role: "admin", live_enabled: true, has_live_data: true,
    }] };
    assert.fail("Unexpected SQL before invite refusal: " + sql);
  });
});
test.afterEach(() => mock.restoreAll());

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

  const accept = authActions.slice(
    authActions.indexOf("export async function actionAccept("),
    authActions.indexOf("function teamLinkFailure("),
  );
  before(accept, 'invite.kind === "team_member"', "acceptInvite(");
  assert.match(accept, /error: "errors\.teamInviteUnavailable"/);
  assert.doesNotMatch(accept, /errors\.teamInvitesSoon/);

  for (const name of ["actionIssueTeamInviteLink", "actionCreateTeamInviteLink"]) {
    const start = authActions.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0);
    const end = authActions.indexOf("\nexport async function ", start + 1);
    const body = authActions.slice(start, end < 0 ? undefined : end);
    before(body, "await requireCurrentConsent()", "readSession()");
    before(body, "await requireCurrentConsent()", name === "actionIssueTeamInviteLink" ? "resendInvite(" : "inviteMember(");
  }

  const auth = source("./auth.ts");
  const teamAccept = auth.slice(auth.indexOf("export async function acceptTeamInvite("));
  before(teamAccept, "teamInvitesAllowedForOrg(row.org_id)", "upsertInvitedUser(");
  for (const name of ["inviteMember", "resendInvite"]) {
    const body = auth.slice(auth.indexOf(`export async function ${name}(`));
    before(body, "assertTeamAdmin(session)", "assertTeamInvitesAllowed(session.orgId)");
    before(body, "assertTeamInvitesAllowed(session.orgId)", "await withClient(");
    before(body, "lockSeatOrganization(client, session.orgId)", 'organization.environment !== "live"');
  }
  const domain = source("./domain.ts");
  const teammate = domain.slice(domain.indexOf("export async function inviteTeammate("));
  before(teammate, 'assertStaff(session, ["admin"], "team.manage")', "assertTeamInvitesAllowed(session.orgId)");
  before(teammate, "assertTeamInvitesAllowed(session.orgId)", "await tx(");

  const teamPage = source("../app/m/team/page.tsx");
  before(teamPage, 'await requireCurrentConsent(undefined, "page")', "getSession()");
  assert.match(teamPage, /const invitesOpen = session\.kind === "staff" && session\.role === "admin" &&\s*session\.environment === "live" && teamInvitesAllowedForOrg\(session\.orgId\)/);
  assert.match(teamPage, /const legacyInvitesOpen = session\.environment !== "live" && teamInvitesAllowedForOrg\(session\.orgId\)/);
  assert.match(teamPage, /\{invitesOpen \? \(\s*member\.expires_at && new Date\(member\.expires_at\)\.getTime\(\) > Date\.now\(\) \? \(\s*<TeamInviteLinkButton invitationId=\{member\.invitation_id\} \/>\s*\) : null\s*\) : legacyInvitesOpen \? \(/);
  assert.match(teamPage, /!invitesOpen && !legacyInvitesOpen/);
  assert.match(teamPage, /invitesOpen \? \(\s*<TeamInviteForm/);
  const acceptPage = source("../app/accept/[token]/page.tsx");
  before(acceptPage, 'invite.kind === "team_member"', "const session = await readSession()");
  assert.match(acceptPage, /i_team_invite_unavailable/);
  assert.doesNotMatch(acceptPage, /team-accept-soon|accept-name|<PasswordFields|<LegalConsentCheckbox/);
  const join = source("../components/team-join.tsx");
  assert.match(join, /if \(!captured\) return;\s*void actionDescribeTeamJoin\(captured\)/);
  assert.match(join, /actionAcceptTeamJoin\(\{/);
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

test("team token failures share the generic unavailable message", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const t = makeT(locale);
    for (const state of ["expired", "used", "revoked", "invalid"]) {
      for (const enabled of [true, false]) {
        const key = inviteStateMessageKey("team_member", state, enabled);
        assert.equal(key, "i_team_invite_unavailable");
        assert.equal(t(key), t("i_team_invite_unavailable"));
        assert.notEqual(t(key), key);
      }
    }
  }
  assert.equal(inviteStateMessageKey("team_member", "ready", true), "");
  assert.equal(inviteStateMessageKey("team_member", "ready", false), "i_team_invite_unavailable");
  assert.equal(inviteStateMessageKey("owner", "timeout", true), "i_portal_timeout");
  assert.equal(inviteStateMessageKey("tenant", "locked", true), "i_portal_invite_locked");
  assert.equal(inviteStateMessageKey("owner", "invalid", true), "i_portal_invite_invalid");
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

function inviteClient(account?: { id: string; has_password: boolean; matches: boolean; claimed?: boolean }) {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM organizations") && sql.includes("FOR UPDATE")) {
        return { rows: [{ environment: "live", plan_tier: "standard", settings: {} }] };
      }
      if (sql.includes(")::int AS used")) return { rows: [{ used: 1 }] };
      if (sql.includes("FROM invitations")) {
        return { rows: [{
          id: INVITEE_ID, org_id: INVITEE_ID, role: "manager", email: "invitee@example.com",
          code_hash: hashInviteToken("token"), status: "pending", unexpired: true,
        }] };
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

test("a passwordless login that serves a contact or a firm never gets a password from a team invite", async () => {
  for (const remote of [true, false]) {
    await withInviteAuthEnv(async () => {
      global.fetch = async () => { throw new Error("Must not provision a claimed login"); };
      const claimed = { id: INVITEE_ID, has_password: false, matches: false, claimed: true };
      const direct = inviteClient(claimed);
      assert.equal(await upsertInvitedUser(direct.client, "invitee@example.com", "新人", "Fresh1234"), null);
      assert.match(direct.statements[0], /FROM contacts c WHERE c\.user_id = u\.id/);
      assert.match(direct.statements[0], /FROM org_members m WHERE m\.user_id = u\.id/);
      assert.equal(direct.statements.some((sql) => /^\s*(INSERT|UPDATE)\b/.test(sql)), false);
      const accept = inviteClient(claimed);
      assert.deepEqual(
        await acceptTeamInvite(accept.client, "token", "新人", "Fresh1234", { ua: null, ip: null }),
        { ok: false, error: "auth", kind: "team_member" },
      );
      assert.equal(accept.statements.at(-1), "ROLLBACK");
      assert.equal(accept.statements.includes("COMMIT"), false);
      assert.equal(accept.statements.some((sql) => /^\s*(INSERT|UPDATE)\b/.test(sql)), false);
    }, remote);
  }
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
