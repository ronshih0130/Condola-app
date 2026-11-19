// Lauren item 3: red-on-base.mjs verdicts, on a tiny throwaway git repo built in a temp dir so the test does not
// depend on Condola's history. PASS = red on merge-base for the expected reason and green on head; FAIL = base
// green or head red; INCONCLUSIVE = missing test, setup failure, or an unrelated base failure.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

// Codex r1 BLOCKING 1: a nonzero base exit is not proof that the regression test ran and failed.
test("inconclusive (exit 2): without --expect a red base is never a pass, nor is a failure before the test runs", () => {
  let r = rob(["--test", "add.test.mjs"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.summary, /^RED-ON-BASE: INCONCLUSIVE /);
  assert.match(r.out, /without --expect nothing shows the regression test itself failed/);
  // reviewer reproduction: base exits 1 because the command fails before the test runs (sub.test.mjs is head-only)
  const preFail = "test -f sub.test.mjs && node --test {tests}";
  r = rob(["--test", "add.test.mjs", "--cmd", preFail]);
  assert.equal(r.status, 2, r.out);
  assert.doesNotMatch(r.summary, /PASS/);
  r = rob(["--test", "add.test.mjs", "--cmd", preFail, "--expect", "add must sum"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /does not match --expect/);
  // an --expect that also matches the passing head output does not identify the failure
  r = rob(["--test", "add.test.mjs", "--expect", "."]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /also matches the passing head output/);
});

// Codex r1 BLOCKING 2: copying the HEAD test into the base worktree must never write through a base-side symlink.
test("inconclusive or safe: a base-side symlink at or above the test path never redirects the copy into the user's files", () => {
  const sym = mkdtempSync(join(tmpdir(), "red-on-base-sym-"));
  const outside = mkdtempSync(join(tmpdir(), "red-on-base-outside-"));
  const sentinel = join(outside, "sentinel.txt");
  writeFileSync(sentinel, "SENTINEL\n");
  git(sym, "init", "-q", "-b", "main");
  writeFileSync(join(sym, "lib.mjs"), BUGGY);
  symlinkSync(sentinel, join(sym, "add.test.mjs")); // base: the test path is a symlink to a file outside
  symlinkSync(outside, join(sym, "nested")); // base: a parent directory of the test path is a symlink outside
  git(sym, "add", "-A");
  git(sym, "commit", "-q", "-m", "base with symlinks");
  git(sym, "checkout", "-q", "-b", "fix");
  git(sym, "rm", "-q", "add.test.mjs", "nested");
  mkdirSync(join(sym, "nested"));
  const nestedTest = ADD_TEST.replace("./lib.mjs", "../lib.mjs");
  commit(sym, { "lib.mjs": FIXED, "add.test.mjs": ADD_TEST, "nested/add.test.mjs": nestedTest }, "real tests + fix");
  const run = args => spawnSync("node", [SCRIPT, "--base", "main", "--cmd", "node --test {tests}", ...args], { cwd: sym, encoding: "utf8" });

  let r = run(["--test", "add.test.mjs", "--expect", "add must sum"]);
  assert.equal(readFileSync(sentinel, "utf8"), "SENTINEL\n", "the sentinel outside the repo must be untouched");
  assert.ok(lstatSync(sentinel).isFile());
  assert.equal(r.status, 0, r.stdout + r.stderr); // the link itself was replaced inside the base worktree
  r = run(["--test", "nested/add.test.mjs", "--expect", "add must sum"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /refusing to copy nested\/add\.test\.mjs: nested is a symlink/);
  assert.deepEqual(readdirSync(outside), ["sentinel.txt"], "nothing may be written into the symlinked directory");
  assert.equal(git(sym, "worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree ")).length, 1);
});

// Spawns red-on-base in its own process group; a hard guard SIGKILLs that whole group so a regressed script cannot
// leave a runaway child behind.
function robAsync(args, { guardMs = 30000, signalAfterMs = 0, signal = "SIGTERM" } = {}) {
  git(dir, "checkout", "-q", "fix");
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn("node", [SCRIPT, "--base", "main", ...args], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { out += c; });
    const guard = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, guardMs);
    if (signalAfterMs) setTimeout(() => { try { process.kill(child.pid, signal); } catch { /* gone */ } }, signalAfterMs);
    child.on("close", status => {
      clearTimeout(guard);
      // Anything still alive in red-on-base's own process group is a leftover child: record it, then kill it.
      let leftovers = false;
      try { process.kill(-child.pid, 0); leftovers = true; process.kill(-child.pid, "SIGKILL"); } catch { /* empty, as it should be */ }
      resolve({ status, out, leftovers, ms: Date.now() - started });
    });
  });
}
// The looping command records its shell pid so the test can prove the process is really gone afterwards.
function loopCmd() {
  const pidFile = join(mkdtempSync(join(tmpdir(), "red-on-base-pid-")), "pid");
  return { pidFile, cmd: `trap "" TERM; echo $$ > '${pidFile}'; while :; do :; done` };
}
// Returns whether the command's shell was still running, killing it if so, so a failing test never leaves a
// runaway loop behind. Called right after the run, before any assertion.
function reap(pidFile) {
  let pid = 0;
  try { pid = Number(readFileSync(pidFile, "utf8").trim()); } catch { return "no pid file"; }
  try { process.kill(pid, 0); } catch { return "gone"; }
  process.kill(pid, "SIGKILL");
  return `process ${pid} was still running`;
}
const worktreeCount = () => git(dir, "worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree ")).length;

