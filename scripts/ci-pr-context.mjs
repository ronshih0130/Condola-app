#!/usr/bin/env node
// Lauren 6-W: the PR context for `npm run gate:pr` in CI (hosted ci.yml and the
// Mac shadow ci-shadow.yml), so both run the same gate entry point.
//
//   node scripts/ci-pr-context.mjs <out-dir>
//
// Writes <out-dir>/body.md (PR body), <out-dir>/title (PR title) and
// <out-dir>/base (the base commit for check-pr-rules), then prints one summary
// line. Exits non-zero, writing nothing, when no PR can be tied to HEAD.
//
// Which PR (all looked up in the GitHub API, so a re-run sees the PR's current
// title and body, and no commit subject is trusted):
//   - pull_request: the event's PR number, re-read from /pulls/N. Base = HEAD^1
//     (the checked-out merge commit's first parent, i.e. the base branch).
//   - push, or workflow_dispatch on the default branch: the PR associated with
//     HEAD (/commits/HEAD/pulls) that was merged with merge_commit_sha == HEAD.
//     This covers merge, squash and rebase merges and any commit subject.
//     Base = HEAD^1 (the branch before the merge).
//   - workflow_dispatch on another branch: the PR associated with HEAD whose head
//     branch is the dispatched branch (open first, so a branch that merged
//     another PR into itself still gets its own PR; a re-run after the branch
//     moved on still finds it). Base = origin/<PR base branch>.
//   - anything else (e.g. a direct push that no PR merged): an error. The PR
//     rules (R2 Spec-Change, R4 Verification) need a PR body.
//
// API reads use $GH_API_TOKEN when set (the workflow's read-only token) and
// retry without it on 401/403 (the repository is public). Nothing is written
// to the API; the token is never printed.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export class ContextError extends Error {}

const pick = (pr, base, how) => ({ number: pr.number, title: pr.title || '', body: pr.body || '', base, how });

// Pure resolution, with every input injected (tests stub them).
// io: { eventName, event, headSha, firstParent, branch, repo, getJson(urlPath) }
export async function resolveContext(io) {
  const { eventName, event } = io;
  const needParent = () => { if (!io.firstParent) throw new ContextError('HEAD has no first parent (checkout needs fetch-depth: 0)'); return io.firstParent; };
  if (eventName === 'pull_request') {
    const n = event && event.pull_request && event.pull_request.number;
    if (!n) throw new ContextError('pull_request event without pull_request data');
    const pr = await io.getJson(`/repos/${io.repo}/pulls/${n}`);
    if (!pr || pr.number !== n) throw new ContextError(`PR #${n} not found`);
    return pick(pr, needParent(), 'pull_request event, current PR text');
  }
  if (eventName !== 'push' && eventName !== 'workflow_dispatch') {
    throw new ContextError(`unsupported event ${eventName}`);
  }
  const list = await io.getJson(`/repos/${io.repo}/commits/${io.headSha}/pulls`);
  const prs = Array.isArray(list) ? list.filter(Boolean) : [];
  const defaultBranch = (event && event.repository && event.repository.default_branch) || 'main';
  const sha = io.headSha.slice(0, 12);
  if (eventName === 'workflow_dispatch' && io.branch && io.branch !== defaultBranch) {
    const own = prs.filter(pr => pr.head && pr.head.ref === io.branch);
    const open = own.filter(pr => pr.state === 'open');
    const chosen = open.length ? open : own;
    if (chosen.length !== 1) {
      throw new ContextError(`expected one PR with head branch ${io.branch} containing ${sha}, found ${chosen.length}${open.length ? ' open' : ''}`);
    }
    const pr = chosen[0];
    if (!pr.base || !pr.base.ref) throw new ContextError(`PR #${pr.number} has no base branch`);
    return pick(pr, `origin/${pr.base.ref}`, `PR for branch ${io.branch}`);
  }
  const merged = prs.filter(pr => pr.merged_at && pr.merge_commit_sha === io.headSha);
  if (merged.length !== 1) {
    throw new ContextError(`${eventName} of ${sha}: expected one PR merged as this commit, found ${merged.length}; the PR rules need a PR body`);
  }
  return pick(merged[0], needParent(), `PR #${merged[0].number} merged as HEAD`);
}

export function makeGetJson({ token, fetchImpl = globalThis.fetch, apiUrl = 'https://api.github.com' }) {
  return async urlPath => {
    const call = auth => fetchImpl(`${apiUrl}${urlPath}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'condola-ci-pr-context', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    });
    let res = await call(token);
    if (token && (res.status === 401 || res.status === 403)) res = await call(null);
    if (!res.ok) throw new ContextError(`GitHub API ${urlPath.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  };
}

function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

async function main() {
  const out = process.argv[2];
  if (!out) { process.stderr.write('usage: node scripts/ci-pr-context.mjs <out-dir>\n'); process.exit(2); }
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  let event = null;
  if (process.env.GITHUB_EVENT_PATH) {
    try { event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { event = null; }
  }
  const io = {
    eventName,
    event,
    headSha: git(['rev-parse', 'HEAD']),
    firstParent: git(['rev-parse', '--verify', '--quiet', 'HEAD^1']),
    branch: process.env.GITHUB_REF_NAME || '',
    repo: process.env.GITHUB_REPOSITORY || '',
    getJson: makeGetJson({ token: process.env.GH_API_TOKEN || '', apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com' }),
  };
  try {
    const ctx = await resolveContext(io);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'body.md'), ctx.body);
    fs.writeFileSync(path.join(out, 'title'), ctx.title);
    fs.writeFileSync(path.join(out, 'base'), ctx.base);
    process.stdout.write(`ci-pr-context: ${eventName} → PR #${ctx.number} (${ctx.how}); base ${ctx.base}; body ${Buffer.byteLength(ctx.body)} bytes\n`);
  } catch (e) {
    process.stderr.write(`ci-pr-context: ${e instanceof ContextError ? e.message : `error: ${e && e.message ? e.message : e}`}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
