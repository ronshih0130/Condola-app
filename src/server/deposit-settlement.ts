import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import type { Client } from "pg";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

export type DepositSettlementStatus = { enabled: false };

/** Build-only inert status. Preserves the synchronous, always-OFF contract. */
export function getDepositSettlementStatus(session: Session): DepositSettlementStatus {
  requireOrgScope(session); // fail-closed on bad org/env
  return { enabled: false };
}

/** Fail closed without a reader client; build-only writers never supply one. */
export async function isDepositSettlementEnabled(
  session: Session,
  client?: Pick<Client, "query">,
): Promise<boolean> {
  session = await guardEffectiveSession(session, "leases.edit");
  requireOrgScope(session);
  if (!client) return false;
  try {
    const org = await client.query<{ id: string }>(`SELECT o.id FROM public.organizations o
      WHERE o.id=$1 AND o.environment::text=$2 AND coalesce(o.live_org_id,o.id)=$3
        AND o.feature_flags->'deposit_settlement'='true'::jsonb
        AND EXISTS (SELECT 1 FROM public.platform_settings p
          WHERE p.key='deposit_settlement' AND p.value->'enabled'='true'::jsonb
            AND jsonb_typeof(p.value->'allowed_org_ids')='array'
            AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text))`,
      [session.orgId, session.environment, session.liveOrgId]);
    return (org.rowCount ?? 0) === 1;
  } catch {
    return false;
  }
}

export type DepositSettlementWriteResult = { ok: false; reason: "disabled" };
type SettlementTarget = { leaseId: string; settlementId: string };
type RevisionTarget = SettlementTarget & { expectedRevision: string };

/** Build-only: no writer obtains or passes a DB client. */
export async function openSettlement(session: Session, _input: {
  leaseId: string;
  basis: "move_out";
  depositHeldMinor: string;
  currency: string;
  sourceHandoverRecordId?: string;
}): Promise<DepositSettlementWriteResult> {
  session = await guardEffectiveSession(session, "leases.edit");
  requireOrgScope(session);
  const enabled = await isDepositSettlementEnabled(session);
  if (!enabled) return { ok: false, reason: "disabled" };
  throw new FlowError("errors.notFound");
}

export async function addOrUpdateLine(session: Session, _input: RevisionTarget & {
  lineId: string;
  itemKey?: string;
  amountMinor: string;
  reason: string;
  sourceLeaseChargeId?: string;
}): Promise<DepositSettlementWriteResult> {
  session = await guardEffectiveSession(session, "leases.edit");
  requireOrgScope(session);
  const enabled = await isDepositSettlementEnabled(session);
  if (!enabled) return { ok: false, reason: "disabled" };
  throw new FlowError("errors.notFound");
}

export async function attachEvidence(session: Session, _input: RevisionTarget & {
  evidenceId: string;
  lineId?: string;
  source:
    | { kind: "handover_attachment"; attachmentId: string }
    | { kind: "settlement_upload"; completedUploadId: string };
}): Promise<DepositSettlementWriteResult> {
  session = await guardEffectiveSession(session, "leases.edit");
  requireOrgScope(session);
  const enabled = await isDepositSettlementEnabled(session);
  if (!enabled) return { ok: false, reason: "disabled" };
  throw new FlowError("errors.notFound");
}

export async function finalizeSettlement(session: Session, _input: RevisionTarget & {
  expectedTotalDeductionMinor: string;
}): Promise<DepositSettlementWriteResult> {
  session = await guardEffectiveSession(session, "leases.edit");
  requireOrgScope(session);
  const enabled = await isDepositSettlementEnabled(session);
  if (!enabled) return { ok: false, reason: "disabled" };
  throw new FlowError("errors.notFound");
}

export async function recordPayment(session: Session, _input: SettlementTarget & {
  requestId: string;
  direction: "refund" | "top_up";
  amountMinor: string;
  currency: string;
  method: string;
  accountLast5?: string;
  payeeAccountId?: string;
  externalRef?: string;
  recordNote?: string;
}): Promise<DepositSettlementWriteResult> {
  session = await guardEffectiveSession(session, "leases.edit");
  requireOrgScope(session);
  const enabled = await isDepositSettlementEnabled(session);
  if (!enabled) return { ok: false, reason: "disabled" };
  throw new FlowError("errors.notFound");
}
