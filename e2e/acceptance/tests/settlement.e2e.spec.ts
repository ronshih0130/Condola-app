import { test, expect, type Page } from '@playwright/test';

const SELECTORS = {
  email: '[data-testid=login-email]',
  password: '[data-testid=login-password]',
  loginSubmit: '[data-testid=login-submit]',
  opening: '[data-testid=statement-opening]',
  closing: '[data-testid=statement-closing]',
  payouts: '[data-testid=statement-payouts]',
  handledRent: '[data-testid=statement-firm]',
  net: '[data-testid=statement-net]',
  deposit: '[data-testid=statement-deposit]',
  recipientGroup: '[data-testid=statement-recipient]',
  reverse: '[data-testid=reverse-payment]',
  reason: '[data-testid=reverse-reason]',
  previousContent: '[data-testid=statement-before]',
  version: '[data-testid=statement-version]',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing QA configuration: ${name}`);
  return value;
}

async function login(page: Page, role: string) {
  await page.goto('/login');
  await page.locator(SELECTORS.email).fill(required(`QA_${role}_EMAIL`));
  await page.locator(SELECTORS.password).fill(required(`QA_${role}_PASSWORD`));
  await page.locator(SELECTORS.loginSubmit).click();
  await expect(page.locator(SELECTORS.loginSubmit)).toBeHidden();
}

test.use({ baseURL: process.env.E2E_BASE_URL });
test.beforeEach(async () => {
  required('E2E_BASE_URL');
  // TODO: isolated fixture per test: generated October QA屋主甲 statement;
  // opening 5000, company rent 36000, owner rent 18000, expenses 4200,
  // manually entered payout 30000, deposit 36000; separate negative statement.
  if (Object.values(SELECTORS).some(value => (value as string) === 'TODO-selector')) {
    throw new Error('Wire SELECTORS and isolated QA settlement fixtures');
  }
});

test('statement title, balances, deposits, recipients and footer', async ({ page }) => {
  await login(page, 'ADMIN');
  await page.goto(required('QA_STATEMENT_PATH'));
  await expect(page.getByRole('heading', {
    name: 'QA屋主甲・2026年10月 屋主租金結算明細', exact: true,
  })).toBeVisible();
  for (const label of ['管理公司匯給屋主', '期初餘額', '期末餘額', '管理公司經手租金']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  for (const [selector, amount] of [
    [SELECTORS.opening, 'NT$5,000'], [SELECTORS.handledRent, 'NT$36,000'],
    [SELECTORS.payouts, 'NT$30,000'], [SELECTORS.closing, 'NT$6,800'],
    [SELECTORS.deposit, 'NT$36,000'],
  ]) await expect(page.locator(selector)).toHaveText(amount);
  // Net includes both recipients' rent, but never deposits.
  await expect(page.locator(SELECTORS.net)).toHaveText('NT$49,800');
  await expect(page.getByText('押金（另列，不計入淨額）', { exact: true })).toBeVisible();
  for (const recipient of ['付給屋主', '付給管理公司']) {
    await expect(page.locator(SELECTORS.recipientGroup).filter({ hasText: recipient })).toHaveCount(1);
  }
  await expect(page.getByText('電費（空房／未簽約）', { exact: true })).toHaveCount(0);
  await expect(page.getByText(
    '押金不計入淨額。此表僅供紀錄與對帳。Condola 只提供管理軟體，不經手任何款項。',
    { exact: true },
  )).toBeVisible();
  await page.goto(required('QA_NEXT_STATEMENT_PATH'));
  await expect(page.locator(SELECTORS.opening)).toHaveText('NT$6,800');
});

test('negative net uses approved warning', async ({ page }) => {
  await login(page, 'ADMIN');
  await page.goto(required('QA_NEGATIVE_STATEMENT_PATH'));
  await expect(page.getByText('本期淨額為負', { exact: true })).toBeVisible();
  await expect(page.getByText(
    '本月費用高於已登記租金，屋主淨額為 −NT$3,300。費用怎麼處理，請和屋主確認。',
    { exact: true },
  )).toBeVisible();
  await expect(page.locator(SELECTORS.closing)).toHaveText('−NT$3,300');
});

test('reversal marks changed and regeneration preserves prior version', async ({ page }) => {
  await login(page, 'ADMIN');
  await page.goto(required('QA_STATEMENT_PATH'));
  const originalVersion = await page.locator(SELECTORS.version).innerText();
  await page.goto(required('QA_STATEMENT_PAYMENT_PATH'));
  await page.locator(SELECTORS.reverse).click();
  await page.locator(SELECTORS.reason).fill('重複登記');
  await page.getByRole('button', { name: '確定撤銷', exact: true }).click();
  await expect(page.getByText('已撤銷', { exact: true })).toBeVisible();
  await page.goto(required('QA_STATEMENT_PATH'));
  await expect(page.getByText('已變更', { exact: true })).toBeVisible();
  await expect(page.getByText('這份結算表產生後有異動，請重新產生。', { exact: true })).toBeVisible();
  await page.getByText('修改紀錄', { exact: true }).click();
  await expect(page.getByText('修改前內容', { exact: true })).toBeVisible();
  await expect(page.locator(SELECTORS.previousContent)).toContainText('NT$6,800');
  await page.getByRole('button', { name: '重新產生月結單', exact: true }).click();
  await expect(page.locator(SELECTORS.version)).not.toHaveText(originalVersion);
  // Fixture payment is company-directed rent 18000.
  await expect(page.locator(SELECTORS.closing)).toHaveText('−NT$11,200');
  await page.getByText('修改紀錄', { exact: true }).click();
  await expect(page.locator(SELECTORS.previousContent)).toContainText('NT$6,800');
});

test('owner sees own readonly statement and foreign statement returns 404', async ({ page }) => {
  await login(page, 'OWNER');
  await page.goto('/o/statements');
  await page.getByText('QA屋主甲・2026年10月 屋主租金結算明細', { exact: true }).click();
  await expect(page.getByRole('button', { name: '重新產生月結單', exact: true })).toHaveCount(0);
  const response = await page.goto(required('QA_OTHER_OWNER_STATEMENT_PATH'));
  expect(response?.status()).toBe(404);
});

test('tenant cannot view statements', async ({ page }) => {
  await login(page, 'TENANT');
  const response = await page.goto(required('QA_STATEMENT_PATH'));
  expect(response?.status()).toBe(404);
  await expect(page.getByText('QA屋主甲・2026年10月 屋主租金結算明細', { exact: true })).toHaveCount(0);
});

test('cross-organization page returns HTTP 404', async ({ page }) => {
  await login(page, 'ADMIN');
  const response = await page.goto(required('QA_CROSS_ORG_STATEMENT_PATH'));
  expect(response?.status()).toBe(404);
});

