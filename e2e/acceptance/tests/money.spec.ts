import { describe, expect, it } from 'vitest';

// TODO: wire to real module. Adapter contract: integer TWD amounts; ISO civil dates;
// no Date parsing in the host timezone; returned objects must expose fields asserted below.
import {
  allocateOldestFirst,
  paymentBalance,
  prorateRent,
  inclusiveDays,
  settlementClosing,
  nextOpening,
  companyHandledRent,
  depositBalance,
  formatTwd,
  validDueDay,
  defaultDueDay,
  overdueDays,
  validPaymentDate,
} from '../src/money';

describe('payment balances', () => {
  it.each([
    { payments: [10000], status: '部分付款', remaining: 8000, text: '尚未繳 NT$8,000' },
    { payments: [10000, 8000], status: '已繳清', remaining: 0, text: null },
  ])('$payments → $status', ({ payments, ...expected }) => {
    expect(paymentBalance(18000, payments)).toMatchObject(expected);
  });

  it('allocates to the oldest unpaid bill regardless of input order', () => {
    expect(allocateOldestFirst([
      { period: '2026-09', remaining: 18000 },
      { period: '2026-08', remaining: 18000 },
    ], 25000)).toEqual([
      { period: '2026-08', remaining: 0 },
      { period: '2026-09', remaining: 11000 },
    ]);
  });

  it.each([
    ['2026-10-22', true],
    ['2026-10-23', false],
  ])('payment date %s is accepted=%s', (date, accepted) => {
    expect(validPaymentDate(date, '2026-10-22')).toBe(accepted);
  });
});

describe('moveout money', () => {
  it.each([
    [18000, 12, 7200],
    [15000, 7, 3500],
    [17500, 11, 6417],
    [20000, 1, 667],
    [18000, 30, 18000],
    // D24: half-up (bankers rounding would give 432).
    [12975, 1, 433],
    // D24: capped at one month's rent (uncapped would be 18,600).
    [18000, 31, 18000],
  ])('prorates %i for %i days to %i', (rent, days, expected) => {
    expect(prorateRent(rent, days)).toBe(expected);
  });

  it('D24: rounds half-up once at the end (12,975 × 1 ÷ 30 = 432.5 → 433)', () => {
    expect(prorateRent(12975, 1)).toBe(433);
  });

  it('D24: caps 31 days at one month rent (18,000 × 31 → 18,000)', () => {
    expect(prorateRent(18000, 31)).toBe(18000);
  });

  it('includes the last day', () => {
    expect(inclusiveDays('2026-10-01', '2026-10-12')).toBe(12);
  });

  it.each([
    { deductions: [30000, 8500], shortfall: 2500, refund: 0, warning: true, text: '補付 NT$2,500' },
    { deductions: [36000], shortfall: 0, refund: 0, warning: false, text: null },
  ])('deposit deductions $deductions', ({ deductions, ...expected }) => {
    expect(depositBalance(36000, deductions)).toMatchObject(expected);
  });
});

describe('settlement calculations (integration remains Class B)', () => {
  it.each([
    [5000, 36000, 4200, 30000, 6800],
    [0, 0, 3300, 0, -3300],
  ])('closing(%i,%i,%i,%i) = %i', (opening, rent, expenses, payouts, expected) => {
    expect(settlementClosing({ opening, rent, expenses, payouts })).toBe(expected);
  });

  it('carries the previous closing forward', () => {
    expect(nextOpening(6800)).toBe(6800);
  });

  it('counts company-directed rent only, excluding deposits', () => {
    // D25: only rent whose 付款對象 is the management company; deposits excluded.
    expect(companyHandledRent([
      { recipient: 'company', type: 'rent', amount: 36000 },
      { recipient: 'owner', type: 'rent', amount: 18000 },
      { recipient: 'company', type: 'deposit', amount: 36000 },
    ])).toBe(36000);
  });
});

describe('display and due dates', () => {
  it.each([
    [7200, 'NT$7,200'],
    [4380, 'NT$4,380'],
    [-3300, '−NT$3,300'],
  ])('formats %i', (amount, expected) => {
    expect(formatTwd(amount)).toBe(expected);
  });

  it.each([[1, true], [28, true], [0, false], [29, false]])(
    'due day %i valid=%s', (day, expected) => {
      expect(validDueDay(day)).toBe(expected);
    },
  );

  it('defaults to day 5', () => {
    expect(defaultDueDay(undefined)).toBe(5);
  });

  it.each([
    ['2026-10-05', 0],
    ['2026-10-06', 1],
    ['2026-10-12', 7],
  ])('overdue on %s = %i days', (today, expected) => {
    expect(overdueDays('2026-10-05', today)).toBe(expected);
  });
});

