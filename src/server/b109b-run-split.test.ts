import assert from "node:assert/strict";
import test from "node:test";
import { ERRORS } from "../i18n/errors";
import { correctionSeededMilli, parseRunSharedConfig, parseSharedRecord, readRunSharedConfig, seededTotalMilli, sharedWeights, splitSharesMilli, type RunSharedConfig } from "./b109b-run-split";

// B-109b pure pieces and the gateway calls, with a recording fake client (the real gateways run in the DB test).
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
type Q = { sql: string; args?: unknown[] };
function client(answers: (q: Q) => unknown, role = "authenticated") {
  const sent: Q[] = [];
  return { sent, query: async (sql: string, args?: unknown[]) => {
    sent.push({ sql, args });
    if (sql === "SELECT current_user AS role") return { rows: [{ role }] };
    if (sql.startsWith("SET LOCAL ROLE") || sql === "RESET ROLE") return { rows: [] };
    return { rows: [answers({ sql, args })] };
  } } as never as { sent: Q[]; query: (sql: string, args?: unknown[]) => Promise<{ rows: unknown[] }> };
}
const applies = (over: Partial<Extract<RunSharedConfig, { status: "applies" }>> = {}): Extract<RunSharedConfig, { status: "applies" }> => ({
  status: "applies", revision: 2, method: "even", effectiveFrom: "2026-12-01", spaceIds: [A, B], startReading: "1000.500", firstPeriod: true,
  mainReading: { value: "1162.500", estimated: false, readOn: "2026-12-31" }, ...over });
const scope = { orgId: "o", liveOrgId: "o", environment: "live", sessionId: "s" };

test("parseRunSharedConfig accepts the gateway's shapes and refuses anything else", () => {
  assert.equal(parseRunSharedConfig(null), null);
  assert.equal(parseRunSharedConfig(undefined), null);
  assert.deepEqual(parseRunSharedConfig({ status: "none", revision: 3 }), { status: "none" });
  assert.deepEqual(parseRunSharedConfig({ status: "multi_unit", revision: 3 }), { status: "multi_unit", revision: 3 });
  assert.deepEqual(parseRunSharedConfig({ status: "whole_unit", revision: 1 }), { status: "whole_unit", revision: 1 });
  assert.deepEqual(parseRunSharedConfig({ status: "unavailable_rooms", revision: 4 }), { status: "unavailable_rooms", revision: 4 });
  assert.deepEqual(parseRunSharedConfig(applies()), applies());
  assert.deepEqual(parseRunSharedConfig(applies({ mainReading: null, firstPeriod: false })), applies({ mainReading: null, firstPeriod: false }));
  for (const bad of [{ status: "ready" }, { status: "multi_unit" }, applies({ spaceIds: [] }), applies({ spaceIds: ["x"] }), applies({ method: "weird" as never }),
    applies({ startReading: "-1" }), applies({ startReading: "1.2345" }), applies({ revision: 1.5 }), applies({ firstPeriod: "yes" as never }),
    applies({ mainReading: { value: 1 } as never }), { ...applies(), effectiveFrom: undefined }])
    assert.throws(() => parseRunSharedConfig(bad), /Invalid shared meter run config/, JSON.stringify(bad));
});

test("seededTotalMilli: an actual main reading is required in every period, typed total or not; a typed total then wins; only the first period seeds", () => {
  const stop = (c: Extract<RunSharedConfig, { status: "applies" }>, typed: number | null) =>
    assert.throws(() => seededTotalMilli(c, typed), (e: { key?: string }) => e.key === "errors.sharedMeterReadings", JSON.stringify([c.firstPeriod, c.mainReading, typed]));
  const estimated = { value: "1162.500", estimated: true, readOn: "2026-12-31" }, below = { value: "999.000", estimated: false, readOn: "2026-12-31" };
  // First period.
  assert.equal(seededTotalMilli(applies(), 161), null, "typed total wins");
  assert.equal(seededTotalMilli(applies(), 0), null);
  assert.equal(seededTotalMilli(applies(), null), 162000, "seeded: 1162.5 − 1000.5");
  for (const typed of [161, null]) {
    stop(applies({ mainReading: null }), typed);
    stop(applies({ mainReading: estimated }), typed);
    stop(applies({ mainReading: below }), typed);
  }
  // A later period: the reading is still required and actual; the total must be typed.
  const later = (main: Extract<RunSharedConfig, { status: "applies" }>["mainReading"]) => applies({ firstPeriod: false, mainReading: main });
  assert.equal(seededTotalMilli(later({ value: "1300.000", estimated: false, readOn: "2027-01-31" }), 140), null);
  assert.equal(seededTotalMilli(later(below), 140), null, "a later period is not compared with the starting reading");
  stop(later({ value: "1300.000", estimated: false, readOn: "2027-01-31" }), null);
  stop(later(null), 140);
  stop(later(estimated), 140);
});

