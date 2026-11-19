// Lauren item 6: `npm run gate:pr` runs typecheck → lint → check-pr-rules → test:unit, in that order, and stops at
// the first failure with a nonzero exit. Dry-run hooks keep the test fast and environment-independent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const run = (env: Record<string, string>, args: string[] = []) =>
  spawnSync("bash", ["scripts/gate-pr.sh", ...args], { encoding: "utf8", env: { ...process.env, GATE_PR_DRY_RUN: "1", PR_BODY_FILE: "", ...env } });
const steps = (out: string) => [...out.matchAll(/^== gate:pr \[([^\]]+)\]/gm)].map(m => m[1]);

test("gate:pr runs the four checks in order and passes when all pass", () => {
  const r = run({});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(steps(r.stdout), ["typecheck", "lint", "check-pr-rules", "test:unit"]);
  assert.match(r.stdout, /gate:pr PASS/);
});

test("gate:pr stops at the first failing step with a nonzero exit", () => {
  for (const [failAt, ran] of [["typecheck", ["typecheck"]], ["lint", ["typecheck", "lint"]],
    ["check-pr-rules", ["typecheck", "lint", "check-pr-rules"]], ["test:unit", ["typecheck", "lint", "check-pr-rules", "test:unit"]]] as const) {
    const r = run({ GATE_PR_FAIL_AT: failAt });
    assert.equal(r.status, 1, failAt);
    assert.deepEqual(steps(r.stdout), ran, failAt);
    assert.match(r.stdout, new RegExp(`gate:pr FAIL at ${failAt.replace(":", "\\:")}`));
    assert.doesNotMatch(r.stdout, /gate:pr PASS/);
  }
});

test("gate:pr passes --base and the PR body to check-pr-rules with --r2-only", () => {
  const r = run({}, ["--base", "origin/feature", "--pr-body-file", "/tmp/body.md"]);
  assert.equal(r.status, 0);
  const line = r.stdout.split("\n").find(l => l.includes("[check-pr-rules]")) ?? "";
  assert.match(line, /node scripts\/check-pr-rules\.mjs --base origin\/feature --head HEAD --r2-only --pr-body-file \/tmp\/body\.md$/);
  assert.equal(run({}, ["--bogus"]).status, 2);
});

test("package.json exposes gate:pr as the script", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["gate:pr"], "bash scripts/gate-pr.sh");
});
