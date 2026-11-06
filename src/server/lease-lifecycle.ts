import type { Client } from "pg";
import { parseRenewalInput, validRenewalDate, type RenewalInput } from "@/lib/renewal-comparison";
import { recordAudit, auditScope } from "./audit-write";
import { tx } from "./db";
import { requireOrgScope } from "./org-guard";
import { isUuid } from "./repair-rules";
import { renewalComparisonView } from "./renewal-comparison";
import type { Session } from "./types";

export type LifecycleResult =
  | { state: "submitted"; leaseId: string }
  | { state: "replayed"; leaseId: string }
  | { state: "recorded"; recordId: string; version: number }
  | { state: "unavailable" | "invalid" | "conflict" | "overlap" | "stale" };
export type NoticeKind = "renewal_intent" | "non_renewal_notice" | "early_termination_notice";
export type NoticeSource = "self_report" | "document" | "staff_record";
export type NoticeInput = {
  recordId: string; expectedVersion: number; kind: NoticeKind; source: NoticeSource;
  occurredOn: string | null; effectiveOn: string | null; body: string;
};
export type ResponseInput = {
  recordId: string; noticeVersion: number; expectedVersion: number;
  response: "agree" | "disagree" | "undecided"; body: string;
};
type Party = "tenant" | "owner" | "management";
export type LifecycleView = {
  leases: { id: string; startDate: string; endDate: string | null; rentMinor: string; depositMinor: string;
    currency: string; frequency: string; dueDay: number; status: string; readOnly: boolean; previousLeaseId: string | null }[];
  notices: { record_id: string; version: number; kind: NoticeKind; source: NoticeSource; party: Party;
    actor_user_id: string; occurred_on: string | null; effective_on: string | null; body: string; created_at: string }[];
  responses: { record_id: string; version: number; notice_version: number; party: Party;
    actor_user_id: string; response: ResponseInput["response"]; body: string; created_at: string }[];
};
const unavailable = { state: "unavailable" } as const;
function permitted(s: Session, leaseId: string) {
  return !s.needsSandbox && [s.userId, s.orgId, s.liveOrgId, s.sessionId, leaseId].every(isUuid)
    && ["live", "sandbox"].includes(s.environment)
    && (s.kind === "tenant" || s.kind === "owner" || (s.kind === "staff" && ["admin", "manager"].includes(s.role ?? "")));
}
async function viewOn(c: Client, s: Session, leaseId: string): Promise<LifecycleView | null> {
  return (await c.query<{ result: LifecycleView | null }>(
    `SELECT app.b012_lifecycle_view($1,$2,$3,$4) AS result`, [s.orgId, s.sessionId, s.kind, leaseId],
  )).rows[0].result;
}
export async function leaseLifecycleView(s: Session, leaseId: string): Promise<LifecycleView | null> {
  if (!permitted(s, leaseId)) return null;
  try { return await tx(s.userId, c => viewOn(c, s, leaseId), requireOrgScope(s), { readOnly: true }); }
  catch { return null; }
}
async function write(s: Session, leaseId: string, operation: string, run: (c: Client) => Promise<LifecycleResult>, requestId?: string): Promise<LifecycleResult> {
  if (!permitted(s, leaseId)) return unavailable;
  try {
    const scope = requireOrgScope(s);
    if (!("orgId" in scope)) return unavailable;
    return await tx(s.userId, async c => {
      // Fail closed before validation. SQL repeats the strict flag/auth check
      // under control locks; OFF requests never append an audit row either.
      if (!await viewOn(c, s, leaseId)) return unavailable;
      const result = await run(c);
      if (result.state === "submitted" || result.state === "recorded") {
        await c.query("SET LOCAL ROLE service_role");
        await recordAudit(auditScope(s, { orgId: scope.orgId, environment: s.environment }), {
          table: "leases", rowId: leaseId, action: "insert", eventType: operation, requestId,
          // Intentionally omit notice text, dates, source documents and money.
          newRow: result.state === "submitted" ? { replacementId: result.leaseId }
            : { recordId: result.recordId, version: result.version },
        }, c);
        await c.query("SET LOCAL ROLE authenticated");
      }
      return result;
    }, scope);
  } catch { return unavailable; }
}
export async function submitLeaseReplacement(s: Session, leaseId: string, requestId: string, input: RenewalInput): Promise<LifecycleResult> {
  if (s.kind !== "staff") return unavailable;
  return write(s, leaseId, "lease_replacement_submitted", async c => {
    if (!isUuid(requestId)) return { state: "invalid" };
    const current = await renewalComparisonView(s, leaseId);
    if (!current) return unavailable;
    const terms = parseRenewalInput(input, current.terms);
    if (!terms) return { state: "invalid" };
    return (await c.query<{ result: LifecycleResult }>(`SELECT app.b012_submit_replacement($1,$2,$3,$4,$5::jsonb) AS result`,
      [s.orgId, s.sessionId, leaseId, requestId, JSON.stringify(terms)])).rows[0].result;
  }, requestId);
}
function version(value: number) { return Number.isSafeInteger(value) && value >= 0 && value < 2147483647; }
function optionalDate(value: string | null) { return value === null || (typeof value === "string" && validRenewalDate(value)); }
export async function recordLeaseNotice(s: Session, leaseId: string, input: NoticeInput): Promise<LifecycleResult> {
  return write(s, leaseId, "lease_notice_recorded", async c => {
    if (!input || !isUuid(input.recordId) || !version(input.expectedVersion)
      || !optionalDate(input.occurredOn) || !optionalDate(input.effectiveOn)
      || !["renewal_intent", "non_renewal_notice", "early_termination_notice"].includes(input.kind)
      || !["self_report", "document", "staff_record"].includes(input.source)
      || typeof input.body !== "string" || !input.body.trim() || input.body.length > 2000) return { state: "invalid" };
    return (await c.query<{ result: LifecycleResult }>(`SELECT app.b012_record_notice($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11) AS result`,
      [s.orgId, s.sessionId, s.kind, leaseId, input.recordId, input.expectedVersion, input.kind, input.source,
        input.occurredOn, input.effectiveOn, input.body])).rows[0].result;
  });
}
export async function respondLeaseNotice(s: Session, leaseId: string, input: ResponseInput): Promise<LifecycleResult> {
  return write(s, leaseId, "lease_notice_response_recorded", async c => {
    if (!input || !isUuid(input.recordId) || !version(input.expectedVersion) || !version(input.noticeVersion) || input.noticeVersion === 0
      || !["agree", "disagree", "undecided"].includes(input.response) || typeof input.body !== "string" || input.body.length > 2000) return { state: "invalid" };
    return (await c.query<{ result: LifecycleResult }>(`SELECT app.b012_respond_notice($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result`,
      [s.orgId, s.sessionId, s.kind, leaseId, input.recordId, input.noticeVersion, input.expectedVersion, input.response, input.body])).rows[0].result;
  });
}
