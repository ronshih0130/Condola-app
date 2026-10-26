import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Client } from "pg";
import { POST } from "@/app/api/flows/[action]/route";
import { acceptTeamInvite, inviteMember, resendInvite } from "./auth";
import { inviteTeammate } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import {
  TEAM_INVITES_ENABLED,
  assertTeamInvitesAllowed,
  parseTeamInviteOrgAllowlist,
  teamInviteAllowlistConfigured,
  teamInvitesAllowedForOrg,
} from "./team-invites";
import type { Session } from "./types";

const USER_ID = "20000000-0000-4000-8000-000000000099";
const meta = { ua: null, ip: null };

function admin(): Session {
  return {
    userId: USERS.admin, sessionId: "test", email: "yating.lin@songxin.demo",
    name: "林雅婷", kind: "staff", role: "admin", orgId: ORG2_ID,
    liveOrgId: ORG2_ID, environment: "live", locale: "zh-TW",
    calendar: "gregorian", leaseId: null,
  };
}

async function withEnv(run: () => Promise<void>) {
  const keys = [
    "TEAM_INVITES_ORG_ALLOWLIST", "DATABASE_URL", "SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  const savedFetch = global.fetch;
  try {
    for (const key of keys) delete process.env[key];
    process.env.TEAM_INVITES_ORG_ALLOWLIST = ORG_ID;
    process.env.SUPABASE_URL = "http://gotrue.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-service";
    await run();
  } finally {
    global.fetch = savedFetch;
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
}

test("allowlist parsing and predicate fail closed and never imply another org", () => {
  assert.equal(TEAM_INVITES_ENABLED, false);
  const mixedCaseId = "AbCdEf01-2345-6789-aBcD-eF0123456789";
  const cases: Array<[string | undefined, string[]]> = [
    [undefined, []], ["", []], ["  ", []], [",", []],
    [ORG_ID, [ORG_ID]],
    [`  ${mixedCaseId} , , `, [mixedCaseId.toLowerCase()]],
    [`${ORG_ID}, ${ORG2_ID}`, [ORG_ID, ORG2_ID]],
    ...["org-1", "not-a-uuid", "' OR 1=1", ORG_ID.slice(0, -1)].map(
      (bad): [string, string[]] => [`${ORG_ID},${bad}`, []],
    ),
  ];
  for (const [raw, expected] of cases) {
    const env = { TEAM_INVITES_ORG_ALLOWLIST: raw };
    assert.deepEqual([...parseTeamInviteOrgAllowlist(raw)], expected);
    assert.equal(teamInviteAllowlistConfigured(env), expected.length > 0);
    for (const id of [ORG_ID, ORG2_ID, mixedCaseId, mixedCaseId.toUpperCase()]) {
      assert.equal(teamInvitesAllowedForOrg(id, env), expected.includes(id.toLowerCase()));
    }
    for (const id of [null, undefined, "", "org-1", ` ${ORG_ID}`]) {
      assert.equal(teamInvitesAllowedForOrg(id, env), false);
    }
  }
  assert.equal(teamInvitesAllowedForOrg(ORG2_ID, { TEAM_INVITES_ORG_ALLOWLIST: ORG_ID }), false);
  assert.throws(
    () => assertTeamInvitesAllowed(ORG2_ID, { TEAM_INVITES_ORG_ALLOWLIST: ORG_ID }),
    (error) => error instanceof FlowError && error.key === "errors.teamInvitesSoon",
  );
});

test("default env is read at call time", async () => {
  await withEnv(async () => {
    assert.equal(teamInvitesAllowedForOrg(ORG_ID), true);
    process.env.TEAM_INVITES_ORG_ALLOWLIST = ORG2_ID;
    assert.equal(teamInvitesAllowedForOrg(ORG_ID), false);
    assert.equal(teamInvitesAllowedForOrg(ORG2_ID), true);
    delete process.env.TEAM_INVITES_ORG_ALLOWLIST;
    assert.equal(teamInvitesAllowedForOrg(ORG2_ID), false);
  });
});

type Statement = { sql: string; values: unknown[] };

/** Account state represents GoTrue's independent commit; other state is transactional. */
function fakeClient(options: { orgId?: string; role?: string; throwOn?: RegExp } = {}) {
  const statements: Statement[] = [];
  let account: { password: string } | undefined;
  let accepted = false;
  let memberRole: unknown;
  let pendingAccepted = false;
  let pendingRole: unknown;
  let throwOn = options.throwOn;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      if (throwOn?.test(sql)) {
        throwOn = undefined;
        throw new Error("injected DB failure");
      }
      if (sql === "BEGIN") {
        pendingAccepted = accepted;
        pendingRole = memberRole;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        pendingAccepted = accepted;
        pendingRole = memberRole;
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        accepted = pendingAccepted;
        memberRole = pendingRole;
        return { rows: [] };
      }
      if (sql.includes("FROM invitations")) {
        return { rows: accepted ? [] : [{
          id: USER_ID, org_id: options.orgId ?? ORG_ID,
          email: "fault@example.com", role: options.role ?? "accountant",
        }] };
      }
      if (sql.includes("FROM auth.users")) {
        return { rows: account ? [{
          id: USER_ID, has_password: true, matches: account.password === values[1],
        }] : [] };
      }
      if (sql.includes("SELECT status::text FROM org_members")) return { rows: [] };
      if (sql.includes("INSERT INTO profiles")) return { rows: [] };
      if (sql.includes("INSERT INTO org_members")) {
        pendingRole = values[2];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE invitations")) {
        pendingAccepted = true;
        return { rows: [], rowCount: 1 };
      }
      if (
        sql === "RESET ROLE" ||
        sql === "SET ROLE service_role" ||
        sql === "SET LOCAL ROLE service_role" ||
        sql === "DELETE FROM portal_invite_secrets WHERE invitation_id = $1"
      ) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as Client;
  return {
    client, statements,
    provision(password: string) { account = { password }; },
    get accepted() { return accepted; },
    get memberRole() { return memberRole; },
  };
}

function noWrites(statements: Statement[]) {
  assert.equal(statements.some(({ sql }) => /^\s*(INSERT|UPDATE)\b/.test(sql)), false);
}

test("refused invitation org rolls back before any provisioning or writes", async () => {
  await withEnv(async () => {
    let fetches = 0;
    global.fetch = async () => { fetches++; throw new Error("Must not fetch"); };
    const fake = fakeClient({ orgId: ORG2_ID });
    assert.deepEqual(
      await acceptTeamInvite(fake.client, "token", "Hire", "Fresh1234", meta),
      { ok: false, error: "soon", kind: "team_member" },
    );
    assert.equal(fake.statements.at(-1)?.sql, "ROLLBACK");
    noWrites(fake.statements);
    assert.equal(fetches, 0);
  });
});

test("server invite functions refuse before DB access; unauthenticated API remains 400", async () => {
  await withEnv(async () => {
    assert.equal(process.env.DATABASE_URL, undefined);
    for (const run of [
      () => inviteMember(admin(), { email: "hire@example.com", name: "Hire", role: "accountant" }),
      () => resendInvite(admin(), USER_ID),
      () => inviteTeammate(admin(), { email: "hire@example.com", role: "accountant" }),
    ]) {
      await assert.rejects(run, (error) => error instanceof FlowError && error.key === "errors.teamInvitesSoon");
    }
    const route = readFileSync(new URL("../app/api/flows/[action]/route.ts", import.meta.url), "utf8");
    const configuredGate = route.indexOf("!teamInviteAllowlistConfigured()");
    const read = route.indexOf("readSession()");
    const orgGate = route.indexOf("teamInvitesAllowedForOrg(session?.orgId)");
    const unauthorized = route.indexOf("if (!session)");
    const handler = route.indexOf("handler(session, body)");
    assert.ok(configuredGate >= 0 && read > configuredGate);
    assert.ok(orgGate > read);
    assert.ok(unauthorized > orgGate);
    assert.ok(handler > orgGate);

    for (const raw of [undefined, "", "  ", `${ORG_ID},not-a-uuid`]) {
      if (raw === undefined) delete process.env.TEAM_INVITES_ORG_ALLOWLIST;
      else process.env.TEAM_INVITES_ORG_ALLOWLIST = raw;
      const response = await POST(
        new Request("http://localhost/api/flows/inviteTeammate", {
          method: "POST", body: JSON.stringify({ email: "hire@example.com", role: "accountant" }),
        }),
        { params: Promise.resolve({ action: "inviteTeammate" }) },
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, error: "errors.teamInvitesSoon" });
    }
  });
});

/** Post-COMMIT consent/audit/session helpers use the real DB, absent in unit tests. */
async function reachesCommit(fake: ReturnType<typeof fakeClient>) {
  try {
    await acceptTeamInvite(fake.client, "token", "Hire", "Fresh1234", meta);
  } catch {
    // A post-COMMIT helper may throw; the transaction evidence is asserted below.
  }
  assert.ok(fake.statements.some(({ sql }) => sql === "COMMIT"));
  assert.equal(fake.accepted, true);
  assert.equal(fake.memberRole, "accountant");
}

test("I-11: independent GoTrue commit survives DB rollback; retries preserve password and role", async () => {
  await withEnv(async () => {
    const fake = fakeClient({ throwOn: /INSERT INTO org_members/, role: "accountant" });
    let creates = 0;
    global.fetch = async (input, init) => {
      assert.equal(String(input), "http://gotrue.test/auth/v1/admin/users");
      assert.equal(init?.method, "POST");
      creates++;
      fake.provision(JSON.parse(String(init?.body)).password);
      return Response.json({ id: USER_ID });
    };
    await assert.rejects(
      () => acceptTeamInvite(fake.client, "token", "Hire", "Fresh1234", meta),
      /injected DB failure/,
    );
    assert.equal(fake.statements.at(-1)?.sql, "ROLLBACK");
    assert.equal(fake.statements.some(({ sql }) => sql === "COMMIT"), false);
    assert.equal(fake.accepted, false);
    assert.equal(fake.memberRole, undefined);
    assert.equal(creates, 1);

    fake.statements.length = 0;
    assert.deepEqual(
      await acceptTeamInvite(fake.client, "token", "Hire", "Different1234", meta),
      { ok: false, error: "auth", kind: "team_member" },
    );
    noWrites(fake.statements);
    assert.equal(fake.statements.some(({ sql }) => sql === "COMMIT"), false);
    assert.equal(creates, 1);

    fake.statements.length = 0;
    await reachesCommit(fake);
    assert.equal(creates, 1);
    assert.equal(fake.statements.some(({ sql }) => /INSERT INTO auth\.users|UPDATE auth\.users/.test(sql)), false);
  });
});

test("I-11: ambiguous GoTrue timeout rolls back; a remotely created account supports retry", async () => {
  await withEnv(async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const fake = fakeClient({ role: "accountant" });
      let creates = 0;
      global.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          init?.method !== "POST" ||
          url !== "http://gotrue.test/auth/v1/admin/users"
        ) {
          throw new Error("unexpected fetch");
        }
        creates++;
        fake.provision(JSON.parse(String(init?.body)).password);
        throw new DOMException("ambiguous timeout", name);
      };
      assert.deepEqual(
        await acceptTeamInvite(fake.client, "token", "Hire", "Fresh1234", meta),
        { ok: false, error: "failed", kind: "team_member" },
      );
      assert.equal(fake.statements.at(-1)?.sql, "ROLLBACK");
      assert.equal(fake.statements.some(({ sql }) => sql === "COMMIT"), false);
      noWrites(fake.statements);
      assert.equal(fake.accepted, false);
      fake.statements.length = 0;
      await reachesCommit(fake);
      assert.equal(creates, 1);
    }
  });
});
