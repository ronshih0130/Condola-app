#!/usr/bin/env node
// red-on-base.mjs — prove a regression test is red without the fix and green
// with it (Lauren item 3; AGENTS.md §13 R1 bug-fix loop).
//
// Usage:
//   node scripts/red-on-base.mjs --test <path>... [--cmd "<test command>"]
//     [--expect <regex>] [--base <ref>] [--timeout <seconds>] [--verbose]
//
//   --test     one or more test files (repeat the flag or list several paths
//              after it), relative to the repo root or the current directory.
//   --cmd      shell command run in each checkout (bash -c). `{tests}` is
//              replaced by the shell-quoted test paths; without it the command
//              runs as given. Default: npx tsx --test {tests}
//   --expect   regex (JavaScript syntax) the BASE output must match, i.e. the
//              reason the test is expected to fail without the fix.
//   --base     ref to diff against; the base checkout is merge-base(<base>, HEAD).
//              Default: origin/main.
//   --timeout  per-run limit in seconds. Default: 600.
//
// What it does:
//   1. Resolves HEAD and merge-base(<base>, HEAD). Only committed code is used:
//      uncommitted edits are ignored, so the SHAs printed are exactly what ran.
//   2. Creates two temporary git worktrees (detached): base at the merge-base,
//      head at HEAD. Links node_modules into each from this checkout (or the
//      main worktree), the same way our worktrees share node_modules.
//   3. Copies the HEAD version of each --test file into the base worktree, and
//      nothing else, then runs --cmd there. Then runs --cmd in the head worktree.
//   4. Removes both worktrees with `git worktree remove --force`.
//
// Verdicts (last line: `RED-ON-BASE: <VERDICT> base=<sha> head=<sha> tests=<n>`):
//   PASS          exit 0  base run fails for the expected reason AND head run passes.
//   FAIL          exit 1  base run passes (the test proves nothing), or head run fails.
//   INCONCLUSIVE  exit 2  not proof either way: bad arguments, unknown ref, a test
//                         file missing at HEAD, worktree/node_modules setup failure,
//                         a timeout or killed run, a command that cannot start
//                         (exit 126/127), or a base failure for another reason:
//                         output showing the test could not load (missing module
//                         or export, failed transform) — a test that needs the
//                         new code, not a reproduced bug, even if --expect names
//                         that error — or output not matching --expect.
//   Precedence: setup/timeouts > base passes (FAIL) > head fails (FAIL) >
//   base fails for another reason (INCONCLUSIVE) > PASS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const DEFAULT_CMD = 'npx tsx --test {tests}';
// The test could not even load on base. A generic SyntaxError is not listed:
// it can be the bug itself (e.g. a JSON.parse regression).
const LOAD_ERROR_RE = /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package|does not provide an export named|ERR_UNKNOWN_FILE_EXTENSION|Transform failed with \d+ error/;
const TAIL_LINES = 15;

const VERDICT_EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 };

function parseArgs(argv) {
  const out = { tests: [], cmd: DEFAULT_CMD, base: 'origin/main', timeout: 600, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--test':
        out.tests.push(value());
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.tests.push(argv[++i]);
        break;
      case '--cmd': out.cmd = value(); break;
      case '--expect': out.expect = value(); break;
      case '--base': out.base = value(); break;
      case '--timeout': out.timeout = Number(value()); break;
      case '--verbose': out.verbose = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function git(cwd, gitArgs) {
  const r = spawnSync('git', ['-C', cwd, ...gitArgs], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function tail(text, n) {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-n);
}

class Inconclusive extends Error {}

function finish(verdict, reason, ctx) {
  const short = sha => (sha ? sha.slice(0, 12) : 'unknown');
  process.stdout.write(`reason: ${reason}\n`);
  process.stdout.write(`RED-ON-BASE: ${verdict} base=${short(ctx.baseSha)} head=${short(ctx.headSha)} tests=${ctx.tests ? ctx.tests.length : 0}\n`);
  process.exitCode = VERDICT_EXIT[verdict];
}

// node_modules to link into each temporary worktree: this checkout's (which may
// itself be a symlink to the main checkout's), else the main worktree's.
function findNodeModules(root) {
  const candidates = [path.join(root, 'node_modules')];
  const list = git(root, ['worktree', 'list', '--porcelain']);
  if (list.ok) {
    const first = list.out.split('\n').find(l => l.startsWith('worktree '));
    if (first) candidates.push(path.join(first.slice('worktree '.length), 'node_modules'));
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return fs.realpathSync(c); } catch { /* next */ }
  }
  return null;
}

function addWorktree(root, sha, label, created) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `red-on-base-${label}-`));
  const r = git(root, ['worktree', 'add', '--detach', dir, sha]);
  if (!r.ok) {
    try { fs.rmdirSync(dir); } catch { /* empty dir only; leave it if not */ }
    throw new Inconclusive(`could not create the ${label} worktree at ${sha.slice(0, 12)}: ${r.err}`);
  }
  created.push(dir);
  return dir;
}

