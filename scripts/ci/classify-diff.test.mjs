import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUTO_LABELS,
  classifyDiff,
  COPY_COMMENT_MARKER,
  planActions,
  renderCopyComment,
} from "./classify-diff.mjs";

const gate = fileURLToPath(new URL("./risk-gate.mjs", import.meta.url));

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function rulesOf(result) {
  return result.reasons.map((reason) => reason.rule);
}

const cases = [
  ["migration-added.diff", ["has-migration", "high-risk"], ["migration"], ["unclassified"]],
  ["migration-deleted.diff", ["has-migration", "high-risk"], ["migration"], ["unclassified"]],
  ["migration-renamed.diff", ["has-migration", "high-risk"], ["migration"], ["unclassified"]],
  ["unclassified-readme.diff", ["high-risk"], ["unclassified"], ["migration"]],
  ["pr-description-ignored.diff", ["high-risk"], ["unclassified"], ["migration"]],
  ["domain-logic.diff", ["high-risk"], ["unclassified"], ["migration"]],
  ["ci-script.diff", ["high-risk"], ["unclassified"], ["migration"]],
  ["i18n-plain.diff", ["copy-change"], [], ["promise-price", "unclassified"]],
  ["i18n-price.diff", ["copy-change", "high-risk"], ["promise-price"], ["unclassified"]],
  ["i18n-refund.diff", ["copy-change", "high-risk"], ["promise-refund"], ["unclassified"]],
  ["i18n-retention.diff", ["copy-change", "high-risk"], ["promise-retention"], ["unclassified"]],
  ["i18n-security.diff", ["copy-change", "high-risk"], ["promise-security"], ["unclassified"]],
  ["i18n-remove-price.diff", ["copy-change"], [], ["promise-price", "unclassified"]],
  ["i18n-allowlisted-phrase.diff", ["copy-change"], [], ["promise-price", "unclassified"]],
  ["sql-rls.diff", ["high-risk"], ["rls"], ["migration"]],
  ["sql-grant-definer.diff", ["high-risk"], ["grant-revoke", "security-definer"], ["migration"]],
  ["sql-comment-grant.diff", ["high-risk"], ["unclassified"], ["grant-revoke", "security-definer"]],
  ["perms-module.diff", ["high-risk"], ["permission"], ["unclassified"]],
  ["org-scope.diff", ["high-risk"], ["permission"], ["unclassified"]],
  ["id-hash.diff", ["high-risk"], ["id-document"], ["unclassified"]],
  ["privacy-module.diff", ["high-risk"], ["id-document"], ["legal"]],
  ["purge-function.diff", ["high-risk"], ["delete-purge"], ["unclassified"]],
  ["purge-path.diff", ["high-risk"], ["delete-purge"], ["unclassified"]],
  ["billing-module.diff", ["high-risk"], ["billing"], ["unclassified"]],
  ["pricing-page.diff", ["copy-change", "high-risk"], ["billing"], ["unclassified"]],
  ["pricing-logic.diff", ["high-risk"], ["billing"], ["unclassified"]],
  ["legal-lease.diff", ["copy-change", "high-risk"], ["legal"], ["unclassified"]],
  ["ui-text.diff", ["copy-change"], [], ["unclassified", "promise-price"]],
  ["ui-logic.diff", ["high-risk"], ["unclassified"], ["promise-price"]],
  ["ui-refund.diff", ["copy-change", "high-risk"], ["promise-refund"], ["promise-retention", "unclassified"]],
  ["test-only.diff", [], [], ["unclassified", "billing"]],
  ["billing-test.diff", ["high-risk"], ["billing"], ["unclassified"]],
  ["email-template.diff", ["copy-change"], [], ["unclassified", "promise-price"]],
  ["messages-json.diff", ["copy-change"], [], ["unclassified"]],
  ["website-home.diff", ["copy-change"], [], ["unclassified", "promise-security"]],
  ["allowlist-edit.diff", ["high-risk"], ["permission"], ["migration", "unclassified"]],
  ["combined.diff", ["copy-change", "has-migration", "high-risk"], ["migration"], []],
];

for (const [name, labels, present, absent] of cases) {
  test(name, () => {
    const result = classifyDiff(fixture(name));
    assert.deepEqual(result.labels, labels);
    const rules = rulesOf(result);
    for (const rule of present) assert.equal(rules.includes(rule), true, rule);
    for (const rule of absent) assert.equal(rules.includes(rule), false, rule);
  });
}

test("classifyDiff reads the diff only", () => {
  assert.equal(classifyDiff.length, 1);
  assert.deepEqual(AUTO_LABELS, ["copy-change", "has-migration", "high-risk"]);
});

