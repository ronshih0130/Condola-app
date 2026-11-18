#!/usr/bin/env node
// check-pr-rules.mjs — enforce R2 (no silent test-assertion changes) and R3
// (typecheck + unit tests pass). Runnable locally and in CI. No extra deps.
//
// R2 assertion-mutation detection is a parenthesis-depth heuristic: an
// assertion call is opened when a line matches the assertion detector, and its
// depth is tracked across context (' ') and removed ('-') lines by counting
// parentheses so that argument-only edits of multiline assert/expect calls
// (e.g. a lone `-  200` inside `assert.strictEqual(\n ... \n)`) are still
// caught. It can miss unusual formatting (parens inside strings/comments), but
// argument-only edits of standard multiline assert/expect calls must be
// caught. For this to work the diff must carry context lines, so git diffs are
// generated with -U3; a --diff-file passed in at -U0 with no opener context
// for a multiline call cannot be fully analysed (the opener keyword is absent),
// so git-generated diffs from this script always include context.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--base': out.base = argv[++i]; break;
      case '--head': out.head = argv[++i]; break;
      case '--pr-body': out.prBody = argv[++i]; break;
      case '--pr-body-file': out.prBodyFile = argv[++i]; break;
      case '--diff-file': out.diffFile = argv[++i]; break;
      case '--r2-only': out.r2Only = true; break;
      case '--r3-only': out.r3Only = true; break;
      case '-h': case '--help': out.help = true; break;
      default: out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(
    'Usage: node scripts/check-pr-rules.mjs [--base <ref>] [--head <ref>]\n' +
    '  [--pr-body <text>] [--pr-body-file <path>] [--diff-file <path>]\n' +
    '  [--r2-only] [--r3-only]\n'
  );
  process.exit(0);
}

