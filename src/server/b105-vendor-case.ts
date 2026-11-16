import { brandV2Enabled } from "./brand-v2";
import { svc } from "./db";
import { FlowError } from "./errors";
import { confirmVendorPhoto } from "./vendor-repair";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";

/**
 * B-105 (R9-VEN) Round 7 batch 3: the vendor case on /v/[token] (RV-JOB-ACCEPT, RV-DECLINE, RV-JOB-WAIT,
 * RV-PHOTOS, RV-PHOTOS-CLOSED). Every read and write goes through the app.b105_* service-only gateways,
 * which admit the token bearer only and are OFF unless vendor_job_v3 (plus brand_v3, vendor_dispatch and
 * the enhanced vendor_link) is on for the job's organization. Nothing here sends anything outside the app.
 */
export type CasePhase = "before" | "after";
export type CasePhoto = { id: string; name: string; phase: CasePhase; viewable: boolean };
export type VendorCase = {
  company: string;
  closed: boolean;
  decision: "accepted" | "declined" | null;
  agreedCompletionOn: string | null;
  scheduledOn: string | null;
  /** GS-26: the current estimate's version number while it waits for the owner; otherwise null. */
  ownerWaitVersion: number | null;
  estimates: boolean;
  photos: CasePhoto[];
};
export type LoadedVendorCase = { state: "ready"; value: VendorCase } | { state: "unavailable" };
export type VendorCaseStage = "accept" | "declined" | "owner_wait" | "open" | "closed";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Strict decode of app.b105_vendor_case; anything unexpected is a read failure, never a guessed stage. */
export function parseVendorCase(raw: unknown): VendorCase {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Malformed vendor case");
  const row = raw as Record<string, unknown>;
  const decision = row.decision ?? null;
  if (decision !== null && decision !== "accepted" && decision !== "declined") throw new Error("Malformed vendor case");
  const wait = row.ownerWaitVersion ?? null;
  if (wait !== null && (typeof wait !== "number" || !Number.isSafeInteger(wait) || wait < 1)) throw new Error("Malformed vendor case");
  const dates = [row.agreedCompletionOn ?? null, row.scheduledOn ?? null];
  if (dates.some(date => date !== null && (typeof date !== "string" || !DATE.test(date)))) throw new Error("Malformed vendor case");
  if (typeof row.closed !== "boolean" || typeof row.estimates !== "boolean" || typeof row.company !== "string"
    || !Array.isArray(row.photos)) throw new Error("Malformed vendor case");
  const photos = row.photos.map((photo: unknown): CasePhoto => {
    const p = (photo ?? {}) as Record<string, unknown>;
    if (typeof p.id !== "string" || !UUID.test(p.id) || typeof p.name !== "string"
      || (p.phase !== "before" && p.phase !== "after") || typeof p.viewable !== "boolean") throw new Error("Malformed vendor case");
    return { id: p.id, name: p.name, phase: p.phase, viewable: p.viewable };
  });
  return {
    company: row.company, closed: row.closed, decision, agreedCompletionOn: text(dates[0]), scheduledOn: text(dates[1]),
    ownerWaitVersion: wait, estimates: row.estimates, photos,
  };
}

/** VEN-26-AC1 (amended): 接單 first; a decline ends the vendor's part; a closed case is read only. */
export function vendorCaseStage(value: Pick<VendorCase, "closed" | "decision" | "ownerWaitVersion">): VendorCaseStage {
  if (value.decision === "declined") return "declined";
  if (value.closed) return "closed";
  if (value.decision !== "accepted") return "accept";
  return value.ownerWaitVersion !== null ? "owner_wait" : "open";
}

/** null: OFF or not admitted (callers keep their existing response). unavailable: GS-02 read error. */
export async function loadVendorCase(token: string): Promise<LoadedVendorCase | null> {
  if (!vendorTokenAcceptable(token)) return null;
  try {
    const raw = await svc(null, async client => (await client.query<{ c: unknown }>(
      "SELECT app.b105_vendor_case($1,$2) AS c", [hashVendorToken(token), brandV2Enabled()])).rows[0]?.c ?? null);
    return raw === null ? null : { state: "ready", value: parseVendorCase(raw) };
  } catch {
    return { state: "unavailable" };
  }
}

export type DecisionInput = { requestId: string; decision: "accepted" | "declined"; agreedOn: string | null; reason: string | null };
export type DecisionResult = { status: "recorded"; decision: "accepted" | "declined"; replayed: boolean }
  | { status: "rejected_invalid" | "rejected_conflict" };

/** Request-shape validation shared by the route and the tests; the gateway re-validates everything. */
export function parseDecisionInput(value: unknown): DecisionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== "string" || !UUID.test(v.requestId)) return null;
  if (v.decision !== "accepted" && v.decision !== "declined") return null;
  const agreedOn = v.agreedOn == null || v.agreedOn === "" ? null : v.agreedOn;
  if (agreedOn !== null && (typeof agreedOn !== "string" || !DATE.test(agreedOn) || Number.isNaN(Date.parse(`${agreedOn}T00:00:00Z`)))) return null;
  if (v.reason != null && typeof v.reason !== "string") return null;
  const reason = typeof v.reason === "string" && v.reason.trim() ? v.reason.trim() : null;
  if (reason !== null && reason.length > 500) return null;
  if (v.decision === "accepted" && reason !== null) return null;
  if (v.decision === "declined" && agreedOn !== null) return null;
  return { requestId: v.requestId, decision: v.decision, agreedOn: agreedOn as string | null, reason };
}

function denied(error: unknown) {
  const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  return code === "42501";
}

/** 接受工單 / 確定不接. Throws FlowError("errors.notFound") when the bearer is not admitted (nothing written). */
export async function decideVendorCase(token: string, input: DecisionInput): Promise<DecisionResult> {
  if (!vendorTokenAcceptable(token)) throw new FlowError("errors.notFound");
  try {
    return await svc(null, async client => (await client.query<{ r: DecisionResult }>(
      "SELECT app.b105_vendor_decide($1,$2,$3::uuid,$4,$5::date,$6) AS r",
      [hashVendorToken(token), brandV2Enabled(), input.requestId, input.decision, input.agreedOn, input.reason])).rows[0].r);
  } catch (error) {
    if (denied(error)) throw new FlowError("errors.notFound");
    throw error;
  }
}

/**
 * RV-PHOTOS upload confirm: only an accepted, open case. The existing vendor confirm attaches the file
 * (same storage, limits and link checks); the B-105 gateway then tags this job's own upload with its set.
 * A retry with the same upload is idempotent end to end, so a failed tag never needs a second file.
 */
export async function confirmVendorCasePhoto(token: string, phase: CasePhase, input: Parameters<typeof confirmVendorPhoto>[1]) {
  const loaded = await loadVendorCase(token);
  if (!loaded) throw new FlowError("errors.notFound");
  if (loaded.state !== "ready") throw new FlowError("errors.generic");
  const stage = vendorCaseStage(loaded.value);
  if (stage !== "open" && stage !== "owner_wait") throw new FlowError("errors.notFound");
  const id = await confirmVendorPhoto(token, input);
  try {
    await svc(null, client => client.query("SELECT app.b105_vendor_photo_phase($1,$2,$3::uuid,$4)",
      [hashVendorToken(token), brandV2Enabled(), id, phase]));
  } catch (error) {
    if (denied(error)) throw new FlowError("errors.notFound");
    throw error;
  }
  return id;
}
