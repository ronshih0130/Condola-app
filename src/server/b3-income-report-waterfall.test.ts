import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { INCOME_REPORT_CASH_DATE_SQL, INCOME_REPORT_WATERFALL_SQL, INCOME_REPORT_RECOGNITION_SQL, INCOME_REPORT_UNALLOCATED_SQL } from "./b3-income-report";

type Allocation = { allocation_id: string; source_id: string; invoice_id: string; currency: string;
  service_month_start: string | null; payment_month_end: string; date: string; confirmed_at: string | null; allocated_amount: string };
type Line = { invoice_id: string; line_id: string; charge_type: string; line_no: number; item: string; line_amount: string };
type Portion = { allocation: string; line: string; currency: string; amount: string };
const allocation = (n: number, amount: string, extra: Partial<Allocation> = {}): Allocation => ({
  allocation_id: `a${n}`, source_id: `p${n}`, invoice_id: "invoice", currency: "TWD",
  service_month_start: "2030-05-01", payment_month_end: "2030-05-31", date: `2030-05-0${n}`, confirmed_at: "2030-05-01T00:00:00Z", allocated_amount: amount, ...extra,
});
const line = (kind: string, amount: string, n: number, extra: Partial<Line> = {}): Line => ({
  invoice_id: "invoice", line_id: kind, charge_type: kind, line_no: n, item: kind, line_amount: amount, ...extra,
});
const rentDeposit = [line("deposit", "100", 1), line("rent", "100", 2)]; // charge type precedes line number
const portion = (allocation: string, line: string, amount: string, currency = "TWD"): Portion => ({ allocation, line, currency, amount });

/** Execute the production window/intersection CTEs unchanged using Python's stdlib SQLite.
 * No PostgreSQL, server, network, npm dependency or fixture DB is needed. SQLite has the
 * same ROWS/window arithmetic for these fixtures; register PostgreSQL's least/greatest.
 * Python binds/returns integers without JS Number conversion (amounts cross JSON as strings).
 * This tests the SQL math, not PostgreSQL typing, RLS or query plans: those remain Mac integration checks.
 * Requires python3 with SQLite >= 3.30 (window functions and NULLS LAST).
 */
function waterfall(allocations: Allocation[], lines = rentDeposit, from = "2030-05-01", to = "2030-05-31", recognize = false): Portion[] {
  const sql = `WITH ${INCOME_REPORT_WATERFALL_SQL}${recognize ? `, ${INCOME_REPORT_RECOGNITION_SQL}` : ""}
    SELECT allocation_id AS allocation, line_id AS line, currency, CAST(amount AS TEXT) AS amount${recognize ? ", kind, income_date" : ""}
    FROM ${recognize ? "recognized_portions" : `portions WHERE amount > 0 AND ${INCOME_REPORT_CASH_DATE_SQL}`}
    ORDER BY allocation_id, line_id`.replaceAll("::date", "");
  const run = spawnSync("python3", ["-c", `
import json, sqlite3, sys
data = json.load(sys.stdin)
db = sqlite3.connect(':memory:')
db.row_factory = sqlite3.Row
db.create_function('greatest', -1, max)
db.create_function('least', -1, min)
db.executescript('''
CREATE TABLE allocation_inputs (allocation_id TEXT, source_id TEXT, invoice_id TEXT, currency TEXT,
  date TEXT, confirmed_at TEXT, allocated_amount INTEGER, service_month_start TEXT, payment_month_end TEXT);
CREATE TABLE line_inputs (invoice_id TEXT, line_id TEXT, charge_type TEXT, line_no INTEGER, item TEXT, line_amount INTEGER);
''')
for a in data['allocations']:
    db.execute('INSERT INTO allocation_inputs VALUES (?,?,?,?,?,?,?,?,?)',
      [a[k] for k in ['allocation_id','source_id','invoice_id','currency','date','confirmed_at']] + [int(a['allocated_amount']), a['service_month_start'], a['payment_month_end']])
for l in data['lines']:
    db.execute('INSERT INTO line_inputs VALUES (?,?,?,?,?,?)',
      [l[k] for k in ['invoice_id','line_id','charge_type','line_no','item']] + [int(l['line_amount'])])
print(json.dumps([dict(r) for r in db.execute(data['sql'], {'2': data['from'], '3': data['to']})]))
db.close()
`], { input: JSON.stringify({ sql, allocations, lines, from, to }), encoding: "utf8" });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  return JSON.parse(run.stdout);
}

