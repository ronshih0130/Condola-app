import assert from "node:assert/strict";
import test from "node:test";
import { resolveIdentity, type IdentityResolveCtx } from "./identity";

const ctx: IdentityResolveCtx = {
  preferredOrg: null,
  envCookie: null,
  path: "",
  portalCookie: null,
  leaseId: null,
};

type Row = Record<string, unknown>;
type Step = {
  match: string;
  rows: Row[];
  check?: (sql: string, params: unknown[]) => void;
};

function scripted(steps: Step[]) {
  let index = 0;
  return {
    async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const step = steps[index++];
      assert.ok(step, `Unexpected query: ${sql}`);
      assert.ok(sql.includes(step.match), `Expected query containing ${step.match}`);
      step.check?.(sql, params);
      return { rows: step.rows as T[] };
    },
    done() {
      assert.equal(index, steps.length);
    },
  };
}

const member = {
  org_id: "live-a",
  role: "manager",
  live_enabled: true,
  has_live_data: false,
};

function contact(orgId: string, owner: boolean, tenant: boolean, extra: Row = {}): Row {
  return {
    org_id: orgId,
    environment: "live",
    live_org_id: orgId,
    is_owner: owner,
    is_tenant: tenant,
    latest_kind: null,
    latest_at: null,
    ...extra,
  };
}

function portalSteps(rows: Row[]): Step[] {
  return [
    { match: "FROM org_members m", rows: [] },
    {
      match: "FROM contacts c",
      rows,
      check(sql, params) {
        assert.ok(sql.includes("c.user_id = $1 AND c.archived_at IS NULL"));
        assert.deepEqual(params, ["user"]);
      },
    },
  ];
}

test("staff wins before portal even on a portal path with a lease cookie", async () => {
  const sql = scripted([{ match: "FROM org_members m", rows: [member] }]);
  assert.deepEqual(await resolveIdentity(sql, "user", {
    ...ctx, path: "/o", portalCookie: "owner", leaseId: "lease",
  }), {
    kind: "staff", orgId: "live-a", liveOrgId: "live-a",
    environment: "live", role: "manager", liveEnabled: true, needsSandbox: false,
  });
  sql.done();
});

test("preferredOrg only orders active live memberships", async () => {
  for (const preferredOrg of [null, "live-a", "live-b", "foreign"]) {
    const sql = scripted([{
      match: "FROM org_members m",
      rows: [{ ...member, org_id: preferredOrg === "live-b" ? "live-b" : "live-a" }],
      check(query, params) {
        assert.deepEqual(params, ["user", preferredOrg]);
        assert.ok(query.includes("m.status = 'active' AND o.environment = 'live'"));
        assert.ok(query.includes("ORDER BY CASE WHEN m.org_id::text = $2 THEN 0 ELSE 1 END, m.created_at"));
      },
    }]);
    const result = await resolveIdentity(sql, "user", { ...ctx, preferredOrg });
    assert.equal(result?.orgId, preferredOrg === "live-b" ? "live-b" : "live-a");
    sql.done();
  }
});

test("sandbox swaps to the linked org or requests provisioning", async () => {
  for (const present of [true, false]) {
    const sql = scripted([
      { match: "FROM org_members m", rows: [member] },
      {
        match: "WHERE live_org_id = $1 AND environment = 'sandbox'",
        rows: present ? [{ id: "sandbox-a" }] : [],
        check(_query, params) { assert.deepEqual(params, ["live-a"]); },
      },
    ]);
    assert.deepEqual(await resolveIdentity(sql, "user", { ...ctx, envCookie: "sandbox" }), {
      kind: "staff", orgId: present ? "sandbox-a" : "live-a",
      liveOrgId: "live-a", environment: "sandbox", role: "manager",
      liveEnabled: true, needsSandbox: !present,
    });
    sql.done();
  }
});

