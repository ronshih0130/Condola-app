#!/usr/bin/env node
// check-pr-rules.mjs — enforce R2 (no silent test-assertion changes), R3
// (typecheck + unit tests pass) and R4 (the PR body carries `## Verification`
// evidence; bug fixes carry red-on-base proof). Runnable locally and in CI.
// No extra deps. R4 is documented next to its code below.
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
      case '--pr-title': out.prTitle = argv[++i]; break;
      case '--r2-only': out.r2Only = true; break;
      case '--r3-only': out.r3Only = true; break;
      case '--r4-only': out.r4Only = true; break;
      case '--no-r3': out.noR3 = true; break;
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
    '  [--pr-body <text>] [--pr-body-file <path>] [--pr-title <text>]\n' +
    '  [--diff-file <path>] [--r2-only | --r3-only | --r4-only | --no-r3]\n' +
    'With no rule flag, R2, R3 and R4 all run. --no-r3 runs every rule except\n' +
    'R3 (gate:pr runs typecheck and test:unit as its own steps).\n'
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

// PR title: only used by R4 to spot a `fix:` conventional-commit title. null
// means unknown (e.g. a local run before the PR exists); R4 then relies on the
// body alone.
function resolvePrTitle() {
  if (args.prTitle != null) return args.prTitle;
  if (process.env.PR_TITLE != null && process.env.PR_TITLE !== '') return process.env.PR_TITLE;
  const ev = readEvent();
  if (ev && ev.pull_request && typeof ev.pull_request.title === 'string') return ev.pull_request.title;
  return null;
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
// R4 — Verification evidence (Lauren item 3)
// ---------------------------------------------------------------------------
// The PR body must prove the change was run, not just describe it.
//
// Parsing: HTML comments (<!-- ... -->) outside fenced code blocks are dropped
// first, fences inside a comment included, so template hints never count. The
// Verification section starts at a `## Verification` heading (any case)
// outside a fence and runs to the next
// `#` or `##` heading outside a fence (### sub-headings and `# comments` inside
// code blocks stay in the section). Several such headings are read together.
//
// PASS needs all of:
//   1. the section exists;
//   2. at least one fenced code block (``` or ~~~) in it holds a command line
//      AND at least one output line. A command line starts with `$ ` or with
//      npm/npx/node/tsx/bash/git followed by an argument. An output line is any
//      other non-blank line. Placeholders do not count: a command containing a
//      `<like-this>` token, or an output line that is only `<...>`, `...`, `…`,
//      TODO, TBD or "paste output";
//   3. the word INCONCLUSIVE (upper case) appears nowhere in the section, in
//      prose or output: an INCONCLUSIVE verdict is not a PASS;
//   4. bug-fix PRs only (see below): a `Red-On-Base: PASS` line in the section,
//      no `Red-On-Base:` line with any other value, a fenced block in the
//      section with a line that invokes the runner itself —
//      `[$ ][VAR=x ]node [./]scripts/red-on-base.mjs ... --test <t> ... --expect <re>`
//      (an `echo red-on-base.mjs` does not count) — whose LAST `RED-ON-BASE:`
//      summary line after that invocation is exactly
//      `RED-ON-BASE: PASS base=<sha> head=<sha> tests=<n>` (n >= 1), and the
//      last `RED-ON-BASE:` summary anywhere in the section's code is that PASS
//      (an earlier FAIL is fine; a later FAIL is not). Pasted output is still
//      trusted text; CI (item 3-W) can re-run the proof.
//
// A PR is a bug fix when any of these holds:
//   a. the PR title (--pr-title, $PR_TITLE or the GitHub event) is a `fix`
//      conventional commit: `fix:`, `fix(scope):`, `fix!:` (any case);
//   b. the body's prose (outside comments and code blocks) has a line starting
//      `Fix:`, `Fixes:` or `Bug-Fix:` (any case) followed by text (an optional
//      list marker is allowed);
//   c. the body's prose has any `Red-On-Base:` line (exact case; the tool's
//      upper-case `RED-ON-BASE:` summary line in pasted output is not one).
// When the title is unknown (a local run before the PR exists), only b and c
// apply; CI passes the title.
const VERIFICATION_HEADING_RE = /^\s{0,3}##\s+verification\s*#*\s*$/i;
const SECTION_END_RE = /^\s{0,3}#{1,2}(?:\s|$)/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const COMMAND_RE = /^\s*(?:\$\s+\S|(?:npm|npx|node|tsx|bash|git)\s+\S)/;
const PLACEHOLDER_TOKEN_RE = /<[A-Za-z][^<>\n]*>/;
const PLACEHOLDER_LINE_RE = /^\s*(?:<[^<>]*>|\.{3}|…|todo|tbd|paste (?:the )?output(?: here)?)\s*$/i;
const INCONCLUSIVE_RE = /\bINCONCLUSIVE\b/;
const FIX_TITLE_RE = /^\s*fix(?:\([^)]*\))?!?:/i;
const FIX_LINE_RE = /^\s*(?:[-*]|\d+\.)?\s*(?:Fix|Fixes|Bug-Fix):\s*\S/im;
const RED_ON_BASE_LINE_RE = /^\s*(?:[-*]|\d+\.)?\s*`?Red-On-Base:\s*([^\s`]*)/; // exact case: the tool's own summary line is RED-ON-BASE:
const RED_ON_BASE_SUMMARY_RE = /^\s*RED-ON-BASE: PASS base=[0-9a-f]{7,40} head=[0-9a-f]{7,40} tests=[1-9]\d*\s*$/;
const RED_ON_BASE_ANY_SUMMARY_RE = /^\s*RED-ON-BASE:\s/;
// `$ node scripts/red-on-base.mjs <args>` (optional `$ `, env assignments, ./)
const RED_ON_BASE_INVOKE_RE = /^\s*(?:\$\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*node\s+(?:\.\/)?scripts\/red-on-base\.mjs(?=\s|$)(.*)$/;

// Drop HTML comments outside fenced code blocks. A comment hides everything up
// to its `-->`, fences included (as GitHub renders it); `<!--` inside a code
// block is literal text.
function stripHtmlComments(body) {
  const out = [];
  let fence = null;
  let inComment = false;
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      out.push(line);
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    let rest = line;
    let kept = '';
    for (;;) {
      if (inComment) {
        const close = rest.indexOf('-->');
        if (close === -1) { rest = ''; break; }
        rest = rest.slice(close + 3);
        inComment = false;
      }
      const open = rest.indexOf('<!--');
      if (open === -1) { kept += rest; break; }
      kept += rest.slice(0, open);
      rest = rest.slice(open + 4);
      inComment = true;
    }
    if (kept === '' && line !== '' && inComment) continue; // line wholly inside a comment
    const m = FENCE_RE.exec(kept);
    if (m) fence = m[1];
    out.push(kept);
  }
  return out.join('\n');
}

