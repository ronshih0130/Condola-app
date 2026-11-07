import type { Client } from "pg";
import { simulatedResult, type ResendResult, type ResendStatus } from "../lib/portal-resend-state";
import { tx } from "./db";
import { can } from "./perms";
import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { portalResendMockTransport } from "./portal-resend-mock-transport";
import type { Session } from "./types";

export function portalResendOn(global: unknown, flags: unknown, orgId: string): boolean {
  if (!global || typeof global !== "object" || Array.isArray(global) || !flags || typeof flags !== "object" || Array.isArray(flags)) return false;
  const g = global as Record<string, unknown>, f = flags as Record<string, unknown>;
  return g.enabled === true && Array.isArray(g.allowed_org_ids) && g.allowed_org_ids.includes(orgId.toLowerCase()) && f.INVITE_RESEND_RESULTS === true;
}
export async function portalResendEnabled(client: Client, orgId: string) {
  const { rows } = await client.query<{ value: unknown; feature_flags: unknown }>(
    `SELECT (SELECT value FROM platform_settings WHERE key='INVITE_RESEND_RESULTS') AS value,
      feature_flags FROM organizations WHERE id=$1`, [orgId]);
  return portalResendOn(rows[0]?.value, rows[0]?.feature_flags, orgId);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Input = Readonly<{ sourceId: string; requestId: string }>;
type Claim = { status: ResendStatus; claimed: boolean; deadline_at: Date | null };
type Dependencies = { transport?: (signal: AbortSignal) => Promise<unknown>; timeoutMs?: number };

/** Session comes from the authenticated server entrypoint. Only identifiers are
 * accepted from the caller; the claim RPC derives eligibility and fingerprint.
 * No process-local reservation or promise cache: replay works on another worker.
 */
export async function resendPortalInvite(session: Session, input: Input, dependencies: Dependencies = {}): Promise<ResendResult> {
  if (session.kind !== "staff" || !["admin", "manager"].includes(session.role ?? "") || !can(session, "leases.edit")) return simulatedResult("unavailable");
  session = await guardEffectiveSession(session, "leases.edit");
  if (![session.orgId, session.userId, input?.sourceId, input?.requestId].every(value => typeof value === "string" && uuid.test(value))) return simulatedResult("conflict");
  const scope = { orgId: session.orgId.toLowerCase(), environment: session.environment };
  const timeout = dependencies.timeoutMs ?? 2000;
  const claim = () => tx(session.userId, async client => withEffectiveAuthority(client, session, "leases.edit", async () => (await client.query<Claim>(
    `SELECT * FROM app.b005_resend_claim($1,$2,$3,$4)`, [scope.orgId, input.sourceId, input.requestId, timeout])).rows[0]), scope);
  const settle = (outcome: unknown) => tx(session.userId, async client => {
    const safe = outcome === "captured" || outcome === "accepted" || outcome === "rejected" ? outcome : "unknown";
    const { rows } = await client.query<{ status: ResendStatus }>(`SELECT app.b005_resend_settle($1,$2,$3) AS status`, [scope.orgId, input.requestId, safe]);
    return simulatedResult(rows[0].status);
  }, scope);
  let entry = await claim();
  if (entry.claimed) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = Math.max(0, entry.deadline_at!.getTime() - Date.now());
      const outcome = await Promise.race([
        new Promise<"unknown">((resolve) => { timer = setTimeout(() => { controller.abort(); resolve("unknown"); }, remaining); }),
        Promise.resolve().then(() => remaining > 0 ? (dependencies.transport ?? portalResendMockTransport)(controller.signal) : "unknown").catch(() => "unknown"),
      ]);
      return await settle(outcome);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  while (entry.status === "processing") {
    await new Promise(resolve => setTimeout(resolve, 20));
    entry = await claim(); // Also terminalizes an expired claim left by a lost worker.
  }
  return simulatedResult(entry.status);
}

/** Read-only page adapter. Flag OFF returns before reading any invitation. */
export async function portalResendControl(session: Session, contactId: string, kind: "owner" | "tenant", leaseId?: string) {
  if (session.kind !== "staff" || !["admin", "manager"].includes(session.role ?? "") || !can(session, "leases.edit")) return null;
  session = await guardEffectiveSession(session, "leases.edit");
  return tx(session.userId, async client => {
    if (!await portalResendEnabled(client, session.orgId)) return null;
    const { rows } = await client.query<{ id: string; company: string }>(
      `SELECT i.id,o.name AS company FROM invitations i JOIN organizations o ON o.id=i.org_id
       WHERE i.org_id=$1 AND i.contact_id=$2 AND i.kind=$3
         AND ($3='owner' OR i.lease_id=$4) ORDER BY i.created_at DESC,i.id LIMIT 1`,
      [session.orgId, contactId, kind, leaseId ?? null]);
    return rows[0] ?? null;
  }, { orgId: session.orgId, environment: session.environment });
}
