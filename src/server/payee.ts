import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireEffectivePerm } from "./b017-custom-role-governance";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./auth";
import { withClient } from "./db";
import { requireOrgScope, txForSession } from "./org-guard";
import { readSession, sessionTokenHash } from "./session";
import type { Session } from "./types";
import type { PayeeAccount, PayeeInput, TenantPayeeView } from "./payee-rules";
import { tenantPayeeDecision, validUuid } from "./payee-rules";

type Result<T> = { ok: boolean; reason: string; data: T | null };
type Settings = { country: string; accounts: PayeeAccount[]; owners: { id: string; display_name: string }[]; leases: { id: string; payee_bank_account_id: string | null; label?: string }[] };
type PayeeContext = Pick<Session, "sessionId" | "userId"> & { orgId: string | null; environment: "live" | "sandbox" | null };

/** Preserve a verified identity even when no organization can be resolved. */
export async function readPayeeContext(): Promise<PayeeContext | null> {
  const session = await readSession();
  if (session) return session;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await withClient(async (client) => client.query<{ session_id: string; user_id: string }>(
    `SELECT id::text AS session_id,user_id::text FROM auth_sessions
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`, [sessionTokenHash(token)],
  ));
  return row.rows[0] ? { sessionId: row.rows[0].session_id, userId: row.rows[0].user_id, orgId: null, environment: null } : null;
}

/** Commit the gateway decision and audit before exposing a result to the caller. */
async function gateway<T>(session: PayeeContext | null, op: "settings" | "tenant" | "save" | "assign" | "ingress", target: string | null = null, input: object = {}): Promise<Result<T>> {
  try {
    return await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE service_role");
        const row = await client.query<{ result: Result<T> }>(
          `SELECT app.payee_gateway($1::uuid,$2::uuid,$3::uuid,$4::text,$5::uuid,$6::text,$7::uuid,$8::jsonb) AS result`,
          [session?.sessionId ?? null, session?.userId ?? null, session?.orgId ?? null, session?.environment ?? null, randomUUID(), op, target, JSON.stringify(input)],
        );
        if (op !== "ingress" && session && "kind" in session) await requireEffectivePerm(client, session as Session, op === "tenant" ? "stmt.view" : "settings.edit");
        await client.query("COMMIT");
        return row.rows[0].result;
      } catch {
        try { await client.query("ROLLBACK"); } catch { /* fixed failure below */ }
        throw new Error("Payee access unavailable");
      }
    });
  } catch {
    // Do not pass database error text, details or inputs to logging or clients.
    throw new Error("Payee access unavailable");
  }
}

export async function payeeSettings(session: Session): Promise<Settings | null> {
  session = await guardEffectiveSession(session, "settings.edit");
  const result = await gateway<Settings>(session, "settings");
  const data = result.data;
  if (!result.ok || !data) return null;
  // Full details were authorized and audited by the gateway. Resolve only
  // same-org display labels here so the settings form does not expose UUIDs.
  const scope = requireOrgScope(session) as { orgId: string; environment: "live" | "sandbox" };
  const { orgId } = scope;
  const labels = await txForSession(session, async (client) => client.query<{ id: string; label: string }>(
    `SELECT l.id::text, concat_ws(' · ', p.name, u.label, l.start_date::text) AS label
       FROM leases l JOIN properties p ON p.id=l.property_id AND p.org_id=l.org_id
       LEFT JOIN units u ON u.id=l.unit_id AND u.org_id=l.org_id
      WHERE l.org_id=$1 AND l.id=ANY($2::uuid[])`,
    [orgId, data.leases.map(lease => lease.id)],
  ), { readOnly: true });
  const byId = new Map(labels.rows.map(lease => [lease.id, lease.label]));
  return { ...data, leases: data.leases.map(lease => ({...lease, label: byId.get(lease.id)})) };
}

export async function tenantPayee(session: Session, leaseId: string, unavailableOnDenied = false): Promise<TenantPayeeView> {
  session = await guardEffectiveSession(session, null);
  const valid = validUuid(leaseId);
  const result = await gateway<TenantPayeeView>(session, "tenant", valid ? leaseId : null, { invalid: !valid });
  return tenantPayeeDecision(result, unavailableOnDenied);
}

export async function savePayee(session: Session | null, input: PayeeInput) {
  session = await guardEffectiveSession(session, "settings.edit");
  const valid = !input.id || validUuid(input.id);
  const target = valid ? input.id || null : null;
  const result = await gateway<{ accountId: string }>(session, "save", target, { ...input, invalid: !valid });
  if (!result.ok || !result.data) throw new Error("Payee access unavailable");
  return result.data.accountId;
}

export async function setLeasePayee(session: Session | null, leaseId: string | null, accountId: string | null) {
  session = await guardEffectiveSession(session, "settings.edit");
  const valid = !!leaseId && validUuid(leaseId) && (accountId === null || validUuid(accountId));
  const result = await gateway<{ leaseId: string; accountId: string | null }>(session, "assign", valid ? leaseId : null, { accountId, invalid: !valid });
  if (!result.ok || !result.data) throw new Error("Payee access unavailable");
  return result.data;
}

/** Explicit unauthenticated/no-context payee requests only, not ordinary page redirects. */
export async function logPayeeIngress(session: PayeeContext | null) {
  await gateway(session, "ingress");
}