function removeWorktrees(root, created) {
  for (const dir of created) {
    const r = git(root, ['worktree', 'remove', '--force', dir]);
    if (!r.ok) process.stderr.write(`red-on-base: warning: could not remove worktree ${dir}: ${r.err}\n`);
  }
  git(root, ['worktree', 'prune']);
}

function runSide(label, cwd, command, timeoutSec, verbose) {
  const started = Date.now();
  // A standalone test run: drop node:test's parent-runner marker so a nested
  // `node --test` (e.g. when this script itself runs under a test) really runs.
  const env = { ...process.env, RED_ON_BASE_SIDE: label };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('bash', ['-c', command], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const ms = Date.now() - started;
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const status = r.status;
  process.stdout.write(`--- ${label}: exit=${status == null ? `signal ${r.signal || 'none'}` : status}${timedOut ? ' (timeout)' : ''} ${ms}ms\n`);
  const shown = verbose ? output.replace(/\s+$/, '').split('\n') : tail(output, TAIL_LINES);
  for (const line of shown) process.stdout.write(`  | ${line}\n`);
  return { status, signal: r.signal, timedOut, spawnError: r.error && !timedOut ? r.error.message : null, output };
}

function main() {
  let opts;
  const ctx = {};
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    finish('INCONCLUSIVE', `bad arguments: ${e.message}`, ctx);
    return;
  }
  if (opts.help) {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
    process.stdout.write(src.slice(1, 20).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return;
  }
  ctx.tests = opts.tests;
  if (opts.tests.length === 0) { finish('INCONCLUSIVE', 'no --test file given', ctx); return; }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) { finish('INCONCLUSIVE', 'bad --timeout', ctx); return; }
  let expectRe = null;
  if (opts.expect != null) {
    try { expectRe = new RegExp(opts.expect, 'm'); }
    catch (e) { finish('INCONCLUSIVE', `bad --expect regex: ${e.message}`, ctx); return; }
  }

  const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!top.ok) { finish('INCONCLUSIVE', `not inside a git repository: ${top.err}`, ctx); return; }
  const root = top.out;

  const created = [];
  try {
    const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!head.ok) throw new Inconclusive(`cannot resolve HEAD: ${head.err}`);
    ctx.headSha = head.out;
    const baseRef = git(root, ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`]);
    if (!baseRef.ok) throw new Inconclusive(`base ref "${opts.base}" does not exist (fetch it or pass --base)`);
    const mb = git(root, ['merge-base', baseRef.out, ctx.headSha]);
    if (!mb.ok || !mb.out) throw new Inconclusive(`no merge-base between ${opts.base} and HEAD`);
    ctx.baseSha = mb.out;

    // Test paths relative to the repo root; each must exist at HEAD.
    const rels = opts.tests.map(t => {
      // Resolve symlinks (macOS /var -> /private/var) so the path compares with
      // git's real top-level path.
      let abs = path.resolve(process.cwd(), t);
      try { abs = fs.realpathSync(abs); }
      catch { try { abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* keep as given */ } }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel.startsWith('..')) throw new Inconclusive(`test file is outside the repository: ${t}`);
      return rel;
    });
    for (const rel of rels) {
      if (!git(root, ['cat-file', '-e', `${ctx.headSha}:${rel}`]).ok) {
        throw new Inconclusive(`test file missing at HEAD ${ctx.headSha.slice(0, 12)}: ${rel} (commit it first)`);
      }
    }
    const command = opts.cmd.includes('{tests}')
      ? opts.cmd.split('{tests}').join(rels.map(shQuote).join(' '))
      : opts.cmd;

    process.stdout.write(`red-on-base: base=${ctx.baseSha.slice(0, 12)} (merge-base of ${opts.base} and HEAD) head=${ctx.headSha.slice(0, 12)}\n`);
    process.stdout.write(`red-on-base: tests=${rels.join(' ')}\n`);
    process.stdout.write(`red-on-base: cmd=${command}${expectRe ? `  expect=/${opts.expect}/` : ''}\n`);

    const needsModules = fs.existsSync(path.join(root, 'package.json'));
    const nodeModules = needsModules ? findNodeModules(root) : null;
    if (needsModules && !nodeModules) {
      throw new Inconclusive('package.json present but no node_modules to link (install dependencies in the main checkout)');
    }

    const baseDir = addWorktree(root, ctx.baseSha, 'base', created);
    const headDir = addWorktree(root, ctx.headSha, 'head', created);
    for (const dir of [baseDir, headDir]) {
      if (!nodeModules) continue;
      const link = path.join(dir, 'node_modules');
      if (fs.existsSync(link)) continue;
      try { fs.symlinkSync(nodeModules, link, 'dir'); }
      catch (e) { throw new Inconclusive(`could not link node_modules into ${dir}: ${e.message}`); }
    }
    for (const rel of rels) {
      const blob = spawnSync('git', ['-C', root, 'show', `${ctx.headSha}:${rel}`]);
      if (blob.status !== 0) throw new Inconclusive(`could not read ${rel} at HEAD`);
      const dest = path.join(baseDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, blob.stdout);
    }

    const base = runSide('base', baseDir, command, opts.timeout, opts.verbose);
    if (expectRe) {
      const hits = base.output.split('\n').filter(l => expectRe.test(l)).slice(0, 3);
      for (const h of hits) process.stdout.write(`  base matches --expect: ${h.trim()}\n`);
      if (!hits.length && expectRe.test(base.output)) process.stdout.write('  base matches --expect (across lines)\n');
    }
    const headRun = runSide('head', headDir, command, opts.timeout, opts.verbose);

    const notRun = (side, r) => {
      if (r.timedOut) return `${side} run timed out after ${opts.timeout}s`;
      if (r.spawnError) return `${side} run could not start: ${r.spawnError}`;
      if (r.status == null) return `${side} run was killed (signal ${r.signal})`;
      if (r.status === 126 || r.status === 127) return `${side} command could not run (exit ${r.status}: not found or not executable)`;
      return null;
    };
    const setup = notRun('base', base) || notRun('head', headRun);
    if (setup) { finish('INCONCLUSIVE', setup, ctx); return; }
    if (base.status === 0) { finish('FAIL', 'base run passed: the test does not reproduce the bug without the fix', ctx); return; }
    if (headRun.status !== 0) { finish('FAIL', `head run failed (exit ${headRun.status}): the fix does not make the test pass`, ctx); return; }
    const loadError = LOAD_ERROR_RE.exec(base.output);
    if (loadError) {
      finish('INCONCLUSIVE', `base run failed because the test could not load (${loadError[0]}), not because it reproduced the bug: write the regression test against code that exists on base`, ctx);
      return;
    }
    if (expectRe && !expectRe.test(base.output)) {
      finish('INCONCLUSIVE', `base run failed, but its output does not match --expect /${opts.expect}/ (unrelated failure)`, ctx);
      return;
    }
    finish('PASS', `base red${expectRe ? ' for the expected reason' : ''} (exit ${base.status}), head green`, ctx);
  } catch (e) {
    if (e instanceof Inconclusive) finish('INCONCLUSIVE', e.message, ctx);
    else finish('INCONCLUSIVE', `setup error: ${e && e.message ? e.message : e}`, ctx);
  } finally {
    removeWorktrees(root, created);
  }
}

main();