// Returns { found, lines, blocks } for the Verification section(s). blocks are
// arrays of the lines inside each fenced code block.
function verificationSection(cleanBody) {
  const lines = cleanBody.split('\n');
  const section = [];
  const blocks = [];
  let inSection = false;
  let found = false;
  let fence = null;
  let block = null;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
        fence = null;
        if (block) { blocks.push(block); block = null; }
      } else if (block) {
        block.push(line);
      }
      if (inSection) section.push(line);
      continue;
    }
    if (m) {
      fence = m[1];
      if (inSection) { section.push(line); block = []; }
      continue;
    }
    if (VERIFICATION_HEADING_RE.test(line)) { inSection = true; found = true; continue; }
    if (SECTION_END_RE.test(line)) { inSection = false; continue; }
    if (inSection) section.push(line);
  }
  if (block) blocks.push(block); // unterminated fence runs to the end
  return { found, lines: section, blocks };
}

function blockEvidence(block) {
  const commands = [];
  const output = [];
  for (const line of block) {
    if (!line.trim()) continue;
    if (COMMAND_RE.test(line)) {
      if (!PLACEHOLDER_TOKEN_RE.test(line)) commands.push(line.trim());
      continue;
    }
    if (!PLACEHOLDER_LINE_RE.test(line)) output.push(line);
  }
  return { commands, output, ok: commands.length > 0 && output.length > 0 };
}

// Lines of the (comment-free) body that sit outside fenced code blocks.
function proseLines(cleanBody) {
  const out = [];
  let fence = null;
  for (const line of cleanBody.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    out.push(line);
  }
  return out;
}

function isBugFix(cleanBody, title) {
  const reasons = [];
  const prose = proseLines(cleanBody);
  if (title != null && FIX_TITLE_RE.test(title)) reasons.push('title is a fix: conventional commit');
  if (FIX_LINE_RE.test(prose.join('\n'))) reasons.push('body has a Fix:/Fixes:/Bug-Fix: line');
  if (prose.some(l => RED_ON_BASE_LINE_RE.test(l))) reasons.push('body has a Red-On-Base: line');
  return reasons;
}

