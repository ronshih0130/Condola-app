import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SANDBOX_SAMPLE_CSV } from "../data/sandbox-sample";
import { demoModeEnabled, enforceDemoSafety } from "./demo";
import { resolveStaffEnvironment } from "./org-scope";
import { SANDBOX_NOT_SENT, canSendReal, deliveryPlan } from "./outbound";
import {
  SAMPLE_LABEL,
  displaySampleName,
  isSampleName,
  loadSampleRows,
  overFree,
  parseSampleCsv,
  sampleCounts,
  sampleIdMask,
  toE164,
  withSampleName,
  type SampleCounts,
  type SampleRow,
} from "./sandbox-data";

const now = new Date("2026-10-20T00:00:00Z");

function derive(rows: SampleRow[]): SampleCounts {
  return {
    properties: new Set(rows.map((row) => row.property).filter(Boolean)).size,
    spaces: rows.length,
    owners: new Set(rows.map((row) => row.ownerEmail.toLowerCase()).filter(Boolean)).size,
    tenants: rows.filter((row) => row.tenantName).length,
    leases: rows.filter((row) => row.tenantName && row.start).length,
    bills: rows.filter((row) => row.billAmount.trim()).length,
  };
}

test("sandbox sample is bundled and loads without reading the filesystem", () => {
  const source = readFileSync(new URL("./sandbox-data.ts", import.meta.url), "utf8");
  assert.equal(source.includes("node:fs"), false);
  assert.equal(source.includes("readFile"), false);
  assert.equal(source.includes("process.cwd"), false);
  const parsed = parseSampleCsv(SANDBOX_SAMPLE_CSV);
  const loaded = loadSampleRows();
  assert.deepEqual(parsed, loaded);
  assert.ok(parsed.length > 0);
  const counts = sampleCounts(parsed);
  assert.deepEqual(counts, derive(parsed));
  assert.ok(counts.properties > 0);
  assert.equal(counts.spaces, parsed.length);
  assert.equal(counts.bills, parsed.filter((row) => row.billAmount.trim()).length);

  const extra: SampleRow = {
    ...parsed[0],
    property: "額外建物",
    ownerEmail: "extra-owner@example.com",
    tenantName: "額外租客",
    start: "2026-01-01",
    billAmount: "120",
  };
  const next = sampleCounts([...parsed, extra]);
  assert.equal(next.properties, counts.properties + 1);
  assert.equal(next.spaces, counts.spaces + 1);
  assert.equal(next.owners, counts.owners + 1);
  assert.equal(next.tenants, counts.tenants + 1);
  assert.equal(next.leases, counts.leases + 1);
  assert.equal(next.bills, counts.bills + 1);
});

test("login and sign-up open the live org unless the user chose the sample company", () => {
  assert.equal(resolveStaffEnvironment({ cookie: null, hasLiveData: false, liveEnabled: false }), "live");
  assert.equal(resolveStaffEnvironment({ cookie: "live", hasLiveData: false, liveEnabled: true }), "live");
  assert.equal(resolveStaffEnvironment({ cookie: "live", hasLiveData: true, liveEnabled: false }), "live");
  assert.equal(resolveStaffEnvironment({ cookie: null, hasLiveData: true, liveEnabled: true }), "live");
  assert.equal(resolveStaffEnvironment({ cookie: "sandbox", hasLiveData: false, liveEnabled: false }), "sandbox");
  assert.equal(resolveStaffEnvironment({ cookie: "sandbox", hasLiveData: true, liveEnabled: true }), "sandbox");
});

test("rentable spaces are rooms plus whole units that have no rooms", () => {
  const rows = loadSampleRows();
  const rooms = rows.filter((row) => row.rentalMode !== "整層");
  const whole = rows.filter((row) => row.rentalMode === "整層");
  const occupied = rows.filter((row) => row.tenantName && row.start);
  assert.equal(rooms.length, 31);
  assert.equal(whole.length, 7);
  assert.equal(whole.filter((row) => row.room).length, 0);
  assert.equal(rooms.length + whole.length, 38);
  assert.equal(occupied.length, 31);
});

test("sample names stay tagged once and phones become E.164", () => {
  assert.equal(withSampleName("中壢範例分租公寓"), `中壢範例分租公寓〔${SAMPLE_LABEL}〕`);
  assert.equal(withSampleName(`中壢範例分租公寓〔${SAMPLE_LABEL}〕`), `中壢範例分租公寓〔${SAMPLE_LABEL}〕`);
  assert.equal(withSampleName("Oakland [Sample data]"), "Oakland [Sample data]");
  assert.equal(isSampleName(`甲〔${SAMPLE_LABEL}〕`), true);
  assert.equal(isSampleName("信義松仁"), false);
  assert.equal(displaySampleName(`中壢範例分租公寓〔${SAMPLE_LABEL}〕`), "中壢範例分租公寓");
  assert.equal(displaySampleName("Oakland [Sample data]"), "Oakland");
  assert.equal(toE164("0900-000-101"), "+886900000101");
  assert.equal(toE164(""), null);
  assert.equal(sampleIdMask(1), "A00****001");
});