// Codex r1 BLOCKING 3: a run that ignores TERM must still be stopped, reported and cleaned up.
test("inconclusive (exit 2): a timeout stops a command that ignores TERM, quickly, and removes the worktrees", async () => {
  const { pidFile, cmd } = loopCmd();
  const r = await robAsync(["--test", "add.test.mjs", "--timeout", "0.5", "--cmd", cmd]);
  const reaped = reap(pidFile);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /^RED-ON-BASE: INCONCLUSIVE /m);
  assert.match(r.out, /base run timed out after 0\.5s/);
  assert.ok(r.ms < 15000, `took ${r.ms}ms`);
  assert.equal(reaped, "gone", "the command's process must be stopped");
  assert.equal(r.leftovers, false, "no process left in red-on-base's process group");
  assert.equal(worktreeCount(), 1);
});

test("inconclusive (exit 2): SIGTERM to red-on-base mid-run stops the command and still removes the worktrees", async () => {
  const { pidFile, cmd } = loopCmd();
  const r = await robAsync(["--test", "add.test.mjs", "--cmd", cmd], { signalAfterMs: 1500 });
  const reaped = reap(pidFile);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /^RED-ON-BASE: INCONCLUSIVE /m);
  assert.match(r.out, /interrupted by SIGTERM/);
  assert.equal(reaped, "gone", "the command's process must be stopped");
  assert.equal(r.leftovers, false, "no process left in red-on-base's process group");
  assert.equal(worktreeCount(), 1);
});

// Codex r2 BLOCKING: the reviewer's reproduction. A background descendant ignores TERM and redirects its streams, so
// the shell leader exits on TERM and closes the pipes before the grace ends; the group KILL must still be sent.
test("inconclusive (exit 2): a TERM-ignoring background descendant that outlives the shell is still killed on timeout", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "red-on-base-pid-")), "pid");
  const cmd = `bash -c "trap \\"\\" TERM; echo \\$\\$ > '${pidFile}'; while :; do :; done" </dev/null >/dev/null 2>&1 & wait`;
  const r = await robAsync(["--test", "add.test.mjs", "--timeout", "1", "--cmd", cmd]);
  const reaped = reap(pidFile);
  assert.equal(reaped, "gone", "the background descendant must be stopped before the verdict");
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /^RED-ON-BASE: INCONCLUSIVE /m);
  assert.match(r.out, /base run timed out after 1s/);
  assert.equal(r.leftovers, false, "no process left in red-on-base's process group");
  assert.equal(worktreeCount(), 1);
});

// A run that finishes normally but leaves a background process in its group: the process is killed before the
// verdict (and before the worktrees are removed), and the verdict itself is unchanged.
test("pass (exit 0): background processes left by a finished run are killed, and the verdict stands", async () => {
  const pidDir = mkdtempSync(join(tmpdir(), "red-on-base-pid-")); // one pid file per side: pid-base, pid-head
  const pidFile = `${pidDir}/pid-$RED_ON_BASE_SIDE`;
  const cmd = `node --test {tests}; rc=$?; bash -c "trap \\"\\" TERM; echo \\$\\$ > '${pidFile}'; while :; do :; done" </dev/null >/dev/null 2>&1 & while [ ! -s "${pidFile}" ]; do sleep 0.05; done; exit $rc`;
  const r = await robAsync(["--test", "add.test.mjs", "--expect", "add must sum", "--cmd", cmd]);
  const reaped = ["base", "head"].map(side => reap(join(pidDir, `pid-${side}`)));
  assert.deepEqual(reaped, ["gone", "gone"], "the leftover background process of each side must be stopped");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^RED-ON-BASE: PASS /m);
  assert.match(r.out, /--- base: killed processes left in the run's process group/);
  assert.match(r.out, /--- head: killed processes left in the run's process group/);
  assert.equal(r.leftovers, false, "no process left in red-on-base's process group");
  assert.equal(worktreeCount(), 1);
});

test("only committed HEAD content runs, and the temporary worktrees are removed", () => {
  writeFileSync(join(dir, "lib.mjs"), BUGGY); // uncommitted revert of the fix must not leak into the head run
  const r = rob(["--test", "add.test.mjs", "--expect", "add must sum"]);
  git(dir, "checkout", "--", "lib.mjs");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(git(dir, "worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree ")).length, 1);
});
