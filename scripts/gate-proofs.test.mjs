// Lauren 3-W: scripts/gate-proofs.mjs re-runs red-on-base proofs in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shellWords, parseRunArgs, parseRuleTable, main, ProofError, ALLOWED_CMDS, ciCommand } from './gate-proofs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const ROW1 = '| RT-01 | Gate grows a skip switch | #255 | `scripts/gate-pr.test.ts` | `d7471dd1` | `DRY_RUN\\|FAIL_AT\\|SKIP` |';
const ROW2 = '| RT-02 | Process left running | #259 | `scripts/red-on-base.test.mjs` | `3912a1dd` | `was still running` |';
const table = (...rows) => ['# AGENTS', '', '## 16. Rule Table — repeat mistakes', 'Prose with `\\|` and RT-01 mentioned.', '',
  '| ID | Mistake class | Encodes | ENFORCER | Proof-Fails-On | Expect |', '|---|---|---|---|---|---|', ...rows, '', '## 17. Next', '| other | table |'].join('\n');

test('shellWords reads the strict shell subset like bash', () => {
  assert.deepEqual(shellWords(`--test 'a b' c --expect "x\\(y\\) \\$z \\"q\\"" 'p''q' r"s"`), ['--test', 'a b', 'c', '--expect', 'x\\(y\\) $z "q"', 'pq', 'rs']);
  assert.deepEqual(shellWords('  --expect DRY_RUN  '), ['--expect', 'DRY_RUN']);
  for (const bad of ['a | tail', 'a > out', 'a; b', 'a && b', '$HOME', '"$X"', '"`id`"', 'a*', '{a,b}', 'a # c', "'open", '"open', 'a\\ b', '~/x']) {
    assert.throws(() => shellWords(bad), ProofError, bad);
  }
});

test('parseRunArgs mirrors red-on-base flags, allows only listed --cmd values', () => {
  const r = parseRunArgs(` --base origin/pe/x --test a.test.ts b.test.ts --cmd "bash scripts/red-on-base-db.sh {tests}" --expect 'boom|bang' --timeout 120 --verbose`);
  assert.deepEqual(r, { tests: ['a.test.ts', 'b.test.ts'], expect: 'boom|bang', cmd: 'bash scripts/red-on-base-db.sh {tests}', timeout: '120', pastedBase: 'origin/pe/x' });
  for (const cmd of ALLOWED_CMDS) assert.equal(parseRunArgs(`--test t --expect e --cmd '${cmd}'`).cmd, cmd);
  assert.throws(() => parseRunArgs('--test t --expect e --cmd "bash rob-cmd.sh {tests}"'), /not re-run in CI/);
  assert.throws(() => parseRunArgs('--test t --expect e --cmd "npx tsx --test {tests}; curl x"'), /not re-run in CI/);
  assert.throws(() => parseRunArgs('--test t'), /no --expect/);
  assert.throws(() => parseRunArgs('--expect e'), /no --test/);
  assert.throws(() => parseRunArgs('--test t --expect e --bogus'), /unsupported argument/);
  assert.throws(() => parseRunArgs('--test t --expect e --timeout 1e9'), /--timeout/);
});

test('an option-looking --test value is rejected, so it cannot become --base or --cmd once forwarded (Codex 3-W r1)', () => {
  // The two reproductions from the r1 review, verbatim in substance.
  assert.throws(() => parseRunArgs("--test scripts/gate-pr.test.ts --test '--base' d7471dd1 --expect 'DRY_RUN|FAIL_AT|SKIP'"), /not a plain repo-relative test path/);
  assert.throws(() => parseRunArgs("--test scripts/gate-pr.test.ts --test '--cmd' 'if true; then echo X; fi' --expect X"), /unsupported shell character|not a plain repo-relative/);
  assert.throws(() => parseRunArgs("--test scripts/gate-pr.test.ts --test '--cmd' 'echo_X' --expect X"), /not a plain repo-relative test path/);
  for (const bad of ['-x', '../a.test.ts', 'a/../../b.test.ts', '/abs/a.test.ts']) {
    assert.throws(() => parseRunArgs(`--test '${bad}' --expect e`), /not a plain repo-relative test path/, bad);
  }
});

