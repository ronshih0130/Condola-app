import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
/**
 * B-013 shared state; B-021 flag-gated production readers and owner decisions.
 */
import { createHash } from "node:crypto";
import { maybe, svc, withClient } from "./db";
import { FlowError } from "./errors";
import {
  assertAppointment,
  assertDecision,
  assertEmergency,
  assertEstimate,
  assertIdentifiers,
  stableJson,
  timestamp,
  type AppointmentTimes,
  type EvidenceRef,
  type Minor,
  type Time,
} from "./repair-approval-rules";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import type { Session } from "./types";

export type ApprovalResult = { status: string; [key: string]: unknown };

function jsonResult(value: unknown): ApprovalResult {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || typeof (parsed as ApprovalResult).status !== "string") {
    throw new FlowError("errors.required");
  }
  return parsed as ApprovalResult;
}

function payloadHash(session: Session, operation: string, payload: unknown): Buffer {
  return createHash("sha256").update(stableJson({
    orgId: session.orgId,
    operation,
    payload,
  }), "utf8").digest();
}

/** Flags and current authorization are checked atomically inside each gateway. */
async function run<T>(
  session: Session,
  sql: string,
  params: unknown[],
  parse: (value: unknown) => T,
): Promise<T> {
  session = await guardEffectiveSession(session, "tickets.update");
  assertIdentifiers(session.userId, session.orgId, session.sessionId);
  return svc(session.userId, async (client) => {
    const row = await maybe<{ r: unknown }>(client, sql, params);
    if (!row) throw new FlowError("errors.notFound");
    return parse(row.r);
  });
}

export type SubmitEstimateInput = {
  requestId: string;
  ticketId: string;
  expectedHeadId: string | null;
  amountMinor: Minor;
  currency: string;
  minorUnit: number;
  workScope: string;
  evidence: EvidenceRef[];
};

export function submitEstimate(session: Session, input: SubmitEstimateInput): Promise<ApprovalResult> {
  assertIdentifiers(input.requestId, input.ticketId);
  if (input.expectedHeadId !== null) assertIdentifiers(input.expectedHeadId);
  assertEstimate(input);
  const payload = {
    ticketId: input.ticketId,
    expectedHeadId: input.expectedHeadId,
    amountMinor: input.amountMinor.toString(),
    currency: input.currency,
    minorUnit: input.minorUnit,
    workScope: input.workScope.trim(),
    evidence: input.evidence,
  };
  return run(session,
    "SELECT app.b013_submit_estimate($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::text,$8::smallint,$9::text,$10::jsonb,$11::bytea) AS r",
    [session.orgId, session.sessionId, input.requestId, payload.ticketId, payload.expectedHeadId,
      payload.amountMinor, payload.currency, payload.minorUnit, payload.workScope,
      stableJson(payload.evidence), payloadHash(session, "submit", payload)],
    jsonResult);
}

export type DecideEstimateInput = {
  requestId: string;
  versionId: string;
  decision: string;
  reason?: string | null;
};

export function decideEstimate(session: Session, input: DecideEstimateInput): Promise<ApprovalResult> {
  assertIdentifiers(input.requestId, input.versionId);
  assertDecision(input);
  const payload = {
    versionId: input.versionId,
    decision: input.decision,
    reason: input.reason == null ? null : input.reason.trim(),
  };
  return run(session,
    "SELECT app.b013_decide_estimate($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::bytea) AS r",
    [session.orgId, session.sessionId, input.requestId, payload.versionId, payload.decision,
      payload.reason, payloadHash(session, "decision", payload)],
    jsonResult);
}

export type AuthorizeEmergencyInput = {
  requestId: string;
  versionId: string;
  category: string;
  reason: string;
  photos: EvidenceRef[];
};

export function authorizeEmergency(session: Session, input: AuthorizeEmergencyInput): Promise<ApprovalResult> {
  assertIdentifiers(input.requestId, input.versionId);
  assertEmergency({
    isAdmin: session.kind === "staff" && session.role === "admin",
    category: input.category,
    reason: input.reason,
    photos: input.photos,
  });
  const payload = {
    versionId: input.versionId,
    category: input.category,
    reason: input.reason.trim(),
    photos: input.photos,
  };
  return run(session,
    "SELECT app.b013_authorize_emergency($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::jsonb,$8::bytea) AS r",
    [session.orgId, session.sessionId, input.requestId, payload.versionId, payload.category,
      payload.reason, stableJson(payload.photos), payloadHash(session, "emergency", payload)],
    jsonResult);
}

