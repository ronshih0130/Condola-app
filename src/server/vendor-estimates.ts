import { maybe, svc } from "./db";
import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { FlowError } from "./errors";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import { assertIdentifiers } from "./repair-approval-rules";
import type { VendorEstimateContext, VendorEstimateResult } from "../lib/vendor-estimate-types";
import { assertVendorEstimate, type VendorEstimateInput } from "./vendor-estimate-rules";
import { requireOrgScope } from "./org-guard";
import { auditScope, recordAudit } from "./audit-write";
import type { Session } from "./types";

function tokenHash(token: string) {
  if (!vendorTokenAcceptable(token)) throw new FlowError("errors.forbidden");
  return hashVendorToken(token);
}
export async function submitVendorEstimate(token: string, input: VendorEstimateInput): Promise<VendorEstimateResult> {
  assertVendorEstimate(input);
  const hash = tokenHash(token);
  return svc(null, async client => {
    const row = await maybe<{ result: VendorEstimateResult }>(client,
      "SELECT app.b026_submit_vendor_estimate($1::text,$2::uuid,$3::uuid,$4::bigint,$5::text,$6::smallint,$7::text,$8::jsonb) AS result",
      [hash, input.requestId, input.expectedHeadId, input.amountMinor.toString(), input.currency,
        input.minorUnit, input.workScope, JSON.stringify(input.evidence)]);
    if (!row) throw new FlowError("errors.forbidden");
    return row.result;
  });
}
export async function vendorEstimateContext(token: string): Promise<VendorEstimateContext | null> {
  const hash = tokenHash(token);
  return svc(null, async client => (await maybe<{ result: VendorEstimateContext | null }>(client,
    "SELECT app.b026_vendor_estimate_context($1::text) AS result", [hash]))?.result ?? null);
}
export type ManagerEstimate = {
  versionId: string; versionNo: string; amountMinor: string; currency: string; minorUnit: number;
  workScope: string; isCurrent: boolean; state: string; photos: { id: string }[];
};
export async function managerVendorEstimates(session: Session, ticketId: string): Promise<ManagerEstimate[]> {
  requireOrgScope(session);
  const scope = { orgId: session.orgId, environment: session.environment };
  assertIdentifiers(ticketId, session.sessionId, session.liveOrgId);
  if (session.kind !== "staff" || !["admin", "manager"].includes(session.role ?? "")) throw new FlowError("errors.forbidden");
  session = await guardEffectiveSession(session, "tickets.update");
  return svc(session.userId, async client => withEffectiveAuthority(client, session, "tickets.update", async () => {
    const row = await maybe<{ result: ManagerEstimate[] }>(client,
      "SELECT app.b026_manager_estimates($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid) AS result",
      [scope.orgId, session.liveOrgId, scope.environment, session.sessionId, ticketId]);
    const rows = row?.result ?? [];
    if (rows.length) await recordAudit(auditScope(session, scope), {
      table: "maintenance_tickets", rowId: ticketId, action: "select", eventType: "vendor_estimate_comparison",
      // Deliberately excludes work text, documents, tokens and monetary values.
      newRow: { version_ids: rows.map(item => item.versionId) }, reason: "vendor_estimate_comparison",
    }, client);
    return rows;
  }));
}