test('the DB wrapper command runs this checkout\'s copy by absolute path; other commands pass through', () => {
  assert.equal(ciCommand('bash scripts/red-on-base-db.sh {tests}', '/w/r'), "bash '/w/r/scripts/red-on-base-db.sh' {tests}");
  assert.equal(ciCommand('bash scripts/red-on-base-db.sh {tests}', "/w/it's"), "bash '/w/it'\\''s/scripts/red-on-base-db.sh' {tests}");
  assert.equal(ciCommand('node --test {tests}', '/w/r'), 'node --test {tests}');
});

test('parseRuleTable reads the real AGENTS.md table and unescapes \\|', () => {
  const rows = parseRuleTable(AGENTS);
  assert.ok(rows.length >= 2);
  const rt1 = rows.find(r => r.id === 'RT-01');
  assert.deepEqual(rt1, { id: 'RT-01', enforcer: 'scripts/gate-pr.test.ts', proof: 'd7471dd1', expect: 'DRY_RUN|FAIL_AT|SKIP' });
  assert.deepEqual(parseRuleTable(table(ROW1, ROW2)).map(r => r.id), ['RT-01', 'RT-02']);
});

test('parseRuleTable fails closed instead of skipping a row', () => {
  const cases = {
    'none row': table(ROW1, '| RT-03 | x | y | none | `abcdef1` | `e` |'),
    'row without edge pipes': table(ROW1, 'RT-03 | x | y | `a.test.ts` | `abcdef1` | `e`'),
    'row after a blank line': table(ROW1, '', ROW2),
    'second table in the section': table(ROW1) .replace('## 17. Next', '| ID | x |\n|---|---|\n| RT-09 | y |\n\n## 17. Next'),
    'bad sha': table('| RT-03 | x | y | `a.test.ts` | `main` | `e` |'),
    'two sha-like words': table('| RT-03 | x | y | `a.test.ts` | `abcdef1` `abcdef2` | `e` |'),
    'path escaping the repo': table('| RT-03 | x | y | `../a.test.ts` | `abcdef1` | `e` |'),
    'unbackticked expect': table('| RT-03 | x | y | `a.test.ts` | `abcdef1` | e |'),
    'bad regex': table('| RT-03 | x | y | `a.test.ts` | `abcdef1` | `(` |'),
    'duplicate id': table(ROW1, ROW1),
    'extra cell': table('| RT-03 | x | y | `a.test.ts` | `abcdef1` | `e` | z |'),
    'no rows': table(),
    'two sections': `${table(ROW1)}\n## Rule Table\n${ROW2}`,
    'no section': '# AGENTS\n\nnothing',
    'wrong header': table(ROW1).replace('| Expect |', '| Expected |'),
  };
  for (const [name, md] of Object.entries(cases)) assert.throws(() => parseRuleTable(md), ProofError, name);
});

// main() with a stubbed red-on-base: what CI runs, and what fails the gate.
function stubIo(verdicts) {
  const calls = [];
  const out = [];
  return {
    calls, out,
    io: {
      log: s => out.push(s), err: s => out.push(s), exit: c => c,
      spawn: (cmd, args) => {
        calls.push(args.slice(1));
        const v = verdicts.length > 1 ? verdicts.shift() : verdicts[0];
        const code = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2 }[v];
        return { status: code, stdout: `reason: stub\nRED-ON-BASE: ${v} base=aaaaaaaaaaaa head=bbbbbbbbbbbb tests=1\n`, stderr: '' };
      },
    },
  };
}
const tmpBody = text => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-proofs-')), 'body.md'); fs.writeFileSync(f, text); return f; };
const FIX_BODY = (cmdArgs, summary = 'RED-ON-BASE: PASS base=c81c08495164 head=f69b4642a092 tests=1') => [
  '## Summary', 'Fix: the balance check.', '', '## Verification', 'Red-On-Base: PASS', '```',
  `$ node scripts/red-on-base.mjs ${cmdArgs}`, 'reason: base red for the expected reason (exit 1), head green', summary, '```', ''].join('\n');