test("two payments of 100 consume rent 100 then deposit 100, independent of input order", () => {
  assert.deepEqual(waterfall([allocation(2, "100"), allocation(1, "100")]), [
    portion("a1", "rent", "100"), portion("a2", "deposit", "100"),
  ]);
});

test("three payments split rent/deposit without exceeding a line or double counting", () => {
  assert.deepEqual(waterfall([allocation(3, "90"), allocation(1, "60"), allocation(2, "50")]), [
    portion("a1", "rent", "60"), portion("a2", "deposit", "10"), portion("a2", "rent", "40"), portion("a3", "deposit", "90"),
  ]);
});

test("partial allocation, deposit after rent, and excess money never moves back onto consumed lines", () => {
  assert.deepEqual(waterfall([allocation(1, "30"), allocation(2, "20")]), [portion("a1", "rent", "30"), portion("a2", "rent", "20")]);
  assert.deepEqual(waterfall([allocation(1, "150"), allocation(2, "100"), allocation(3, "50")]), [
    portion("a1", "deposit", "50"), portion("a1", "rent", "100"), portion("a2", "deposit", "50"),
  ]);
});

test("cross-period allocations retain earlier consumption and each land on the right invoice lines", () => {
  const payments = [allocation(1, "150"), allocation(2, "50", { date: "2030-06-01" })];
  const may = waterfall(payments), june = waterfall(payments, rentDeposit, "2030-06-01", "2030-06-30");
  assert.deepEqual(may, [portion("a1", "deposit", "50"), portion("a1", "rent", "100")]);
  assert.deepEqual(june, [portion("a2", "deposit", "50")]);
  assert.deepEqual(waterfall(payments, rentDeposit, "2030-05-01", "2030-06-30"), [...may, ...june]);
});

test("PR-019 same-month, late and missing-period rent retain cash dates", () => {
  for (const service of ["2030-05-01", "2030-05-31", "2030-04-01", null]) {
    const payments = [allocation(1, "100", { date: "2030-05-15", service_month_start: service })];
    assert.deepEqual(waterfall(payments, [line("rent", "100", 1)], "2030-05-15", "2030-05-15", true),
      [{ ...portion("a1", "rent", "100"), kind: "income", income_date: "2030-05-15" }]);
    assert.deepEqual(waterfall(payments, rentDeposit, "2030-05-16", "2030-05-31", true), []);
  }
});

test("PR-019 May-paid June rent is separate in May, income in June, once across a spanning range", () => {
  const payments = [allocation(1, "150", { date: "2030-05-31", service_month_start: "2030-06-01" })];
  const early = { ...portion("a1", "rent", "100"), kind: "earlyRent", income_date: "2030-06-01" };
  const income = { ...early, kind: "income" };
  const deposit = { ...portion("a1", "deposit", "50"), kind: "deposit", income_date: "2030-05-31" };
  assert.deepEqual(waterfall(payments, rentDeposit, "2030-05-31", "2030-05-31", true), [deposit, early]);
  assert.deepEqual(waterfall(payments, rentDeposit, "2030-06-01", "2030-06-01", true), [income]);
  assert.deepEqual(waterfall(payments, rentDeposit, "2030-05-01", "2030-06-01", true), [deposit, income]);
  assert.deepEqual(waterfall(payments, rentDeposit, "2030-05-01", "2030-05-30", true), []);
  assert.deepEqual(waterfall(payments, rentDeposit, "2030-06-02", "2030-06-30", true), []);
});

test("PR-019 uses exact invoice period_start, not a guessed first day; only rent is deferred", () => {
  const payments = [allocation(1, "150", { date: "2030-05-31", service_month_start: "2030-06-15" })];
  const lines = [line("rent", "100", 1), line("utility", "50", 2)];
  assert.deepEqual(waterfall(payments, lines, "2030-06-01", "2030-06-14", true), []);
  assert.deepEqual(waterfall(payments, lines, "2030-06-15", "2030-06-15", true),
    [{ ...portion("a1", "rent", "100"), kind: "income", income_date: "2030-06-15" }]);
  assert.deepEqual(waterfall(payments, lines, "2030-05-31", "2030-05-31", true), [
    { ...portion("a1", "rent", "100"), kind: "earlyRent", income_date: "2030-06-15" },
    { ...portion("a1", "utility", "50"), kind: "income", income_date: "2030-05-31" },
  ]);
});