test("a pull request description cannot add has-migration", () => {
  const result = classifyDiff(fixture("pr-description-ignored.diff"));
  assert.equal(result.hasMigration, false);
  assert.deepEqual(result.unclassified, ["README.md"]);
});

test("plain i18n edits are listed for Product Marketing", () => {
  const result = classifyDiff(fixture("i18n-plain.diff"));
  assert.equal(result.copyLines.some((entry) => entry.path === "src/i18n/zh-TW.json" && entry.text.includes("已繳清")), true);
  const comment = renderCopyComment(result.copyLines);
  assert.equal(comment.includes(COPY_COMMENT_MARKER), true);
  assert.equal(comment.includes("src/i18n/zh-TW.json:10"), true);
  assert.equal(comment.includes("已繳清"), true);
  assert.equal(comment.includes("supabase/migrations"), false);
});

test("the copy comment caps the line list", () => {
  const lines = [
    "diff --git a/src/i18n/zh-TW.json b/src/i18n/zh-TW.json",
    "--- a/src/i18n/zh-TW.json",
    "+++ b/src/i18n/zh-TW.json",
    "@@ -0,0 +1,201 @@",
  ];
  for (let index = 0; index < 201; index += 1) lines.push(`+  "k${index}": "字${index}"`);
  const result = classifyDiff(lines.join("\n"));
  assert.equal(result.copyChange, true);
  assert.equal(result.copyLines.length, 201);
  assert.equal(renderCopyComment(result.copyLines).includes("1 more changed lines are not listed."), true);
});

test("fixture filenames do not inherit risk from their names", () => {
  const wrapped = [
    "diff --git a/scripts/ci/fixtures/purge-path.diff b/scripts/ci/fixtures/purge-path.diff",
    "--- /dev/null",
    "+++ b/scripts/ci/fixtures/purge-path.diff",
    "@@ -0,0 +1,1 @@",
    "+export function purgeTenant() {}",
  ].join("\n");
  assert.deepEqual(classifyDiff(wrapped).labels, []);
});

test("a fixture file checked in with the pull request is not a migration", () => {
  const wrapped = [
    "diff --git a/scripts/ci/fixtures/migration-added.diff b/scripts/ci/fixtures/migration-added.diff",
    "--- /dev/null",
    "+++ b/scripts/ci/fixtures/migration-added.diff",
    "@@ -0,0 +1,2 @@",
    "+diff --git a/supabase/migrations/x.sql b/supabase/migrations/x.sql",
    "+CREATE POLICY org_read ON invoices",
  ].join("\n");
  const result = classifyDiff(wrapped);
  assert.equal(result.hasMigration, false);
  assert.equal(result.highRisk, false);
  assert.deepEqual(result.labels, []);
});

test("maintainer labels are not applied or removed by the plan", () => {
  const copy = planActions(classifyDiff(fixture("i18n-plain.diff")), ["copy-ok", "has-migration", "pm-full-accept"]);
  assert.deepEqual(copy.add, ["copy-change"]);
  assert.deepEqual(copy.remove, ["has-migration"]);
  assert.equal(copy.statuses["copy-ok"].state, "success");
  assert.equal(copy.statuses["pm-full-accept"].state, "success");

  const risk = planActions(classifyDiff(fixture("migration-added.diff")), []);
  assert.deepEqual(risk.add, ["has-migration", "high-risk"]);
  assert.deepEqual(risk.remove, []);
  assert.equal(risk.statuses["copy-ok"].state, "success");
  assert.equal(risk.statuses["pm-full-accept"].state, "pending");
  assert.equal(risk.add.includes("copy-ok"), false);
  assert.equal(risk.add.includes("pm-full-accept"), false);

  const accepted = planActions(classifyDiff(fixture("domain-logic.diff")), ["pm-full-accept"]);
  assert.equal(accepted.statuses["pm-full-accept"].state, "success");
  assert.equal(accepted.statuses["pm-full-accept"].description.includes("pm-full-accept"), true);
});

test("the risk gate dry-run prints labels from the diff", () => {
  const diff = fileURLToPath(new URL("./fixtures/combined.diff", import.meta.url));
  const stdout = execFileSync(process.execPath, [gate, "--diff", diff, "--dry-run"], { encoding: "utf8" });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.labels, ["copy-change", "has-migration", "high-risk"]);
  assert.equal(parsed.actions.statuses["pm-full-accept"].state, "pending");
  assert.equal(parsed.actions.statuses["copy-ok"].state, "pending");
});
