import { AsyncLocalStorage } from "node:async_hooks";
import {
  costCapBlock,
  dailyCap,
  inSliceCountry,
  maskE164,
  normalizeE164,
  numberKey,
  parseDestAllowlist,
  rateLimitBlock,
  type SmsRateRefusal,
} from "./guards";
import { isSlicePurpose, SMS_PURPOSES } from "./purposes";
import { selectTransport, type SmsTransport, type SmsTransportMode } from "./transport";

export type SmsOtpRequest = {
  purpose: unknown; // Set server-side per route; still checked at runtime.
  to: unknown;
  orgId: string | null;
  ip: string | null;
  deviceId: string | null;
  requestId?: string | null;
  actorUserId?: string | null;
  locale?: "zh-TW" | "en";
};

export type SmsOtpRefusal =
  | "purpose_not_allowed"
  | "invalid_e164"
  | "country_not_in_slice"
  | "dest_allowlist_missing"
  | "dest_allowlist_invalid"
  | "dest_not_allowlisted"
  | "flag_off"
  | "org_missing"
  | SmsRateRefusal
  | "daily_cost_cap"
  | "live_config_missing"
  | "provider_error";

export type SmsOtpResult =
  | { ok: true; status: "captured" | "pending"; mode: SmsTransportMode }
  | { ok: false; reason: SmsOtpRefusal };

export type SmsOtpDeps = {
  env: Record<string, string | undefined>;
  flagOn: (orgId: string) => Promise<boolean>;
  ledger: SmsLedger;
  transport?: SmsTransport;
  audit: (row: SmsAuditRow) => Promise<void>;
  now?: () => number;
};

type CountQuery = { numberKey: string; ip: string | null; deviceId: string | null; now: number };
type Counts = {
  numberHour: number;
  numberDay: number;
  ipHour: number;
  deviceHour: number;
  lastToNumberAt: number | null;
  providerSendsToday: number;
};

