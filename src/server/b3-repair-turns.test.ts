import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { staffRepairTurns } from "./b3-repair-turns";
import { todayTurnCounts, repairTodayKey } from "../lib/b3-today";
import { FlowError } from "./errors";
const read = (p: string) => readFileSync(p, "utf8");
const m1 = read("supabase/migrations/20261115170000_b3_owner_pending_terminal.sql");
const m2 = read("supabase/migrations/20261115170100_b3_staff_repair_turns.sql");
const m3 = read("supabase/migrations/20261115170200_b3_vendor_repair_turn.sql");
const session = { kind: "staff", role: "admin", orgId: "00000000-0000-4000-8000-000000000001", liveOrgId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002", sessionId: "00000000-0000-4000-8000-000000000003", name: "Synthetic", email: "",
  environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null } as const;

test("B1 M1 is exactly PR-015 pending plus terminal predicate; history/writers untouched, OFF exception", () => {
  const original = read("supabase/migrations/20261115130000_b013_current_owner_authority.sql");
  const body = (s: string) => s.slice(s.indexOf("CREATE OR REPLACE FUNCTION app.b013_owner_pending"), s.indexOf("END $$;") + 7);
  const delta = "  AND EXISTS (\n   SELECT 1 FROM public.maintenance_tickets t\n   WHERE t.org_id=v.org_id AND t.id=v.ticket_id AND t.property_id=v.property_id\n    AND t.status NOT IN ('closed','cancelled')\n  )\n";
  assert.ok(m1.includes(delta)); assert.equal(body(m1).replace(delta, ""), body(original));
  assert.equal((m1.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
  assert.doesNotMatch(m1, /b013_owner_history|b013_decide_estimate|feature_flags|CURRENT_DATE/);
});
test("M2/M3 SQL first-match order, helpers, B-026 and no business writes", () => {
  for (const sql of [m2, m3]) {
    const partition = sql.slice(sql.indexOf(", rules AS MATERIALIZED"), sql.indexOf(", mapped AS MATERIALIZED"));
    assert.deepEqual([...partition.matchAll(/THEN '(R[^']+)'|ELSE '(R8)'/g)].map(m => m[1] ?? m[2]),
      ["R1", "R2", "R3", "R5", "R6", "R7a", "R7b", "R8-blocked", "R4", "R8"]);
    assert.match(sql, /NOT retained OR allowed closure_guard/);
    assert.doesNotMatch(sql, /repair_vendor_secrets|b104_vendor_command_exists|INSERT\s+INTO|UPDATE\s+(?:public\.|app\.)|DELETE\s+FROM/i);
    assert.match(sql, /LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp/);
  }
  const facts = m2.slice(m2.indexOf("WITH facts AS MATERIALIZED"), m2.indexOf(" ), predicates AS MATERIALIZED"));
  assert.doesNotMatch(facts, /app\.[a-z_0-9]+\s*\(/i, "M2 facts must not invoke per-ticket helpers");
  assert.match(facts, /head\.org_id=t\.org_id AND head\.ticket_id=t\.id/);
  assert.match(facts, /v\.id=head\.current_version_id/);
  assert.match(facts, /NOT v\.requires_owner_decision OR d\.decision='approved' OR e\.id IS NOT NULL/);
  assert.match(m3, /app\.b104_current_repair_version/); assert.match(m3, /app\.b104_vendor_latest_event/);
  assert.match(m2, /a\.repair_vendor_job_id=j\.id AND a\.version_id=v\.id/);
  assert.match(m2, /ORDER BY a\.occurred_at DESC,a\.id DESC/);
  assert.doesNotMatch(m3, /app\.b013_repair_appointments/);
  const maintenance = m2.slice(m2.indexOf("IF actor.member_role='maintenance'"), m2.indexOf("-- Both selected-org"));
  assert.doesNotMatch(maintenance, /b013|b104|b026|emergenc|estimate|event_at/);
  assert.match(maintenance, /'holder',NULL,'step',NULL/);
  assert.match(m2, /app\.b056_member_paused\(p_live,p_user\)/);
  assert.match(m2, /public\.b017_resolve\(p_live,p_user,p_session\)/);
  assert.match(m2, /current_setting\('app.active_org_id'/);
  assert.match(m3, /expires_at<=clock_timestamp\(\)/);
});
test("PLT-53 APIs: OFF avoids transactions; flag failure unavailable; nonstaff denied", async () => {
  const never = (async () => { throw new Error("transaction must not run"); }) as never;
  assert.deepEqual(await staffRepairTurns(session, {}, { v3: async () => false, transaction: never }), { state: "off" });
  assert.deepEqual(await staffRepairTurns(session, {}, { v3: async () => { throw new Error("flag read failed"); }, transaction: never }), { state: "unavailable" });
  for (const actor of [{ ...session, kind: "owner" as const, role: null }, { ...session, kind: "tenant" as const, role: null },
    { ...session, role: "accountant" as const }]) await assert.rejects(staffRepairTurns(actor, {}, { v3: async () => true, transaction: never }),
      (e: unknown) => e instanceof FlowError && e.key === "errors.forbidden");
});
test("MGT-125/126 reader pins org and RR with bounds; timeout is unavailable, never zero", async () => {
  const result = { state: "ready", counts: [], yourTurn: 120, mine: [], others: [], next: { mine: null, others: null }, detail: null };
  const seen: string[] = [];
  const transaction = (async (user: string, callback: (client: unknown) => Promise<unknown>, options: unknown) => {
    assert.equal(user, session.userId); assert.deepEqual(options, { isolation: "repeatable read" });
    return callback({ query: async (sql: string, args?: unknown[]) => {
      seen.push(sql);
      if (sql.includes("b3_staff_repair_turns")) { assert.equal(args?.[8], 50); assert.equal(args?.[0], session.orgId); }
      return { rows: [{ result }] };
    } });
  }) as never;
  assert.deepEqual(await staffRepairTurns(session, { limit: 120 }, { v3: async () => true, transaction }), result);
  assert.ok(seen[0].includes("statement_timeout")); assert.ok(seen[1].includes("lock_timeout")); assert.ok(seen[2].includes("app.active_org_id"));
  assert.deepEqual(await staffRepairTurns(session, {}, { v3: async () => true,
    transaction: (async () => { throw Object.assign(new Error("statement timeout"), { code: "57014" }); }) as never }), { state: "unavailable" });
  await assert.rejects(staffRepairTurns(session, { after: { ticketId: session.orgId, since: null } }, { v3: async () => true }), /required/);
});
test("Today data aggregate: repair-only admission, uncapped counts, failure propagation and distinct keys", () => {
  const repairs = { state: "ready" as const, counts: [{ holder: "manager" as const, step: "dispatch" as const, canAct: true, count: 120 },
    { holder: "owner" as const, step: "approve_estimate" as const, canAct: false, count: 200 }], yourTurn: 120,
    mine: [], others: [], detail: null, next: { mine: null, others: null } };
  const other = { payments: { state: "off" as const }, rentals: { state: "off" as const }, overdue: { state: "off" as const }, roomUnits: {} };
  assert.deepEqual(todayTurnCounts({ ...other, repairs }), { state: "ready", mine: 120, others: 200 });
  assert.deepEqual(todayTurnCounts({ ...other, repairs: { state: "unavailable" } }), { state: "unavailable" });
  assert.equal(repairTodayKey("id"), "repair:id");
  assert.match(read("src/server/today-v3.ts"), /!paymentAllowed && !rentalAllowed && !repairAllowed/);
  assert.doesNotMatch(read("src/components/v3/m/today/today.tsx"), /staffRepairTurns|repairTodayKey|todayTurnCounts/);
});
test("M3 combined ON loader is one writable RR client; admission denial skips projection; OFF delegates", async () => {
  const source = read("src/server/b3-vendor-repair-turn.ts");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const out: Record<string, (t: string) => Promise<unknown>> = {};
  let on = true, deny = false, failed = false, projected = 0, legacy = 0, snapshots = 0;
  const opened = { org_id: session.orgId, expires_at: "2099-01-01T00:00:00Z" };
  const client = { query: async (sql: string) => {
    if (sql.includes("b3_vendor_repair_turn")) { projected++; if (failed) throw Object.assign(new Error("serialize"), { code: "40001" });
      return { rows: [{ turn: { state: "ready", holder: "vendor", step: "do_repair", viewerCanAct: true, dispatchAllowed: true, currentEvent: "none", private: "must omit" } }] }; }
    if (sql.includes("feature_flags")) return { rows: [{ v2: true, v3: true }] };
    return { rows: [opened] };
  } };
  const deps: Record<string, unknown> = {
    "./brand-v3": { brandV3ReadForOrg: async (_id: string, _env?: unknown, lookup?: (id: string) => Promise<unknown>) => { if (lookup) await lookup(session.orgId); return on; } },
    "./db": { svc: async (_id: unknown, cb: (c: unknown) => Promise<unknown>, opts?: unknown) => { if (opts) { snapshots++; assert.deepEqual(opts, { isolation: "repeatable read" }); } return cb(client); } },
    "./errors": { logServerError: () => {} },
    "./vendor-repair": { loadVendorJob: async () => { legacy++; return {}; }, loadVendorJobOn: async (c: unknown) => {
      assert.equal(c, client); return deny ? { vendorLink: { sharingApproved: false, capability: "write" } } : {}; } },
    "./vendor-job": { resolveVendorJobStateOn: async (c: unknown) => { assert.equal(c, client); return null; }, resolveVendorJobState: async () => { legacy++; return null; } },
    "./vendor-repair-rules": { hashVendorToken: () => "synthetic", vendorTokenAcceptable: () => true },
  };
  new Function("require", "exports", compiled)((id: string) => { assert.ok(id in deps, id); return deps[id]; }, out);
  const first = await out.loadVendorRepairTurns("synthetic"); assert.equal(snapshots, 1); assert.equal(projected, 1); assert.equal(legacy, 0);
  assert.ok(!JSON.stringify(first).includes("private"));
  deny = true; await out.loadVendorRepairTurns("synthetic"); assert.equal(projected, 1);
  deny = false; failed = true; assert.deepEqual(await out.loadVendorRepairTurns("synthetic"), { state: "unavailable" });
  on = false; await out.loadVendorRepairTurns("synthetic"); assert.equal(legacy, 2);
});

test("R5 only counts a concrete re-estimate with current owner, threshold and currency scale", () => {
  assert.match(m2, /WHEN rule='R5' THEN approvals AND ancestry_open AND reestimate_ready/);
  assert.match(m2, /ORDER BY po\.id LIMIT 1/);
  assert.match(m2, /region\.minor_unit IS NULL OR region\.minor_unit=/);
  assert.match(m2, /po\.effective_to > \(clock_timestamp\(\) AT TIME ZONE o\.timezone\)::date/);
});

test("a SQL 42501 denial wrapped by svc/mapDbError is still forbidden, not unavailable (Codex 3b r1)", async () => {
  const { sqlDenied } = await import("./b3-repair-turns");
  const { FlowError } = await import("./errors");
  const wrapped = new FlowError("errors.generic"); (wrapped as { cause?: unknown }).cause = { code: "42501" };
  assert.equal(sqlDenied(wrapped), true);
  assert.equal(sqlDenied({ code: "42501" }), true);
  const other = new FlowError("errors.generic"); (other as { cause?: unknown }).cause = { code: "57014" };
  assert.equal(sqlDenied(other), false);
  assert.equal(sqlDenied(new Error("boom")), false);
  assert.match(readFileSync(new URL("./b3-repair-turns.ts", import.meta.url), "utf8"), /if \(sqlDenied\(error\)\) throw new FlowError\("errors\.forbidden"\);/);
});
