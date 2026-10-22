import { describe, expect, it } from 'vitest';
import { readTrialLength } from '../../../src/server/trial-length';

// Dates are ISO civil dates; annual end is inclusive; reminder state is explicit.
// Trial length comes from QA_TRIAL_UNIT and QA_TRIAL_COUNT. This file does not choose one.
import {
  monthlyPrice, annualQuote, trialOfferMonths, seatLimit, canInvite,
  unitChange, trialReminders, annualWindow, switchSubscription,
  effectiveLeaseCount,
} from '../src/pricing';

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

  it('gives paid plans the configured trial length and free plans zero', () => {
    const length = readTrialLength();
    expect(trialOfferMonths('free', length)).toBe(0);
    expect(trialOfferMonths('std', length)).toBe(length.count);
    expect(trialOfferMonths('pro', length)).toBe(length.count);
  });

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
  it.each([
    ['2026-10-17', '2026-10-01', [], [14]],
    ['2026-10-17', '2026-10-01', [14], []],
    ['2026-10-24', '2026-10-01', [14], [7]],
    ['2026-10-24', '2026-10-01', [14, 7], []],
    ['2026-10-21', '2026-10-21', [], []],
    ['2026-10-24', '2026-10-21', [], [7]],
  ])('reminders on %s activated %s', (today, activatedAt, sent, expected) => {
    expect(trialReminders({
      trialEnd: '2026-10-31', today, activatedAt, sent,
      lineLaunched: false, lineConnected: true,
    })).toEqual(expected.map(days => ({
      days, channels: ['email', 'in-app'],
    })));
  });

  it('adds LINE only after launch and connection', () => {
    expect(trialReminders({
      trialEnd: '2026-10-31', today: '2026-10-24',
      activatedAt: '2026-10-01', sent: [14],
      lineLaunched: true, lineConnected: true,
    })).toEqual([{ days: 7, channels: ['email', 'in-app', 'line'] }]);
  });

  it('starts a twelve-month annual period the day after trial', () => {
    expect(annualWindow('2027-03-31')).toEqual({
      start: '2027-04-01', end: '2028-03-31', trialCharge: 0,
    });
  });

  it.each([
    ['std', 'monthly'], ['pro', 'annual'], ['free', 'monthly'],
  ] as const)('switch to %s/%s preserves trial', (plan, billing) => {
    expect(switchSubscription({
      trialUsed: true, trialEnd: '2027-03-31', plan: 'std', billing: 'monthly',
    }, { plan, billing })).toMatchObject({
      trialUsed: true, trialEnd: '2027-03-31',
      annualStart: '2027-04-01', trialRestarted: false,
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

