/**
 * Build-only (B-013). No production caller; gateways fail closed when repair_approvals/vendor_dispatch OFF.
 */
import { createHash } from "node:crypto";
import { maybe, svc } from "./db";
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
function run<T>(
  session: Session,
  sql: string,
  params: unknown[],
  parse: (value: unknown) => T,
): Promise<T> {
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
  };
  return run(session,
    "SELECT app.b013_record_appointment($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,$7::timestamptz,$8::timestamptz,$9::timestamptz,$10::timestamptz,$11::bytea) AS r",
    [session.orgId, session.sessionId, input.requestId, payload.versionId, payload.vendorJobId,
      payload.eventKind, payload.proposedStart, payload.proposedEnd, payload.confirmedStart,
      payload.confirmedEnd, payloadHash(session, "appointment", payload)],
    jsonResult);
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
