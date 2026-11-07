import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Client } from "pg";
import { recordAudit } from "./audit-write";
import { consentCoversCurrent, readConsent } from "./consent";
import { svc } from "./db";
import { normalizePhone } from "./lease-rules";
import { requireOrgScope } from "./org-guard";
import { portalInviteOrigin } from "./portal-invite";
import type { Session } from "./types";

export const UNIT_QR_COOKIE = "condola_unit_qr";
export const UNIT_QR_SECONDS = 30 * 60;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9_-]{43}$/;
export function unitQrHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function key() {
  const value = process.env.UNIT_QR_SIGNING_KEY;
  return value && Buffer.byteLength(value) >= 32 ? value : null;
}
export function newUnitQrToken() {
  const secret = key();
  if (!secret) return null;
  const nonce = randomBytes(32).toString("base64url");
  return `${nonce}.${createHmac("sha256", secret).update(`unit-qr-v1:${nonce}`).digest("base64url")}`;
}
export function verifyUnitQrToken(token: string) {
  const secret = key();
  if (!secret || typeof token !== "string") return false;
  const [nonce, signature, extra] = token.split(".");
  if (extra !== undefined || !opaque.test(nonce ?? "") || !opaque.test(signature ?? "")) return false;
  const expected = createHmac("sha256", secret).update(`unit-qr-v1:${nonce}`).digest("base64url");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
function staffScope(session: Session) {
  if (session.kind !== "staff" || !["admin", "manager"].includes(session.role ?? "")
    || ![session.orgId, session.userId, session.sessionId].every(value => uuid.test(value))) return null;
  return requireOrgScope(session);
}
export async function unitQrStaffUnits(session: Session) {
  const scope = staffScope(session);
  if (!scope || !key()) return null;
  return svc(session.userId, async client => {
    const allowed = (await client.query(`SELECT app.b005_unit_qr_staff($1,$2,$3) AS ok`,
      [session.orgId, session.userId, session.sessionId])).rows[0]?.ok;
    if (allowed !== true) return null;
    return (await client.query<{ id: string; label: string }>(
      `SELECT u.id::text,p.name || ' / ' || u.label AS label FROM units u
       JOIN properties p ON p.id=u.property_id AND p.org_id=u.org_id
       WHERE u.org_id=$1 AND u.archived_at IS NULL AND p.archived_at IS NULL ORDER BY p.name,u.label,u.id`, [session.orgId])).rows;
  });
}
export async function issueUnitQr(session: Session, unitId: string, origin: string) {
  const scope = staffScope(session);
  if (!scope || !uuid.test(unitId)) return null;
  const token = newUnitQrToken();
  if (!token) return null;
  return svc(session.userId, async client => {
    const id = (await client.query<{ id: string | null }>(`SELECT app.b005_unit_qr_issue($1,$2,$3,$4,$5)::text AS id`,
      [session.orgId, unitId, session.userId, session.sessionId, unitQrHash(token)])).rows[0]?.id;
    if (!id) return null;
    await recordAudit({ orgId: session.orgId, actorUserId: session.userId, actorRole: session.role! },
      { table: "b005_unit_qr_contexts", rowId: id, action: "insert", eventType: "unit_qr_issued", newRow: { state: "issued" } }, client);
    return { id, url: `${portalInviteOrigin(origin)}/signup/unit-qr#t=${token}`, expiresIn: UNIT_QR_SECONDS };
  });
}
export async function revokeUnitQr(session: Session, id: string) {
  if (!staffScope(session) || !uuid.test(id)) return false;
  return svc(session.userId, async client => {
    const ok = (await client.query(`SELECT app.b005_unit_qr_revoke($1,$2,$3,$4) AS ok`,
      [session.orgId, id, session.userId, session.sessionId])).rows[0]?.ok === true;
    if (ok) await recordAudit({ orgId: session.orgId, actorUserId: session.userId, actorRole: session.role! },
      { table: "b005_unit_qr_contexts", rowId: id, action: "update", eventType: "unit_qr_revoked", newRow: { state: "revoked" } }, client);
    return ok;
  });
}
export async function scanUnitQr(token: string, ip: string | null) {
  if (!verifyUnitQrToken(token)) return null;
  const handle = randomBytes(32).toString("base64url");
  const ipHash = createHmac("sha256", key()!).update(`unit-qr-ip:${ip || "unknown"}`).digest("hex");
  const ok = await svc(null, async client => (await client.query(`SELECT app.b005_unit_qr_scan($1,$2,$3) AS ok`,
    [unitQrHash(token), unitQrHash(handle), ipHash])).rows[0]?.ok === true);
  return ok ? handle : null;
}
export type UnitQrContext = { id: string; done: boolean; active: boolean };
type ContextRow = UnitQrContext & { enabled: boolean };
async function lookupUnitQr(handle?: string | null, userId?: string | null): Promise<ContextRow | null> {
  if (handle && !opaque.test(handle)) return null;
  if (!handle && !userId) return null;
  if (userId && !uuid.test(userId)) return null;
  return svc(userId ?? null, async client => (await client.query<ContextRow>(
    `SELECT * FROM app.b005_unit_qr_context($1,$2)`, [handle ? unitQrHash(handle) : null, userId ?? null])).rows[0] ?? null);
}
/** Opaque continuation only; never returns an org, unit, address or contact. */
export async function readUnitQrContext(handle?: string | null, userId?: string | null): Promise<UnitQrContext | null> {
  const row = await lookupUnitQr(handle, userId);
  return row?.enabled && (!handle || row.active) ? { id: row.id, done: row.done, active: row.active } : null;
}
/** A present but invalid handle must never silently become an ordinary signup. */
export async function readUnitQrContinuation(handle?: string | null): Promise<
  { state: "absent" | "disabled" | "invalid" } | { state: "active"; context: UnitQrContext }
> {
  if (!handle) return { state: "absent" };
  const row = await lookupUnitQr(handle);
  if (row && !row.enabled) return { state: "disabled" };
  if (!row?.active || row.done) return { state: "invalid" };
  return { state: "active", context: { id: row.id, done: row.done, active: row.active } };
}
/** GET has no fragment context; admit only when at least one org can use QR. */
export async function unitQrEntryEnabled() {
  if (!key()) return false;
  return svc(null, async client => (await client.query(`SELECT EXISTS (
    SELECT 1 FROM public.organizations o WHERE app.b005_unit_qr_enabled(o.id)
  ) AS ok`)).rows[0]?.ok === true);
}
export async function createUnitQrForm(handle: string) {
  if (!opaque.test(handle)) return null;
  return svc(null, async client => (await client.query<{ id: string | null }>(
    `SELECT app.b005_unit_qr_form($1) AS id`, [unitQrHash(handle)])).rows[0]?.id ?? null);
}
export async function unitQrFormMatches(formId: string, handle: string) {
  if (!uuid.test(formId) || !opaque.test(handle)) return false;
  return svc(null, async client => (await client.query(
    `SELECT app.b005_unit_qr_form_matches($1,$2) AS ok`, [formId, unitQrHash(handle)])).rows[0]?.ok === true);
}
/** Called only inside startSignup after new-account creation or a matching password. */
export async function bindUnitQrOn(client: Client, handle: string, userId: string) {
  if (!opaque.test(handle)) return false;
  return (await client.query(`SELECT app.b005_unit_qr_bind($1,$2) AS ok`, [unitQrHash(handle), userId])).rows[0]?.ok === true;
}
export async function completeUnitQr(userId: string, contextId: string, name: string, phone: string) {
  if (!uuid.test(userId) || !uuid.test(contextId) || !name.trim() || name.trim().length > 120
    || !phone.trim().startsWith("+")) return null;
  const normalized = normalizePhone(phone, "");
  if (!normalized || !/^\+[1-9][0-9]{6,14}$/.test(normalized)) return null;
  if (!consentCoversCurrent(await readConsent(userId))) return null;
  return svc(userId, async client => {
    const hit = (await client.query<{ id: string; org_id: string; created: boolean }>(
      `SELECT * FROM app.b005_unit_qr_complete($1,$2,$3,$4)`, [contextId, userId, name.trim(), normalized])).rows[0];
    if (!hit) return null;
    if (hit.created) await recordAudit({ orgId: hit.org_id, actorUserId: userId, actorRole: "applicant" },
      { table: "b005_unit_qr_applicants", rowId: hit.id, action: "insert", eventType: "unit_qr_applied", newRow: { state: "pending" } }, client);
    return { id: hit.id };
  });
}
