import { test, expect } from '@playwright/test';

const SELECTORS = {
  email: '[data-testid=login-email]',
  password: '[data-testid=login-password]',
  loginSubmit: '[data-testid=login-submit]',
  // No move-out screen exists yet. These stay open until that page has real controls.
  moveoutDate: 'TODO-selector',
  amount: 'TODO-selector',
  saveOverride: 'TODO-selector',
  overrideReason: 'TODO-selector',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing QA configuration: ${name}`);
  return value;
}

test.use({ baseURL: process.env.E2E_BASE_URL });
test.beforeEach(async ({ page }) => {
  required('E2E_BASE_URL');
  // TODO: isolated QA租客A moveout fixture: monthly rent 18000, period start
  // 2026-10-01, deposit 36000, deductions 30000 + 8500.
  // Freeze server and browser business time to 2026-10-12 10:00 Asia/Taipei.
  if (Object.values(SELECTORS).some(value => value === 'TODO-selector')) {
    throw new Error('Wire SELECTORS and isolated QA moveout fixtures');
  }
  await page.clock.install({ time: new Date('2026-10-12T10:00:00+08:00') });
  await page.goto('/login');
  await page.locator(SELECTORS.email).fill(required('QA_ADMIN_EMAIL'));
  await page.locator(SELECTORS.password).fill(required('QA_ADMIN_PASSWORD'));
  await page.locator(SELECTORS.loginSubmit).click();
  await expect(page.locator(SELECTORS.loginSubmit)).toBeHidden();
  await page.goto(required('QA_MOVEOUT_PATH'));
});

test('inclusive prorate formula and persisted manual override', async ({ page }) => {
  await page.locator(SELECTORS.moveoutDate).fill('2026-10-12');
  await page.locator(SELECTORS.moveoutDate).blur();
  await expect(page.getByText('NT$18,000 ÷ 30 × 12 天 ＝ NT$7,200', { exact: true })).toBeVisible();
  await page.locator(SELECTORS.amount).fill('7000');
  await page.locator(SELECTORS.overrideReason).fill('協議調整');
  await page.locator(SELECTORS.saveOverride).click();
  await page.reload();
  await expect(page.getByText(
    `已手動修改（${required('QA_ADMIN_DISPLAY_NAME')}・2026-10-12 10:00）`,
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText('原金額 NT$7,200，已改為 NT$7,000', { exact: true })).toBeVisible();
  // PM QA also verifies exactly one persisted audit_event with actor, server time,
  // before=7200, after=7000, reason=協議調整; reload must not add an event.
});

test('deposit shortfall uses exact approved copy', async ({ page }) => {
  await page.goto(required('QA_MOVEOUT_SHORTFALL_PATH'));
  await expect(page.getByText('押金不足扣抵', { exact: true })).toBeVisible();
  await expect(page.getByText('扣款超過押金，租客還需補付 NT$2,500', { exact: true })).toBeVisible();
});

