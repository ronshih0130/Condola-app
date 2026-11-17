import { brandV2Enabled } from "./brand-v2";
import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { svc } from "./db";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { portalInviteOrigin } from "./portal-invite";
import { assertIdentifiers } from "./repair-approval-rules";
import { hashVendorToken, newVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import type { Session } from "./types";

/**
 * B-110 CASE-SHARE (ven-copy-link, share-expired; VEN-25, MGT-124-AC1…AC3, AC6 = GS-54, OWN-32). One read-only link
 * per case through the app.b110_* service-only gateways. The system never sends it: the vendor or staff copies it.
 */
export type ShareLink = { url: string; expiresAt: string };
export type ShareMode = "check" | "open" | "copy";

export function shareUrl(origin: string, token: string) {
  return `${portalInviteOrigin(origin)}/s/${encodeURIComponent(token)}`;
}
function sqlState(error: unknown) {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}
function refused(error: unknown) {
  if (sqlState(error) === "42501") return new FlowError("errors.notFound");
  return error;
}
type Ready = { status: "ready"; token: string; expiresAt: string; created: boolean };
function link(origin: string, result: Ready | { status: string }): ShareLink {
  if (result.status !== "ready" || !("token" in result)) throw new FlowError("errors.required");
  return { url: shareUrl(origin, result.token), expiresAt: result.expiresAt };
}

/** Vendor (B-105 case token): check eligibility (no write), open the link, or copy it (restarts the 90 days). */
export async function vendorCaseShare(token: string, mode: ShareMode, origin: string): Promise<{ eligible: boolean } | ShareLink> {
  if (!vendorTokenAcceptable(token)) throw new FlowError("errors.notFound");
  try {
    const result = await svc(null, async client => (await client.query<{ r: Ready | { status: string } }>(
      "SELECT app.b110_vendor_share($1,$2,$3,$4) AS r", [hashVendorToken(token), brandV2Enabled(), mode, newVendorToken()])).rows[0].r);
    if (mode === "check") return { eligible: result.status === "eligible" };
    return link(origin, result);
  } catch (error) { throw refused(error); }
}

/** Staff (admin / manager, tickets.update): open or copy the case's link (MGT-124-AC1). */
export async function staffCaseShare(session: Session, ticketId: string, copy: boolean, origin: string): Promise<ShareLink> {
  session = await guardEffectiveSession(session, "tickets.update");
  requireOrgScope(session);
  const scope = { orgId: session.orgId, environment: session.environment };
  assertIdentifiers(ticketId, session.sessionId, session.liveOrgId);
  try {
    const result = await svc(session.userId, client => withEffectiveAuthority(client, session, "tickets.update", async () =>
      (await client.query<{ r: Ready | { status: string } }>("SELECT app.b110_staff_share($1,$2,$3,$4,$5,$6,$7,$8) AS r",
        [scope.orgId, session.liveOrgId, scope.environment, session.sessionId, brandV2Enabled(), ticketId, newVendorToken(), copy])).rows[0].r));
    return link(origin, result);
  } catch (error) { throw refused(error); }
}

/** Staff revoke (MGT-124-AC3): the old link then shows 「這個分享已撤銷」; the next copy makes a new link. */
export async function staffRevokeCaseShare(session: Session, ticketId: string): Promise<"revoked" | "none"> {
  session = await guardEffectiveSession(session, "tickets.update");
  requireOrgScope(session);
  const scope = { orgId: session.orgId, environment: session.environment };
  assertIdentifiers(ticketId, session.sessionId, session.liveOrgId);
  try {
    const result = await svc(session.userId, client => withEffectiveAuthority(client, session, "tickets.update", async () =>
      (await client.query<{ r: { status: "revoked" | "none" } }>("SELECT app.b110_staff_revoke($1,$2,$3,$4,$5,$6) AS r",
        [scope.orgId, session.liveOrgId, scope.environment, session.sessionId, brandV2Enabled(), ticketId])).rows[0].r));
    return result.status;
  } catch (error) { throw refused(error); }
}

export type ShareDocument = { id: string; kind: "receipt" | "completion_statement"; docNo: string; status: "issued" | "voided"; totalMinor: string };
export type ShareView =
  | { state: "expired" | "revoked"; company: string }
  | { state: "ok"; company: string; title: string; status: string; vendor: string | null; currency: string;
      photos: { id: string; name: string }[]; documents: ShareDocument[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Strict decode: anything unexpected is treated as no share (404), never partial content. */
export function parseShareView(raw: unknown): ShareView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.company !== "string") return null;
  if (v.state === "expired" || v.state === "revoked") return { state: v.state, company: v.company };
  if (v.state !== "ok" || typeof v.title !== "string" || typeof v.status !== "string" || !Array.isArray(v.photos) || !Array.isArray(v.documents)) return null;
  const photos = v.photos.flatMap((p: unknown) => {
    const x = p as Record<string, unknown>;
    return x && typeof x.id === "string" && UUID.test(x.id) && typeof x.name === "string" ? [{ id: x.id, name: x.name }] : [];
  });
  const documents = v.documents.flatMap((d: unknown): ShareDocument[] => {
    const x = d as Record<string, unknown>;
    return x && typeof x.id === "string" && UUID.test(x.id) && (x.kind === "receipt" || x.kind === "completion_statement")
      && typeof x.docNo === "string" && (x.status === "issued" || x.status === "voided") && typeof x.totalMinor === "string" && /^\d+$/.test(x.totalMinor)
      ? [{ id: x.id, kind: x.kind, docNo: x.docNo, status: x.status, totalMinor: x.totalMinor }] : [];
  });
  return { state: "ok", company: v.company, title: v.title, status: v.status, vendor: typeof v.vendor === "string" ? v.vendor : null,
    currency: typeof v.currency === "string" ? v.currency : "TWD", photos, documents };
}

/** Public read by the share link (no session). null = unknown link or gate off (404). */
export async function loadShareView(token: string): Promise<ShareView | null> {
  if (!vendorTokenAcceptable(token)) return null;
  const raw = await svc(null, async client => (await client.query<{ r: unknown }>(
    "SELECT app.b110_share_view($1,$2) AS r", [hashVendorToken(token), brandV2Enabled()])).rows[0].r);
  return raw === null ? null : parseShareView(raw);
}

/**
 * A live share's approved 處理後 photo (storage path); null when not served. Document PDFs are never served publicly:
 * the stored B-025 PDF carries the buyer's details, the work address, line items and the vendor's contact details.
 */
export async function loadSharePhoto(token: string, id: string) {
  if (!vendorTokenAcceptable(token) || !UUID.test(id)) return null;
  return svc(null, async client => (await client.query<{ storage_path: string; file_name: string }>(
    "SELECT * FROM app.b110_share_photo($1,$2,$3::uuid)", [hashVendorToken(token), brandV2Enabled(), id])).rows[0] ?? null);
}