const ruleRows = parseRuleTable(AGENTS).length;

test('a PR that is not a bug fix re-runs only the Rule Table rows, each from its own cells', () => {
  const s = stubIo(['PASS']);
  const code = main(['--base', 'origin/main', '--pr-body-file', tmpBody('## Verification\n```\n$ npm test\nok\n```\n'), '--pr-title', 'ci: x'], s.io);
  assert.equal(code, 0);
  assert.equal(s.calls.length, ruleRows);
  assert.deepEqual(s.calls[0], ['--base', 'd7471dd1', '--test', 'scripts/gate-pr.test.ts', '--expect', 'DRY_RUN|FAIL_AT|SKIP']);
  assert.ok(s.out.some(l => /not a bug-fix PR/.test(l)));
});

test('a bug-fix PR re-runs its pasted proof against the gate base, not the pasted base', () => {
  const s = stubIo(['PASS']);
  const body = tmpBody(FIX_BODY(`--base origin/pe/old --test src/server/x.integration.test.ts --cmd "bash scripts/red-on-base-db.sh {tests}" --expect "current outstanding balance above"`));
  assert.equal(main(['--base', 'abc1234', '--pr-body-file', body, '--pr-title', 'fix: x'], s.io), 0);
  assert.deepEqual(s.calls.at(-1), ['--base', 'abc1234', '--test', 'src/server/x.integration.test.ts', '--expect', 'current outstanding balance above', '--cmd', `bash '${path.join(ROOT, 'scripts/red-on-base-db.sh')}' {tests}`]);
  assert.ok(s.out.some(l => /pasted --base origin\/pe\/old replaced by abc1234/.test(l)));
});

test('a pasted PASS does not count when the CI re-run is FAIL or INCONCLUSIVE', () => {
  for (const v of ['FAIL', 'INCONCLUSIVE']) {
    const verdicts = Array(ruleRows).fill('PASS').concat([v]);
    const s = stubIo(verdicts);
    const code = main(['--base', 'origin/main', '--pr-body-file', tmpBody(FIX_BODY(`--test a.test.ts --expect boom`)), '--pr-title', 'fix: x'], s.io);
    assert.equal(code, 1, v);
    assert.ok(s.out.some(l => new RegExp(`^FAIL pr-run-1: RED-ON-BASE: ${v}`).test(l)), v);
  }
});

test('a failing Rule Table row fails the gate even for a PR that is not a bug fix', () => {
  const s = stubIo(['INCONCLUSIVE', 'PASS']);
  assert.equal(main(['--base', 'origin/main', '--pr-body-file', tmpBody(''), '--pr-title', 'docs: x'], s.io), 1);
  assert.ok(s.out.some(l => /^FAIL RT-01: RED-ON-BASE: INCONCLUSIVE/.test(l)));
});

test('missing or unusable bug-fix evidence fails without running anything for the PR', () => {
  const cases = [
    ['no pasted run', '## Verification\nRed-On-Base: PASS\n```\n$ npm test\nok\n```\n', /no pasted red-on-base run/],
    ['pasted run whose last summary is not PASS', FIX_BODY('--test a.test.ts --expect boom', 'RED-ON-BASE: INCONCLUSIVE base=c81c08495164 head=f69b4642a092 tests=1'), /no pasted red-on-base run/],
    ['untracked --cmd script', FIX_BODY('--test a.test.ts --cmd "bash rob-cmd.sh {tests}" --expect boom'), /not re-run in CI/],
    ['shell pipe', FIX_BODY('--test a.test.ts --expect boom 2>&1 | tail -3'), /unsupported shell character/],
  ];
  for (const [name, text, re] of cases) {
    const s = stubIo(['PASS']);
    assert.equal(main(['--base', 'origin/main', '--pr-body-file', tmpBody(text), '--pr-title', 'fix: x'], s.io), 1, name);
    assert.equal(s.calls.length, ruleRows, name);
    assert.ok(s.out.some(l => re.test(l)), name);
  }
});

