// Lauren 6-W: scripts/ci-pr-context.mjs ties a CI run to its PR so `npm run gate:pr` gets the PR body and title,
// the same way in hosted CI (pull_request, push) and in the Mac shadow (push to main, workflow_dispatch).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextError, makeGetJson, resolveContext } from "./ci-pr-context.mjs";

const HEAD = "a".repeat(40), PARENT = "b".repeat(40), REPO = "ronshih0130/Condola-app";
const assoc = `/repos/${REPO}/commits/${HEAD}/pulls`;
const pr = (n, over = {}) => ({ number: n, state: "open", title: `PR ${n}`, body: `## Verification\nbody ${n}`, merged_at: null,
  merge_commit_sha: null, head: { ref: `feat/${n}`, sha: HEAD }, base: { ref: "main" }, ...over });
const mergedAs = (n, sha = HEAD, over = {}) => pr(n, { state: "closed", merged_at: "2026-11-20T00:00:00Z", merge_commit_sha: sha, ...over });
function io(over = {}) {
  const calls = [];
  const api = over.api ?? {};
  return {
    calls,
    eventName: "push", event: { repository: { default_branch: "main" } }, headSha: HEAD, firstParent: PARENT, branch: "main", repo: REPO,
    getJson: async p => { calls.push(p); if (!(p in api)) throw new ContextError(`GitHub API ${p}: HTTP 404`); return api[p]; },
    ...over,
  };
}

test("pull_request: the PR is re-read from the API, so a re-run after a body fix sees the current body (Codex 6-W r1 BLOCKING 3)", async () => {
  const x = io({ eventName: "pull_request", event: { pull_request: { number: 7, title: "old", body: "stale body without Verification" } },
    api: { [`/repos/${REPO}/pulls/7`]: pr(7, { title: "fix(x): y", body: "## Verification\nfixed" }) } });
  assert.deepEqual(await resolveContext(x), { number: 7, title: "fix(x): y", body: "## Verification\nfixed", base: PARENT, how: "pull_request event, current PR text" });
  assert.deepEqual(x.calls, [`/repos/${REPO}/pulls/7`]);
  // a null body is an empty body (R4 then fails in gate:pr, as it should)
  assert.equal((await resolveContext(io({ eventName: "pull_request", event: { pull_request: { number: 8 } }, api: { [`/repos/${REPO}/pulls/8`]: pr(8, { body: null }) } }))).body, "");
  await assert.rejects(() => resolveContext(io({ eventName: "pull_request", event: {} })), /without pull_request data/);
  await assert.rejects(() => resolveContext(io({ eventName: "pull_request", event: { pull_request: { number: 9 } } })), /HTTP 404/);
  await assert.rejects(() => resolveContext(io({ eventName: "pull_request", firstParent: "", event: { pull_request: { number: 7 } }, api: { [`/repos/${REPO}/pulls/7`]: pr(7) } })), /fetch-depth: 0/);
});

test("push and dispatch on main: the PR merged as HEAD, for merge, squash, rebase and custom subjects (Codex 6-W r1 BLOCKING 1)", async () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    // the association list also holds the PR whose branch contained HEAD before; only the one merged as HEAD counts
    const x = io({ eventName, api: { [assoc]: [pr(300, { state: "closed", merged_at: "2026-11-19T00:00:00Z", merge_commit_sha: "c".repeat(40) }), mergedAs(301)] } });
    assert.deepEqual(await resolveContext(x), { number: 301, title: "PR 301", body: "## Verification\nbody 301", base: PARENT, how: "PR #301 merged as HEAD" });
    assert.deepEqual(x.calls, [assoc]);
  }
  // no PR merged as HEAD (a direct push), or two: fail, the PR rules need a PR body
  await assert.rejects(() => resolveContext(io({ api: { [assoc]: [] } })), /push of a{12}: expected one PR merged as this commit, found 0/);
  await assert.rejects(() => resolveContext(io({ api: { [assoc]: [pr(302)] } })), /found 0/);
  await assert.rejects(() => resolveContext(io({ api: { [assoc]: [mergedAs(303), mergedAs(304)] } })), /found 2/);
  await assert.rejects(() => resolveContext(io({ eventName: "schedule" })), /unsupported event schedule/);
  // a default branch other than main is read from the event
  const dev = io({ eventName: "workflow_dispatch", branch: "dev", event: { repository: { default_branch: "dev" } }, api: { [assoc]: [mergedAs(305)] } });
  assert.equal((await resolveContext(dev)).number, 305);
});

