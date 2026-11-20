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
//              reason the test is expected to fail without the fix. REQUIRED for
//              PASS: a nonzero base exit alone does not show the regression test
//              ran and failed (the command may have failed before it). Pick text
//              only the failure prints, e.g. the assertion message; a regex that
//              also matches the passing head output is rejected as too broad.
//   --base     ref to diff against; the base checkout is merge-base(<base>, HEAD).
//              Default: origin/main.
//   --timeout  per-run limit in seconds. Default: 600. On timeout the run's
//              whole process group gets TERM, then KILL after a short grace,
//              even if the shell itself has already exited. After every run
//              the group is KILLed and must be empty before the verdict; a
//              process that left the group (setsid, a daemon) is not tracked.
//
// What it does:
//   1. Resolves HEAD and merge-base(<base>, HEAD). Only committed code is used:
//      uncommitted edits are ignored, so the SHAs printed are exactly what ran.
//   2. Creates two temporary git worktrees (detached): base at the merge-base,
//      head at HEAD. Links node_modules into each from this checkout (or the
//      main worktree), the same way our worktrees share node_modules.
//   3. Copies the HEAD version of each --test file into the base worktree, and
//      nothing else, then runs --cmd there. Then runs --cmd in the head worktree.
//      The copy never follows symlinks: every parent directory must be a real
//      directory inside the base worktree (else INCONCLUSIVE), and a symlink at
//      the destination is unlinked (the link, not its target) before writing.
//   4. Removes both worktrees with `git worktree remove --force`, also after a
//      timeout, an error, or SIGINT/SIGTERM/SIGHUP to this script.
//
// Verdicts (last line: `RED-ON-BASE: <VERDICT> base=<sha> head=<sha> tests=<n>`):
//   PASS          exit 0  base run fails for the expected reason AND head run passes.
//   FAIL          exit 1  base run passes (the test proves nothing), or head run fails.
//   INCONCLUSIVE  exit 2  not proof either way: bad arguments, unknown ref, a test
//                         file missing at HEAD, worktree/node_modules setup failure,
//                         a test path that would be written through a symlink, a
//                         timeout or killed run, a run whose process group is
//                         still not empty after SIGKILL, a command that cannot start
//                         (exit 126/127), or a base failure without affirmative
//                         evidence that the regression test failed: no --expect,
//                         output showing the test could not load (missing module
//                         or export, failed transform; even if --expect names it),
//                         output not matching --expect, or an --expect that also
//                         matches the passing head output.
//   Precedence: setup/timeouts > base passes (FAIL) > head fails (FAIL) >
//   base failure without that evidence (INCONCLUSIVE) > PASS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_CMD = 'npx tsx --test {tests}';
// The test could not even load on base. A generic SyntaxError is not listed:
// it can be the bug itself (e.g. a JSON.parse regression).
const LOAD_ERROR_RE = /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package|does not provide an export named|ERR_UNKNOWN_FILE_EXTENSION|Transform failed with \d+ error/;
const TAIL_LINES = 15;
const KILL_GRACE_MS = 2000; // TERM -> KILL escalation after a timeout
const GROUP_EMPTY_WAIT_MS = 5000; // how long a KILLed process group may take to empty

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

// Cleanup state shared with the signal handlers.
const state = { root: null, created: [], pgid: null, finished: false, interrupting: false };

function finish(verdict, reason, ctx) {
  if (state.finished) return;
  state.finished = true;
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
  while (created.length) {
    const dir = created.shift();
    const r = git(root, ['worktree', 'remove', '--force', dir]);
    if (!r.ok) process.stderr.write(`red-on-base: warning: could not remove worktree ${dir}: ${r.err}\n`);
  }
  git(root, ['worktree', 'prune']);
}

