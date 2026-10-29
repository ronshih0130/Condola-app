/**
 * Pure domain rules. Callers must authenticate actors and verify email codes
 * before constructing events. No database, delivery or clock dependencies.
 */
import { matchesGeneratedContract, type GeneratedContractProof } from "./stamp";

export type CaseStatus = "draft" | "sent" | "signing" | "completed" | "voided" | "superseded";
export type Role = "company_admin" | "company_staff" | "owner" | "tenant";
export type IdentityMethod = "email" | "otp";
export type IdentityResult = "completed" | "failed";
export const EMAIL_IDENTITY_LABEL = "已完成 Email 身分確認步驟";

export type Point = { x: number; y: number };
export type Stroke = readonly Point[];
export type SignaturePolicy = { minPoints: number; minWidth: number; minHeight: number };
export const DEFAULT_SIGNATURE_POLICY: SignaturePolicy = {
  minPoints: 3,
  minWidth: 4,
  minHeight: 4,
};

export function acceptableSignature(
  strokes: readonly Stroke[],
  policy: SignaturePolicy = DEFAULT_SIGNATURE_POLICY,
): boolean {
  if (
    !Number.isInteger(policy.minPoints) || policy.minPoints < 2 ||
    !Number.isFinite(policy.minWidth) || policy.minWidth <= 0 ||
    !Number.isFinite(policy.minHeight) || policy.minHeight <= 0
  ) throw new Error("Invalid signature policy");
  const points = strokes.flat();
  if (points.length < policy.minPoints) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasMovement = false;
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.length; i++) {
      const p = stroke[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      if (i > 0 && (p.x !== stroke[i - 1].x || p.y !== stroke[i - 1].y)) hasMovement = true;
    }
  }
  return hasMovement && maxX - minX >= policy.minWidth && maxY - minY >= policy.minHeight;
}

export type ForeignDocumentCheck = {
  documentType: "passport" | "residence_permit";
  checkedByStaffId: string;
  checkedAt: string;
};

export type Signer = {
  id: string;
  role: "owner" | "tenant";
  status: "pending_consent" | "pending_identity" | "pending_review" | "pending_signature" | "completed";
  consent?: {
    kind: "explicit" | "presumed";
    at: string;
  };
  notice?: { sentAt: string; presumedConsentDeadline: string; termsVersion: string };
  objectionAt?: string;
  identity?: { method: IdentityMethod; result: IdentityResult; at: string; attempts: number };
  emailChallenge?: { issuedAt: string; expiresAt: string; attemptCap: number; attempts: number };
  /** Set by the authenticated company adapter, never by signer input. */
  documentCheckRequired: boolean;
  foreignDocumentCheck?: ForeignDocumentCheck;
  reviewedAt?: string;
  signature?: {
    signedAt: string;
    imageRef: string;
    documentDigest: string;
    ip: string;
    userAgent: string;
    device: string;
  };
};

export type Version = {
  id: string;
  status: CaseStatus;
  effect: "pending" | "effective" | "superseded" | "voided";
  body: string;
  documentDigest: string;
  order: "parallel" | "sequential";
  signers: Signer[];
  halted?: "objection" | "identity_failed";
  completedAt?: string;
  finalDigest?: string;
  supersedes_version_id?: string;
  previous_version_id?: string;
  initiatedBy?: string;
  initiatedAt?: string;
  voided_by?: string;
  voided_at?: string;
  voidReason?: string;
};

export type AuditEvent = {
  type: Event["type"] | "became_effective" | "became_superseded";
  versionId: string;
  actorId: string;
  at: string;
  signerId?: string;
  relatedVersionId?: string;
  reason?: string;
  method?: IdentityMethod;
  result?: IdentityResult;
  documentType?: ForeignDocumentCheck["documentType"];
};

export type SigningCase = {
  versions: Version[];
  audit: AuditEvent[];
};

