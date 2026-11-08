import { maybe, tx } from "./db";
import { guardEffectiveSession } from "./b017-custom-role-governance";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** B-019 flag mirror (strict === true): platform_settings.tenant_thread_create + org flag. */
export function tenantThreadCreateOn(global: unknown, flags: unknown, orgId: string): boolean {
  if (!global || typeof global !== "object" || Array.isArray(global) || !flags || typeof flags !== "object" || Array.isArray(flags)) return false;
  const g = global as Record<string, unknown>, f = flags as Record<string, unknown>;
  return g.enabled === true && Array.isArray(g.allowed_org_ids) && g.allowed_org_ids.includes(orgId) && f.tenant_thread_create === true;
}

export async function tenantThreadCreateEnabled(session: Session): Promise<boolean> {
  if (session.kind !== "tenant" || !uuid.test(session.orgId)) return false;
  session = await guardEffectiveSession(session, null);
  try {
    return await tx(session.userId, async (client) => {
      const row = await maybe<{ global: unknown; flags: unknown }>(client,
        `SELECT (SELECT value FROM platform_settings WHERE key='tenant_thread_create') AS global, feature_flags AS flags FROM organizations WHERE id=$1`, [session.orgId]);
      return tenantThreadCreateOn(row?.global, row?.flags, session.orgId);
    }, requireOrgScope(session), { readOnly: true });
  } catch { return false; }
}

/** Starts (or idempotently replays) the lease conversation with the tenant's first message. */
export async function startTenantThread(session: Session, input: { leaseId: string; requestId: string; body: string }) {
  if (session.kind !== "tenant" || !uuid.test(input?.leaseId ?? "") || !uuid.test(input?.requestId ?? "") || typeof input.body !== "string") return { state: "unavailable" as const };
  if (!input.body.trim() || input.body.length > 4000) return { state: "invalid" as const };
  session = await guardEffectiveSession(session, null);
  try {
    const threadId = await tx(session.userId, async (client) => (await client.query<{ id: string }>(
      `SELECT app.b019_start_tenant_thread($1,$2,$3)::text AS id`, [input.leaseId, input.requestId, input.body])).rows[0].id, requireOrgScope(session));
    return { state: "started" as const, threadId };
  } catch { return { state: "unavailable" as const }; }
}
