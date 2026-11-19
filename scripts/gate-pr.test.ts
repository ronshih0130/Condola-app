// Lauren item 6: `npm run gate:pr` runs typecheck → lint → check-pr-rules → test:unit, in that order, and stops at
// the first failure with a nonzero exit. The script has no skip/dry-run switch; these tests put stub `npm` and
// `node` executables first on PATH that record each call and fail on demand, so the REAL failure handling runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function stubs() {
  const dir = mkdtempSync(join(tmpdir(), "gate-pr-stub-"));
  const log = join(dir, "calls.log");
  const stub = (name: string) => {
    const file = join(dir, name);
    // Records "<name> <args>" and exits 1 when the call matches $STUB_FAIL (a substring), else 0.
    writeFileSync(file, `#!/usr/bin/env bash\nline="${name} $*"\nprintf '%s\\n' "$line" >> "${log}"\nif [ -n "\${STUB_FAIL:-}" ] && [[ "$line" == *"$STUB_FAIL"* ]]; then exit 1; fi\nexit 0\n`);
    chmodSync(file, 0o755);
  };
  stub("npm"); stub("node");
  const body = join(dir, "body.md"); writeFileSync(body, "body\n");
  return { dir, log, body };
}
function run(fail = "", args: string[] = [], env: Record<string, string> = {}) {
  const s = stubs();
  const r = spawnSync("bash", ["scripts/gate-pr.sh", ...args], { encoding: "utf8",
    env: { ...process.env, PATH: `${s.dir}:${process.env.PATH}`, PR_BODY_FILE: s.body, PR_TITLE: "", STUB_FAIL: fail, ...env } });
  let calls: string[] = [];
  try { calls = readFileSync(s.log, "utf8").trim().split("\n").filter(Boolean); } catch { calls = []; }
  return { ...r, calls, body: s.body };
}
const ALL = ["npm run -s typecheck", "npm run -s lint", "node scripts/check-pr-rules.mjs", "npm run -s test:unit"];

test("gate:pr runs the four real commands in order and passes when all pass", () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.calls.length, 4, r.calls.join("|"));
  r.calls.forEach((call, i) => assert.ok(call.startsWith(ALL[i]), `${i}: ${call}`));
  assert.match(r.stdout, /gate:pr PASS/);
});

test("a failing command stops gate:pr there with exit 1, runs nothing after it, and never prints PASS", () => {
  for (let i = 0; i < ALL.length; i++) {
    const r = run(ALL[i]);
    assert.equal(r.status, 1, ALL[i]);
    assert.equal(r.calls.length, i + 1, `${ALL[i]}: ${r.calls.join("|")}`);
    assert.match(r.stdout, /gate:pr FAIL at /);
    assert.doesNotMatch(r.stdout, /gate:pr PASS/);
  }
});

test("check-pr-rules gets --base, --head HEAD, --no-r3 and the PR body; an unknown argument exits 2", () => {
  const r = run("", ["--base", "origin/feature"]);
  assert.equal(r.status, 0);
  assert.equal(r.calls[2], `node scripts/check-pr-rules.mjs --base origin/feature --head HEAD --no-r3 --pr-body-file ${r.body}`);
  assert.equal(run("", ["--bogus"]).status, 2);
});

// Lauren item 3: gate:pr runs every check-pr-rules rule except R3 (so R4 Verification runs), and forwards the PR
// title so R4 can spot `fix:` PRs.
test("gate:pr runs R4 via --no-r3 (never --r2-only) and forwards the PR title from --pr-title or $PR_TITLE", () => {
  const src = readFileSync("scripts/gate-pr.sh", "utf8");
  assert.doesNotMatch(src, /--r2-only/);
  const a = run("", ["--pr-title", "fix(x): y"]);
  assert.equal(a.status, 0);
  assert.equal(a.calls[2], `node scripts/check-pr-rules.mjs --base origin/main --head HEAD --no-r3 --pr-body-file ${a.body} --pr-title fix(x): y`);
  const b = run("", [], { PR_TITLE: "feat: z" });
  assert.match(b.calls[2], / --pr-title feat: z$/);
  assert.doesNotMatch(run().calls[2], /--pr-title/);
});

test("the script has no skip or dry-run switch, and package.json exposes it as gate:pr", () => {
  const src = readFileSync("scripts/gate-pr.sh", "utf8");
  assert.doesNotMatch(src, /DRY_RUN|FAIL_AT|SKIP/);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).scripts["gate:pr"], "bash scripts/gate-pr.sh");
});