// Real red-on-base in a throwaway repository: a bug commit, a fix commit with
// its regression test, and copies of the three scripts.
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
test('end to end: a real fix passes; a pasted PASS for a test that is green on base fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-proofs-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'scripts'));
  for (const f of ['gate-proofs.mjs', 'check-pr-rules.mjs', 'red-on-base.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
  fs.writeFileSync(path.join(dir, 'add.mjs'), 'export const add = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# A\n');
  // package.json + node_modules: red-on-base links them into its worktrees, so the
  // Rule Table row's default `npx tsx --test` resolves tsx locally (no download).
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module","private":true}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'bug');
  const bug = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'add.mjs'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(dir, 'add.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.mjs';\ntest('add', () => assert.equal(add(2, 2), 4, 'add is broken'));\n");
  fs.writeFileSync(path.join(dir, 'other.test.mjs'), "import { test } from 'node:test';\ntest('fine', () => {});\n");
  // Stand-in for scripts/red-on-base-db.sh (no database here): it runs the tests
  // in its current directory, the side's checkout.
  fs.writeFileSync(path.join(dir, 'scripts', 'red-on-base-db.sh'), '#!/usr/bin/env bash\n[ -f add.mjs ] || exit 3\nexec node --test "$@"\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), table(`| RT-01 | add subtracts | #1 | \`add.test.mjs\` | \`${bug.slice(0, 8)}\` | \`add is broken\` |`));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'fix');
  const run = text => spawnSync(process.execPath, ['scripts/gate-proofs.mjs', '--base', bug, '--pr-body-file', tmpBody(text), '--pr-title', 'fix: add'], { cwd: dir, encoding: 'utf8' });
  const good = run(FIX_BODY(`--test add.test.mjs --cmd 'node --test {tests}' --expect 'add is broken'`));
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /PASS RT-01: RED-ON-BASE: PASS/);
  assert.match(good.stdout, /PASS pr-run-1: RED-ON-BASE: PASS/);
  const faked = run(FIX_BODY(`--test other.test.mjs --cmd 'node --test {tests}' --expect 'fine'`));
  assert.equal(faked.status, 1, faked.stdout + faked.stderr);
  assert.match(faked.stdout, /FAIL pr-run-1: RED-ON-BASE: FAIL/);
  const wrongReason = run(FIX_BODY(`--test add.test.mjs --cmd 'node --test {tests}' --expect 'not what fails'`));
  assert.equal(wrongReason.status, 1);
  assert.match(wrongReason.stdout, /FAIL pr-run-1: RED-ON-BASE: INCONCLUSIVE/);
  // Two test files are forwarded as two --test flags.
  const two = run(FIX_BODY(`--test add.test.mjs other.test.mjs --cmd 'node --test {tests}' --expect 'add is broken'`));
  assert.equal(two.status, 0, two.stdout + two.stderr);
  assert.match(two.stdout, /--test add\.test\.mjs --test other\.test\.mjs/);
  // The DB wrapper exists only in the fix commit (base predates it, as with 3-W
  // itself): CI runs head's copy in the base checkout, against base's code.
  const wrapped = run(FIX_BODY(`--test add.test.mjs --cmd "bash scripts/red-on-base-db.sh {tests}" --expect 'add is broken'`));
  assert.equal(wrapped.status, 0, wrapped.stdout + wrapped.stderr);
  assert.match(wrapped.stdout, /PASS pr-run-1: RED-ON-BASE: PASS/);
  // PASS needs base red for the expected reason: base's own add.mjs ran (a
  // missing wrapper would be exit 127, an inconclusive verdict).
  assert.match(wrapped.stdout, /base: exit=1/);
});