test("dispatch on a branch: that branch's own PR, even when HEAD merged another PR into it or the branch moved on (Codex 6-W r1 BLOCKING 2, SHOULD 5)", async () => {
  // branch P merged PR Q into itself: HEAD is Q's merge commit, but the run is about P
  const q = mergedAs(310, HEAD, { head: { ref: "feat/q", sha: "e".repeat(40) }, base: { ref: "feat/p" } });
  const p = pr(311, { head: { ref: "feat/p", sha: HEAD } });
  let x = io({ eventName: "workflow_dispatch", branch: "feat/p", api: { [assoc]: [q, p] } });
  assert.deepEqual(await resolveContext(x), { number: 311, title: "PR 311", body: "## Verification\nbody 311", base: "origin/main", how: "PR for branch feat/p" });
  // a re-run after P moved on to a newer head still finds P (its head SHA is no longer HEAD)
  x = io({ eventName: "workflow_dispatch", branch: "feat/p", api: { [assoc]: [pr(311, { head: { ref: "feat/p", sha: "f".repeat(40) } })] } });
  assert.equal((await resolveContext(x)).number, 311);
  // after P was merged (closed), the re-run still uses P
  x = io({ eventName: "workflow_dispatch", branch: "feat/p", api: { [assoc]: [mergedAs(311, "9".repeat(40), { head: { ref: "feat/p", sha: HEAD } })] } });
  assert.equal((await resolveContext(x)).number, 311);
  // an open PR wins over an old closed PR from the same branch name
  x = io({ eventName: "workflow_dispatch", branch: "feat/p", api: { [assoc]: [pr(312, { state: "closed", head: { ref: "feat/p", sha: HEAD } }), p] } });
  assert.equal((await resolveContext(x)).number, 311);
  await assert.rejects(() => resolveContext(io({ eventName: "workflow_dispatch", branch: "feat/p", api: { [assoc]: [q] } })), /expected one PR with head branch feat\/p containing a{12}, found 0/);
  await assert.rejects(() => resolveContext(io({ eventName: "workflow_dispatch", branch: "feat/p", api: { [assoc]: [p, pr(313, { head: { ref: "feat/p", sha: HEAD } })] } })), /found 2 open/);
  // a push is never resolved by branch, only by the merged-as-HEAD rule
  await assert.rejects(() => resolveContext(io({ eventName: "push", branch: "feat/p", api: { [assoc]: [p] } })), /expected one PR merged as this commit/);
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

test("the CLI writes body, title and base from the API, sends the token only as a header, prints no token, and writes nothing on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-pr-context-"));
  const eventFile = join(dir, "event.json");
  writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 9, title: "stale", body: "stale" } }));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push([req.url, req.headers.authorization ?? null]);
    if (req.url === `/repos/${REPO}/pulls/9`) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(pr(9, { title: "docs: t", body: "## Verification\n$ npm run gate:pr\nok" }))); return; }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const run = (args, env) => new Promise(resolve => {
    const child = spawn("node", ["scripts/ci-pr-context.mjs", ...args], { env });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { err += c; });
    child.on("close", status => resolve({ status, out, err }));
  });
  try {
    const out = join(dir, "ctx");
    const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventFile, GITHUB_REPOSITORY: REPO, GITHUB_API_URL: apiUrl, GH_API_TOKEN: "secret-token-value" };
    let r = await run([out], env);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /^ci-pr-context: pull_request → PR #9 \(pull_request event, current PR text\); base [0-9a-f]{40}; body \d+ bytes\n$/);
    assert.ok(!(r.out + r.err).includes("secret-token-value"));
    assert.deepEqual(seen, [[`/repos/${REPO}/pulls/9`, "Bearer secret-token-value"]]);
    assert.equal(readFileSync(join(out, "body.md"), "utf8"), "## Verification\n$ npm run gate:pr\nok");
    assert.equal(readFileSync(join(out, "title"), "utf8"), "docs: t");
    assert.match(readFileSync(join(out, "base"), "utf8"), /^[0-9a-f]{40}$/);
    const out2 = join(dir, "ctx2");
    r = await run([out2], { ...env, GITHUB_EVENT_NAME: "push" });
    assert.equal(r.status, 1);
    assert.match(r.err, /ci-pr-context: GitHub API \/repos\/ronshih0130\/Condola-app\/commits\/[0-9a-f]{40}\/pulls: HTTP 404/);
    assert.equal(existsSync(out2), false);
    assert.equal((await run([], env)).status, 2);
  } finally {
    server.close();
  }
});