export interface SmsLedger {
  counts(q: CountQuery): Promise<Counts>;
  // Serialize globally; counts and the completion audit must share the lock.
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export type SmsAuditRow = {
  event: "sms_otp_refused" | "sms_otp_captured" | "sms_otp_sent" | "sms_otp_provider_error";
  purpose: string;
  reason: SmsOtpRefusal | null;
  toMasked: string | null;
  numberKey: string | null;
  orgId: string | null;
  ip: string | null;
  deviceId: string | null;
  mode: SmsTransportMode | null;
  requestId: string | null;
  actorUserId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length === 36 && UUID.test(value) ? value : null;
}

function auditMetadata(value: string | null | undefined): string | null {
  // Never accept an E.164 destination copied into ancillary metadata.
  return value != null && !/\+[1-9]\d{7,14}/.test(value) ? value : null;
}

export async function requestSmsOtp(input: SmsOtpRequest, deps: SmsOtpDeps): Promise<SmsOtpResult> {
  const { purpose, locale } = input;
  const orgId = uuidOrNull(input.orgId);
  const ip = auditMetadata(input.ip);
  const deviceId = auditMetadata(input.deviceId);
  const context = {
    purpose: SMS_PURPOSES.find((known) => known === purpose) ?? "unknown",
    orgId,
    ip,
    deviceId,
    requestId: auditMetadata(input.requestId),
    actorUserId: uuidOrNull(input.actorUserId),
  };
  let toMasked: string | null = null;
  let key: string | null = null;
  let mode: SmsTransportMode | null = null;

  async function write(event: SmsAuditRow["event"], reason: SmsOtpRefusal | null) {
    await deps.audit({ ...context, event, reason, toMasked, numberKey: key, mode });
  }

  async function refuse(reason: SmsOtpRefusal): Promise<SmsOtpResult> {
    await write(reason === "provider_error" ? "sms_otp_provider_error" : "sms_otp_refused", reason);
    return { ok: false, reason };
  }

  if (!isSlicePurpose(purpose)) return refuse("purpose_not_allowed");
  const to = normalizeE164(input.to);
  if (to === null) return refuse("invalid_e164");
  toMasked = maskE164(to);
  const destinationKey = numberKey(to);
  key = destinationKey;
  if (!inSliceCountry(to)) return refuse("country_not_in_slice");

  const allowlist = parseDestAllowlist(deps.env.SMS_DEST_ALLOWLIST);
  if (!allowlist.ok) return refuse(allowlist.reason);
  if (!allowlist.set.has(to)) return refuse("dest_not_allowlisted");

  if (orgId === null) return refuse("org_missing");
  let enabled: boolean;
  try {
    enabled = (await deps.flagOn(orgId)) === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return refuse("flag_off");

  return deps.ledger.withLock(async () => {
    const now = (deps.now ?? Date.now)();
    const counts = await deps.ledger.counts({ numberKey: destinationKey, ip, deviceId, now });
    const rateBlock = rateLimitBlock({
      ...counts,
      secondsSinceLastToNumber: counts.lastToNumberAt === null ? null : (now - counts.lastToNumberAt) / 1000,
    });
    if (rateBlock) return refuse(rateBlock);
    const capBlock = costCapBlock(counts.providerSendsToday, dailyCap(deps.env));
    if (capBlock) return refuse(capBlock);

    const selected = deps.transport ? { transport: deps.transport } : selectTransport(deps.env);
    if ("error" in selected) return refuse(selected.error);
    const { transport } = selected;
    mode = transport.mode;

    let status: "captured" | "pending";
    try {
      ({ status } = await transport.startVerification({ to, purpose, ...(locale ? { locale } : {}) }));
    } catch {
      return refuse("provider_error");
    }
    await write(mode === "capture" ? "sms_otp_captured" : "sms_otp_sent", null);
    return { ok: true, status, mode };
  });
}

type DbClient = Parameters<Parameters<typeof import("@/server/db").withClient>[0]>[0];
const transactionClient = new AsyncLocalStorage<DbClient>();

export function createAuditLogSmsLedger(): SmsLedger {
  return {
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      if (transactionClient.getStore()) throw new Error("sms_otp_nested_lock");
      const { withClient } = await import("@/server/db");
      return withClient(async (client) => {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        try {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('condola_sms_otp_daily'))");
          const result = await transactionClient.run(client, fn);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      });
    },
    async counts(q) {
      const client = transactionClient.getStore();
      if (!client) throw new Error("sms_otp_lock_required");
      const { rows } = await client.query<Counts>(
        `WITH bounds AS (
           SELECT to_timestamp($4::double precision / 1000) - interval '1 hour' AS hour_start,
                  to_timestamp($4::double precision / 1000) - interval '24 hours' AS day_start,
                  date_trunc('day', clock_timestamp() AT TIME ZONE 'America/Los_Angeles')
                    AT TIME ZONE 'America/Los_Angeles' AS pacific_start
         )
         SELECT
           (count(*) FILTER (WHERE row_id = $1 AND occurred_at >= hour_start))::int AS "numberHour",
           (count(*) FILTER (WHERE row_id = $1 AND occurred_at >= day_start))::int AS "numberDay",
           (count(*) FILTER (WHERE new_row->>'ip' = $2 AND occurred_at >= hour_start))::int AS "ipHour",
           (count(*) FILTER (WHERE new_row->>'device_id' = $3 AND occurred_at >= hour_start))::int AS "deviceHour",
           (extract(epoch FROM max(occurred_at) FILTER (WHERE row_id = $1)) * 1000)
             ::double precision AS "lastToNumberAt",
           (count(*) FILTER (WHERE event_type IN ('sms_otp_captured', 'sms_otp_sent')
                                     AND occurred_at >= pacific_start))::int AS "providerSendsToday"
         FROM audit_log CROSS JOIN bounds
         WHERE table_name = 'sms_otp'
           AND event_type IN ('sms_otp_captured', 'sms_otp_sent', 'sms_otp_provider_error')
           AND (row_id = $1 OR occurred_at >= least(hour_start, pacific_start))`,
        [q.numberKey, q.ip, q.deviceId, q.now],
      );
      const counts = rows[0];
      if (!counts) throw new Error("sms_otp_counts_missing");
      return counts;
    },
  };
}

export async function auditLogSmsAudit(row: SmsAuditRow): Promise<void> {
  const sql = `INSERT INTO audit_log
    (org_id, actor_user_id, actor_role, table_name, row_id, action,
     event_type, new_row, reason, request_id, occurred_at)
    VALUES ($1, $2, 'system', 'sms_otp', $3, 'insert', $4, $5::jsonb, $6, $7, clock_timestamp())`;
  const params = [
    row.orgId,
    row.actorUserId,
    row.numberKey ?? "none",
    row.event,
    JSON.stringify({
      purpose: row.purpose,
      reason: row.reason,
      to_masked: row.toMasked,
      mode: row.mode,
      ip: row.ip,
      device_id: row.deviceId,
    }),
    row.reason,
    row.requestId,
  ];
  const client = transactionClient.getStore();
  if (client) {
    await client.query(sql, params);
  } else {
    const { query } = await import("@/server/db");
    await query(sql, params);
  }
}

export async function smsOtpFlagOn(orgId: string): Promise<boolean> {
  if (!uuidOrNull(orgId)) return false;
  const { svc } = await import("@/server/db");
  return svc(null, async (client) => {
    const { rows } = await client.query<{ enabled: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.organizations o
         JOIN public.platform_settings f ON f.key = 'sms_otp'
         WHERE o.id = $1 AND o.feature_flags->'sms_otp' = 'true'::jsonb
           AND f.value->'enabled' = 'true'::jsonb
           AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
           AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
       ) AS enabled`,
      [orgId],
    );
    return rows[0]?.enabled === true;
  });
}
