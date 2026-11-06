import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const golden = [
  "return (",
  '  <div data-v2-page={v2 ? "o-approvals" : undefined}>',
  '    <h2>{t("i_approvals")}</h2>',
  '    <p>{t("i_no_approvals")}</p>',
  "  </div>",
  ");",
].join("\n");

test("OFF keeps the exact placeholder JSX and returns before any reader call", () => {
  for (const file of ["page.tsx", "[ticketId]/page.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const start = source.indexOf("if (!(await repairApprovalsEnabled(session.orgId))) {");
    assert.ok(start > 0);
    const block = source.slice(start).match(/\{\n([\s\S]*?)\n  \}/)?.[1];
    assert.ok(block);
    assert.equal(block.split("\n").map(line => line.slice(2)).join("\n"), golden);
    for (const call of source.matchAll(/await (?:ownerPending|ownerHistory)\(/g)) {
      assert.ok(call.index! > start + block.length);
    }
    const calls = [
      'await requireCurrentConsent(undefined, "page")', "await getSession()",
      "await brandV2EnabledForOrg(session.orgId)", "makeT(session.locale)",
    ].map(call => source.indexOf(call));
    assert.ok(calls.every((index, i) => index >= 0 && (i === 0 || index > calls[i - 1])));
    assert.ok(calls[3] < start);
  }
});
test("manager block returns nothing before reading when OFF", () => {
  const source = readFileSync(new URL("../../m/tickets/[id]/approval-panel.tsx", import.meta.url), "utf8");
  const policy = source.indexOf("await repairApprovalPanelPolicy(session.orgId, true)");
  const guard = source.indexOf("if (!policy.approvals) return null;");
  assert.ok(policy >= 0 && guard > policy && guard < source.indexOf("await managerApprovalView("));
  assert.ok(source.includes("enabled={policy.estimates}"));
});
