// Lauren item 3: check-pr-rules R4 — the PR body must carry `## Verification` evidence (commands + pasted output),
// INCONCLUSIVE is never a PASS, and bug-fix PRs need `Red-On-Base: PASS` plus the pasted red-on-base.mjs run.
// The script runs main() on load, so these tests run it as a subprocess, like CI and gate:pr do.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "check-pr-rules-"));
let n = 0;
function rules(body, args = ["--r4-only"], env = {}) {
  const file = join(dir, `body-${n++}.md`);
  writeFileSync(file, body);
  const clean = { ...process.env };
  delete clean.PR_BODY; delete clean.PR_BODY_FILE; delete clean.PR_TITLE; delete clean.GITHUB_EVENT_PATH;
  const r = spawnSync("node", ["scripts/check-pr-rules.mjs", ...args, "--pr-body-file", file],
    { encoding: "utf8", env: { ...clean, ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
}
const FENCE = "```";
const block = (...lines) => [FENCE, ...lines, FENCE].join("\n");
const GATE = block("$ npm run gate:pr -- --pr-body-file .tmp/pr-body.md", "gate:pr PASS (typecheck, lint, check-pr-rules, test:unit) at abc1234");
const ROB_RUN = block(
  "$ node scripts/red-on-base.mjs --test src/server/x.test.ts --expect 'voided_by'",
  "reason: base red for the expected reason (exit 1), head green",
  "RED-ON-BASE: PASS base=0123456789ab head=ba9876543210 tests=1",
);
const body = (verification, extra = "") => `## Summary\nThing.\n${extra}\n## Verification\n${verification}\n\n## Review\n- Verdict: PASS\n`;

test("R4 passes a Verification section with a command and its pasted output", () => {
  const r = rules(body(GATE));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /R4 OK: Verification has 1 command block\(s\) with output/);
  assert.match(r.out, /Summary: R2 SKIP, R3 SKIP, R4 PASS/);
  // npm/node/npx form without a "$ " prompt also counts as a command line
  assert.equal(rules(body(block("npx tsx --test scripts/a.test.ts", "# pass 3"))).status, 0);
});

test("R4 fails when Verification is missing or empty", () => {
  for (const b of ["", "## Summary\nno verification here\n", body(""), body("Ran the tests, all good.")]) {
    const r = rules(b);
    assert.equal(r.status, 1, b);
    assert.match(r.out, /R4 FAIL/);
  }
  assert.match(rules("## Summary\n").out, /no `## Verification` section/);
  assert.match(rules(body("Ran it.")).out, /Verification has no fenced code block/);
  // a heading inside a code block elsewhere is not a Verification section
  assert.match(rules(`## Summary\n${block("## Verification", "$ npm test", "ok")}\n`).out, /no `## Verification` section/);
  // evidence under a later heading is outside the section
  assert.equal(rules(`## Verification\nsee below\n\n## Notes\n${GATE}\n`).status, 1);
});

test("R4 fails when Verification has only template placeholders, a command without output, or output without a command", () => {
  const template = readFileSync(".github/pull_request_template.md", "utf8");
  const t = rules(template);
  assert.equal(t.status, 1, "the unedited PR template must not pass R4");
  assert.match(t.out, /no fenced code block in Verification holds both a real command line/);
  for (const v of [
    block("$ npm run gate:pr -- --pr-body-file <path>", "<paste output>"),
    block("$ npm run gate:pr -- --pr-body-file <path>", "gate:pr PASS (typecheck, lint, check-pr-rules, test:unit) at abc1234"),
    block("$ npm run gate:pr", "<paste output>"),
    block("$ npm run gate:pr", "..."),
    block("$ npm run gate:pr"),
    block("all tests passed"),
    "<!--\n" + GATE + "\n-->",
  ]) {
    assert.equal(rules(body(v)).status, 1, v);
  }
  // shell comments inside the block do not end the section
  assert.equal(rules(body(block("# typecheck first", "$ npm run -s typecheck", "(no output: exit 0)"))).status, 0);
});

test("R4 fails when any verdict in Verification is inconclusive", () => {
  const inconclusive = block("$ node scripts/red-on-base.mjs --test a.test.ts", "RED-ON-BASE: INCONCLUSIVE base=0123456789ab head=ba9876543210 tests=1");
  let r = rules(body(`${GATE}\n${inconclusive}`));
  assert.equal(r.status, 1);
  assert.match(r.out, /INCONCLUSIVE verdict is not a PASS/);
  r = rules(body(`${GATE}\nReviewer verdict: INCONCLUSIVE`));
  assert.equal(r.status, 1);
  // INCONCLUSIVE outside Verification (e.g. an explained demo section) is not a reported verdict there
  assert.equal(rules(body(GATE) + `\n## Notes\n${inconclusive}\n`).status, 0);
  // lower-case prose is not a verdict, so this suite's own test titles can be pasted from test:unit output
  assert.equal(rules(body(block("$ npm run -s test:unit", "ok 4 - inconclusive (exit 2): missing test file"))).status, 0);
});

test("no test title in this repo's unit suites contains the upper-case R4 verdict word, so pasted test:unit output never trips R4", () => {
  const word = ["INCONCLU", "SIVE"].join("");
  for (const f of ["scripts/red-on-base.test.mjs", "scripts/check-pr-rules.test.mjs", "scripts/gate-pr.test.ts"]) {
    const titles = readFileSync(f, "utf8").match(/^test\("[^"]*"/gm) || [];
    assert.ok(titles.length > 0, f);
    for (const t of titles) assert.ok(!t.includes(word), `${f}: ${t}`);
  }
});

test("R4 bug-fix PRs need Red-On-Base: PASS and the pasted red-on-base.mjs run", () => {
  const good = body(`${GATE}\nRed-On-Base: PASS\n${ROB_RUN}`);
  // detection: fix: title, Fix: line, or a Red-On-Base: line
  const noProof = body(GATE);
  let r = rules(noProof, ["--r4-only", "--pr-title", "fix(b001): bind voided_by"]);
  assert.equal(r.status, 1);
  assert.match(r.out, /bug-fix PR \(title is a fix: conventional commit\) needs a `Red-On-Base: PASS` line/);
  assert.equal(rules(noProof, ["--r4-only"], { PR_TITLE: "fix: x" }).status, 1, "PR_TITLE env is read");
  assert.equal(rules(body(GATE, "Fix: voided_by was the service role\n")).status, 1);
  assert.equal(rules(body(`${GATE}\nRed-On-Base: PASS`)).status, 1, "line without the pasted run");
  assert.equal(rules(body(`${GATE}\n${ROB_RUN}`), ["--r4-only", "--pr-title", "fix: x"]).status, 1, "run without the line");
  assert.equal(rules(body(`${GATE}\nRed-On-Base: FAIL\n${ROB_RUN}`)).status, 1);
  assert.equal(rules(body(`${GATE}\nRed-On-Base: PASS\nRed-On-Base: FAIL\n${ROB_RUN}`)).status, 1);
  const zero = ROB_RUN.replace("tests=1", "tests=0");
  assert.equal(rules(body(`${GATE}\nRed-On-Base: PASS\n${zero}`)).status, 1, "tests=0 is not proof");

  r = rules(good, ["--r4-only", "--pr-title", "fix(b001): bind voided_by"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /bug fix with Red-On-Base: PASS/);
  assert.equal(rules(good).status, 0, "a Red-On-Base: line alone marks a bug fix and is satisfied");
  // not a bug fix: feat title, no Fix:/Red-On-Base: prose; the upper-case tool summary in output is not a declaration
  assert.equal(rules(body(GATE), ["--r4-only", "--pr-title", "feat: prefix fix"]).status, 0);
  assert.equal(rules(body(`${GATE}\n${block("$ git log -1 --format=%s", "fix: something")}`)).status, 0);
});

// Codex r1 SHOULD 4: the evidence must come from a real runner invocation, and its last verdict must be PASS.
test("R4 bug-fix evidence needs a real red-on-base.mjs invocation with --expect, and the last summary must be PASS", () => {
  const withRun = run => body(`${GATE}\nRed-On-Base: PASS\n${run}`);
  const PASS_LINE = "RED-ON-BASE: PASS base=0123456789ab head=ba9876543210 tests=1";
  const FAIL_LINE = "RED-ON-BASE: FAIL base=0123456789ab head=ba9876543210 tests=1";
  // reviewer reproduction: an echo that merely mentions the script name is not an invocation
  let r = rules(withRun(block("$ echo red-on-base.mjs", "RED-ON-BASE: PASS base=0123456 head=abcdef0 tests=1")));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /needs the pasted run of `node scripts\/red-on-base\.mjs/);
  // an echo of a full invocation is still not an invocation
  r = rules(withRun(block("$ echo node scripts/red-on-base.mjs --test a.test.ts --expect boom", PASS_LINE)));
  assert.equal(r.status, 1, r.out);
  // the run's own last summary must be PASS: a PASS pasted from elsewhere later does not rescue it
  assert.equal(rules(withRun(`${block("$ node scripts/red-on-base.mjs --test a.test.ts --expect boom", PASS_LINE, FAIL_LINE)}\n${block("$ cat old-run.log", PASS_LINE)}`)).status, 1);
  // reviewer reproduction: a PASS followed by a later FAIL
  r = rules(withRun(block("$ node scripts/red-on-base.mjs --test a.test.ts --expect boom", PASS_LINE, FAIL_LINE)));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /last RED-ON-BASE summary in Verification is not a PASS/);
  // ... also when the later FAIL is in a separate block
  assert.equal(rules(withRun(`${ROB_RUN}\n${block("$ node scripts/red-on-base.mjs --test a.test.ts --expect boom", FAIL_LINE)}`)).status, 1);
  // an invocation without --expect cannot have produced a PASS
  assert.equal(rules(withRun(block("$ node scripts/red-on-base.mjs --test a.test.ts", PASS_LINE))).status, 1);
  // trailing junk on the summary line is not the tool's summary
  assert.equal(rules(withRun(block("$ node scripts/red-on-base.mjs --test a.test.ts --expect boom", PASS_LINE + " (edited)"))).status, 1);
  // a FAIL first, then a fixed PASS run, is fine; so are ./ and env-prefixed invocations
  assert.equal(rules(withRun(block("$ node scripts/red-on-base.mjs --test a.test.ts --expect boom", FAIL_LINE, "$ CI=1 node ./scripts/red-on-base.mjs --test a.test.ts --expect boom", PASS_LINE))).status, 0);
});

test("rule selection: --r2-only and --r3-only keep their meaning, --no-r3 runs R2 + R4, selectors are exclusive", () => {
  const diff = join(dir, "empty.diff");
  writeFileSync(diff, "");
  let r = rules("", ["--r2-only", "--diff-file", diff]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Summary: R2 PASS, R3 SKIP, R4 SKIP/);
  r = rules("", ["--no-r3", "--diff-file", diff]);
  assert.equal(r.status, 1);
  assert.match(r.out, /Summary: R2 PASS, R3 SKIP, R4 FAIL/);
  r = rules(body(GATE), ["--no-r3", "--diff-file", diff]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Summary: R2 PASS, R3 SKIP, R4 PASS/);
  r = rules("", ["--r2-only", "--r3-only"]);
  assert.equal(r.status, 2);
  assert.match(r.out, /--r2-only and --r3-only are mutually exclusive/);
  assert.equal(rules("", ["--r4-only", "--no-r3"]).status, 2);
});

test("the PR template has the required sections and its hints never satisfy R2 (no Spec-Change: line)", () => {
  const template = readFileSync(".github/pull_request_template.md", "utf8");
  for (const h of ["## Summary", "## Story / AC", "## File ownership & merge order (RULES 7)", "## Verification", "## Review"]) {
    assert.ok(template.includes(`\n${h}\n`) || template.startsWith(`${h}\n`), h);
  }
  assert.match(template, /npm run gate:pr/);
  assert.match(template, /Red-On-Base: PASS/);
  const diff = join(dir, "assert.diff");
  writeFileSync(diff, [
    "diff --git a/src/a.test.ts b/src/a.test.ts", "--- a/src/a.test.ts", "+++ b/src/a.test.ts", "@@ -1,1 +1,1 @@",
    "-  assert.equal(x, 1);", "+  assert.equal(x, 2);", "",
  ].join("\n"));
  const r = rules(template, ["--r2-only", "--diff-file", diff]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /R2 FAIL/);
});