test("sandbox ignores the free cap and live allows four units or a plan or trial", () => {
  const free = { tier: "free", trialUntil: null };
  assert.equal(overFree({ environment: "sandbox", activeUnits: 100, plan: free, now }), false);
  assert.equal(overFree({ environment: "live", activeUnits: 4, plan: free, now }), false);
  assert.equal(overFree({ environment: "live", activeUnits: 5, plan: free, now }), true);
  assert.equal(overFree({ environment: "live", activeUnits: 5, plan: { tier: "beta", trialUntil: null }, now }), true);
  assert.equal(overFree({ environment: "live", activeUnits: 9, plan: { tier: "pro", trialUntil: null }, now }), false);
  assert.equal(overFree({ environment: "live", activeUnits: 9, plan: { tier: "business", trialUntil: null }, now }), false);
  assert.equal(overFree({ environment: "live", activeUnits: 9, plan: { tier: "standard", trialUntil: null }, now }), false);
  assert.equal(overFree({ environment: "live", activeUnits: 9, plan: { tier: "free", trialUntil: "2099-01-01" }, now }), false);
  assert.equal(overFree({ environment: "live", activeUnits: 5, plan: { tier: "free", trialUntil: "2020-01-01" }, now }), true);
});

test("sandbox delivery is logged and never uses the live demo sender", () => {
  assert.equal(canSendReal("sandbox"), false);
  assert.equal(canSendReal("live"), true);
  const sandbox = deliveryPlan("sandbox");
  assert.equal(sandbox.sent, false);
  assert.equal(sandbox.status, "skipped");
  assert.equal(sandbox.provider, "sandbox_log");
  assert.equal(sandbox.error, SANDBOX_NOT_SENT);
  const live = deliveryPlan("live");
  assert.equal(live.sent, false);
  assert.equal(live.provider, "demo_line");
  assert.equal(live.error, "demo_not_sent");
  assert.equal(live.error.includes(SANDBOX_NOT_SENT), false);
});

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("a sandbox session rewrites a retired sample avenue to the Taichung sample street", () => {
  const sandbox = readFileSync(new URL("./sandbox.ts", import.meta.url), "utf8");
  const session = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
  assert.match(sandbox, /export const RETIRED_SAMPLE_ADDRESS = "台中市西區範例路 1 號"/);
  assert.match(sandbox, /export const SECOND_SAMPLE_ADDRESS = "台中市西區範例路 2 號"/);
  assert.match(sandbox, /address_display LIKE '%' \|\| \$4 \|\| '%'/);
  assert.match(sandbox, /範例大道/);
  assert.match(sandbox, /sampleAddressRev/);
  assert.match(session, /correctRetiredSampleAddresses\(client, firm\.orgId\)/);
  assert.match(session, /correctRetiredSampleAddresses\(client, sandboxId\)/);
  const building = parseSampleCsv(SANDBOX_SAMPLE_CSV).filter((row) => row.property.includes("青埔"));
  assert.ok(building.length > 0);
  for (const row of building) assert.equal(row.address, "台中市西區範例路 1 號");
  const second = parseSampleCsv(SANDBOX_SAMPLE_CSV).filter((row) => row.property.includes("桃園區範例學舍"));
  assert.ok(second.length > 0);
  for (const row of second) assert.equal(row.address, "台中市西區範例路 2 號");
  const first = parseSampleCsv(SANDBOX_SAMPLE_CSV).filter((row) => row.property.includes("中壢範例分租公寓"));
  assert.ok(first.length > 0);
  for (const row of first) assert.equal(row.address, "桃園市中壢區範例路1號");
  assert.equal(SANDBOX_SAMPLE_CSV.includes("（虛構）"), false);
  assert.equal(SANDBOX_SAMPLE_CSV.includes("示" + "範"), false);
});

test("the demo production guard still refuses to start", () => {
  const previous = {
    DEMO_MODE: process.env.DEMO_MODE,
    NODE_ENV: process.env.NODE_ENV,
    CONDOLA_ENV: process.env.CONDOLA_ENV,
    NEXT_PHASE: process.env.NEXT_PHASE,
  };
  try {
    setEnv("DEMO_MODE", "true");
    setEnv("NODE_ENV", "production");
    setEnv("CONDOLA_ENV", undefined);
    setEnv("NEXT_PHASE", undefined);
    assert.equal(demoModeEnabled(), false);
    assert.throws(() => enforceDemoSafety(), /Refusing to start/);
  } finally {
    for (const [key, value] of Object.entries(previous)) setEnv(key, value);
  }
});
