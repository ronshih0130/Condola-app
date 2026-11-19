import {
  costCapBlock,
  dailyCap,
  deviceKey,
  inSliceCountry,
  ipLiteralOrNull,
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
  | "number_key_secret_missing"
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
  now?: () => number; // In-memory ledger clock only; the SQL ledger uses the DB clock.
};

type CountQuery = { numberKey: string; ip: string; deviceKey: string };
type Counts = {
  numberHour: number;
  numberDay: number;
  ipHour: number;
  deviceHour: number;
  secondsSinceLastToNumber: number | null;
  providerSendsToday: number;
};

export type SmsAuditRow = {
  event: "sms_otp_attempt" | "sms_otp_refused" | "sms_otp_captured" | "sms_otp_sent" | "sms_otp_provider_error";
  purpose: string;
  reason: SmsOtpRefusal | null;
  toMasked: string | null;
  numberKey: string | null;
  orgId: string | null;
  ip: string | null;
  deviceKey: string | null;
  mode: SmsTransportMode | null;
  requestId: string | null;
  actorUserId: string | null;
};

export interface SmsLedgerTransaction {
  counts(q: CountQuery): Promise<Counts>;
  insert(row: SmsAuditRow & { event: "sms_otp_attempt" | "sms_otp_refused" }): Promise<void>;
}

export interface SmsLedger {
  // Count and insert under one global lock. Resolve only after commit and lock release.
  withLock<T>(fn: (tx: SmsLedgerTransaction) => Promise<T>): Promise<T>;
}

type Reservation =
  | { reserved: true; transport: SmsTransport; attempt: SmsAuditRow }
  | { reserved: false; reason: SmsOtpRefusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length === 36 && UUID.test(value) ? value : null;
}

function requestIdOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(value) && !/\d{7,}/.test(value)
    ? value
    : null;
}

export async function requestSmsOtp(input: SmsOtpRequest, deps: SmsOtpDeps): Promise<SmsOtpResult> {
  const { purpose, locale } = input;
  const orgId = uuidOrNull(input.orgId);
  const context = {
    purpose: SMS_PURPOSES.find((known) => known === purpose) ?? "unknown",
    orgId,
    requestId: requestIdOrNull(input.requestId),
    actorUserId: uuidOrNull(input.actorUserId),
  };
  let toMasked: string | null = null;
  let key: string | null = null;
  let device: string | null = null;
  let ip: string | null = null;

  function auditRow<E extends SmsAuditRow["event"]>(
    event: E,
    reason: SmsOtpRefusal | null,
    mode: SmsTransportMode | null = null,
  ): SmsAuditRow & { event: E } {
    return { ...context, event, reason, toMasked, numberKey: key, ip, deviceKey: device, mode };
  }

  async function refuse(reason: SmsOtpRefusal): Promise<SmsOtpResult> {
    await deps.audit(auditRow("sms_otp_refused", reason));
    return { ok: false, reason };
  }

  if (!isSlicePurpose(purpose)) return refuse("purpose_not_allowed");

  const to = normalizeE164(input.to);
  if (to === null) return refuse("invalid_e164");
  toMasked = maskE164(to);
  if (!inSliceCountry(to)) return refuse("country_not_in_slice");

  const allowlist = parseDestAllowlist(deps.env.SMS_DEST_ALLOWLIST);
  if (!allowlist.ok) return refuse(allowlist.reason);
  if (!allowlist.set.has(to)) return refuse("dest_not_allowlisted");

  const secret = deps.env.SMS_NUMBER_KEY_SECRET;
  if (secret === undefined || secret.length < 32 || secret.trim() === "") {
    return refuse("number_key_secret_missing");
  }
  const destinationKey = numberKey(to, secret);
  const rateDeviceKey = deviceKey(input.deviceId, secret);
  key = destinationKey;
  device = rateDeviceKey;

  if (orgId === null) return refuse("org_missing");
  let enabled: boolean;
  try {
    enabled = (await deps.flagOn(orgId)) === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return refuse("flag_off");

  const rateIp = ipLiteralOrNull(input.ip);
  ip = rateIp;
  const reservation = await deps.ledger.withLock<Reservation>(async (tx) => {
    async function refuseLocked(reason: SmsOtpRefusal): Promise<Reservation> {
      await tx.insert(auditRow("sms_otp_refused", reason));
      return { reserved: false, reason };
    }

    if (rateIp === null) return refuseLocked("rate_context_missing");
    const counts = await tx.counts({ numberKey: destinationKey, ip: rateIp, deviceKey: rateDeviceKey });
    const rateBlock = rateLimitBlock(counts);
    if (rateBlock !== null) return refuseLocked(rateBlock);

    const capBlock = costCapBlock(counts.providerSendsToday, dailyCap(deps.env));
    if (capBlock !== null) return refuseLocked(capBlock);

    // Selecting a transport only validates config and constructs the adapter; it does not send.
    const selected = deps.transport ? { transport: deps.transport } : selectTransport(deps.env);
    if ("error" in selected) return refuseLocked(selected.error);
    const { transport } = selected;
    const attempt = auditRow("sms_otp_attempt", null, transport.mode);
    await tx.insert(attempt);
    return { reserved: true, transport, attempt };
  });

  if (!reservation.reserved) return { ok: false, reason: reservation.reason };
  const { transport, attempt } = reservation;
  const mode = transport.mode;

  // A committed attempt counts even if the provider or the independent outcome insert fails.
  let status: "captured" | "pending";
  try {
    ({ status } = await transport.startVerification({ to, purpose, ...(locale ? { locale } : {}) }));
  } catch {
    await deps.audit({ ...attempt, event: "sms_otp_provider_error", reason: "provider_error" });
    return { ok: false, reason: "provider_error" };
  }
  await deps.audit({ ...attempt, event: mode === "capture" ? "sms_otp_captured" : "sms_otp_sent" });
  return { ok: true, status, mode };
}

const INSERT_SMS_AUDIT = `INSERT INTO audit_log
  (org_id, actor_user_id, actor_role, table_name, row_id, action,
   event_type, new_row, reason, request_id, occurred_at)
  VALUES ($1, $2, 'system', 'sms_otp', $3, 'insert', $4, $5::jsonb, $6, $7, clock_timestamp())`;

function auditParams(row: SmsAuditRow): (string | null)[] {
  return [
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
      device_key: row.deviceKey,
    }),
    row.reason,
    row.requestId,
  ];
}