test("portal selection follows path, cookie, latest invitation, then tenant preference", async () => {
  const owner = contact("owner-org", true, false, {
    latest_kind: "owner", latest_at: new Date("2026-11-04"),
  });
  const tenant = contact("tenant-org", false, true, {
    latest_kind: "tenant", latest_at: new Date("2026-11-03"),
  });
  const cases = [
    { path: "/t", cookie: "owner", rows: [owner, tenant], kind: "tenant", org: "tenant-org" },
    { path: "/t/leases", cookie: "owner", rows: [owner, tenant], kind: "tenant", org: "tenant-org" },
    { path: "/o", cookie: "tenant", rows: [owner, tenant], kind: "owner", org: "owner-org" },
    { path: "/o/leases", cookie: "tenant", rows: [owner, tenant], kind: "owner", org: "owner-org" },
    { path: "", cookie: "tenant", rows: [owner, tenant], kind: "tenant", org: "tenant-org" },
    { path: "", cookie: "owner", rows: [owner, tenant], kind: "owner", org: "owner-org" },
    { path: "", cookie: null, rows: [owner, tenant], kind: "owner", org: "owner-org" },
    { path: "", cookie: "invalid", rows: [owner, tenant], kind: "owner", org: "owner-org" },
    {
      path: "", cookie: null,
      rows: [contact("owner-org", true, false), contact("tenant-org", false, true)],
      kind: "tenant", org: "tenant-org",
    },
    { path: "/t", cookie: "tenant", rows: [owner], kind: "owner", org: "owner-org" },
    { path: "/o", cookie: "owner", rows: [tenant], kind: "tenant", org: "tenant-org" },
  ];
  for (const entry of cases) {
    const sql = scripted(portalSteps(entry.rows));
    assert.deepEqual(await resolveIdentity(sql, "user", {
      ...ctx, path: entry.path, portalCookie: entry.cookie,
    }), {
      kind: entry.kind, role: null, orgId: entry.org, liveOrgId: entry.org,
      environment: "live",
      portals: {
        owner: entry.rows.some((row) => row.is_owner),
        tenant: entry.rows.some((row) => row.is_tenant),
      },
    });
    sql.done();
  }
});

test("dual-role contact uses path before cookie and invitation", async () => {
  for (const [path, kind] of [["/t", "tenant"], ["/o", "owner"]]) {
    const sql = scripted(portalSteps([contact("both", true, true, {
      latest_kind: "owner", latest_at: new Date("2026-11-04"),
    })]));
    const result = await resolveIdentity(sql, "user", { ...ctx, path, portalCookie: "owner" });
    assert.equal(result?.kind, kind);
    assert.equal(result?.orgId, "both");
    sql.done();
  }
});

test("lease override requires the user's own contact; foreign lease grants nothing", async () => {
  for (const own of [true, false]) {
    const sql = scripted([
      ...portalSteps([contact("tenant-org", false, true)]),
      {
        match: "FROM leases l",
        rows: own ? [{ org_id: "lease-org", environment: "sandbox", live_org_id: "lease-live" }] : [],
        check(query, params) {
          assert.ok(query.includes("JOIN lease_parties lp ON lp.lease_id = l.id"));
          assert.ok(query.includes("JOIN contacts c ON c.id = lp.contact_id"));
          assert.ok(query.includes("WHERE l.id = $1 AND c.user_id = $2"));
          assert.deepEqual(params, [own ? "own-lease" : "foreign-lease", "user"]);
        },
      },
    ]);
    assert.deepEqual(await resolveIdentity(sql, "user", {
      ...ctx, leaseId: own ? "own-lease" : "foreign-lease",
    }), {
      kind: "tenant", role: null, orgId: own ? "lease-org" : "tenant-org",
      liveOrgId: own ? "lease-live" : "tenant-org", environment: own ? "sandbox" : "live",
      portals: { owner: false, tenant: true },
    });
    sql.done();
  }
});

test("neither membership nor portal returns null, even with foreign org and lease cookies", async () => {
  const sql = scripted(portalSteps([]));
  assert.equal(await resolveIdentity(sql, "user", {
    ...ctx, preferredOrg: "foreign", leaseId: "foreign-lease",
  }), null);
  sql.done();
});
