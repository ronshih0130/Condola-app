// Lauren item 3: red-on-base.mjs verdicts, on a tiny throwaway git repo built in a temp dir so the test does not
// depend on Condola's history. PASS = red on merge-base for the expected reason and green on head; FAIL = base
// green or head red; INCONCLUSIVE = missing test, setup failure, or an unrelated base failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const SCRIPT = resolve("scripts/red-on-base.mjs");
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ID } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(cwd, files, msg) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
}

const BUGGY = "export const add = (a, b) => a + b + (a === 1 ? -1 : 0);\nexport const mul = (a, b) => a * b;\n";
const FIXED = "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n";
const ADD_TEST = 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { add } from "./lib.mjs";\n' +
  'test("add", () => assert.equal(add(1, 2), 3, "add must sum its arguments"));\n';
const MUL_TEST = 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { mul } from "./lib.mjs";\n' +
  'test("mul", () => assert.equal(mul(2, 3), 6));\n';
const NEW_EXPORT_TEST = 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { sub } from "./lib.mjs";\n' +
  'test("sub", () => assert.equal(sub(3, 1), 2));\n';

// main: buggy lib. Branch "fix": regression tests + the fix. Branch "nofix": regression test only.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "red-on-base-repo-"));
  git(dir, "init", "-q", "-b", "main");
  commit(dir, { "lib.mjs": BUGGY }, "buggy lib");
  git(dir, "checkout", "-q", "-b", "fix");
  commit(dir, { "add.test.mjs": ADD_TEST, "mul.test.mjs": MUL_TEST }, "regression tests");
  commit(dir, { "lib.mjs": FIXED + "export const sub = (a, b) => a - b;\n", "sub.test.mjs": NEW_EXPORT_TEST }, "fix add, add sub");
  git(dir, "checkout", "-q", "-b", "nofix", "main");
  commit(dir, { "add.test.mjs": ADD_TEST }, "regression test without the fix");
  git(dir, "checkout", "-q", "fix");
  return dir;
}
const dir = repo();

function rob(args, branch = "fix") {
  git(dir, "checkout", "-q", branch);
  const r = spawnSync("node", [SCRIPT, "--base", "main", "--cmd", "node --test {tests}", ...args], { cwd: dir, encoding: "utf8" });
  const summary = (r.stdout.match(/^RED-ON-BASE: .*$/m) || [""])[0];
  return { status: r.status, out: r.stdout + r.stderr, summary };
}
const SHA = "[0-9a-f]{12}";

test("pass (exit 0): the regression test is red on merge-base for the expected reason and green on head", () => {
  const r = rob(["--test", "add.test.mjs", "--expect", "add must sum"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.summary, new RegExp(`^RED-ON-BASE: PASS base=${SHA} head=${SHA} tests=1$`));
  assert.equal(r.summary.split(" ")[2], `base=${git(dir, "merge-base", "main", "HEAD").slice(0, 12)}`);
  assert.match(r.out, /--- base: exit=1/);
  assert.match(r.out, /--- head: exit=0/);
  // without --expect, any base failure that is not a load error is accepted as red
  assert.equal(rob(["--test", "add.test.mjs"]).status, 0);
  // an absolute path through the /var -> /private/var symlink (macOS tmpdir) resolves to the same repo file
  assert.equal(rob(["--test", join(dir, "add.test.mjs"), "--expect", "add must sum"]).status, 0);
});

test("fail (exit 1): the test also passes on base, so it proves nothing", () => {
  const r = rob(["--test", "mul.test.mjs"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.summary, /^RED-ON-BASE: FAIL /);
  assert.match(r.out, /base run passed: the test does not reproduce the bug/);
});

test("fail (exit 1): head is red, the fix does not make the test pass", () => {
  const r = rob(["--test", "add.test.mjs", "--expect", "add must sum"], "nofix");
  assert.equal(r.status, 1, r.out);
  assert.match(r.summary, /^RED-ON-BASE: FAIL /);
  assert.match(r.out, /head run failed/);
});

test("inconclusive (exit 2): missing test file, unknown base ref, or a command that cannot run", () => {
  let r = rob(["--test", "missing.test.mjs"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.summary, /^RED-ON-BASE: INCONCLUSIVE /);
  assert.match(r.out, /test file missing at HEAD/);
  r = rob(["--test", "add.test.mjs", "--base", "no-such-ref"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /base ref "no-such-ref" does not exist/);
  r = rob(["--test", "add.test.mjs", "--cmd", "definitely-not-a-command-xyz {tests}"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /command could not run \(exit 127/);
  assert.equal(rob([]).status, 2, "no --test");
});

test("inconclusive (exit 2): base fails for an unrelated reason (output does not match --expect, or the test cannot load)", () => {
  let r = rob(["--test", "add.test.mjs", "--expect", "some other failure"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.summary, /^RED-ON-BASE: INCONCLUSIVE /);
  assert.match(r.out, /does not match --expect/);
  // the test imports an export that only the head commit adds: a new-feature test, not a reproduced bug
  r = rob(["--test", "sub.test.mjs"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /could not load/);
  // naming the load error as the "expected" reason does not turn it into proof
  r = rob(["--test", "sub.test.mjs", "--expect", "does not provide an export named"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /could not load/);
});

test("only committed HEAD content runs, and the temporary worktrees are removed", () => {
  writeFileSync(join(dir, "lib.mjs"), BUGGY); // uncommitted revert of the fix must not leak into the head run
  const r = rob(["--test", "add.test.mjs", "--expect", "add must sum"]);
  git(dir, "checkout", "--", "lib.mjs");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(git(dir, "worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree ")).length, 1);
});
