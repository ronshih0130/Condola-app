import { test, expect, type Page } from '@playwright/test';

const SELECTORS = {
  email: '[data-testid=login-email]',
  password: '[data-testid=login-password]',
  loginSubmit: '[data-testid=login-submit]',
  lease: '[data-testid=rent-lease]',
  type: '[data-testid=rent-kind]',
  period: '[data-testid=rent-period]',
  amount: '[data-testid=rent-amount]',
  date: '[data-testid=rent-date]',
  accountSuffix: '[data-testid=rent-last5]',
  notes: '[data-testid=rent-note]',
  recipient: '[data-testid=rent-payee]',
  record: '[data-testid=payment-record]',
  reverse: '[data-testid=reverse-payment]',
  reason: '[data-testid=reverse-reason]',
  unitEdit: '[data-testid=edit-property]',
  leaseEdit: '[data-testid=edit-lease]',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing QA configuration: ${name}`);
  return value;
}

async function login(page: Page, role = 'ADMIN') {
  await page.goto('/login');
  await page.locator(SELECTORS.email).fill(required(`QA_${role}_EMAIL`));
  await page.locator(SELECTORS.password).fill(required(`QA_${role}_PASSWORD`));
  await page.locator(SELECTORS.loginSubmit).click();
  await expect(page.locator(SELECTORS.loginSubmit)).toBeHidden();
}

async function openForm(page: Page, amount: string, recipient = '付給管理公司') {
  await page.getByRole('button', { name: '登記繳租', exact: true }).click();
  await page.locator(SELECTORS.lease).selectOption({ label: 'QA租客A・QA物件101' });
  await page.locator(SELECTORS.type).selectOption({ label: '租金（2026年10月）' });
  await page.locator(SELECTORS.period).selectOption('2026-10');
  await page.locator(SELECTORS.amount).fill(amount);
  await page.locator(SELECTORS.date).fill('2026-10-06');
  await page.locator(SELECTORS.recipient).selectOption({ label: recipient });
}

async function save(page: Page) {
  await page.getByRole('button', { name: '儲存為已登記', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test.use({ baseURL: process.env.E2E_BASE_URL });

test.beforeEach(async ({ page }) => {
  required('E2E_BASE_URL');
  // TODO: connect an isolated per-test QA seed/reset fixture before enabling.
  // Seed business clock 2026-10-06 Asia/Taipei, unpaid October bill 18000,
  // oldest unpaid bill October, QA租客A/QA物件101, no matching payments.
  if (Object.values(SELECTORS).some(value => (value as string) === 'TODO-selector')) {
    throw new Error('Wire SELECTORS and isolated QA fixtures before running acceptance tests');
  }
  await page.clock.install({ time: new Date('2026-10-06T04:00:00+08:00') });
  await login(page);
  const clock = await page.request.post('/api/demo/clock', { data: { today: '2026-10-06' } });
  expect(clock.ok(), 'DEMO_MODE server business clock').toBeTruthy();
  await page.goto('/m/payments');
});

test('required fields and future date block registration', async ({ page }) => {
  await page.getByRole('button', { name: '登記繳租', exact: true }).click();
  await page.locator(SELECTORS.amount).fill('0');
  await page.getByRole('button', { name: '儲存為已登記', exact: true }).click();
  for (const text of [
    '請選擇租約', '金額需大於 NT$0', '請選擇款項類型',
    '請選擇期別', '有欄位需要修正，請查看標示處。',
  ]) await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.locator(SELECTORS.date).fill('2026-10-07');
  await page.getByRole('button', { name: '儲存為已登記', exact: true }).click();
  await expect(page.getByText('匯款日期不能晚於今天', { exact: true })).toBeVisible();
  await page.locator(SELECTORS.date).fill('2026-10-06');
  await page.getByRole('button', { name: '儲存為已登記', exact: true }).click();
  await expect(page.getByText('匯款日期不能晚於今天', { exact: true })).toBeHidden();
});

test('partial payment then final installment', async ({ page }) => {
  await openForm(page, '10000');
  await save(page);
  await expect(page.getByText('部分付款', { exact: true })).toBeVisible();
  await expect(page.getByText('尚未繳 NT$8,000', { exact: true })).toBeVisible();
  await openForm(page, '8000');
  await save(page);
  await expect(page.getByText('已繳清', { exact: true })).toBeVisible();
  await expect(page.getByText('尚未繳 NT$8,000', { exact: true })).toBeHidden();
});

test('duplicate hint allows a second identical payment', async ({ page }) => {
  await openForm(page, '10000');
  await save(page);
  await openForm(page, '10000');
  await expect(page.getByText(
    '這期租金已有一筆登記 NT$10,000。如果是分次匯款，可以繼續儲存；如果是重複登記，請取消。',
    { exact: true },
  )).toBeVisible();
  await save(page);
  await expect(page.locator(SELECTORS.record).filter({ hasText: 'NT$10,000' })).toHaveCount(2);
});

test('reversal requires reason, retains original and recalculates bill', async ({ page }) => {
  await openForm(page, '10000');
  await save(page);
  const record = page.locator(SELECTORS.record).filter({ hasText: 'NT$10,000' });
  await expect(record.getByRole('button', { name: '編輯', exact: true })).toHaveCount(0);
  await expect(record.getByRole('button', { name: '刪除', exact: true })).toHaveCount(0);
  await record.locator(SELECTORS.reverse).click();
  await expect(page.getByRole('heading', { name: '撤銷這筆登記？', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '確定撤銷', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(record.getByText('已撤銷', { exact: true })).toHaveCount(0);
  await page.locator(SELECTORS.reason).fill('重複登記');
  await page.getByRole('button', { name: '確定撤銷', exact: true }).click();
  await expect(record.getByText('已撤銷', { exact: true })).toBeVisible();
  await expect(record.getByText('撤銷原因：重複登記', { exact: true })).toBeVisible();
  await expect(page.getByText('尚未繳 NT$18,000', { exact: true })).toBeVisible();
});

test('readonly unit permits record/reversal and disables unit/lease edit', async ({ page }) => {
  await page.goto(required('QA_READONLY_PAYMENT_PATH'));
  await expect(page.getByText(
    '這個物件目前唯讀（超過方案戶數），仍可登記和撤銷付款，但不能編輯物件和租約。',
    { exact: true },
  )).toBeVisible();
  await expect(page.locator(SELECTORS.unitEdit)).toBeDisabled();
  await expect(page.locator(SELECTORS.leaseEdit)).toBeDisabled();
  await openForm(page, '10000');
  await save(page);
  const record = page.locator(SELECTORS.record).filter({ hasText: 'NT$10,000' });
  await record.locator(SELECTORS.reverse).click();
  await page.locator(SELECTORS.reason).fill('金額更正');
  await page.getByRole('button', { name: '確定撤銷', exact: true }).click();
  await expect(record.getByText('已撤銷', { exact: true })).toBeVisible();
});

test('unpaid bill is overdue on the sixth', async ({ page }) => {
  await expect(page.getByText('未繳租金', { exact: true })).toBeVisible();
  await expect(page.getByText('到期 10/05・已逾期 1 天', { exact: true })).toBeVisible();
});

test('recipient persists independently for each payment', async ({ page }) => {
  for (const [amount, recipient] of [
    ['10000', '付給屋主'], ['8000', '付給管理公司'],
  ]) {
    await openForm(page, amount, recipient);
    await save(page);
  }
  await page.reload();
  for (const recipient of ['付給屋主', '付給管理公司']) {
    await expect(page.locator(SELECTORS.record).filter({ hasText: recipient })).toHaveCount(1);
  }
});

for (const role of ['ADMIN', 'ACCOUNTANT', 'MANAGER'] as const) {
  test(`${role} reversal permission`, async ({ page }) => {
    // TODO: fixture login must replace the previous session, including cookies/storage.
    await login(page, role);
    await page.goto(required('QA_EXISTING_PAYMENT_PATH'));
    if (role === 'MANAGER') {
      await expect(page.getByText('只有管理員或會計可以撤銷登記。', { exact: true })).toBeVisible();
      await expect(page.locator(SELECTORS.reverse)).toBeDisabled();
    } else {
      await page.locator(SELECTORS.reverse).click();
      await page.locator(SELECTORS.reason).fill('金額更正');
      await page.getByRole('button', { name: '確定撤銷', exact: true }).click();
      await expect(page.getByText('已撤銷', { exact: true })).toBeVisible();
    }
  });
}

