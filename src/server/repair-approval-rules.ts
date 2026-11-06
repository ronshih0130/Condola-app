import { FlowError } from "./errors";
import { isUuid, PHOTO_LIMIT } from "./repair-rules";

export const DECISIONS = ["approved", "rejected", "more_information"] as const;
export const APPROVAL_STATES = ["pending_approval", "policy_qualified", ...DECISIONS] as const;
export const EMERGENCY_CATEGORIES = ["water", "electricity", "safety"] as const;
export const APPOINTMENT_EVENTS = [
  "vendor_proposed",
  "company_confirmed",
  "vendor_rejected",
  "vendor_completion_submitted",
] as const;

export type Minor = bigint | number;
export type Time = string | number | Date;
export type EvidenceRef = { id: string; [key: string]: unknown };
export type EstimateSnapshot = {
  amountMinor: Minor;
  currency: string;
  minorUnit: number;
  scope: string;
  evidence: readonly EvidenceRef[];
  designatedPrincipal: string;
};

function minor(value: Minor): bigint {
  if (typeof value === "bigint" && value >= BigInt(0)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new FlowError("errors.amount");
}

export function classifyThreshold(amountMinor: Minor, thresholdMinor: Minor) {
  return minor(amountMinor) > minor(thresholdMinor) ? "pending_approval" : "policy_qualified";
}

/** Canonical JSON: object keys sorted recursively; array order is significant.
 * Bigints use decimal strings. Unsupported values and cycles fail closed.
 */
export function stableJson(value: unknown): string {
  const active = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "bigint") return JSON.stringify(item.toString());
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || active.has(item)) throw new FlowError("errors.required");
    active.add(item);
    try {
      if (Array.isArray(item)) return "[" + Array.from(item, encode).join(",") + "]";
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new FlowError("errors.required");
      const record = item as Record<string, unknown>;
      return "{" + Object.keys(record).sort().map((key) =>
        JSON.stringify(key) + ":" + encode(record[key]),
      ).join(",") + "}";
    } finally {
      active.delete(item);
    }
  }
  return encode(value);
}

export function requiresNewVersion(prev: EstimateSnapshot, next: EstimateSnapshot): boolean {
  return minor(prev.amountMinor) !== minor(next.amountMinor)
    || prev.currency !== next.currency
    || prev.minorUnit !== next.minorUnit
    || prev.scope !== next.scope
    || stableJson(prev.evidence) !== stableJson(next.evidence)
    || prev.designatedPrincipal !== next.designatedPrincipal;
}

function assertText(value: unknown, limit: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > limit) {
    throw new FlowError("errors.required");
  }
}

export function assertDecision(input: { decision: string; reason?: string | null }): void {
  if (!DECISIONS.includes(input.decision as (typeof DECISIONS)[number])) {
    throw new FlowError("errors.required");
  }
  if (input.reason != null) assertText(input.reason, 4000);
  if (input.decision !== "approved") assertText(input.reason, 4000);
}

export function timestamp(value: Time): string {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") {
    throw new FlowError("errors.date");
  }
  // Strings must carry a timezone so results do not depend on the server timezone.
  if (typeof value === "string" && !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new FlowError("errors.date");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new FlowError("errors.date");
  return date.toISOString();
}

export function reminderDue(input: {
  now: Time;
  submittedAt: Time;
  requiresOwnerDecision: boolean;
  hasDecision: boolean;
  alreadyReminded: boolean;
}): boolean {
  const elapsed = Date.parse(timestamp(input.now)) - Date.parse(timestamp(input.submittedAt));
  return input.requiresOwnerDecision === true
    && input.hasDecision === false
    && input.alreadyReminded === false
    && elapsed >= 24 * 60 * 60 * 1000;
}

/** Reference shape only; storage authorization and actual bytes remain reader gates. */
export function evidenceShapeOk(evidence: unknown): evidence is EvidenceRef[] {
  return Array.isArray(evidence)
    && evidence.length <= PHOTO_LIMIT
    && Array.from(evidence).every((ref: unknown) =>
      ref !== null && typeof ref === "object" && !Array.isArray(ref)
      && typeof (ref as EvidenceRef).id === "string"
      && (ref as EvidenceRef).id.trim().length > 0,
    );
}