type Base = { versionId: string; actorId: string; role: Role; at: string };
type SignerBase = Base & { signerId: string };
export type Event =
  | (Base & {
      type: "send";
      presumedConsentDeadline: string;
      termsVersion: string;
    })
  | (SignerBase & { type: "consent"; kind: "explicit" | "presumed" })
  | (SignerBase & { type: "object" })
  | (SignerBase & {
      type: "issue_identity";
      method: IdentityMethod;
      expiresAt: string;
      attemptCap: number;
    })
  | (SignerBase & {
      type: "check_identity";
      method: IdentityMethod;
      /** Trusted adapter result; never include an actual email code in an event. */
      codeMatches: boolean;
    })
  | (Base & {
      type: "check_foreign_document";
      signerId: string;
      documentType: ForeignDocumentCheck["documentType"];
    })
  | (SignerBase & { type: "review"; scrolledToEnd: boolean })
  | (SignerBase & {
      type: "sign";
      strokes: readonly Stroke[];
      imageRef: string;
      documentDigest: string;
      ip: string;
      userAgent: string;
      device: string;
      /** Digest of the finalized PDF, required for the last signature. */
      finalDigest?: string;
    })
  | (Base & { type: "void"; reason: string })
  | (Base & {
      type: "create_version";
      /** In-process proof from generateContractPdf; re-generate after reload. */
      documentProof?: GeneratedContractProof;
      newVersionId: string;
      body: string;
      documentDigest: string;
    });

function requireRule(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function instant(value: string): number {
  requireRule(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value), "Timestamp needs timezone");
  const n = Date.parse(value);
  requireRule(Number.isFinite(n), "Invalid timestamp");
  return n;
}

