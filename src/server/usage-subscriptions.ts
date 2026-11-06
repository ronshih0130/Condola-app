import { createHash } from 'node:crypto';
import { svc, tx } from './db';
import { FlowError } from './errors';
import { requireOrgScope } from './org-guard';
import type { Session } from './types';
import { usageSubscriptionCopy } from '@/i18n/usage-subscriptions';
import { localMockEnabled, usagePeriodInstant, verifyMockFixture, type PlanPresentation, type UsageDimension } from './b030-subscription-rules';

function reader(session: Session) {
  const scope = requireOrgScope(session);
  if (session.kind !== 'staff' || !['admin', 'accountant'].includes(session.role ?? '')) throw new FlowError('errors.forbidden');
  return scope;
}
export type UsageSummary = { dimension: UsageDimension; quantity: string; events: string; source_event_ids: string[] };
export async function readUsageSummary(session: Session, from: string, to: string): Promise<UsageSummary[]> {
  const scope = reader(session);
  const start = usagePeriodInstant(from), end = usagePeriodInstant(to);
  if (start === null || end === null || start >= end) throw new FlowError('errors.forbidden');
  return tx(session.userId, async client => (await client.query<UsageSummary>(
    'SELECT * FROM app.b030_usage_summary($1,$2::timestamptz,$3::timestamptz)', [session.orgId, from, to],
  )).rows, scope, { readOnly: true });
}
export async function readSubscriptionPlan(session: Session) {
  return tx(session.userId, async client => {
    const plan = (await client.query<{ plan: PlanPresentation }>('SELECT app.b030_plan_presentation($1) AS plan', [session.orgId])).rows[0].plan;
    return { ...plan, pricingLabel: usageSubscriptionCopy(session.locale).pricingNotConfigured };
  }, reader(session), { readOnly: true });
}

export type MockEventResult = 'off' | 'applied' | 'duplicate';
/** Internal local fixture handler. No provider request or outbound operation. */
export async function handleMockSubscriptionWebhook(raw: string, timestamp: string, signature: string): Promise<MockEventResult> {
  if (!localMockEnabled(process.env)) throw new FlowError('errors.forbidden');
  let event;
  try { event = verifyMockFixture(raw, timestamp, signature, process.env.B030_MOCK_PROVIDER_HMAC_SECRET); }
  catch { throw new FlowError('errors.forbidden'); }
  const sha = createHash('sha256').update(raw).digest('hex');
  return svc(null, async client => (await client.query<{ result: MockEventResult }>(
    'SELECT app.b030_apply_mock_event($1,$2,$3::bigint,$4,$5::timestamptz,$6,$7,$8) AS result',
    [event.orgId, event.eventId, event.sequence, event.state, event.occurredAt, event.planKey, event.planVersion, sha],
  )).rows[0].result);
}