export type RecordAppointmentInput = AppointmentTimes & {
  requestId: string;
  versionId: string;
  vendorJobId: string;
};

export function recordAppointment(session: Session, input: RecordAppointmentInput): Promise<ApprovalResult> {
  assertIdentifiers(input.requestId, input.versionId, input.vendorJobId);
  assertAppointment(input);
  const payload = {
    versionId: input.versionId,
    vendorJobId: input.vendorJobId,
    eventKind: input.eventKind,
    proposedStart: input.proposedStart == null ? null : timestamp(input.proposedStart),
    proposedEnd: input.proposedEnd == null ? null : timestamp(input.proposedEnd),
    confirmedStart: input.confirmedStart == null ? null : timestamp(input.confirmedStart),
    confirmedEnd: input.confirmedEnd == null ? null : timestamp(input.confirmedEnd),
    ...(input.reason == null ? {} : { reason: input.reason.trim() }),
  };
  return run(session,
    "SELECT app.b013_record_appointment($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11::bytea,$12::text) AS r",
    [session.orgId, session.sessionId, input.requestId, payload.versionId, payload.vendorJobId,
      payload.eventKind, payload.proposedStart, payload.proposedEnd, payload.confirmedStart,
      payload.confirmedEnd, payloadHash(session, "appointment", payload), payload.reason ?? null],
    jsonResult);
}

export type VendorAppointmentInput = RecordAppointmentInput & { orgId: string };
export type VendorAppointmentCredential = { token: string } | { tokenHash: string };

/** Server-only capability caller. The gateway validates every supplied scope ID. */
export function recordVendorAppointment(
  credential: VendorAppointmentCredential,
  input: VendorAppointmentInput,
): Promise<ApprovalResult> {
  assertIdentifiers(input.orgId, input.requestId, input.versionId, input.vendorJobId);
  assertAppointment(input);
  if (input.eventKind === "company_confirmed") throw new FlowError("errors.forbidden");
  let tokenHash: string;
  if ("token" in credential) {
    if (!vendorTokenAcceptable(credential.token)) throw new FlowError("errors.forbidden");
    tokenHash = hashVendorToken(credential.token);
  } else {
    tokenHash = credential.tokenHash;
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new FlowError("errors.forbidden");
  }
  const payload = {
    orgId: input.orgId,
    vendorJobId: input.vendorJobId,
    versionId: input.versionId,
    eventKind: input.eventKind,
    proposedStart: input.proposedStart == null ? null : timestamp(input.proposedStart),
    proposedEnd: input.proposedEnd == null ? null : timestamp(input.proposedEnd),
    confirmedStart: input.confirmedStart == null ? null : timestamp(input.confirmedStart),
    confirmedEnd: input.confirmedEnd == null ? null : timestamp(input.confirmedEnd),
    reason: input.reason == null ? null : input.reason.trim(),
  };
  const digest = createHash("sha256").update(stableJson({
    operation: "appointment", principal: "vendor", payload,
  }), "utf8").digest();
  return svc(null, async (client) => {
    const row = await maybe<{ r: unknown }>(client,
      "SELECT app.b013_record_vendor_appointment($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::text,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11::text,$12::bytea) AS r",
      [payload.orgId, payload.vendorJobId, tokenHash, input.requestId, payload.versionId,
        payload.eventKind, payload.proposedStart, payload.proposedEnd, payload.confirmedStart,
        payload.confirmedEnd, payload.reason, digest]);
    if (!row) throw new FlowError("errors.notFound");
    return jsonResult(row.r);
  });
}

/** Trusted scheduler entrypoint; the gateway owns due checks and deduplication. */
export function emitReminder(
  session: Session,
  input: { versionId: string; now: Time },
): Promise<ApprovalResult> {
  assertIdentifiers(input.versionId);
  return run(session,
    "SELECT app.b013_emit_reminder($1::uuid,$2::uuid,$3::timestamptz) AS r",
    [session.orgId, input.versionId, timestamp(input.now)],
    jsonResult);
}

