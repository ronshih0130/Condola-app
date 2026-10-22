import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatRebase, readRebase, rebaseVerdict } from "./rebase-check.mjs";

const checker = fileURLToPath(new URL("./rebase-check.mjs", import.meta.url));

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "rebase-test",
  GIT_AUTHOR_EMAIL: "rebase-test@example.com",
  GIT_COMMITTER_NAME: "rebase-test",
  GIT_COMMITTER_EMAIL: "rebase-test@example.com",
  GIT_EDITOR: "true",
};

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv }).trim();
}

function commit(repo, file, message) {
  writeFileSync(join(repo, file), `${message}\n`);
  git(repo, ["add", file]);
  git(repo, ["commit", "-m", message]);
}

function repoWithMain() {
  const repo = mkdtempSync(join(tmpdir(), "condola-rebase-"));
  git(repo, ["init", "-b", "main"]);
  commit(repo, "base.txt", "base");
  return repo;
}

test("a branch that contains main is up to date", () => {
  assert.equal(rebaseVerdict("abc", "main", "main").upToDate, true);
  assert.equal(rebaseVerdict("abc", "old", "main").upToDate, false);
  assert.equal(rebaseVerdict("", "", "").upToDate, false);
  assert.match(formatRebase(rebaseVerdict("abc", "old", "main")), /Rebase onto main/);
  assert.match(formatRebase(rebaseVerdict("abc", "main", "main")), /rebase: up to date/);
});

test("the checker fails after main moves and passes again once the branch contains it", () => {
  const repo = repoWithMain();
  const base = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-b", "feature"]);
  commit(repo, "feature.txt", "feature work");
  assert.equal(readRebase(repo, "main").upToDate, true);

  git(repo, ["checkout", "main"]);
  commit(repo, "main.txt", "later main");
  git(repo, ["checkout", "feature"]);
  const behind = readRebase(repo, "main");
  assert.equal(behind.upToDate, false);
  assert.equal(behind.mergeBase, base);
  assert.notEqual(behind.main, base);

  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [checker, "--repo", repo, "--base", "main"], { encoding: "utf8" });
  } catch (error) {
    status = error.status;
    stdout = error.stdout;
  }
  assert.equal(status, 1);
  assert.match(stdout, /does not contain the latest origin\/main/);

  git(repo, ["rebase", "main"]);
  const current = readRebase(repo, "main");
  assert.equal(current.upToDate, true);
  assert.equal(current.mergeBase, current.main);
  const passed = execFileSync(process.execPath, [checker, "--repo", repo, "--base", "main"], { encoding: "utf8" });
  assert.match(passed, /rebase: up to date/);
  assert.match(passed, new RegExp(`origin/main ${git(repo, ["rev-parse", "main"])}`));
});
