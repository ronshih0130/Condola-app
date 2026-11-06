import { createHash } from "node:crypto";
import type { Client } from "pg";
import { svc } from "./db";
import { FlowError } from "./errors";
import { resolveVendorIdentity } from "./vendor-identity";
import { planVendorAttribution } from "./vendor-attribution";
import { vendorLinkCapability } from "./vendor-link-rules";
import { newVendorToken, hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import { requireOrgScope } from "./org-guard";
import { auditScope, recordAudit } from "./audit-write";
import { assertIdentifiers } from "./repair-approval-rules";
import type { Session } from "./types";
import type { VendorAccountHistory } from "../lib/vendor-account-types";
import { consentCoversCurrent, readConsent } from "./consent";
import { readPartnerStateOn } from "./partner-consent";

function sessionHash(token: string) {
  if (!token || token.length > 512) throw new FlowError("errors.forbidden");
  return createHash("sha256").update(token).digest("hex");
}
async function actorOn(client: Client, token: string) {
  return (await client.query<{ actor: string }>("SELECT app.b026_account_actor($1) AS actor", [sessionHash(token)])).rows[0].actor;
}
/** Account routes use the auth cookie directly: no persona provisioning or session-touch writes. */
export async function authorizeVendorAccountRequest(request: Request) {
  const raw = request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith("condola_session="))?.slice("condola_session=".length);
  if (!raw) throw new FlowError("errors.forbidden");
  const actor = await svc(null, client => actorOn(client, raw));
  if (!consentCoversCurrent(await readConsent(actor))) throw new FlowError("errors.consentRequired");
  return raw;
}
/** Staff context is selected explicitly and revalidated by each SQL gateway. No session touch. */
export async function authorizeVendorAccountStaffRequest(request: Request): Promise<Session> {
  const credential = await authorizeVendorAccountRequest(request);
  const org = request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith("condola_org="))?.slice("condola_org=".length);
  if (!org) throw new FlowError("errors.forbidden");
  assertIdentifiers(org);
  const env = request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith("condola_env="))?.slice("condola_env=".length) ?? "live";
  if (env !== "live" && env !== "sandbox") throw new FlowError("errors.forbidden");
  return svc(null, async client => {
    const row = (await client.query<{ user_id: string; session_id: string; org_id: string; environment: "live" | "sandbox"; live_org_id: string; role: "admin" | "manager" }>(
      `SELECT s.user_id,s.id session_id,o.id org_id,o.environment,coalesce(o.live_org_id,o.id) live_org_id,m.role
       FROM auth_sessions s JOIN org_members m ON m.user_id=s.user_id
       JOIN organizations o ON o.id=m.org_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
       AND m.status='active' AND m.role IN ('admin','manager') AND o.environment::text=$3
       AND (o.id=$2 OR ($3='sandbox' AND o.live_org_id=$2))`, [sessionHash(credential), org, env])).rows[0];
    if (!row) throw new FlowError("errors.forbidden");
    const session: Session = { userId: row.user_id, sessionId: row.session_id, orgId: row.org_id,
      liveOrgId: row.live_org_id, environment: row.environment, kind: "staff", role: row.role,
      locale: "zh-TW", calendar: "gregorian", email: "", name: "", leaseId: null };
    session.partnerConsent = await readPartnerStateOn(client, session);
    if (session.partnerConsent.required) throw new FlowError("errors.consentRequired");
    return session;
  });
}
export async function vendorAccountHistory(sessionToken: string): Promise<VendorAccountHistory> {
  return svc(null, async client => (await client.query<{ result: VendorAccountHistory }>(
    "SELECT app.b026_vendor_account_history($1) AS result", [sessionHash(sessionToken)])).rows[0].result);
}
/** Recompute capability using wall clock AFTER the post-state read, then plan; SQL rechecks under locks. */
export async function syncVendorAccount(sessionToken: string) {
  const hash = sessionHash(sessionToken);
  const candidates = await svc(null, async client => {
    await actorOn(client, sessionToken);
    return (await client.query<{ token: string }>("SELECT token FROM app.b026_account_candidates($1)", [hash])).rows;
  });
  let linked = 0;
  for (const candidate of candidates) linked += await svc(null, async client => {
    const actor = await actorOn(client, sessionToken);
    const resolution = await resolveVendorIdentity(client, { token: candidate.token, linkedUserId: null, now: new Date() });
    if (!resolution) return 0;
    const gate = (await client.query<{ enabled: boolean }>("SELECT app.b026_accounts_enabled($1) AS enabled", [resolution.orgId])).rows[0].enabled;
    if (gate !== true) return 0;
    const post = (await client.query<{ active: boolean; revoked_at: Date | null; expires_at: Date; status: string }>(
      `SELECT j.active,j.revoked_at,j.expires_at,t.status::text FROM repair_vendor_jobs j
       JOIN maintenance_tickets t ON t.id=j.ticket_id AND t.org_id=j.org_id
       WHERE j.id=$1 AND j.token_hash=$2 AND j.vendor_contact_id=t.assigned_vendor_contact_id
       AND j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL`, [resolution.jobId, resolution.tokenHash])).rows[0];
    const now = new Date();
    if (!post) return 0;
    const capability = vendorLinkCapability({ active: post.active, revokedAt: post.revoked_at,
      expiresAt: post.expires_at, ticketStatus: post.status, now });
    if (capability !== "write") return 0;
    const plan = planVendorAttribution({ ...resolution, capability, linkable: true }, actor, now, gate === true, "existing_open");
    if (plan.status !== "attributable") return 0;
    const result = await client.query<{ linked: boolean }>("SELECT app.b026_link_vendor_job($1,$2) AS linked", [hash, plan.record.tokenHash]);
    return result.rows[0].linked === true ? 1 : 0;
  });
  return { linked };
}
export async function claimVendorAccount(sessionToken: string, invitation: string) {
  if (!vendorTokenAcceptable(invitation)) throw new FlowError("errors.forbidden");
  const result = await svc(null, async client => (await client.query<{ result: { status: "claimed" | "disabled"; orgId?: string } }>(
    "SELECT app.b026_claim_vendor_account($1,$2) AS result", [sessionHash(sessionToken), hashVendorToken(invitation)])).rows[0].result);
  if (result.status === "claimed") await syncVendorAccount(sessionToken);
  return result;
}
function staffScope(session: Session) {
  requireOrgScope(session);
  assertIdentifiers(session.orgId, session.liveOrgId, session.sessionId);
  if (session.kind !== "staff" || !["admin", "manager"].includes(session.role ?? "")) throw new FlowError("errors.forbidden");
  return { orgId: session.orgId, environment: session.environment };
}
export async function inviteVendorAccount(session: Session, contactId: string, userId: string) {
  const scope = staffScope(session);
  assertIdentifiers(contactId, userId);
  const token = newVendorToken();
  return svc(session.userId, async client => {
    const id = (await client.query<{ id: string | null }>("SELECT app.b026_invite_vendor_account($1,$2,$3,$4,$5,$6,$7) AS id",
      [scope.orgId, session.liveOrgId, scope.environment, session.sessionId, contactId, userId, hashVendorToken(token)])).rows[0].id;
    if (!id) return { status: "disabled" as const };
    await recordAudit(auditScope(session, scope), { table: "contacts", rowId: contactId, action: "insert",
      eventType: "vendor_account_invited", reason: "vendor_account_invited", newRow: { invitation_id: id, user_id: userId } }, client);
    return { status: "invited" as const, invitation: token };
  });
}
/** Revoke the old binding and invite its replacement; acceptance remains mandatory. */
export async function rebindVendorAccount(session: Session, contactId: string, userId: string) {
  const scope = staffScope(session);
  assertIdentifiers(contactId, userId);
  const token = newVendorToken();
  return svc(session.userId, async client => {
    const result = (await client.query<{ result: { status: "disabled" | "invited"; invitationId?: string; eventId?: string; previousUserId?: string } }>(
      "SELECT app.b026_rebind_vendor_account($1,$2,$3,$4,$5,$6,$7) AS result",
      [scope.orgId, session.liveOrgId, scope.environment, session.sessionId, contactId, userId, hashVendorToken(token)])).rows[0].result;
    if (result.status === "disabled") return { status: "disabled" as const };
    await recordAudit(auditScope(session, scope), { table: "contacts", rowId: contactId, action: "update",
      eventType: "vendor_account_rebound", reason: "staff_rebind",
      newRow: { previous_user_id: result.previousUserId, user_id: userId, invitation_id: result.invitationId, event_id: result.eventId } }, client);
    return { status: "invited" as const, invitation: token };
  });
}
export async function correctVendorJobAccount(session: Session, jobId: string, userId: string | null) {
  const scope = staffScope(session);
  assertIdentifiers(jobId, ...(userId === null ? [] : [userId]));
  return svc(session.userId, async client => {
    const result = (await client.query<{ result: { status: string; eventId?: string } }>(
      "SELECT app.b026_correct_vendor_job($1,$2,$3,$4,$5,$6) AS result",
      [scope.orgId, session.liveOrgId, scope.environment, session.sessionId, jobId, userId])).rows[0].result;
    if (result.status === "corrected") await recordAudit(auditScope(session, scope), {
      table: "repair_vendor_jobs", rowId: jobId, action: "update", eventType: "vendor_account_corrected",
      reason: userId === null ? "staff_unlink" : "staff_correct", newRow: { event_id: result.eventId, user_id: userId },
    }, client);
    return result;
  });
}

export async function vendorAccountLinkEvents(session: Session, jobId: string) {
  const scope = staffScope(session);
  assertIdentifiers(jobId);
  return svc(session.userId, async client => {
    const result = (await client.query<{ result: { id: string; actorId: string; reason: string; previousUserId: string | null; userId: string | null; at: string }[] }>(
      "SELECT app.b026_vendor_link_events_for_staff($1,$2,$3,$4,$5) AS result",
      [scope.orgId, session.liveOrgId, scope.environment, session.sessionId, jobId])).rows[0].result;
    if (result.length) await recordAudit(auditScope(session, scope), { table: "repair_vendor_jobs", rowId: jobId,
      action: "select", eventType: "vendor_account_link_history", reason: "vendor_account_link_history",
      newRow: { event_ids: result.map(event => event.id) } }, client);
    return result;
  });
}

/** Called only after password verification; this is routing, never account authorization. */
export async function vendorAccountLoginAccess(userId: string) {
  return svc(null, async client => (await client.query<{ enabled: boolean }>(
    "SELECT app.b026_vendor_login_access($1) AS enabled", [userId])).rows[0].enabled === true);
}