// Write the HEAD bytes of <rel> into the base worktree without following any
// symlink the base commit may have at that path or above it.
function copyIntoBase(baseDir, rel, bytes) {
  const parts = rel.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Inconclusive(`refusing unusual test path: ${rel}`);
  let dir = baseDir;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    let st = null;
    try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st === null) { fs.mkdirSync(dir); continue; }
    if (!st.isDirectory()) {
      throw new Inconclusive(`refusing to copy ${rel}: ${path.relative(baseDir, dir)} is a ${st.isSymbolicLink() ? 'symlink' : 'non-directory'} in the base worktree`);
    }
  }
  const dest = path.join(dir, parts[parts.length - 1]);
  const realBase = fs.realpathSync(baseDir);
  const realParent = fs.realpathSync(dir);
  if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) {
    throw new Inconclusive(`refusing to copy ${rel}: it resolves outside the base worktree`);
  }
  let st = null;
  try { st = fs.lstatSync(dest); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && st.isDirectory()) throw new Inconclusive(`refusing to copy ${rel}: it is a directory in the base worktree`);
  if (st) fs.unlinkSync(dest); // a symlink is removed itself, never followed
  fs.writeFileSync(dest, bytes, { flag: 'wx' }); // exclusive create: never through a link
}

function killGroup(pgid, signal) {
  try { process.kill(-pgid, signal); return true; } catch { return false; /* group already gone */ }
}
const groupAlive = pgid => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// SIGKILL the whole group, then wait until no process is left in it. Returns
// false if something in the group is still alive after GROUP_EMPTY_WAIT_MS.
async function emptyGroup(pgid) {
  const deadline = Date.now() + GROUP_EMPTY_WAIT_MS;
  while (groupAlive(pgid)) {
    killGroup(pgid, 'SIGKILL');
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

// Runs the command in its own process group so a timeout can stop the whole
// tree: TERM to the group, then KILL after KILL_GRACE_MS. The KILL is sent when
// the grace ends whether or not the shell itself has already exited (Codex r2:
// a TERM-ignoring background descendant must not outlive the run). Every run,
// timed out or not, ends with a group-wide KILL and a check that the group is
// empty before the result is used, so no descendant that stayed in the group
// survives the verdict or the worktree removal.
function runSide(label, cwd, command, timeoutSec, verbose) {
  return new Promise(resolve => {
    const started = Date.now();
    // A standalone test run: drop node:test's parent-runner marker so a nested
    // `node --test` (e.g. when this script itself runs under a test) really runs.
    const env = { ...process.env, RED_ON_BASE_SIDE: label };
    delete env.NODE_TEST_CONTEXT;
    let output = '';
    let timedOut = false;
    let spawnError = null;
    let closed = null; // { status, signal } once the shell is gone and its pipes are closed
    let escalated = false; // the timeout's KILL has been sent (or no timeout happened)
    let finishing = false;
    const timers = [];
    const child = spawn('bash', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const pgid = child.pid;
    state.pgid = pgid;
    const collect = chunk => { if (output.length < 64 * 1024 * 1024) output += chunk.toString('utf8'); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const maybeDone = async () => {
      if (finishing || closed === null || (timedOut && !escalated)) return;
      finishing = true;
      for (const t of timers) clearTimeout(t);
      const leftovers = pgid != null && groupAlive(pgid);
      const groupEmpty = pgid == null ? true : await emptyGroup(pgid);
      if (groupEmpty) state.pgid = null;
      const { status, signal } = closed;
      if (!state.interrupting) {
        const ms = Date.now() - started;
        process.stdout.write(`--- ${label}: exit=${status == null ? `signal ${signal || 'none'}` : status}${timedOut ? ' (timeout)' : ''} ${ms}ms\n`);
        if (leftovers) process.stdout.write(`--- ${label}: ${groupEmpty ? 'killed' : 'could not kill'} processes left in the run's process group\n`);
        const shown = verbose ? output.replace(/\s+$/, '').split('\n') : tail(output, TAIL_LINES);
        for (const line of shown) process.stdout.write(`  | ${line}\n`);
      }
      resolve({ status, signal, timedOut, spawnError, output, groupEmpty });
    };
    child.on('error', e => { spawnError = e.message; if (closed === null) closed = { status: null, signal: null }; maybeDone(); });
    child.on('close', (status, signal) => { if (closed === null) closed = { status, signal }; maybeDone(); });
    timers.push(setTimeout(() => {
      timedOut = true;
      killGroup(pgid, 'SIGTERM');
      // Not cancelled by the shell's close: the grace always ends in a group KILL.
      setTimeout(() => {
        killGroup(pgid, 'SIGKILL');
        escalated = true;
        // If something outside the group still holds the pipes, stop waiting.
        timers.push(setTimeout(() => {
          child.stdout.destroy(); child.stderr.destroy();
          if (closed === null) closed = { status: null, signal: 'SIGKILL' };
          maybeDone();
        }, KILL_GRACE_MS));
        maybeDone();
      }, KILL_GRACE_MS);
    }, timeoutSec * 1000));
  });
}

// Ctrl-C or a kill of this script: stop the running command and still remove
// the temporary worktrees.
async function onSignal(sig) {
  if (state.interrupting) return;
  state.interrupting = true;
  finish('INCONCLUSIVE', `interrupted by ${sig}`, {});
  if (state.pgid != null) await emptyGroup(state.pgid);
  if (state.root) removeWorktrees(state.root, state.created);
  process.exit(VERDICT_EXIT.INCONCLUSIVE);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => onSignal(sig));

async function main() {
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
    const end = src.findIndex(l => l.startsWith('import '));
    process.stdout.write(src.slice(1, end).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
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
  state.root = root;

  const created = state.created;
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
      copyIntoBase(baseDir, rel, blob.stdout);
    }

    const notRun = (side, r) => {
      if (r.groupEmpty === false) return `${side} run left processes in its process group that survived SIGKILL`;
      if (r.timedOut) return `${side} run timed out after ${opts.timeout}s (process group stopped)`;
      if (r.spawnError) return `${side} run could not start: ${r.spawnError}`;
      if (r.status == null) return `${side} run was killed (signal ${r.signal})`;
      if (r.status === 126 || r.status === 127) return `${side} command could not run (exit ${r.status}: not found or not executable)`;
      return null;
    };
    const base = await runSide('base', baseDir, command, opts.timeout, opts.verbose);
    if (state.interrupting) return;
    const baseNotRun = notRun('base', base);
    if (baseNotRun) { finish('INCONCLUSIVE', baseNotRun, ctx); return; }
    if (expectRe) {
      const hits = base.output.split('\n').filter(l => expectRe.test(l)).slice(0, 3);
      for (const h of hits) process.stdout.write(`  base matches --expect: ${h.trim()}\n`);
      if (!hits.length && expectRe.test(base.output)) process.stdout.write('  base matches --expect (across lines)\n');
    }
    const headRun = await runSide('head', headDir, command, opts.timeout, opts.verbose);
    if (state.interrupting) return;
    const headNotRun = notRun('head', headRun);
    if (headNotRun) { finish('INCONCLUSIVE', headNotRun, ctx); return; }
    if (base.status === 0) { finish('FAIL', 'base run passed: the test does not reproduce the bug without the fix', ctx); return; }
    if (headRun.status !== 0) { finish('FAIL', `head run failed (exit ${headRun.status}): the fix does not make the test pass`, ctx); return; }
    const loadError = LOAD_ERROR_RE.exec(base.output);
    if (loadError) {
      finish('INCONCLUSIVE', `base run failed because the test could not load (${loadError[0]}), not because it reproduced the bug: write the regression test against code that exists on base`, ctx);
      return;
    }
    if (!expectRe) {
      finish('INCONCLUSIVE', `base run failed (exit ${base.status}) and head passed, but without --expect nothing shows the regression test itself failed on base: pass --expect '<failure reason>'`, ctx);
      return;
    }
    if (!expectRe.test(base.output)) {
      finish('INCONCLUSIVE', `base run failed, but its output does not match --expect /${opts.expect}/ (unrelated failure)`, ctx);
      return;
    }
    if (expectRe.test(headRun.output)) {
      finish('INCONCLUSIVE', `--expect /${opts.expect}/ also matches the passing head output, so it does not identify the failure: use text only the failure prints`, ctx);
      return;
    }
    finish('PASS', `base red for the expected reason (exit ${base.status}), head green`, ctx);
  } catch (e) {
    if (e instanceof Inconclusive) finish('INCONCLUSIVE', e.message, ctx);
    else finish('INCONCLUSIVE', `setup error: ${e && e.message ? e.message : e}`, ctx);
  } finally {
    if (!state.interrupting) removeWorktrees(root, created);
  }
}

main().catch(e => finish('INCONCLUSIVE', `setup error: ${e && e.message ? e.message : e}`, {}));