export function dispatchAllowed(session: Session, input: { versionId: string }): Promise<boolean> {
  assertIdentifiers(input.versionId);
  return run(session,
    "SELECT app.b013_dispatch_allowed($1::uuid,$2::uuid) AS r",
    [session.orgId, input.versionId],
    (value) => {
      if (typeof value !== "boolean") throw new FlowError("errors.required");
      return value;
    });
}

export type ApprovalMoney = {
  version_id: string; version_no: string; amount_minor: string;
  currency: string; minor_unit: number; captured_threshold_minor: string;
  submitted_at: string;
};
export type OwnerPendingRow = ApprovalMoney & {
  ticket_id: string; property_id: string; threshold_source: string;
  work_scope: string; evidence_snapshot: { id: string }[];
  has_emergency: boolean; reminder_intent_at: string | null;
};
export type OwnerHistoryRow = ApprovalMoney & {
  requires_owner_decision: boolean; decision: string | null;
  decided_at: string | null; decision_reason: string | null;
  emergency_category: string | null; emergency_reason: string | null;
  emergency_photo_refs: { id: string }[];
  emergency_notice_intent_at: string | null; is_current: boolean;
};
export type ManagerApprovalRow = OwnerHistoryRow & {
  threshold_source: string; submitted_by: string; decided_by: string | null;
  appointment_event_kind: string | null; appointment_occurred_at: string | null;
  reminder_intent_at: string | null;
};

function approvalRows<T>(value: unknown): T[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new FlowError("errors.required");
  return parsed as T[];
}

function readApprovals<T>(
  session: Session,
  gateway: "b013_owner_pending" | "b013_owner_history" | "b013_manager_view",
  ticketId?: string,
): Promise<T[]> {
  assertIdentifiers(session.liveOrgId);
  if (!["live", "sandbox"].includes(session.environment)) throw new FlowError("errors.forbidden");
  if (ticketId !== undefined) assertIdentifiers(ticketId);
  // Decimal strings avoid JSON/JavaScript precision loss for PostgreSQL bigint.
  const args = ticketId === undefined ? "$1::uuid,$2::uuid,$3::text,$4::uuid"
    : "$1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid";
  const sql = "SELECT coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object("
    + "'version_no',r.version_no::text,'amount_minor',r.amount_minor::text,"
    + "'captured_threshold_minor',r.captured_threshold_minor::text)"
    + " ORDER BY r.submitted_at DESC,r.version_id),'[]'::jsonb) AS r FROM app."
    + gateway + "(" + args + ") r";
  const params: unknown[] = [session.orgId, session.liveOrgId, session.environment, session.sessionId];
  if (ticketId !== undefined) params.push(ticketId);
  return run(session, sql, params, approvalRows<T>);
}

export function ownerPending(session: Session): Promise<OwnerPendingRow[]> {
  return readApprovals(session, "b013_owner_pending");
}
export function ownerHistory(session: Session, input: { ticketId: string }): Promise<OwnerHistoryRow[]> {
  return readApprovals(session, "b013_owner_history", input.ticketId);
}
export function managerApprovalView(session: Session, input: { ticketId: string }): Promise<ManagerApprovalRow[]> {
  return readApprovals(session, "b013_manager_view", input.ticketId);
}

/** Rendering hint only. Gateways independently recheck the registered control. */
export async function repairApprovalsEnabled(orgId: string): Promise<boolean> {
  assertIdentifiers(orgId);
  return withClient(async (client) => {
    const row = await maybe<{ enabled: boolean }>(client,
      "SELECT coalesce((SELECT o.feature_flags->'repair_approvals'='true'::jsonb"
      + " AND f.value->'enabled'='true'::jsonb"
      + " AND jsonb_typeof(f.value->'allowed_org_ids')='array'"
      + " AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)"
      + " FROM public.organizations o CROSS JOIN public.platform_settings f"
      + " WHERE o.id=$1::uuid AND f.key='repair_approvals'),false) AS enabled", [orgId]);
    return row?.enabled === true;
  });
}