export function createAuditLogSmsLedger(): SmsLedger {
  return {
    async withLock<T>(fn: (tx: SmsLedgerTransaction) => Promise<T>): Promise<T> {
      const { withClient } = await import("@/server/db");
      return withClient(async (client) => {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        try {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('condola_sms_otp_daily'))");
          const result = await fn({
            async counts(q) {
              const { rows } = await client.query<Counts>(
                `WITH sample AS (
                   SELECT clock_timestamp() AS ts
                 ), bounds AS (
                   SELECT ts,
                          ts - interval '1 hour' AS hour_start,
                          ts - interval '24 hours' AS day_start,
                          date_trunc('day', ts AT TIME ZONE 'America/Los_Angeles')
                            AT TIME ZONE 'America/Los_Angeles' AS pacific_start
                   FROM sample
                 )
                 SELECT
                   (count(*) FILTER (WHERE row_id = $1 AND occurred_at >= hour_start))::int AS "numberHour",
                   (count(*) FILTER (WHERE row_id = $1 AND occurred_at >= day_start))::int AS "numberDay",
                   (count(*) FILTER (WHERE new_row->>'ip' = $2 AND occurred_at >= hour_start))::int AS "ipHour",
                   (count(*) FILTER (WHERE new_row->>'device_key' = $3 AND occurred_at >= hour_start))::int AS "deviceHour",
                   extract(epoch FROM min(ts - occurred_at) FILTER (WHERE row_id = $1))
                     ::double precision AS "secondsSinceLastToNumber",
                   (count(*) FILTER (WHERE occurred_at >= pacific_start))::int AS "providerSendsToday"
                 FROM audit_log CROSS JOIN bounds
                 WHERE table_name = 'sms_otp'
                   AND event_type = 'sms_otp_attempt'
                   AND (row_id = $1 OR occurred_at >= least(hour_start, pacific_start))`,
                [q.numberKey, q.ip, q.deviceKey],
              );
              const counts = rows[0];
              if (!counts) throw new Error("sms_otp_counts_missing");
              return counts;
            },
            async insert(row) {
              await client.query(INSERT_SMS_AUDIT, auditParams(row));
            },
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      });
    },
  };
}

export async function auditLogSmsAudit(row: SmsAuditRow): Promise<void> {
  const { query } = await import("@/server/db");
  await query(INSERT_SMS_AUDIT, auditParams(row));
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