function nonempty(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function digest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function taipeiDate(value: string): string {
  const d = new Date(instant(value) + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function replacementLine(completedAt: string): string {
  return `本版取代 ${taipeiDate(completedAt)} 簽署之前版`;
}

/** Require a separate body line, not a substring hidden in another sentence. */
export function validateReplacementBody(body: string, completedAt: string): boolean {
  const required = replacementLine(completedAt);
  return body.split(/\r?\n/).some((line) => line.trim() === required);
}

export function createCase(input: {
  versionId: string;
  body: string;
  documentDigest: string;
  /** Trusted company configuration; do not bind this input from a signer request. */
  signers: ReadonlyArray<{ id: string; role: "owner" | "tenant"; documentCheckRequired?: boolean }>;
  order?: "parallel" | "sequential";
}): SigningCase {
  requireRule(nonempty(input.versionId) && nonempty(input.body), "Version and body required");
  requireRule(digest(input.documentDigest), "Invalid document digest");
  requireRule(input.signers.length >= 2, "At least two parties required");
  requireRule(new Set(input.signers.map((s) => s.id)).size === input.signers.length, "Duplicate signer");
  requireRule(input.signers.some((s) => s.role === "owner"), "Owner required");
  requireRule(input.signers.some((s) => s.role === "tenant"), "Tenant required");
  requireRule(input.signers.every((s) => nonempty(s.id)), "Signer ID required");
  return {
    versions: [{
      id: input.versionId,
      body: input.body,
      documentDigest: input.documentDigest,
      order: input.order ?? "parallel",
      status: "draft",
      effect: "pending",
      signers: input.signers.map((s) => ({
        id: s.id, role: s.role, status: "pending_consent",
        documentCheckRequired: s.documentCheckRequired === true,
      })),
    }],
    audit: [],
  };
}

/**
 * Returns a detached state. Old audit entries are never rewritten. Completion
 * of a replacement changes both version statuses in this single operation.
 * Authentication and durable atomic persistence belong to the future adapter.
 */
export function transition(state: SigningCase, event: Event): SigningCase {
  const now = instant(event.at);
  requireRule(nonempty(event.actorId), "Actor required");
  const last = state.audit.at(-1);
  if (last) requireRule(now >= instant(last.at), "Time cannot move backwards");
  const next: SigningCase = structuredClone(state);
  const v = next.versions.find((candidate) => candidate.id === event.versionId);
  requireRule(v, "Unknown version");
  const admin = () => requireRule(event.role === "company_admin", "Company admin required");
  const entry: AuditEvent = {
    type: event.type,
    versionId: v.id,
    actorId: event.actorId,
    at: event.at,
  };

  if (event.type === "create_version") {
    admin();
    requireRule(
      (v.status === "completed" && v.effect === "effective") || v.status === "voided",
      "New version requires an effective completed or voided predecessor",
    );
    requireRule(nonempty(event.newVersionId), "Version ID required");
    requireRule(!next.versions.some((x) => x.id === event.newVersionId), "Duplicate version");
    requireRule(
      !next.versions.some((x) =>
        (x.previous_version_id === v.id || x.supersedes_version_id === v.id) &&
        x.effect === "pending"),
      "Replacement already pending",
    );
    requireRule(nonempty(event.body) && digest(event.documentDigest), "Body and digest required");
    if (v.effect === "effective") {
      requireRule(v.completedAt, "Missing completion time");
      requireRule(validateReplacementBody(event.body, v.completedAt), "Replacement line required");
    }
    const fresh = createCase({
      versionId: event.newVersionId,
      body: event.body,
      documentDigest: event.documentDigest,
      order: v.order,
      signers: v.signers,
    }).versions[0];
    // A voided replacement still points to the effective original.
    const effectiveId = v.effect === "effective" ? v.id : v.supersedes_version_id;
    if (effectiveId) {
      const old = next.versions.find((x) => x.id === effectiveId);
      requireRule(old?.effect === "effective" && old.completedAt, "Original no longer effective");
      requireRule(validateReplacementBody(event.body, old.completedAt), "Replacement line required");
      requireRule(
        !next.versions.some((x) => x.supersedes_version_id === effectiveId && x.effect === "pending"),
        "Replacement already pending",
      );
      requireRule(
        matchesGeneratedContract(event.documentProof, event.body, event.documentDigest),
        "Replacement PDF must be generated from the validated body",
      );
      fresh.supersedes_version_id = effectiveId;
    }
    fresh.previous_version_id = v.id;
    fresh.initiatedBy = event.actorId;
    fresh.initiatedAt = event.at;
    next.versions.push(fresh);
    entry.relatedVersionId = fresh.id;
    next.audit.push(entry);
    return next;
  }

  requireRule(
    v.status !== "completed" && v.status !== "voided" && v.status !== "superseded",
    "Version is read-only",
  );

  if (event.type === "void") {
    admin();
    requireRule(nonempty(event.reason), "Void reason required");
    v.status = "voided";
    v.effect = "voided";
    v.voided_by = event.actorId;
    v.voided_at = event.at;
    v.voidReason = event.reason.trim();
    entry.reason = v.voidReason;
    if (v.supersedes_version_id) entry.relatedVersionId = v.supersedes_version_id;
    next.audit.push(entry);
    return next;
  }

  requireRule(!v.halted, "Case halted; company handling required");

  if (event.type === "send") {
    admin();
    requireRule(v.status === "draft", "Only drafts can be sent");
    requireRule(instant(event.presumedConsentDeadline) > now, "Deadline must follow notice");
    requireRule(nonempty(event.termsVersion), "Terms version required");
    if (v.supersedes_version_id) {
      const old = next.versions.find((x) => x.id === v.supersedes_version_id);
      requireRule(old?.effect === "effective" && old.completedAt, "Original no longer effective");
      requireRule(validateReplacementBody(v.body, old.completedAt), "Replacement line required");
    }
    v.status = "sent";
    for (const s of v.signers) {
      s.notice = {
        sentAt: event.at,
        presumedConsentDeadline: event.presumedConsentDeadline,
        termsVersion: event.termsVersion,
      };
    }
  } else {
    requireRule(v.status === "sent" || v.status === "signing", "Invitations must be sent");
    const s = v.signers.find((x) => x.id === event.signerId);
    requireRule(s, "Unknown signer");
    entry.signerId = s.id;
    if (event.type === "check_foreign_document") {
      requireRule(
        event.role === "company_admin" || event.role === "company_staff",
        "Company staff required",
      );
      requireRule(s.status !== "completed", "Signer record is read-only");
      requireRule(!s.foreignDocumentCheck, "Document check already recorded");
      requireRule(
        event.documentType === "passport" || event.documentType === "residence_permit",
        "Unsupported document type",
      );
      // Explicit projection prevents accidental document-number retention.
      s.foreignDocumentCheck = {
        documentType: event.documentType,
        checkedByStaffId: event.actorId,
        checkedAt: event.at,
      };
      entry.documentType = event.documentType;
    } else {
      requireRule(event.actorId === s.id && event.role === s.role, "Signer may act only for self");
      if (event.type === "object") {
        s.objectionAt = event.at;
        v.halted = "objection";
      } else {
        requireRule(s.status !== "completed", "Signer record is read-only");
        if (v.order === "sequential") {
          const index = v.signers.indexOf(s);
          requireRule(v.signers.slice(0, index).every((x) => x.status === "completed"), "Signing order");
        }
        switch (event.type) {
          case "consent":
            requireRule(s.status === "pending_consent" && s.notice, "Consent out of order");
            requireRule(event.kind === "explicit" || event.kind === "presumed", "Invalid consent kind");
            if (event.kind === "presumed") {
              requireRule(now >= instant(s.notice.presumedConsentDeadline), "Consent deadline not reached");
            }
            s.consent = { kind: event.kind, at: event.at };
            s.status = "pending_identity";
            v.status = "signing";
            break;
          case "issue_identity":
            requireRule(event.method === "email", "Identity method not available");
            requireRule(s.status === "pending_identity", "Identity out of order");
            requireRule(!s.emailChallenge, "Challenge already issued");
            requireRule(
              Number.isInteger(event.attemptCap) && event.attemptCap > 0,
              "Positive attempt cap required",
            );
            requireRule(instant(event.expiresAt) > now, "Expiry must be in the future");
            s.emailChallenge = {
              issuedAt: event.at,
              expiresAt: event.expiresAt,
              attemptCap: event.attemptCap,
              attempts: 0,
            };
            entry.method = "email";
            break;
          case "check_identity": {
            requireRule(event.method === "email", "Identity method not available");
            requireRule(s.status === "pending_identity" && s.emailChallenge, "Challenge required");
            const challenge = s.emailChallenge;
            requireRule(challenge.attempts < challenge.attemptCap, "Attempt cap reached");
            challenge.attempts++;
            const expired = now >= instant(challenge.expiresAt);
            const result: IdentityResult = event.codeMatches === true && !expired ? "completed" : "failed";
            s.identity = { method: "email", result, at: event.at, attempts: challenge.attempts };
            entry.method = "email";
            entry.result = result;
            if (result === "completed") {
              s.status = "pending_review";
              delete s.emailChallenge;
            } else if (expired || challenge.attempts >= challenge.attemptCap) {
              v.halted = "identity_failed";
              delete s.emailChallenge;
            }
            break;
          }
          case "review":
            requireRule(s.status === "pending_review", "Review out of order");
            requireRule(event.scrolledToEnd === true, "Scroll to end required");
            s.reviewedAt = event.at;
            s.status = "pending_signature";
            break;
          case "sign": {
            requireRule(s.status === "pending_signature", "Signature out of order");
            requireRule(!s.documentCheckRequired || s.foreignDocumentCheck, "Document check required");
            requireRule(acceptableSignature(event.strokes), "Handwritten signature required");
            requireRule(
              nonempty(event.imageRef) && nonempty(event.ip) &&
              nonempty(event.userAgent) && nonempty(event.device),
              "Complete signature audit fields required",
            );
            requireRule(event.documentDigest === v.documentDigest, "Shown document digest mismatch");
            const isLast = v.signers.every((x) => x.id === s.id || x.status === "completed");
            if (isLast) requireRule(event.finalDigest && digest(event.finalDigest), "Final PDF digest required");
            s.signature = {
              signedAt: event.at,
              imageRef: event.imageRef,
              documentDigest: event.documentDigest,
              ip: event.ip,
              userAgent: event.userAgent,
              device: event.device,
            };
            s.status = "completed";
            if (isLast) {
              let old: Version | undefined;
              if (v.supersedes_version_id) {
                old = next.versions.find((x) => x.id === v.supersedes_version_id);
                requireRule(old?.effect === "effective", "Original no longer effective");
              }
              v.status = "completed";
              v.effect = "effective";
              v.completedAt = event.at;
              v.finalDigest = event.finalDigest;
              if (old) {
                old.status = "superseded";
                old.effect = "superseded";
                next.audit.push({
                  type: "became_superseded",
                  versionId: old.id,
                  relatedVersionId: v.id,
                  actorId: event.actorId,
                  at: event.at,
                });
              }
              next.audit.push({
                type: "became_effective",
                versionId: v.id,
                ...(old ? { relatedVersionId: old.id } : {}),
                actorId: event.actorId,
                at: event.at,
              });
            }
            break;
          }
          default:
            throw new Error("Unknown event");
        }
      }
    }
  }
  next.audit.push(entry);
  return next;
}

export type AuditViewer = { id: string; role: Role };

/** Company management sees technical fields; adapter must authorize organization access. */
export function auditView(version: Version, signerId: string, viewer: AuditViewer) {
  const staff = viewer.role === "company_admin" || viewer.role === "company_staff";
  requireRule(
    staff || version.signers.some((s) => s.id === viewer.id && s.role === viewer.role),
    "Not a participant",
  );
  const signer = version.signers.find((s) => s.id === signerId);
  requireRule(signer, "Unknown signer");
  return {
    signerId: signer.id,
    status: signer.status,
    signedAt: signer.signature?.signedAt ?? null,
    identityLabel: signer.identity?.result === "completed" ? EMAIL_IDENTITY_LABEL : null,
    documentDigest: version.finalDigest ?? version.documentDigest,
    ...(staff ? {
      ip: signer.signature?.ip ?? null,
      userAgent: signer.signature?.userAgent ?? null,
      device: signer.signature?.device ?? null,
    } : {}),
  };
}

function calendarDate(value: string): { year: number; month: number; day: number } {
  requireRule(/^\d{4}-\d{2}-\d{2}$/.test(value), "Expected Asia/Taipei calendar date");
  const [year, month, day] = value.split("-").map(Number);
  requireRule(year >= 1 && year <= 9984, "Year out of range");
  const parsed = new Date(`${value}T00:00:00Z`);
  requireRule(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, "Invalid date");
  return { year, month, day };
}

/** Date-only values represent Asia/Taipei calendar dates, not UTC instants. */
export function retentionUntil(leaseEndDate: string): string {
  const { year, month, day } = calendarDate(leaseEndDate);
  const target = year + 15;
  const leap = target % 4 === 0 && (target % 100 !== 0 || target % 400 === 0);
  return `${String(target).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
    month === 2 && day === 29 && !leap ? 28 : day,
  ).padStart(2, "0")}`;
}

export function retentionAction(
  now: string | Date,
  leaseEndDate: string,
): "retain" | "eligible_for_delete_or_anonymize" {
  const current = now instanceof Date ? now.toISOString() : now;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(current)
    ? (calendarDate(current), current)
    : taipeiDate(current);
  return date < retentionUntil(leaseEndDate) ? "retain" : "eligible_for_delete_or_anonymize";
}

export function idPhotoPurgeMayDelete(kind: string): boolean {
  return kind === "id_photo";
}
