import { brandV2Enabled } from "./brand-v2";
import { maybe, svc } from "./db";
import { FlowError } from "./errors";
import { acceptPhotoObject, assertPhotoMeta, isTicketPhotoPath, photoFileId } from "./repair-rules";
import { inspectRepairObject, removeRepairObject, vendorUploadGrantMatches } from "./ticket-photos";
import { recordStoredFileUsage } from "./usage-events";
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

type Run = (sql: string, params: unknown[]) => Promise<unknown>;
const runSvc: Run = (sql, params) => svc(null, async client => (await client.query<{ r: unknown }>(sql, params)).rows[0]?.r ?? null);

/**
 * null: OFF, not admitted, or not proven ON (callers keep the legacy V-TOKEN response).
 * unavailable: vendor_job_v3 positively admits this bearer, but the case could not be read (GS-02 read error).
 */
export async function loadVendorCase(token: string, run: Run = runSvc): Promise<LoadedVendorCase | null> {
  if (!vendorTokenAcceptable(token)) return null;
  const params = [hashVendorToken(token), brandV2Enabled()];
  let raw: unknown;
  try {
    raw = await run("SELECT app.b105_vendor_case($1,$2) AS r", params);
  } catch {
    // The flag is not proven ON by a failed read: only a positive admission answer may show a v3 state.
    try {
      return (await run("SELECT app.b105_vendor_case_admitted($1,$2) AS r", params)) === true ? { state: "unavailable" } : null;
    } catch {
      return null;
    }
  }
  if (raw === null || raw === undefined) return null;
  try {
    return { state: "ready", value: parseVendorCase(raw) };
  } catch {
    // A non-NULL answer is itself a positive admission.
    return { state: "unavailable" };
  }
}

export type DecisionInput = { requestId: string; decision: "accepted" | "declined"; agreedOn: string | null; reason: string | null };
export type DecisionResult = { status: "recorded"; decision: "accepted" | "declined"; replayed: boolean }
  | { status: "rejected_invalid" | "rejected_conflict" };

/** A real calendar day as YYYY-MM-DD (rejects 2026-02-30, 2026-13-01 and years outside 1..9999). */
export function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Request-shape validation shared by the route and the tests; the gateway re-validates everything. */
export function parseDecisionInput(value: unknown): DecisionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== "string" || !UUID.test(v.requestId)) return null;
  if (v.decision !== "accepted" && v.decision !== "declined") return null;
  const agreedOn = v.agreedOn == null || v.agreedOn === "" ? null : v.agreedOn;
  if (agreedOn !== null && !calendarDate(agreedOn)) return null;
  if (v.reason != null && typeof v.reason !== "string") return null;
  const reason = typeof v.reason === "string" && v.reason.trim() ? v.reason.trim() : null;
  if (reason !== null && reason.length > 500) return null;
  if (v.decision === "accepted" && reason !== null) return null;
  if (v.decision === "declined" && agreedOn !== null) return null;
  return { requestId: v.requestId, decision: v.decision, agreedOn: agreedOn as string | null, reason };
}

function sqlState(error: unknown) {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}
function denied(error: unknown) {
  return sqlState(error) === "42501";
}
/** 22007 invalid_datetime_format, 22008 datetime_field_overflow, 22P02 invalid_text_representation. */
function badInput(error: unknown) {
  return ["22007", "22008", "22P02"].includes(sqlState(error) ?? "");
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
    if (badInput(error)) return { status: "rejected_invalid" };
    throw error;
  }
}

/**
 * RV-PHOTOS upload confirm. The case must be accepted and open. The upload grant (issued by the existing vendor
 * sign route to this token, ticket and path) and the stored bytes are checked first; then ONE service transaction
 * runs app.b105_vendor_attach_photo, which writes the files row and the attachment with its set together, and
 * records stored-file usage. A refusal or failure leaves no file row or attachment behind. Retrying the same
 * upload returns the same attachment.
 */
const DISCARD = new Set(["errors.photoLimit", "errors.photoType", "errors.photoSize", "errors.photoStorage", "errors.photoHeic"]);
export type CasePhotoInput = { path: string; fileName: string; mime: string; size: number; uploadToken: string };
type CasePhotoDeps = { inspect?: typeof inspectRepairObject; remove?: typeof removeRepairObject };

export async function confirmVendorCasePhoto(token: string, phase: CasePhase, input: CasePhotoInput, deps: CasePhotoDeps = {}) {
  if (!vendorTokenAcceptable(token) || (phase !== "before" && phase !== "after")) throw new FlowError("errors.notFound");
  const hash = hashVendorToken(token);
  const loaded = await loadVendorCase(token);
  if (!loaded) throw new FlowError("errors.notFound");
  if (loaded.state !== "ready") throw new FlowError("errors.generic");
  const stage = vendorCaseStage(loaded.value);
  if (stage !== "open" && stage !== "owner_wait") throw new FlowError("errors.notFound");
  const job = await svc(null, client => maybe<{ org_id: string; ticket_id: string }>(client,
    "SELECT org_id::text, ticket_id::text FROM app.open_vendor_job($1)", [hash]));
  if (!job) throw new FlowError("errors.notFound");
  const fileId = photoFileId(input.path);
  if (!fileId || !isTicketPhotoPath(input.path, job.org_id, job.ticket_id)
    || !vendorUploadGrantMatches(hash, job.ticket_id, input.path, input.uploadToken ?? "")) throw new FlowError("errors.forbidden");
  let accepted: { size: number; mime: string };
  let fileName: string;
  try {
    const meta = assertPhotoMeta({ fileName: input.fileName, mime: input.mime, size: input.size });
    fileName = meta.fileName;
    const stored = await (deps.inspect ?? inspectRepairObject)(input.path);
    accepted = acceptPhotoObject({ size: stored.size, mime: stored.mime, header: stored.header }, meta.mime);
  } catch (error) {
    // A rejected object that no file row references is this grant's own orphan: remove it, as the existing confirm does.
    if (error instanceof FlowError && DISCARD.has(error.key)) {
      const referenced = await svc(null, client => maybe<{ id: string }>(client,
        "SELECT id::text FROM public.files WHERE storage_path=$1", [input.path]));
      if (!referenced) await (deps.remove ?? removeRepairObject)(input.path);
    }
    throw error;
  }
  let result: { status: string; id?: string; replayed?: boolean };
  try {
    result = await svc(null, async client => {
      const r = (await client.query<{ r: { status: string; id?: string; replayed?: boolean } }>(
        "SELECT app.b105_vendor_attach_photo($1,$2,$3::uuid,$4,$5,$6,$7::bigint,$8) AS r",
        [hash, brandV2Enabled(), fileId, input.path, fileName, accepted.mime, accepted.size, phase])).rows[0].r;
      if (r.status === "recorded" && !r.replayed) await recordStoredFileUsage(client, job.org_id, fileId);
      return r;
    });
  } catch (error) {
    if (denied(error)) throw new FlowError("errors.notFound");
    throw error;
  }
  if (result.status === "rejected_limit") throw new FlowError("errors.photoLimit");
  if (result.status !== "recorded" || !result.id) throw new FlowError("errors.required");
  return result.id;
}