test("paid date, confirmation timestamp, payment id and allocation id each break ties deterministically", () => {
  const cases: [Partial<Allocation>, Partial<Allocation>][] = [
    [{ date: "2030-05-01", confirmed_at: "2030-05-03T00:00:00Z" }, { date: "2030-05-02", confirmed_at: "2030-05-01T00:00:00Z" }],
    [{ confirmed_at: "2030-05-01T00:00:00.000001Z", source_id: "z" }, { confirmed_at: "2030-05-01T00:00:00.000002Z", source_id: "a" }],
    [{ confirmed_at: "2030-05-01T00:00:00Z", source_id: "z" }, { confirmed_at: null, source_id: "a" }],
    [{ source_id: "a" }, { source_id: "z" }],
    [{ source_id: "same" }, { source_id: "same" }],
  ];
  for (const [first, second] of cases) {
    assert.deepEqual(waterfall([
      allocation(2, "100", { date: "2030-05-01", ...second }), allocation(1, "100", { date: "2030-05-01", ...first }),
    ]), [portion("a1", "rent", "100"), portion("a2", "deposit", "100")]);
  }
});

test("line-number order within charge type; zero/negative lines consume nothing", () => {
  const lines = [line("rent", "70", 2, { line_id: "rent2" }), line("rent", "30", 1), line("credit", "-20", 3), line("deposit", "0", 4)];
  assert.deepEqual(waterfall([allocation(1, "50"), allocation(2, "70")], lines), [
    portion("a1", "rent", "30"), portion("a1", "rent2", "20"), portion("a2", "rent2", "50"),
  ]);
});

test("invoice/currency isolation and integer precision above Number.MAX_SAFE_INTEGER", () => {
  const payments = [allocation(1, "9007199254740993"), allocation(2, "7"), allocation(3, "11", { invoice_id: "usd-invoice", currency: "USD" })];
  const lines = [line("rent", "9007199254740993", 1), line("deposit", "7", 2), line("rent", "11", 1, { invoice_id: "usd-invoice", line_id: "usd-rent" })];
  assert.deepEqual(waterfall(payments, lines), [portion("a1", "rent", "9007199254740993"), portion("a2", "deposit", "7"), portion("a3", "usd-rent", "11", "USD")]);
});

test("PR-019 unallocated remainder subtracts every allocation once, per payment and org, on inclusive cash dates", () => {
  const sql = `WITH ${INCOME_REPORT_UNALLOCATED_SQL}
    SELECT source_id, currency, CAST(amount AS TEXT) AS amount FROM unallocated_payments
    WHERE amount > 0 ORDER BY source_id`.replaceAll("::date", "");
  const run = spawnSync("python3", ["-c", `
import json, sqlite3, sys
db = sqlite3.connect(':memory:')
db.row_factory = sqlite3.Row
db.create_function('greatest', -1, max)
db.executescript("""
CREATE TABLE payment_inputs (source_id TEXT, source_amount INTEGER, date TEXT, currency TEXT);
CREATE TABLE payment_allocations (payment_id TEXT, org_id TEXT, amount_minor INTEGER);
INSERT INTO payment_inputs VALUES ('partial',200,'2030-05-01','TWD'), ('none',9007199254740993,'2030-05-31','USD'),
  ('full',100,'2030-05-15','TWD'), ('before',100,'2030-04-30','TWD'), ('after',100,'2030-06-01','TWD'),
  ('over',100,'2030-05-01','TWD');
INSERT INTO payment_allocations VALUES ('partial','org',50),('partial','org',70),('partial','other',999),
  ('full','org',100),('over','org',110);
""")
print(json.dumps([dict(r) for r in db.execute(sys.stdin.read(), {'1':'org','2':'2030-05-01','3':'2030-05-31'})]))
`], { input: sql, encoding: "utf8" });
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [
    { source_id: "none", currency: "USD", amount: "9007199254740993" },
    { source_id: "partial", currency: "TWD", amount: "80" },
  ]);
});
