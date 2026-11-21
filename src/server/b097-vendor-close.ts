import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { brandV2Enabled } from "./brand-v2";
import { svc } from "./db";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";

/**
 * B-097 VEN-CLOSE (VEN-29, MGT-146-AC3/AC4; RV-DONE). 送出完工 by the assigned vendor's B-105 case bearer closes the
 * repair when at least one explicit 處理後 photo is attached (LPQ-25 item 3); admin / manager staff with tickets.update
 * may 重開 it within 7 days with a reason. All through the app.b097_* service-only gateways behind vendor_job_v3.
 * Nothing here sends anything outside the app.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
/** NUL and the other C0 controls except newline, DEL, C1 controls and the line / paragraph separators. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

export type DonePhoto = { id: string; name: string };
export type VendorDone = {
  company: string; closed: boolean; accepted: boolean; afterPhotos: DonePhoto[];
  closedAt: string | null; reopenUntil: string | null; closedByThisJob: boolean;
};

/** Strict decode of app.b097_vendor_done_view; anything unexpected is a read failure. */
export function parseVendorDone(raw: unknown): VendorDone {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Malformed vendor done view");
  const row = raw as Record<string, unknown>;
  const stamp = (value: unknown) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || !STAMP.test(value)) throw new Error("Malformed vendor done view");
    return value;
  };
  if (typeof row.company !== "string" || typeof row.closed !== "boolean" || typeof row.accepted !== "boolean"
    || typeof row.closedByThisJob !== "boolean" || !Array.isArray(row.afterPhotos)) throw new Error("Malformed vendor done view");
  const afterPhotos = row.afterPhotos.map((photo: unknown): DonePhoto => {
    const p = (photo ?? {}) as Record<string, unknown>;
    if (typeof p.id !== "string" || !UUID.test(p.id) || typeof p.name !== "string") throw new Error("Malformed vendor done view");
    return { id: p.id, name: p.name };
  });
  return { company: row.company, closed: row.closed, accepted: row.accepted, afterPhotos,
    closedAt: stamp(row.closedAt), reopenUntil: stamp(row.reopenUntil), closedByThisJob: row.closedByThisJob };
}

function sqlState(error: unknown) {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}
/** A NUL can never reach a PostgreSQL text value (22021 / 22P05); such input is invalid, never a server error. */
const hasNul = (value: string | null) => value !== null && value.includes("\u0000");

/** null: OFF or not admitted (the page 404s, as for an unknown link). Throws on a read failure. */
export async function loadVendorDone(token: string): Promise<VendorDone | null> {
  if (!vendorTokenAcceptable(token)) return null;
  const raw = await svc(null, async client => (await client.query<{ r: unknown }>(
    "SELECT app.b097_vendor_done_view($1,$2) AS r", [hashVendorToken(token), brandV2Enabled()])).rows[0]?.r ?? null);
  return raw === null ? null : parseVendorDone(raw);
}

export type CompleteInput = { requestId: string; note: string | null };
export type CompleteResult = { status: "recorded"; closedAt: string; reopenUntil: string; replayed: boolean }
  | { status: "rejected_invalid" | "rejected_conflict" | "rejected_closed" | "rejected_no_photo" | "rejected_state" };

/** Request shape shared by the route and the tests; the gateway re-validates everything. */
export function parseCompleteInput(value: unknown): CompleteInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["token", "requestId", "note"].includes(key))) return null;
  if (typeof v.requestId !== "string" || !UUID.test(v.requestId)) return null;
  if (v.note != null && typeof v.note !== "string") return null;
  const note = typeof v.note === "string" ? v.note.replace(/\r\n?/g, "\n").trim() : "";
  if (note.length > 500 || CONTROL.test(note)) return null;
  return { requestId: v.requestId, note: note || null };
}

/** 送出完工. Throws FlowError("errors.notFound") when the bearer is not admitted (nothing written). */
export async function completeVendorCase(token: string, input: CompleteInput): Promise<CompleteResult> {
  if (!vendorTokenAcceptable(token)) throw new FlowError("errors.notFound");
  if (hasNul(input.note)) return { status: "rejected_invalid" };
  try {
    return await svc(null, async client => (await client.query<{ r: CompleteResult }>(
      "SELECT app.b097_vendor_complete($1,$2,$3::uuid,$4) AS r",
      [hashVendorToken(token), brandV2Enabled(), input.requestId, input.note])).rows[0].r);
  } catch (error) {
    if (sqlState(error) === "42501") throw new FlowError("errors.notFound");
    if (sqlState(error) === "22021" || sqlState(error) === "22P05") return { status: "rejected_invalid" };
    throw error;
  }
}

export type ReopenInput = { ticketId: string; requestId: string; reason: string };
export type ReopenResult = { status: "reopened"; replayed: boolean }
  | { status: "rejected_invalid" | "rejected_conflict" | "rejected_state" | "rejected_expired" };

export function parseReopenInput(value: unknown): ReopenInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["ticketId", "requestId", "reason"].includes(key))) return null;
  if (typeof v.ticketId !== "string" || !UUID.test(v.ticketId) || typeof v.requestId !== "string" || !UUID.test(v.requestId)) return null;
  if (typeof v.reason !== "string") return null;
  const reason = v.reason.replace(/\r\n?/g, "\n").trim();
  if (!reason || reason.length > 500 || CONTROL.test(reason)) return null;
  return { ticketId: v.ticketId, requestId: v.requestId, reason };
}

/** 重開 (MGT-146-AC3). tickets.update and an admin / manager seat; throws FlowError("errors.forbidden") otherwise. */
export async function staffReopenRepair(session: Session, input: ReopenInput): Promise<ReopenResult> {
  session = await guardEffectiveSession(session, "tickets.update");
  requireOrgScope(session);
  if (![input.ticketId, input.requestId, session.sessionId, session.liveOrgId].every(id => typeof id === "string" && UUID.test(id))) {
    throw new FlowError("errors.forbidden");
  }
  if (hasNul(input.reason)) return { status: "rejected_invalid" };
  try {
    return await svc(session.userId, client => withEffectiveAuthority(client, session, "tickets.update", async () =>
      (await client.query<{ r: ReopenResult }>("SELECT app.b097_staff_reopen($1,$2,$3,$4,$5,$6,$7::uuid,$8) AS r",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, brandV2Enabled(), input.ticketId,
          input.requestId, input.reason])).rows[0].r));
  } catch (error) {
    if (sqlState(error) === "42501") throw new FlowError("errors.forbidden");
    if (sqlState(error) === "22021" || sqlState(error) === "22P05") return { status: "rejected_invalid" };
    throw error;
  }
}