function checkVerification(body, title) {
  const clean = stripHtmlComments(body || '');
  const sec = verificationSection(clean);
  const problems = [];
  if (!sec.found) {
    return { pass: false, detail: 'PR body has no `## Verification` section', problems: ['add a `## Verification` section with the exact commands you ran and their pasted output'] };
  }
  const evidence = sec.blocks.map(blockEvidence);
  if (!evidence.some(e => e.ok)) {
    problems.push(sec.blocks.length === 0
      ? 'Verification has no fenced code block'
      : 'no fenced code block in Verification holds both a real command line (e.g. `$ npm run gate:pr`) and its pasted output (template placeholders do not count)');
  }
  if (sec.lines.some(l => INCONCLUSIVE_RE.test(l))) {
    problems.push('Verification reports INCONCLUSIVE: an INCONCLUSIVE verdict is not a PASS');
  }
  const fixReasons = isBugFix(clean, title);
  if (fixReasons.length) {
    const secProse = proseLines(sec.lines.join('\n'));
    const robLines = secProse.map(l => RED_ON_BASE_LINE_RE.exec(l)).filter(Boolean);
    const values = robLines.map(m => m[1]);
    if (!values.includes('PASS')) {
      problems.push(`bug-fix PR (${fixReasons.join('; ')}) needs a \`Red-On-Base: PASS\` line in Verification`);
    }
    const bad = values.filter(v => v !== 'PASS');
    if (bad.length) problems.push(`Red-On-Base: must be PASS, found: ${bad.map(v => v || '(empty)').join(', ')}`);
    // A block counts only if a line really invokes the runner (node
    // scripts/red-on-base.mjs --test ... --expect ...) and the last summary line
    // after that invocation in the block is a PASS.
    const pasted = sec.blocks.some(b => b.some((l, i) => {
      const m = RED_ON_BASE_INVOKE_RE.exec(l);
      if (!m || !/(?:^|\s)--test\s+\S/.test(m[1]) || !/(?:^|\s)--expect\s+\S/.test(m[1])) return false;
      const after = b.slice(i + 1).filter(x => RED_ON_BASE_ANY_SUMMARY_RE.test(x));
      return after.length > 0 && RED_ON_BASE_SUMMARY_RE.test(after[after.length - 1]);
    }));
    const summaries = sec.blocks.flat().filter(x => RED_ON_BASE_ANY_SUMMARY_RE.test(x));
    if (summaries.length && !RED_ON_BASE_SUMMARY_RE.test(summaries[summaries.length - 1])) {
      problems.push(`the last RED-ON-BASE summary in Verification is not a PASS: ${summaries[summaries.length - 1].trim()}`);
    }
    if (!pasted) {
      problems.push('bug-fix PR needs the pasted run of `node scripts/red-on-base.mjs --test <test> --expect <reason>` in a Verification code block, whose last summary line is `RED-ON-BASE: PASS base=<sha> head=<sha> tests=<n>`');
    }
  }
  if (problems.length) {
    return { pass: false, detail: `${problems.length} Verification problem(s)`, problems };
  }
  const n = evidence.filter(e => e.ok).length;
  return {
    pass: true,
    detail: `Verification has ${n} command block(s) with output${fixReasons.length ? '; bug fix with Red-On-Base: PASS' : ''}`,
  };
}

function runR4() {
  return checkVerification(resolvePrBody(), resolvePrTitle());
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const selectors = [
    ['--r2-only', args.r2Only], ['--r3-only', args.r3Only],
    ['--r4-only', args.r4Only], ['--no-r3', args.noR3],
  ].filter(([, on]) => on).map(([name]) => name);
  if (selectors.length > 1) {
    fail(`${selectors.join(' and ')} are mutually exclusive`);
  }

  const only = args.r2Only || args.r3Only || args.r4Only;
  const doR2 = only ? !!args.r2Only : true;
  const doR3 = only ? !!args.r3Only : !args.noR3;
  const doR4 = only ? !!args.r4Only : true;

  let r2Status = 'SKIP';
  let r3Status = 'SKIP';
  let r4Status = 'SKIP';
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

  if (doR4) {
    const res = runR4();
    r4Status = res.pass ? 'PASS' : 'FAIL';
    if (!res.pass) {
      ok = false;
      process.stderr.write(`\nR4 FAIL: ${res.detail}\n`);
      for (const p of res.problems) process.stderr.write(`  - ${p}\n`);
      process.stderr.write('See .github/pull_request_template.md and the R4 notes in scripts/check-pr-rules.mjs.\n\n');
    } else {
      process.stdout.write(`R4 OK: ${res.detail}\n`);
    }
  }

  process.stdout.write(`\nSummary: R2 ${r2Status}, R3 ${r3Status}, R4 ${r4Status}\n`);
  process.exit(ok ? 0 : 1);
}

main();
