import { tx } from "./db";
import { guardEffectiveSession } from "./b017-custom-role-governance";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type TenantSessionRow = { id: string; created_at: string; last_active_at: string; expires_at: string; current: boolean };
const tenant = (s: Session) => s.kind === "tenant" && uuid.test(s.orgId) && uuid.test(s.sessionId ?? "");

/** B-020: own active sessions; null when the flag is OFF or the caller is not an admitted tenant. */
export async function tenantSessions(session: Session): Promise<TenantSessionRow[] | null> {
  if (!tenant(session)) return null;
  session = await guardEffectiveSession(session, null);
  try {
    return await tx(session.userId, async (client) => (await client.query<Omit<TenantSessionRow, "current">>(
      `SELECT id::text,created_at::text,last_active_at::text,expires_at::text FROM app.b020_my_sessions($1)`, [session.orgId])).rows
      .map((r) => ({ ...r, current: r.id === session.sessionId })), requireOrgScope(session), { readOnly: true });
  } catch { return null; }
}

/** Revoke another of the caller's sessions; the current session cannot be revoked here. */
export async function revokeTenantSession(session: Session, sessionId: string) {
  if (!tenant(session) || !uuid.test(sessionId) || sessionId === session.sessionId) return { state: "unavailable" as const };
  session = await guardEffectiveSession(session, null);
  try {
    const ok = await tx(session.userId, async (client) => (await client.query<{ ok: boolean }>(
      `SELECT app.b020_revoke_session($1,$2,$3) AS ok`, [session.orgId, sessionId, session.sessionId])).rows[0].ok, requireOrgScope(session));
    return { state: ok ? "revoked" as const : "unavailable" as const };
  } catch { return { state: "unavailable" as const }; }
}

/** Idempotent data request (backend only; UI waits for approved copy). */
export async function submitTenantDataRequest(session: Session, input: { requestId: string; kind: "export" | "correction" | "deletion" }) {
  if (!tenant(session) || !uuid.test(input?.requestId ?? "") || !["export", "correction", "deletion"].includes(input?.kind)) return { state: "unavailable" as const };
  session = await guardEffectiveSession(session, null);
  try {
    const id = await tx(session.userId, async (client) => (await client.query<{ id: string }>(
      `SELECT app.b020_submit_data_request($1,$2,$3)::text AS id`, [session.orgId, input.requestId, input.kind])).rows[0].id, requireOrgScope(session));
    return { state: "submitted" as const, id };
  } catch { return { state: "unavailable" as const }; }
}
