#!/usr/bin/env node
// gate-proofs.mjs — Lauren 3-W: CI re-runs the red-on-base proofs instead of
// trusting pasted text. Runs in hosted CI (ci.yml) and the Mac shadow
// (ci-shadow.yml) as `npm run gate:proofs`, after the disposable database is up.
//
//   npm run gate:proofs [-- --base <ref>] [-- --pr-body-file <path>] [-- --pr-title <text>]
//
// The body and title come from the flags, else $PR_BODY_FILE / $PR_TITLE (CI
// writes them with scripts/ci-pr-context.mjs). --base defaults to origin/main.
//
// Two kinds of proof, each re-run with `node scripts/red-on-base.mjs`, which
// must end in `RED-ON-BASE: PASS`; FAIL and INCONCLUSIVE both fail this gate:
//
//   1. Rule Table rows (AGENTS.md, the one `## Rule Table` section): every row
//      runs `--base <Proof-Fails-On> --test <ENFORCER> --expect <Expect>`, the
//      table's `\|` read as `|`. Rows are parsed strictly; a row, or a line in
//      the table, that does not match the documented format fails the gate, so
//      no row is silently skipped. ENFORCER must be a file tracked at HEAD and
//      Proof-Fails-On a commit HEAD contains.
//
//   2. Bug-fix PRs (same detection as check-pr-rules R4): every pasted run R4
//      accepts (a red-on-base invocation followed by a PASS summary) is re-run.
//      Its arguments are read as shell words in a strict subset (plain words,
//      '...' and "..." with no $ or backquote); anything else fails the gate
//      rather than being guessed. --base is replaced by this gate's --base (the
//      PR's base in CI), so the proof is red on what the PR merges into. --cmd
//      must be one of ALLOWED_CMDS; integration tests use
//      `bash scripts/red-on-base-db.sh {tests}` (a fresh disposable database per
//      side, built from that side's own schema; CI runs this checkout's copy of
//      the wrapper on both sides, since base may predate it). Test values must
//      be plain repo-relative paths, forwarded one `--test` each. Env assignments before `node`
//      on the pasted line are not re-applied.
//
// A PR that is not a bug fix re-runs only the Rule Table. The re-run is the
// evidence: what CI ran is printed, and only its own verdict counts.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripHtmlComments, verificationSection, isBugFix, acceptedRedOnBaseRuns } from './check-pr-rules.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ProofError extends Error {}

export const ALLOWED_CMDS = [
  'npx tsx --test {tests}',
  'node --test {tests}',
  'bash scripts/red-on-base-db.sh {tests}',
];
// The DB wrapper is new in 3-W and red-on-base copies only test files into the
// base checkout, so CI runs THIS checkout's wrapper by absolute path on both
// sides; the wrapper works on its current directory (each side's own checkout,
// schema and seed), never on its own location (Codex 3-W r1).
const DB_CMD = 'bash scripts/red-on-base-db.sh {tests}';
const shQuote = s => `'${s.replace(/'/g, `'\\''`)}'`;
export function ciCommand(cmd, repoRoot = REPO_ROOT) {
  return cmd === DB_CMD ? `bash ${shQuote(path.join(repoRoot, 'scripts/red-on-base-db.sh'))} {tests}` : cmd;
}
// A test value must be a plain repo-relative path: an option-looking value
// (`--test '--base' x`) would be read as a runner option once forwarded.
const TEST_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

// Shell words, in a strict subset of bash: unquoted runs of safe characters,
// '...' (literal) and "..." (\ escapes only $ ` " \ as bash does; an unescaped
// $ or ` is rejected). Adjacent pieces join into one word, as in the shell.
const UNQUOTED_OK = /[A-Za-z0-9_./:=@%+,^-]/;
export function shellWords(text) {
  const words = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let word = '';
    while (i < n && !/\s/.test(text[i])) {
      const c = text[i];
      if (c === "'") {
        const j = text.indexOf("'", i + 1);
        if (j < 0) throw new ProofError('unterminated single quote');
        word += text.slice(i + 1, j);
        i = j + 1;
      } else if (c === '"') {
        i++;
        let closed = false;
        while (i < n) {
          const d = text[i];
          if (d === '"') { closed = true; i++; break; }
          if (d === '\\' && i + 1 < n && '$`"\\'.includes(text[i + 1])) { word += text[i + 1]; i += 2; continue; }
          if (d === '$' || d === '`') throw new ProofError(`unsupported ${d} inside double quotes (expansion is not re-run)`);
          word += d;
          i++;
        }
        if (!closed) throw new ProofError('unterminated double quote');
      } else if (UNQUOTED_OK.test(c)) {
        word += c;
        i++;
      } else {
        throw new ProofError(`unsupported shell character ${JSON.stringify(c)} outside quotes (pipes, redirects, globs, braces, comments and expansions are not re-run)`);
      }
    }
    words.push(word);
  }
  return words;
}

