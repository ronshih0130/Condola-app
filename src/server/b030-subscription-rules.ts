import { createHmac, timingSafeEqual } from 'node:crypto';

export const usageDimensions = ['units', 'signatures', 'stored_bytes', 'notifications', 'vendor_jobs'] as const;
export type UsageDimension = typeof usageDimensions[number];
export const subscriptionStates = ['trialing', 'active', 'grace', 'restricted', 'canceled'] as const;
export type SubscriptionState = typeof subscriptionStates[number];
export type MockSubscriptionEvent = {
  provider: 'local_mock'; eventId: string; orgId: string; sequence: number;
  state: SubscriptionState; occurredAt: string; planKey: string; planVersion: number;
};
export function usageSubscriptionsOn(global: unknown, flags: unknown, orgId: string): boolean {
  if (!global || typeof global !== 'object' || Array.isArray(global) || !flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  const g = global as Record<string, unknown>, f = flags as Record<string, unknown>;
  return g.enabled === true && Array.isArray(g.allowed_org_ids) && g.allowed_org_ids.includes(orgId) && f.usage_subscriptions === true;
}

export function localMockEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.B030_MOCK_PROVIDER_ENABLED !== 'true') return false;
  try {
    const url = new URL(env.DATABASE_URL ?? '');
    return ['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.search && !url.hash && url.pathname.length > 1;
  } catch { return false; }
}

/** Verify exact bytes before parsing. Signing time is distinct from provider event order. */
export function verifyMockFixture(raw: string, timestamp: string, signature: string, secret: string | undefined, now = Date.now()): MockSubscriptionEvent {
  if (!secret || Buffer.byteLength(secret) < 32 || Buffer.byteLength(raw) > 8192 || !/^\d{10}$/.test(timestamp)
    || Math.abs(now - Number(timestamp) * 1000) > 300000 || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid mock fixture');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid mock fixture');
  const e: unknown = JSON.parse(raw);
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('Invalid mock fixture');
  const v = e as Record<string, unknown>;
  const keys = ['provider', 'eventId', 'orgId', 'sequence', 'state', 'occurredAt', 'planKey', 'planVersion'];
  if (Object.keys(v).length !== keys.length || keys.some(k => !(k in v)) || v.provider !== 'local_mock'
    || typeof v.eventId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.eventId)
    || typeof v.orgId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.orgId)
    || !Number.isSafeInteger(v.sequence) || (v.sequence as number) <= 0
    || !subscriptionStates.includes(v.state as SubscriptionState)
    || typeof v.occurredAt !== 'string' || !Number.isFinite(Date.parse(v.occurredAt))
    || new Date(v.occurredAt).toISOString() !== v.occurredAt || Date.parse(v.occurredAt) > now + 300000
    || typeof v.planKey !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(v.planKey)
    || !Number.isInteger(v.planVersion) || (v.planVersion as number) <= 0 || (v.planVersion as number) > 2147483647) throw new Error('Invalid mock fixture');
  return v as MockSubscriptionEvent;
}

export type SubscriptionPlan = {
  enabled: true; state: SubscriptionState | null; planKey: string; planVersion: number;
  pricing: 'not_configured'; priceAmountMinor: null; priceCurrency: null;
  graceSeconds: string | null; graceEndsAt: string | null;
  limits: Record<UsageDimension, string | null>; restrictionRules: null;
};
export type PlanPresentation = { enabled: false } | SubscriptionPlan;

/** Descriptive only. No approved restriction rules, even if provider state says restricted. */
export function evaluateSubscription(plan: PlanPresentation, totals: Partial<Record<UsageDimension, string>>, now = Date.now()) {
  return {
    retainedDataReadable: true as const,
    restrictOperations: false as const,
    restrictionRules: 'not_configured' as const,
    grace: !plan.enabled || plan.state !== 'grace' ? 'not_in_grace' as const
      : plan.graceEndsAt === null ? 'not_configured' as const
      : now >= Date.parse(plan.graceEndsAt) ? 'expired' as const : 'open' as const,
    limits: usageDimensions.map(dimension => {
      const limit = plan.enabled ? plan.limits[dimension] : null;
      return { dimension, limit, status: limit === null ? 'not_configured' as const
        : BigInt(totals[dimension] ?? '0') > BigInt(limit) ? 'exceeded' as const : 'within' as const };
    }),
  };
}

/** Strict ISO instants, at PostgreSQL's microsecond precision. Never infer a timezone
 * or let Date.parse round the fraction or normalize an invalid calendar date. */
export function usagePeriodInstant(value: string): bigint | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, fraction = '', zone] = parts;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y === 0 || m < 1 || m > 12 || d < 1 || d > days[m - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const offsetHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  // RFC 3339 -00:00 denotes an unknown offset, not an explicit known timezone.
  if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0) || zone === '-00:00') return null;
  const offset = (offsetHours * 60 + offsetMinutes) * (zone[0] === '-' ? -1 : 1);
  const wholeSecond = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return BigInt(wholeSecond) * BigInt(1000) - BigInt(offset) * BigInt(60000000)
    + BigInt(fraction.padEnd(6, '0'));
}
