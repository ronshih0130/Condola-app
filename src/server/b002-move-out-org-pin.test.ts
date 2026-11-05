import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

test("move-out action passes validated org and environment pins to the notice", () => {
  const source = readFileSync(new URL("./b002-move-out-actions.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function actionRecordMoveOut(");
  assert.ok(start >= 0);
  const action = source.slice(start);
  assert.match(source, /import\s*\{\s*requireOrgScope\s*\}\s*from\s*"\.\/org-guard"/);
  assert.match(action, /const scope = requireOrgScope\(session\)/);
  const pin = action.indexOf("requireOrgScope(session)");
  const withClient = action.indexOf("withClient(");
  assert.ok(withClient > pin);
  const notice = /recordMoveOutNotice\(client,\s*\{([\s\S]*?)\}\)/.exec(action.slice(pin));
  assert.ok(notice);
  const noticeInput = notice[1]!;
  assert.match(noticeInput, /\borgId:\s*scope\.orgId\b/);
  assert.match(noticeInput, /\benvironment:\s*scope\.environment\b/);
  assert.doesNotMatch(noticeInput, /\bsession\.(?:orgId|environment)\b/);
  assert.match(noticeInput, /\bactorUserId:\s*session\.userId\b/);
  assert.match(noticeInput, /\bliveOrgId:\s*session\.liveOrgId\b/);
  assert.doesNotMatch(action, /\btxForSession\s*\(/);
});

test("requireOrgScope preserves valid org and environment pins for move-out", () => {
  for (const environment of ["live", "sandbox"] as const) {
    const session = {
      orgId: "10000000-0000-4000-8000-000000000001",
      environment,
    } as Session;
    assert.deepEqual(requireOrgScope(session), {
      orgId: session.orgId,
      environment,
    });
  }
});

test("requireOrgScope rejects invalid move-out scope with FlowError", () => {
  for (const orgId of ["", " ", null, undefined]) {
    const session = { orgId, environment: "live" } as unknown as Session;
    assert.throws(() => requireOrgScope(session), FlowError);
  }
  for (const environment of ["", "production", null, undefined]) {
    const session = {
      orgId: "10000000-0000-4000-8000-000000000001",
      environment,
    } as unknown as Session;
    assert.throws(() => requireOrgScope(session), FlowError);
  }
});
