// Lauren 6-W: scripts/ci-pr-context.mjs ties a CI run to its PR so `npm run gate:pr` gets the PR body and title,
// the same way in hosted CI (pull_request, push) and in the Mac shadow (push to main, workflow_dispatch).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextError, makeGetJson, resolveContext } from "./ci-pr-context.mjs";

const HEAD = "a".repeat(40), PARENT = "b".repeat(40), REPO = "ronshih0130/Condola-app";
const merged = (n, sha = HEAD) => ({ number: n, merged: true, merge_commit_sha: sha, title: `PR ${n}`, body: `## Verification\nbody ${n}`, base: { ref: "main" } });
function io(over = {}) {
  const calls = [];
  const api = over.api ?? {};
  return {
    calls,
    eventName: "push", event: {}, headSha: HEAD, firstParent: PARENT, subject: "", branch: "main", repo: REPO,
    getJson: async p => { calls.push(p); if (!(p in api)) throw new ContextError(`GitHub API ${p}: HTTP 404`); return api[p]; },
    ...over,
  };
}

test("pull_request: the event's PR body and title; base is the merge commit's first parent; no API call", async () => {
  const x = io({ eventName: "pull_request", event: { pull_request: { number: 7, title: "fix(x): y", body: "## Verification\nok" } } });
  assert.deepEqual(await resolveContext(x), { number: 7, title: "fix(x): y", body: "## Verification\nok", base: PARENT, how: "pull_request event" });
  assert.deepEqual(x.calls, []);
  // a null body is an empty body (R4 then fails in gate:pr, as it should)
  const empty = await resolveContext(io({ eventName: "pull_request", event: { pull_request: { number: 8, title: "t", body: null } } }));
  assert.equal(empty.body, "");
  await assert.rejects(() => resolveContext(io({ eventName: "pull_request", event: {} })), /without pull_request data/);
  await assert.rejects(() => resolveContext(io({ eventName: "pull_request", firstParent: "", event: { pull_request: { number: 7 } } })), /fetch-depth: 0/);
});

test("push and workflow_dispatch of a merge commit: the merged PR whose merge_commit_sha is HEAD", async () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    const x = io({ eventName, subject: "Merge pull request #259 from ronshih0130/feat/mac/lauren-3-verification",
      api: { [`/repos/${REPO}/pulls/259`]: merged(259) } });
    assert.deepEqual(await resolveContext(x), { number: 259, title: "PR 259", body: "## Verification\nbody 259", base: PARENT, how: "merge commit of PR #259" });
    assert.deepEqual(x.calls, [`/repos/${REPO}/pulls/259`]);
  }
  // a subject naming a PR that this commit did not merge cannot borrow its body
  await assert.rejects(() => resolveContext(io({ subject: "Merge pull request #259 from x/y", api: { [`/repos/${REPO}/pulls/259`]: merged(259, "c".repeat(40)) } })),
    /is not the merge commit of PR #259/);
  await assert.rejects(() => resolveContext(io({ subject: "Merge pull request #259 from x/y", api: { [`/repos/${REPO}/pulls/259`]: { ...merged(259), merged: false } } })),
    /is not the merge commit of PR #259 \(merged=false/);
  await assert.rejects(() => resolveContext(io({ subject: "Merge pull request #404 from x/y" })), /HTTP 404/);
});

test("a push that is not a PR merge, or an unsupported event, fails: the PR rules need a PR body", async () => {
  await assert.rejects(() => resolveContext(io({ subject: "chore: direct push to main" })), /push of a{12} is not a PR merge commit/);
  await assert.rejects(() => resolveContext(io({ eventName: "schedule" })), /unsupported event schedule/);
  // "Merge pull request" must be the start of the subject
  await assert.rejects(() => resolveContext(io({ subject: "Revert \"Merge pull request #259 from x/y\"" })), /not a PR merge commit/);
});

test("workflow_dispatch on a branch: the one open PR for that branch at HEAD; base is origin/<base branch>", async () => {
  const list = `/repos/${REPO}/pulls?state=open&head=${encodeURIComponent("ronshih0130:feat/x")}`;
  const pr = { number: 300, title: "feat: x", body: "## Verification\nb", head: { sha: HEAD }, base: { ref: "main" } };
  const x = io({ eventName: "workflow_dispatch", branch: "feat/x", subject: "feat: x", api: { [list]: [pr] } });
  assert.deepEqual(await resolveContext(x), { number: 300, title: "feat: x", body: "## Verification\nb", base: "origin/main", how: "open PR for branch feat/x" });
  // the branch moved since the PR's head: not the reviewed commit
  await assert.rejects(() => resolveContext(io({ eventName: "workflow_dispatch", branch: "feat/x", api: { [list]: [{ ...pr, head: { sha: "d".repeat(40) } }] } })),
    /expected one open PR with head feat\/x at a{12}, found 0/);
  await assert.rejects(() => resolveContext(io({ eventName: "workflow_dispatch", branch: "feat/x", api: { [list]: [] } })), /found 0/);
  // a push of a non-merge commit never looks up branch PRs
  const p = io({ eventName: "push", branch: "feat/x", api: { [list]: [pr] } });
  await assert.rejects(() => resolveContext(p), /not a PR merge commit/);
  assert.deepEqual(p.calls, []);
});

test("API reads send the token when set, retry without it on 401/403, and fail on other errors", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.Authorization ?? null]);
    if (init.headers.Authorization) return { ok: false, status: 403 };
    return { ok: true, status: 200, json: async () => ({ number: 1 }) };
  };
  assert.deepEqual(await makeGetJson({ token: "t0k", fetchImpl })("/repos/a/b/pulls/1"), { number: 1 });
  assert.deepEqual(seen, [["https://api.github.com/repos/a/b/pulls/1", "Bearer t0k"], ["https://api.github.com/repos/a/b/pulls/1", null]]);
  await assert.rejects(() => makeGetJson({ token: "", fetchImpl: async () => ({ ok: false, status: 500 }) })("/x?y=1"), /GitHub API \/x: HTTP 500/);
});

test("the CLI writes body, title and base for a pull_request event, prints no token, and writes nothing on failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-pr-context-"));
  const eventFile = join(dir, "event.json");
  writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 9, title: "docs: t", body: "## Verification\n$ npm run gate:pr\nok" } }));
  const out = join(dir, "ctx");
  const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: REPO, GH_API_TOKEN: "secret-token-value" };
  let r = spawnSync("node", ["scripts/ci-pr-context.mjs", out], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ci-pr-context: pull_request → PR #9 \(pull_request event\); base [0-9a-f]{40}; body \d+ bytes\n$/);
  assert.ok(!(r.stdout + r.stderr).includes("secret-token-value"));
  assert.equal(readFileSync(join(out, "body.md"), "utf8"), "## Verification\n$ npm run gate:pr\nok");
  assert.equal(readFileSync(join(out, "title"), "utf8"), "docs: t");
  assert.match(readFileSync(join(out, "base"), "utf8"), /^[0-9a-f]{40}$/);
  const out2 = join(dir, "ctx2");
  r = spawnSync("node", ["scripts/ci-pr-context.mjs", out2], { encoding: "utf8", env: { ...env, GITHUB_EVENT_NAME: "schedule" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ci-pr-context: unsupported event schedule/);
  assert.equal(existsSync(out2), false);
  assert.equal(spawnSync("node", ["scripts/ci-pr-context.mjs"], { encoding: "utf8" }).status, 2);
});
