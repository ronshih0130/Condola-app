import { FlowError } from "./errors";

export type VendorResponseTimes = {
  proposedStart?: string | null;
  proposedEnd?: string | null;
  confirmedStart?: string | null;
  confirmedEnd?: string | null;
};

export type VendorResponseInput = {
  action: string;
  times?: VendorResponseTimes;
  reason?: string | null;
};

function invalid(): never {
  throw new FlowError("errors.required");
}

function reasonRequired(reason: unknown) {
  if (typeof reason !== "string" || !reason.trim()) invalid();
}

function assertReason(reason: unknown) {
  if (reason == null) return;
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 4000) invalid();
}

function assertRange(start: unknown, end: unknown) {
  if (typeof start !== "string" || typeof end !== "string") invalid();
  // Require an explicit offset; datetime-local values must be normalized by
  // the browser before submission.
  const zoned = /T.*(?:Z|[+-]\d{2}:\d{2})$/;
  if (!zoned.test(start) || !zoned.test(end)) invalid();
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) invalid();
}

export function assertVendorResponse(input: VendorResponseInput): void {
  assertReason(input.reason);
  switch (input.action) {
    case "reject":
      reasonRequired(input.reason);
      return;
    case "propose":
      assertRange(input.times?.proposedStart, input.times?.proposedEnd);
      return;
    case "accept_confirm":
      assertRange(input.times?.confirmedStart, input.times?.confirmedEnd);
      return;
    default:
      invalid();
  }
}

export function assertCompletion(input: {
  hasAfterPhoto: boolean;
  reason?: string | null;
}): void {
  if (typeof input.hasAfterPhoto !== "boolean") invalid();
  assertReason(input.reason);
  if (!input.hasAfterPhoto) reasonRequired(input.reason);
}