function fail(msg) {
  process.stderr.write(`check-pr-rules: ${msg}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
function git(gitArgs) {
  return spawnSync('git', ['-C', REPO_ROOT, ...gitArgs], { encoding: 'utf8' });
}

function refExists(ref) {
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.status === 0 && r.stdout.trim().length > 0;
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// base / head / pr body resolution
// ---------------------------------------------------------------------------
function resolveBase() {
  if (args.base) return args.base;
  const ev = readEvent();
  if (ev && ev.pull_request && ev.pull_request.base && ev.pull_request.base.sha) {
    return ev.pull_request.base.sha;
  }
  if (process.env.PR_BASE) return process.env.PR_BASE;
  return 'origin/main';
}

function resolveHead() {
  return args.head || 'HEAD';
}

function resolvePrBody() {
  if (args.prBody != null) return args.prBody;
  if (args.prBodyFile) {
    try { return fs.readFileSync(args.prBodyFile, 'utf8'); }
    catch (e) { fail(`cannot read --pr-body-file ${args.prBodyFile}: ${e.message}`); }
  }
  if (process.env.PR_BODY != null) return process.env.PR_BODY;
  if (process.env.PR_BODY_FILE) {
    try { return fs.readFileSync(process.env.PR_BODY_FILE, 'utf8'); }
    catch (e) { fail(`cannot read PR_BODY_FILE ${process.env.PR_BODY_FILE}: ${e.message}`); }
  }
  const ev = readEvent();
  if (ev) {
    if (ev.pull_request && typeof ev.pull_request.body === 'string') return ev.pull_request.body;
    if (ev.issue && typeof ev.issue.body === 'string') return ev.issue.body;
  }
  return ''; // missing body == empty
}

// ---------------------------------------------------------------------------
// diff acquisition
// ---------------------------------------------------------------------------
function getDiffFromGit(base, head) {
  if (!refExists(base)) {
    fail(`base ref "${base}" does not exist (set --base or PR_BASE, or fetch origin/main)`);
  }
  if (!refExists(head)) {
    fail(`head ref "${head}" does not exist`);
  }
  // Prefer triple-dot (merge-base) range; fall back to two-dot.
  // -U3: carry context lines so multiline assertion openers are visible even
  // when only an argument line is removed (see header note).
  let r = git(['diff', '--find-renames', '-U3', `${base}...${head}`, '--']);
  if (r.status === 0) return r.stdout;
  r = git(['diff', '--find-renames', '-U3', `${base}..${head}`, '--']);
  if (r.status === 0) return r.stdout;
  fail(`git diff failed for ${base}...${head} and ${base}..${head}: ${(r.stderr || '').trim()}`);
}

function getDiff(base, head) {
  if (args.diffFile) {
    try { return fs.readFileSync(args.diffFile, 'utf8'); }
    catch (e) { fail(`cannot read --diff-file ${args.diffFile}: ${e.message}`); }
  }
  return getDiffFromGit(base, head);
}

// ---------------------------------------------------------------------------
// diff parsing + R2 detection
// ---------------------------------------------------------------------------
function parseGitPath(raw) {
  let s = raw.trim();
  // strip trailing timestamp git sometimes appends after a tab
  const tab = s.indexOf('\t');
  if (tab !== -1) s = s.slice(0, tab);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1);
  }
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function isTestFile(p) {
  if (!p) return false;
  const base = p.split('/').pop() || '';
  if (/\.(test|spec)\.(cjs|mjs|js|jsx|ts|tsx)$/.test(p)) return true;
  if (base.includes('.test.') || base.includes('.spec.')) return true;
  return false;
}

const ASSERTION_RE = new RegExp([
  '\\bexpect\\(',
  '\\bassert\\(',
  '\\bassert\\.(equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual' +
    '|notDeepEqual|notDeepStrictEqual|ok|match|doesNotMatch|throws|doesNotThrow' +
    '|rejects|doesNotReject|fail|ifError|matchSnapshot)\\b',
  '\\.(toBe|toEqual|toStrictEqual|toMatch|toThrow|toHaveBeenCalled|toContain' +
    '|toBeTruthy|toBeFalsy|toBeNull|toBeDefined|toBeUndefined|toBeCloseTo' +
    '|toBeGreaterThan|toBeLessThan|toBeInstanceOf|toHaveLength|toMatchObject' +
    '|toMatchInlineSnapshot|toMatchSnapshot)\\b',
].join('|'));

function looksLikeAssertion(content) {
  const trimmed = content.replace(/^\s+/, '');
  // skip comment-only lines
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  ) return false;
  return ASSERTION_RE.test(content);
}

// Returns array of offending removed assertion lines in EXISTING test files.
function detectAssertionMutations(diffText) {
  const lines = diffText.split('\n');
  const offending = [];

  let currentFile = null;
  let oldFile = null; // path from the most recent '--- ' line
  let isTest = false;
  let isNew = false;
  let isBinary = false;
  let oldLineNo = 0;
  // Parenthesis depth of an open assertion call in the old-file stream
  // (context + removed lines). >0 means we are inside a multiline assertion.
  let assertDepth = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      oldFile = null;
      isTest = false;
      isNew = false;
      isBinary = false;
      oldLineNo = 0;
      assertDepth = 0;
      continue;
    }
    if (line.startsWith('new file mode ')) { isNew = true; continue; }
    if (line.startsWith('Binary files ')) { isBinary = true; continue; }
    if (line.startsWith('--- ')) {
      const raw = line.slice(4).trim();
      if (raw === '/dev/null') { isNew = true; oldFile = null; }
      else { oldFile = parseGitPath(raw); }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw === '/dev/null') {
        // Deleted file: '+++' is /dev/null but the file still had content in
        // the old tree. Keep tracking removals (incl. a wholesale test delete)
        // by taking the path from the '--- a/<file>' line; this is an edit of
        // the old file, not a new file.
        currentFile = oldFile;
        isTest = isTestFile(currentFile);
        isNew = false;
      } else {
        currentFile = parseGitPath(raw);
        isTest = isTestFile(currentFile);
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
      oldLineNo = m ? parseInt(m[1], 10) : 0;
      assertDepth = 0; // hunks are discontinuous in the old file
      continue;
    }

    if (!currentFile || !isTest || isBinary || isNew) {
      // still advance old line counter for context/removed lines so numbers
      // stay meaningful even in non-test files (cheap, harmless)
      if (line.startsWith(' ') || (line.startsWith('-') && !line.startsWith('--- '))) {
        oldLineNo++;
      }
      continue;
    }

    const isRemoved = line.startsWith('-') && !line.startsWith('--- ');
    const isContext = line.startsWith(' ');

    if (isRemoved || isContext) {
      const content = line.slice(1);
      const before = assertDepth;
      const inside = before > 0;
      const isOpener = before === 0 && looksLikeAssertion(content);

      // Track paren depth across context + removed lines once an assertion
      // call is open (or opens on this line). '+' lines never touch old-file
      // depth, so argument-only edits keep the opener's depth intact.
      if (inside || isOpener) {
        const open = (content.match(/\(/g) || []).length;
        const close = (content.match(/\)/g) || []).length;
        assertDepth = Math.max(0, before + open - close);
      }

      // A removed line is an R2 mutation if it is an assertion opener itself
      // or sits inside an unclosed assertion call (argument-only edit).
      if (isRemoved && (inside || isOpener)) {
        const excerpt = content.trim().slice(0, 140);
        offending.push({ file: currentFile, line: oldLineNo, excerpt });
      }

      oldLineNo++;
    }
    // '+' lines do not advance the old-file counter, do not change old-file
    // assertion depth, and are never R2 offenders
  }

  return offending;
}

const SPEC_CHANGE_RE = /^\s*(?:[-*]|\d+\.)?\s*Spec-Change:\s+\S+/m;

function runR2() {
  const base = resolveBase();
  const head = resolveHead();
  const diffText = getDiff(base, head);
  const offending = detectAssertionMutations(diffText);

  if (offending.length === 0) {
    return { pass: true, detail: 'no existing-test assertion changes' };
  }

  const body = resolvePrBody();
  if (SPEC_CHANGE_RE.test(body)) {
    return {
      pass: true,
      detail: `${offending.length} assertion change(s) allowed by Spec-Change:`,
    };
  }

  return {
    pass: false,
    detail: `${offending.length} existing-test assertion change(s) without a Spec-Change: line`,
    offending,
  };
}

// ---------------------------------------------------------------------------
// R3
// ---------------------------------------------------------------------------
function runNpm(scriptName) {
  const r = spawnSync('npm', ['run', scriptName], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (r.error) {
    process.stderr.write(`check-pr-rules: failed to run npm run ${scriptName}: ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status;
}

function runR3() {
  const tc = runNpm('typecheck');
  if (tc !== 0) return { pass: false, detail: `npm run typecheck exited ${tc}` };
  const tu = runNpm('test:unit');
  if (tu !== 0) return { pass: false, detail: `npm run test:unit exited ${tu}` };
  return { pass: true, detail: 'typecheck + test:unit passed' };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  if (args.r2Only && args.r3Only) {
    fail('--r2-only and --r3-only are mutually exclusive');
  }

  const doR2 = !args.r3Only;
  const doR3 = !args.r2Only;

  let r2Status = 'SKIP';
  let r3Status = 'SKIP';
  let ok = true;

  if (doR2) {
    const res = runR2();
    r2Status = res.pass ? 'PASS' : 'FAIL';
    if (!res.pass) {
      ok = false;
      process.stderr.write(`\nR2 FAIL: ${res.detail}\n`);
      process.stderr.write('Change an existing test assertion only with a `Spec-Change:` line in the PR body.\n');
      process.stderr.write('Offending removed assertions:\n');
      for (const o of res.offending) {
        process.stderr.write(`  ${o.file}:${o.line}: ${o.excerpt}\n`);
      }
      process.stderr.write('\n');
    } else {
      process.stdout.write(`R2 OK: ${res.detail}\n`);
    }
  }

  if (doR3) {
    const res = runR3();
    r3Status = res.pass ? 'PASS' : 'FAIL';
    if (!res.pass) {
      ok = false;
      process.stderr.write(`\nR3 FAIL: ${res.detail}\n`);
    } else {
      process.stdout.write(`R3 OK: ${res.detail}\n`);
    }
  }

  process.stdout.write(`\nSummary: R2 ${r2Status}, R3 ${r3Status}\n`);
  process.exit(ok ? 0 : 1);
}

main();
