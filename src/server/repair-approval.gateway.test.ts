import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import test from "node:test";

const src = resolve(process.cwd(), "src");
const servicePath = join(src, "server", "repair-approval.ts");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

test("B-021 production callers are confined to the owner decision and scoped views", () => {
  const callers: string[] = [];
  for (const path of files(src)) {
    const name = basename(path);
    const local = relative(src, path).replaceAll("\\", "/");
    if (/^repair-approval.*\.ts$/.test(name)
      || /\.(?:test|spec)\.[^.]+$/.test(name)
      || /(?:^|\/)(?:__tests__|tests?|e2e)\//.test(local)) continue;
    const source = readFileSync(path, "utf8");
    // Covers static imports/re-exports, side-effect imports, import(), and require().
    const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      if (/(?:^|\/)repair-approval(?:\.[cm]?[jt]sx?)?$/.test(match[1])) callers.push(local);
    }
  }
  assert.deepEqual([...new Set(callers)].sort(), [
    "app/api/owner-repair-decision/route.ts",
    "app/m/tickets/[id]/approval-panel.tsx",
    "app/o/approvals/[ticketId]/page.tsx",
    "app/o/approvals/approval-cards.tsx",
    "app/o/approvals/decision-form.tsx",
    "app/o/approvals/page.tsx",
    "server/vendor-job.ts",
    "server/vendor-repair.ts",
  ].sort());
});

test("B-021 service uses contracted gateways and the registered rendering control", () => {
  const full = readFileSync(servicePath, "utf8");
  const source = full.split("export async function repairApprovalsEnabled(")[0];
  const resolver = full.slice(source.length);
  const allowed = [
    "b013_submit_estimate",
    "b013_decide_estimate",
    "b013_authorize_emergency",
    "b013_record_appointment",
    "b013_record_vendor_appointment",
    "b013_emit_reminder",
    "b013_dispatch_allowed",
  ];
  const seen = new Set<string>();
  for (const match of source.matchAll(/\b(app|public)\.([a-z_][a-z0-9_]*)\b/gi)) {
    assert.equal(match[1], "app", "No direct public schema access");
    assert.ok(allowed.includes(match[2]), "Non-gateway reference: " + match[0]);
    assert.match(source.slice((match.index ?? 0) + match[0].length), /^\s*\(/);
    seen.add(match[2]);
  }
  assert.deepEqual([...seen].sort(), [...allowed].sort());
  assert.match(source, /svc\(session\.userId,/);
  assert.match(source, /B-013 shared state; B-021 flag-gated/);
  const readerNames = [...source.matchAll(/"(b013_(?:owner_pending|owner_history|manager_view))"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(readerNames)].sort(), ["b013_manager_view", "b013_owner_history", "b013_owner_pending"]);
  assert.match(source, /session.orgId, session.liveOrgId, session.environment, session.sessionId/);
  assert.match(resolver, /public.organizations o CROSS JOIN public.platform_settings f/);
  assert.match(resolver, /jsonb_typeof\(f.value->'allowed_org_ids'\)='array'/);
  assert.match(resolver, /f.value->'allowed_org_ids' @> jsonb_build_array\(o.id::text\)/);
  assert.match(resolver, /o.feature_flags->'repair_approvals'='true'::jsonb/);
  assert.match(resolver, /f.value->'enabled'='true'::jsonb/);
});

test("decision route parses the client request ID and delegates authorization to the gateway", () => {
  const route = readFileSync(join(src, "app/api/owner-repair-decision/route.ts"), "utf8");
  assert.match(route, /await requireCurrentConsent\(undefined, "api"\)/);
  assert.match(route, /session.kind !== "owner"/);
  assert.match(route, /import \{ parseRequestId \} from "\.\/request-id"/);
  assert.match(route, /const requestId = parseRequestId\(fields\.requestId\)/);
  assert.match(route, /if \(requestId === null\) throw new FlowError\("errors\.required"\)/);
  assert.match(route, /input = \{ requestId, versionId: fields\.versionId/);
  assert.match(route, /await decideEstimate\(session, \{ \.\.\.input, requestId: input\.requestId \}\)/);
  assert.doesNotMatch(route, /randomUUID|app\.|public\.|requestId:\s*(?:fields|value)\./);
  assert.match(route, /code === "40001"/);
});
