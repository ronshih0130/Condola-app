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
// Which PR:
//   - pull_request: the event's PR. Base = HEAD^1 (the checked-out merge
//     commit's first parent, i.e. the base branch it was merged onto).
//   - push / workflow_dispatch on a merge commit `Merge pull request #N from …`:
//     PR #N from the GitHub API, which must be merged with merge_commit_sha ==
//     HEAD (so a hand-written subject cannot borrow another PR's body).
//     Base = HEAD^1 (the branch before the merge).
//   - workflow_dispatch on a branch: the one open PR whose head is that branch
//     and whose head SHA == HEAD. Base = origin/<PR base branch>.
//   - anything else (e.g. a direct push that is not a PR merge): an error. The
//     PR rules (R2 Spec-Change, R4 Verification) need a PR body.
//
// API reads use $GH_API_TOKEN when set (the workflow's read-only token) and
// retry without it on 401/403 (the repository is public). Nothing is written
// to the API; the token is never printed.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MERGE_SUBJECT_RE = /^Merge pull request #(\d+) from \S+/;

export class ContextError extends Error {}

// Pure resolution, with every input injected (tests stub them).
// io: { eventName, event, headSha, firstParent, subject, branch, repo, getJson(urlPath) }
export async function resolveContext(io) {
  const { eventName, event } = io;
  if (eventName === 'pull_request') {
    const pr = event && event.pull_request;
    if (!pr || !pr.number) throw new ContextError('pull_request event without pull_request data');
    if (!io.firstParent) throw new ContextError('HEAD has no first parent (checkout needs fetch-depth: 0)');
    return { number: pr.number, title: pr.title || '', body: pr.body || '', base: io.firstParent, how: 'pull_request event' };
  }
  if (eventName !== 'push' && eventName !== 'workflow_dispatch') {
    throw new ContextError(`unsupported event ${eventName}`);
  }
  const m = MERGE_SUBJECT_RE.exec(io.subject || '');
  if (m) {
    const n = Number(m[1]);
    const pr = await io.getJson(`/repos/${io.repo}/pulls/${n}`);
    if (!pr || pr.number !== n) throw new ContextError(`PR #${n} not found`);
    if (!pr.merged || pr.merge_commit_sha !== io.headSha) {
      throw new ContextError(`HEAD ${io.headSha.slice(0, 12)} is not the merge commit of PR #${n} (merged=${!!pr.merged}, merge_commit_sha=${String(pr.merge_commit_sha).slice(0, 12)})`);
    }
    if (!io.firstParent) throw new ContextError('HEAD has no first parent (checkout needs fetch-depth: 0)');
    return { number: n, title: pr.title || '', body: pr.body || '', base: io.firstParent, how: `merge commit of PR #${n}` };
  }
  if (eventName === 'workflow_dispatch' && io.branch) {
    const owner = io.repo.split('/')[0];
    const list = await io.getJson(`/repos/${io.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${io.branch}`)}`);
    const prs = (Array.isArray(list) ? list : []).filter(pr => pr && pr.head && pr.head.sha === io.headSha);
    if (prs.length !== 1) throw new ContextError(`expected one open PR with head ${io.branch} at ${io.headSha.slice(0, 12)}, found ${prs.length}`);
    const pr = prs[0];
    if (!pr.base || !pr.base.ref) throw new ContextError(`PR #${pr.number} has no base branch`);
    return { number: pr.number, title: pr.title || '', body: pr.body || '', base: `origin/${pr.base.ref}`, how: `open PR for branch ${io.branch}` };
  }
  throw new ContextError(`${eventName} of ${io.headSha.slice(0, 12)} is not a PR merge commit, so there is no PR body for the PR rules`);
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
    subject: git(['log', '-1', '--format=%s', 'HEAD']),
    branch: process.env.GITHUB_REF_NAME || '',
    repo: process.env.GITHUB_REPOSITORY || '',
    getJson: makeGetJson({ token: process.env.GH_API_TOKEN || '' }),
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