test("sharedWeights by method, in the revision's order; a selected room without a line or a typed reading stops posting", () => {
  const rooms = new Map([[A, { typedMilli: 100100, days: 31, hasLine: true }], [B, { typedMilli: 50100, days: 21, hasLine: true }]]);
  assert.deepEqual(sharedWeights("even", [B, A], rooms), [{ id: B, weight: 1 }, { id: A, weight: 1 }]);
  assert.deepEqual(sharedWeights("days_occupied", [A, B], rooms), [{ id: A, weight: 31 }, { id: B, weight: 21 }]);
  assert.deepEqual(sharedWeights("sub_meter", [A, B], rooms), [{ id: A, weight: 100100 }, { id: B, weight: 50100 }]);
  const stop = (fn: () => unknown) => assert.throws(fn, (e: { key?: string }) => e.key === "errors.sharedMeterReadings");
  stop(() => sharedWeights("even", [A, "33333333-3333-4333-8333-333333333333"], rooms));
  stop(() => sharedWeights("even", [A], new Map([[A, { typedMilli: 1, days: 1, hasLine: false }]])));
  stop(() => sharedWeights("sub_meter", [A], new Map([[A, { typedMilli: null, days: 1, hasLine: true }]])));
  stop(() => sharedWeights("sub_meter", [A], new Map([[A, { typedMilli: -1, days: 1, hasLine: true }]])));
});

test("splitSharesMilli calls the one split rule as service_role, checks the answer adds up, and returns the caller's role", async () => {
  const c = client(() => ({ r: [{ id: A, milli: "501" }, { id: B, milli: "500" }] }));
  assert.deepEqual(await splitSharesMilli(c as never, [{ id: A, weight: 1 }, { id: B, weight: 1 }], 1001), [501, 500]);
  assert.deepEqual(c.sent.map(q => q.sql.split("(")[0]), ["SELECT current_user AS role", "SET LOCAL ROLE service_role", "SELECT app.b109_split_shares", "SET LOCAL ROLE authenticated"]);
  assert.deepEqual(c.sent[2].args, [JSON.stringify([{ id: A, weight: 1 }, { id: B, weight: 1 }]), 1001]);
  await assert.rejects(splitSharesMilli(client(() => ({ r: [{ id: A, milli: "500" }, { id: B, milli: "500" }] })) as never, [{ id: A, weight: 1 }, { id: B, weight: 1 }], 1001), /Split does not add up/);
  await assert.rejects(splitSharesMilli(client(() => ({ r: [{ id: B, milli: "1001" }] })) as never, [{ id: A, weight: 1 }], 1001), /Invalid split shares/);
  await assert.rejects(splitSharesMilli(client(() => ({ r: [{ id: A, milli: "-1" }] })) as never, [{ id: A, weight: 1 }], 1001), /Invalid split shares/);
  await assert.rejects(splitSharesMilli(client(() => ({})) as never, [{ id: A, weight: 1 }], -1), (e: { key?: string }) => e.key === "errors.amount");
  // A failed call propagates its own error and sends nothing after it (the transaction is aborted; a role reset
  // there would fail with 25P02 and mask the real SQLSTATE). A service_role caller stays service_role.
  const failing = client(() => { throw Object.assign(new Error("db"), { code: "42501" }); });
  await assert.rejects(splitSharesMilli(failing as never, [{ id: A, weight: 1 }], 1), (e: { code?: string }) => e.code === "42501");
  assert.match(failing.sent.at(-1)!.sql, /^SELECT app\.b109_split_shares/);
  const svcCaller = client(() => ({ r: [{ id: A, milli: "1" }] }), "service_role");
  await splitSharesMilli(svcCaller as never, [{ id: A, weight: 1 }], 1);
  assert.ok(!svcCaller.sent.some(q => q.sql === "SET LOCAL ROLE authenticated" || q.sql === "RESET ROLE"));
});

