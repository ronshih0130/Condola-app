import type { Client } from "pg";
import { svc } from "./db";
import { readLineConfig } from "./line/config";

export type DeliveryChannel = "email" | "line";
export type DeliveryStatus = "queued" | "claimed" | "captured" | "accepted" | "failed" | "unknown";
export type DeliveryResult = {
  result: "captured" | "accepted" | "failed" | "unknown";
  providerRef?: string;
  failureCode?: string;
};
export type DeliveryRequest = {
  attemptId: string;
  sourceKind: string;
  sourceId: string;
  recipientKey: string;
  attempt: number;
};
export interface DeliveryAdapter {
  channel: DeliveryChannel;
  deliver(req: DeliveryRequest): Promise<DeliveryResult>;
}

/** Local preparation only; this adapter has no transport. */
export function createCaptureAdapter(channel: DeliveryChannel): DeliveryAdapter & { captures: DeliveryRequest[] } {
  const captures: DeliveryRequest[] = [];
  return {
    channel,
    captures,
    async deliver(req) {
      captures.push({ ...req });
      return { result: "captured" };
    },
  };
}

function deliverySvc<T>(orgId: string, fn: (client: Client) => Promise<T>) {
  return svc(null, async (client) => {
    await client.query("SELECT set_config('app.active_org_id',$1,true)", [orgId]);
    return fn(client);
  });
}

/** Service entry points: callers authorize the selected organization first. */
export async function enqueueDelivery(orgId: string, sourceKind: string, sourceId: string, recipientKey: string, channel: DeliveryChannel): Promise<string> {
  return deliverySvc(orgId, async (client) => (await client.query<{ id: string }>(
    "SELECT app.b028_delivery_enqueue($1,$2,$3,$4,$5) AS id",
    [orgId, sourceKind, sourceId, recipientKey, channel],
  )).rows[0].id);
}

type Claim = { attempt_id: string; token: string; source_kind: string; source_id: string; recipient_key: string; attempt: number };
/** Claim lease; the adapter call is bounded to half of it so ownership holds for the whole dispatch. */
export const DELIVERY_CLAIM_TTL_SECONDS = 120;
export const DELIVERY_ADAPTER_TIMEOUT_MS = (DELIVERY_CLAIM_TTL_SECONDS * 1000) / 2;

async function boundedDeliver(adapter: DeliveryAdapter, req: DeliveryRequest, timeoutMs: number): Promise<DeliveryResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.deliver(req),
      new Promise<DeliveryResult>((resolve) => { timer = setTimeout(() => resolve({ result: "unknown", failureCode: "adapter_timeout" }), timeoutMs); }),
    ]);
  } catch {
    return { result: "failed", failureCode: "adapter_error" };
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Claims ONE attempt at a time immediately before dispatching it (never a batch whose later
 * items could expire while earlier ones run), so a claim cannot be re-taken by another worker
 * while its adapter call is in flight. `attemptId` is stable across retries: transports use it
 * as their idempotency key. A timed-out adapter is recorded as `unknown` and is never
 * automatically retried (the provider may still accept it); it needs reconciliation first.
 * Never pass or log tokens.
 */
export async function runDeliveryAttempts(orgId: string, adapter: DeliveryAdapter, limit: number,
  options: { adapterTimeoutMs?: number } = {}): Promise<number> {
  const timeoutMs = Math.min(options.adapterTimeoutMs ?? DELIVERY_ADAPTER_TIMEOUT_MS, DELIVERY_ADAPTER_TIMEOUT_MS);
  // OFF keeps the original B-028 query sequence. Maintenance has its own bounded
  // transaction: a failure rolls it back, leaves deadlines retryable, and never
  // prevents unrelated Email claims. Log only a classified SQLSTATE, never DB text.
  if (adapter.channel === "email" && readLineConfig().platformEnabled) {
    let maintenanceCode: string | undefined;
    try {
      await deliverySvc(orgId, async client => {
        try {
          await client.query("SET LOCAL statement_timeout='750ms'");
          const installed = (await client.query("SELECT to_regprocedure('app.b033_push_expire(uuid)') IS NOT NULL AS installed")).rows[0].installed;
          if (installed) await client.query("SELECT app.b033_push_expire($1)", [orgId]);
        } catch (error) {
          maintenanceCode = (error as { code?: string })?.code;
          throw error;
        }
      });
    } catch (error) {
      const code = maintenanceCode ?? (error as { code?: string })?.code;
      console.error("b033_expiry_retry_pending", { code: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown" });
    }
  }
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const claim = (await deliverySvc(orgId, async (client) => (await client.query<Claim>(
      "SELECT * FROM app.b028_delivery_claim($1,$2,1,$3)", [orgId, adapter.channel, DELIVERY_CLAIM_TTL_SECONDS],
    )).rows))[0];
    if (!claim) break;
    const outcome = await boundedDeliver(adapter, { attemptId: claim.attempt_id, sourceKind: claim.source_kind,
      sourceId: claim.source_id, recipientKey: claim.recipient_key, attempt: claim.attempt }, timeoutMs);
    await deliverySvc(orgId, (client) => client.query(
      "SELECT app.b028_delivery_complete($1,$2,$3,$4,$5)",
      [claim.attempt_id, claim.token, outcome.result, outcome.providerRef ?? null, outcome.failureCode ?? null],
    ));
    processed++;
  }
  return processed;
}

export async function deliveryStatus(orgId: string, sourceKind: string, sourceId: string): Promise<Record<DeliveryStatus, number>> {
  const rows = await deliverySvc(orgId, async (client) => (await client.query<{ status: DeliveryStatus; count: string }>(
    "SELECT * FROM app.b028_delivery_status($1,$2,$3)", [orgId, sourceKind, sourceId],
  )).rows);
  const counts = { queued: 0, claimed: 0, captured: 0, accepted: 0, failed: 0, unknown: 0 };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}