// The red-on-base arguments of one pasted run, mirroring red-on-base.mjs's own
// parser. Returns { tests, expect, cmd, timeout, pastedBase }.
export function parseRunArgs(argText) {
  const argv = shellWords(argText);
  const out = { tests: [], expect: undefined, cmd: undefined, timeout: undefined, pastedBase: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v == null) throw new ProofError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--test':
        out.tests.push(value());
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.tests.push(argv[++i]);
        for (const t of out.tests) {
          if (!TEST_PATH_RE.test(t) || t.split('/').includes('..')) throw new ProofError(`--test value ${JSON.stringify(t)} is not a plain repo-relative test path`);
        }
        break;
      case '--expect': out.expect = value(); break;
      case '--cmd': out.cmd = value(); break;
      case '--base': out.pastedBase = value(); break;
      case '--timeout': {
        const t = value();
        if (!/^[1-9]\d{0,3}$/.test(t)) throw new ProofError(`--timeout must be whole seconds (1-9999), got ${JSON.stringify(t)}`);
        out.timeout = t;
        break;
      }
      case '--verbose': break;
      default: throw new ProofError(`unsupported argument ${JSON.stringify(a)}`);
    }
  }
  if (!out.tests.length) throw new ProofError('no --test file');
  if (!out.expect) throw new ProofError('no --expect');
  if (out.cmd !== undefined && !ALLOWED_CMDS.includes(out.cmd)) {
    throw new ProofError(`--cmd ${JSON.stringify(out.cmd)} is not re-run in CI; use one of: ${ALLOWED_CMDS.map(c => JSON.stringify(c)).join(', ')}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule Table
// ---------------------------------------------------------------------------
const RULE_HEADING_RE = /^##\s+(?:\d+\.\s+)?Rule Table(?:\s|$)/;
const H2_RE = /^##\s/;
const HEADER = ['ID', 'Mistake class', 'Encodes', 'ENFORCER', 'Proof-Fails-On', 'Expect'];
const SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
const ID_RE = /^RT-\d{2,}$/;
const PATH_CELL_RE = /^`([A-Za-z0-9_][A-Za-z0-9_./-]*)`$/;
const SHA_CELL_RE = /^`([0-9a-f]{7,40})`$/;
const EXPECT_CELL_RE = /^`([^`]+)`$/;

// Cells of a `| a | b |` line: split on `|` not preceded by a backslash.
function cells(line) {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.endsWith('\\|')) return null;
  return t.slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim());
}

// Returns [{ id, enforcer, proof, expect }]. Throws ProofError on any line in
// the section that looks like table content but does not fit the format.
export function parseRuleTable(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const starts = lines.flatMap((l, i) => (RULE_HEADING_RE.test(l) ? [i] : []));
  if (starts.length !== 1) throw new ProofError(`AGENTS.md must have exactly one \`## Rule Table\` section, found ${starts.length}`);
  let end = lines.length;
  for (let i = starts[0] + 1; i < lines.length; i++) if (H2_RE.test(lines[i])) { end = i; break; }
  const section = lines.slice(starts[0] + 1, end);
  const pipeLines = section.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*\|/.test(l) || /\|\s*$/.test(l) || /(^|\|)\s*RT-\d/.test(l));
  const headerAt = section.findIndex(l => { const c = cells(l); return c && c.length === HEADER.length && c.every((x, k) => x === HEADER[k]); });
  if (headerAt < 0) throw new ProofError(`Rule Table header must be exactly | ${HEADER.join(' | ')} |`);
  const sep = cells(section[headerAt + 1] || '');
  if (!sep || sep.length !== HEADER.length || !sep.every(c => SEPARATOR_CELL_RE.test(c))) throw new ProofError('Rule Table header must be followed by its | --- | separator line');
  // The table block: every non-blank line after the separator, up to a blank line.
  const rows = [];
  let i = headerAt + 2;
  for (; i < section.length && section[i].trim() !== ''; i++) {
    const line = section[i];
    const c = cells(line);
    if (!c || c.length !== HEADER.length) throw new ProofError(`Rule Table line is not a 6-cell \`| ... |\` row: ${line.trim()}`);
    const [id, , , enf, proof, expect] = c;
    if (!ID_RE.test(id)) throw new ProofError(`Rule Table row has a bad ID ${JSON.stringify(id)}: ${line.trim()}`);
    const e = PATH_CELL_RE.exec(enf);
    if (!e || e[1].includes('..')) throw new ProofError(`${id}: ENFORCER must be one backticked repo path (rows with \`none\` are not allowed), got ${JSON.stringify(enf)}`);
    const p = SHA_CELL_RE.exec(proof);
    if (!p) throw new ProofError(`${id}: Proof-Fails-On must be one backticked commit SHA, got ${JSON.stringify(proof)}`);
    const x = EXPECT_CELL_RE.exec(expect);
    if (!x) throw new ProofError(`${id}: Expect must be one backticked regex, got ${JSON.stringify(expect)}`);
    const re = x[1].replace(/\\\|/g, '|');
    try { new RegExp(re); } catch (err) { throw new ProofError(`${id}: Expect is not a valid regex: ${err.message}`); }
    if (rows.some(r => r.id === id)) throw new ProofError(`${id}: duplicate ID`);
    rows.push({ id, enforcer: e[1], proof: p[1], expect: re });
  }
  // Nothing table-like may sit elsewhere in the section (a second table, or a
  // row split off by a blank line, would otherwise be skipped).
  const blockEnd = i;
  for (const { l, i: k } of pipeLines) {
    if (k < headerAt || k >= blockEnd) throw new ProofError(`table-like line outside the one Rule Table: ${l.trim()}`);
  }
  if (!rows.length) throw new ProofError('Rule Table has no rows');
  return rows;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------
function git(args) {
  return spawnSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
}

// Runs red-on-base with the given argv; returns { ok, verdict }.
function runRedOnBase(label, argv, io) {
  io.log(`\n== gate:proofs [${label}] node scripts/red-on-base.mjs ${argv.map(a => (/^[A-Za-z0-9_./:=@%+,^-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')}`);
  const r = io.spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/red-on-base.mjs'), ...argv]);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  io.log(out.replace(/\n$/, ''));
  const summaries = out.split('\n').filter(l => /^RED-ON-BASE:\s/.test(l));
  const last = summaries.length ? summaries[summaries.length - 1].trim() : '(no RED-ON-BASE summary)';
  const ok = r.status === 0 && /^RED-ON-BASE: PASS /.test(last);
  return { ok, verdict: last };
}

export function main(argv = process.argv.slice(2), io = defaultIo()) {
  const opts = { base: 'origin/main', bodyFile: process.env.PR_BODY_FILE || '', title: process.env.PR_TITLE ?? null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x == null) { io.err(`gate:proofs: ${a} needs a value`); io.exit(2); } return x; };
    if (a === '--base') opts.base = v();
    else if (a === '--pr-body-file') opts.bodyFile = v();
    else if (a === '--pr-title') opts.title = v();
    else { io.err(`gate:proofs: unknown argument ${a}`); return io.exit(2); }
  }
  const results = [];
  const fail = (label, why) => { results.push({ label, ok: false, verdict: why }); io.err(`gate:proofs [${label}] FAIL: ${why}`); };

  // 1. Rule Table rows.
  let rows = [];
  try {
    rows = parseRuleTable(fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8'));
  } catch (e) {
    if (!(e instanceof ProofError)) throw e;
    fail('rule-table', e.message);
  }
  for (const row of rows) {
    if (git(['ls-files', '--error-unmatch', '--', row.enforcer]).status !== 0) { fail(row.id, `ENFORCER ${row.enforcer} is not a file tracked at HEAD`); continue; }
    if (git(['merge-base', '--is-ancestor', row.proof, 'HEAD']).status !== 0) { fail(row.id, `Proof-Fails-On ${row.proof} is not a commit HEAD contains`); continue; }
    const r = runRedOnBase(row.id, ['--base', row.proof, '--test', row.enforcer, '--expect', row.expect], io);
    results.push({ label: row.id, ...r });
  }

  // 2. The PR's own bug-fix proofs.
  let body = '';
  if (opts.bodyFile) {
    try { body = fs.readFileSync(opts.bodyFile, 'utf8'); } catch (e) { fail('pr', `cannot read PR body file: ${e.message}`); }
  }
  const clean = stripHtmlComments(body);
  const fix = isBugFix(clean, opts.title);
  if (fix.length) {
    const runs = acceptedRedOnBaseRuns(verificationSection(clean).blocks);
    if (!runs.length) fail('pr', `bug-fix PR (${fix.join('; ')}) has no pasted red-on-base run with a PASS summary to re-run`);
    runs.forEach((run, k) => {
      const label = `pr-run-${k + 1}`;
      let parsed;
      try { parsed = parseRunArgs(run.argText); } catch (e) {
        if (!(e instanceof ProofError)) throw e;
        fail(label, `${e.message}; pasted: ${run.line}`);
        return;
      }
      if (parsed.pastedBase && parsed.pastedBase !== opts.base) io.log(`gate:proofs [${label}] note: pasted --base ${parsed.pastedBase} replaced by ${opts.base}`);
      // One --test per file and every value right after its flag, so no value
      // can be read as an option.
      const a = ['--base', opts.base, ...parsed.tests.flatMap(t => ['--test', t]), '--expect', parsed.expect];
      if (parsed.cmd) a.push('--cmd', ciCommand(parsed.cmd));
      if (parsed.timeout) a.push('--timeout', parsed.timeout);
      results.push({ label, ...runRedOnBase(label, a, io) });
    });
  } else {
    io.log('gate:proofs [pr] not a bug-fix PR: no PR proof to re-run');
  }

  io.log('\n== gate:proofs summary');
  for (const r of results) io.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.label}: ${r.verdict}`);
  const bad = results.filter(r => !r.ok);
  io.log(bad.length ? `gate:proofs FAIL (${bad.length} of ${results.length})` : `gate:proofs PASS (${results.length} proof(s) re-run)`);
  return io.exit(bad.length ? 1 : 0);
}

function defaultIo() {
  return {
    log: s => process.stdout.write(`${s}\n`),
    err: s => process.stderr.write(`${s}\n`),
    exit: c => process.exit(c),
    spawn: (cmd, args) => spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