test("readRunSharedConfig: flag OFF (any part) → no gateway call; ON → the gateway with the session's tuple, parsed", async () => {
  const off = client(q => q.sql.includes("platform_settings") ? { on: false } : assert.fail(`unexpected ${q.sql}`));
  assert.equal(await readRunSharedConfig(off as never, scope, A, "2026-12-01", "2026-12-31"), null);
  assert.ok(!off.sent.some(q => q.sql.includes("b109b_run_config")), "no gateway call when OFF");
  assert.match(off.sent.find(q => q.sql.includes("platform_settings"))!.sql, /o\.feature_flags->'shared_meter'='true'::jsonb AND f\.value->'enabled'='true'::jsonb/);
  assert.equal(off.sent.at(-1)?.sql, "SET LOCAL ROLE authenticated");
  const on = client(q => q.sql.includes("platform_settings") ? { on: true } : { r: applies() });
  assert.deepEqual(await readRunSharedConfig(on as never, scope, A, "2026-12-01", "2026-12-31"), applies());
  const call = on.sent.find(q => q.sql.includes("b109b_run_config"))!;
  assert.deepEqual(call.args, ["o", "o", "live", "s", A, "2026-12-01", "2026-12-31"]);
  const nullAnswer = client(q => q.sql.includes("platform_settings") ? { on: true } : { r: null });
  assert.equal(await readRunSharedConfig(nullAnswer as never, scope, A, "2026-12-01", "2026-12-31"), null, "the gateway re-checked the flag after its locks");
  await assert.rejects(readRunSharedConfig(client(q => q.sql.includes("platform_settings") ? { on: true } : { r: { status: "bogus" } }) as never, scope, A, "2026-12-01", "2026-12-31"), /Invalid shared meter run config/);
});

test("the posting blocks have message keys (generic text until approved copy exists)", () => {
  assert.equal(ERRORS["errors.sharedMeterUnits"], "i_generic");
  assert.equal(ERRORS["errors.sharedMeterReadings"], "i_generic");
  assert.equal(ERRORS["errors.sharedMeterRooms"], "i_generic");
  assert.equal(ERRORS["errors.sharedMeterMode"], "i_generic");
});

test("a correction keeps its issued split: parseSharedRecord validates inputs.sharedMeter; correctionSeededMilli prefers a typed total, else the issued seed", () => {
  const record = { revision: 2, method: "even", roomIds: [A, B], weights: ["1", "1"], sharesMilli: [501, 500], kwhMilli: 1001, seededTotalMilli: 162000 };
  assert.equal(parseSharedRecord(null), null);
  assert.equal(parseSharedRecord(undefined), null);
  assert.deepEqual(parseSharedRecord(record), record);
  for (const bad of [{ ...record, method: "weird" }, { ...record, roomIds: [] }, { ...record, roomIds: ["x"] }, { ...record, sharesMilli: [1] },
    { ...record, sharesMilli: [-1, 2] }, { ...record, revision: 1.5 }, { ...record, kwhMilli: "1" }, { ...record, seededTotalMilli: -1 }, { ...record, weights: "1" }])
    assert.throws(() => parseSharedRecord(bad), /Invalid shared meter record/, JSON.stringify(bad));
  const parsed = parseSharedRecord(record)!;
  assert.equal(correctionSeededMilli(parsed, 161), null);
  assert.equal(correctionSeededMilli(parsed, null), 162000);
  assert.throws(() => correctionSeededMilli({ ...parsed, seededTotalMilli: null }, null), (e: { key?: string }) => e.key === "errors.sharedMeterReadings");
});
