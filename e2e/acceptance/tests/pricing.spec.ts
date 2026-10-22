import { describe, expect, it } from 'vitest';

// TODO: wire to real module. Normalize production results to these contracts.
// Dates are ISO civil dates; annual end is inclusive; reminder state is explicit.
import {
  monthlyPrice, annualQuote, trialOfferMonths, seatLimit, canInvite,
  unitChange, trialReminders, annualWindow, switchSubscription,
  effectiveLeaseCount,
} from '../src/pricing';

// Trial length definition — PENDING Ron 10/22 18:30 decision.
// 'calendar_months': 3 calendar months (end = activation + 3 months − 1 day).
// 'days_90': 90 days inclusive (end = activation + 89 days).
type TrialMode = 'calendar_months' | 'days_90';
const TRIAL_MODE: TrialMode =
  (process.env.TRIAL_MODE as TrialMode | undefined) ?? 'calendar_months';
if (!['calendar_months', 'days_90'].includes(TRIAL_MODE)) {
  throw new Error(`Unknown TRIAL_MODE: ${TRIAL_MODE}`);
}

// Pure UTC civil-date helpers (no host timezone parsing).
const toUtc = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => fmt(toUtc(iso) + n * 86_400_000);
const addMonthsClamped = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fmt(Date.UTC(y, m - 1 + n, Math.min(d, last)));
};
function trialEndFor(activatedAt: string, mode: TrialMode = TRIAL_MODE): string {
  return mode === 'days_90'
    ? addDays(activatedAt, 89)
    : addDays(addMonthsClamped(activatedAt, 3), -1);
}
const annualStartFor = (trialEnd: string) => addDays(trialEnd, 1);
const annualEndFor = (start: string) => addDays(addMonthsClamped(start, 12), -1);

describe('pricing', () => {
  it.each([
    ['std', 4, 0], ['std', 5, 30], ['std', 30, 780],
    ['std', 150, 4380], ['std', 501, 14910],
    ['pro', 30, 1040],
    ['free', 1, 0], ['free', 4, 0], ['free', 30, 0], ['free', 501, 0],
  ] as const)('%s / %i units = %i monthly', (plan, units, expected) => {
    expect(monthlyPrice(plan, units)).toBe(expected);
  });

  it.each([
    ['std', 30, 8580, true],
    ['std', 150, 48180, true],
    ['free', 30, 0, false],
  ] as const)('%s / %i annual', (plan, units, amount, discountApplied) => {
    expect(annualQuote(plan, units)).toEqual({ amount, discountApplied });
  });

  it.each([['free', 0], ['std', 3], ['pro', 3]] as const)(
    '%s trial offer', (plan, months) => {
      expect(trialOfferMonths(plan)).toBe(months);
    },
  );

  it.each([
    ['free', 1, 1, false],
    ['std', 5, 5, false],
    ['std', 4, 5, true],
    ['pro', 1000, Infinity, true],
  ] as const)('%s seats at %i', (plan, count, limit, allowed) => {
    expect(seatLimit(plan)).toBe(limit);
    expect(canInvite(plan, count)).toBe(allowed);
  });

  it.each([35, 25])('unit change 30 → %i', (newUnits) => {
    expect(unitChange({
      oldUnits: 30, newUnits, currentAmount: 780, nextPeriod: '2026-11-01',
    })).toEqual({
      currentAmount: 780,
      effectiveDate: '2026-11-01',
      usableUnitsNow: Math.max(30, newUnits),
      refund: 0,
    });
  });

  it.each(['std', 'pro'] as const)('partner does not change %s price', (plan) => {
    expect(monthlyPrice(plan, 30, { partner: true }))
      .toBe(monthlyPrice(plan, 30, { partner: false }));
  });
});

describe('trial lifecycle', () => {
  // Reminder dates derived from TRIAL_MODE; no hardcoded trial end.
  const ACT = '2026-08-01';
  const END = trialEndFor(ACT);
  const d14 = addDays(END, -14);
  const d7 = addDays(END, -7);
  // Late activation (10 days before the same END): only the seven-day reminder applies.
  const lateAct = addDays(END, -10);
  it.each([
    [d14, ACT, [], [14]],
    [d14, ACT, [14], []],
    [d7, ACT, [14], [7]],
    [d7, ACT, [14, 7], []],
    [lateAct, lateAct, [], []],
    [d7, lateAct, [], [7]],
  ] as [string, string, number[], number[]][])('reminders on %s activated %s', (today, activatedAt, sent, expected) => {
    expect(trialReminders({
      trialEnd: END, today, activatedAt, sent,
      lineLaunched: false, lineConnected: true,
    })).toEqual(expected.map(days => ({
      days, channels: ['email', 'in-app'],
    })));
  });

  it('adds LINE only after launch and connection', () => {
    expect(trialReminders({
      trialEnd: END, today: d7,
      activatedAt: ACT, sent: [14],
      lineLaunched: true, lineConnected: true,
    })).toEqual([{ days: 7, channels: ['email', 'in-app', 'line'] }]);
  });

  it(`starts a twelve-month annual period the day after trial (${TRIAL_MODE})`, () => {
    const trialEnd = trialEndFor('2027-01-01');
    const start = annualStartFor(trialEnd);
    expect(annualWindow(trialEnd)).toEqual({
      start, end: annualEndFor(start), trialCharge: 0,
    });
  });

  it.each([
    ['std', 'monthly'], ['pro', 'annual'], ['free', 'monthly'],
  ] as const)('switch to %s/%s preserves trial', (plan, billing) => {
    const trialEnd = trialEndFor('2027-01-01');
    expect(switchSubscription({
      trialUsed: true, trialEnd, plan: 'std', billing: 'monthly',
    }, { plan, billing })).toMatchObject({
      trialUsed: true, trialEnd,
      annualStart: annualStartFor(trialEnd), trialRestarted: false,
    });
  });

  it('counts leases effective on the final trial day', () => {
    expect(effectiveLeaseCount([
      { start: '2026-01-01', end: '2026-10-31' },
      { start: '2026-10-31', end: null },
      { start: '2026-11-01', end: null },
      { start: '2026-01-01', end: '2026-10-30' },
    ], '2026-10-31')).toBe(2);
  });
});