export function assertEmergency(input: {
  isAdmin: boolean;
  category: string;
  reason: string;
  photos: unknown;
}): void {
  if (input.isAdmin !== true) throw new FlowError("errors.forbidden");
  if (!EMERGENCY_CATEGORIES.includes(input.category as (typeof EMERGENCY_CATEGORIES)[number])) {
    throw new FlowError("errors.required");
  }
  assertText(input.reason, 4000);
  if (!evidenceShapeOk(input.photos) || input.photos.length < 1) {
    throw new FlowError("errors.required");
  }
}

export function vendorRejectionKeepsOpen<T extends string>(ticketStatus: T): T {
  return ticketStatus;
}

export function assertIdentifiers(...values: unknown[]): void {
  if (!values.every((value) => typeof value === "string" && isUuid(value))) {
    throw new FlowError("errors.required");
  }
}

export function assertEstimate(input: {
  amountMinor: Minor;
  currency: string;
  minorUnit: number;
  workScope: string;
  evidence: unknown;
}): void {
  if (minor(input.amountMinor) > BigInt("9223372036854775807")) throw new FlowError("errors.amount");
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)
    || !Number.isInteger(input.minorUnit) || input.minorUnit < 0 || input.minorUnit > 4) {
    throw new FlowError("errors.required");
  }
  assertText(input.workScope, 8000);
  if (!evidenceShapeOk(input.evidence)) throw new FlowError("errors.required");
}

export type AppointmentTimes = {
  reason?: string | null;
  eventKind: string;
  proposedStart?: Time | null;
  proposedEnd?: Time | null;
  confirmedStart?: Time | null;
  confirmedEnd?: Time | null;
};

export function assertAppointment(input: AppointmentTimes): void {
  if (input.reason != null) assertText(input.reason, 4000);
  if (input.eventKind === "vendor_rejected") assertText(input.reason, 4000);
  if (!APPOINTMENT_EVENTS.includes(input.eventKind as (typeof APPOINTMENT_EVENTS)[number])) {
    throw new FlowError("errors.required");
  }
  for (const [start, end] of [
    [input.proposedStart, input.proposedEnd],
    [input.confirmedStart, input.confirmedEnd],
  ]) {
    const startMs = start == null ? null : Date.parse(timestamp(start));
    const endMs = end == null ? null : Date.parse(timestamp(end));
    if (startMs !== null && endMs !== null && endMs < startMs) throw new FlowError("errors.date");
  }
  if (input.eventKind === "company_confirmed"
    && (input.confirmedStart == null || input.confirmedEnd == null)) {
    throw new FlowError("errors.date");
  }
}

export function pendingClassify(input: {
  requiresOwnerDecision: boolean; isCurrent: boolean; decision: string | null;
}) {
  if (!input.isCurrent) return "superseded";
  if (DECISIONS.includes(input.decision as (typeof DECISIONS)[number])) {
    return input.decision as (typeof DECISIONS)[number];
  }
  return input.requiresOwnerDecision ? "pending_approval" : "policy_qualified";
}

export function decisionLabel(decision: string | null) {
  return DECISIONS.includes(decision as (typeof DECISIONS)[number])
    ? decision as (typeof DECISIONS)[number] : "undecided";
}

export function intentStatusLabel(at: string | null | undefined): "intent recorded" | "—" {
  return at ? "intent recorded" : "—";
}

export function reapprovalHint(isCurrent: boolean): string | null {
  return isCurrent ? null : "A newer estimate requires its own decision; earlier approval does not carry forward.";
}

/** Shape only; extra fields never become displayable references. */
export function emergencyPhotoRefShape(value: unknown): value is EvidenceRef[] {
  return evidenceShapeOk(value) && value.length >= 1;
}

/** Exact decimal formatting, including values above Number.MAX_SAFE_INTEGER. */
export function approvalAmount(amount: string, currency: string, scale: number): string {
  if (!/^[0-9]+$/.test(amount) || !/^[A-Z]{3}$/.test(currency)
    || !Number.isInteger(scale) || scale < 0 || scale > 4) throw new FlowError("errors.amount");
  const digits = BigInt(amount).toString().padStart(scale + 1, "0");
  return currency + " " + (scale ? digits.slice(0, -scale) + "." + digits.slice(-scale) : digits);
}
