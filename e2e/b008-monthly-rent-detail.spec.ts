import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { ORG2_ID, ORG_ID } from '../src/server/ids';
import { disposableDbUrl } from '../src/server/test-disposable-db';
import { ACCOUNTS, signIn } from './session';

const dbUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
const origin = 'http://127.0.0.1:43139';
type Control = { value: unknown; description: string | null; updated_at: string };
type Saved = { control: Control | undefined; flags: unknown };
async function db<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: dbUrl });
  try { await client.connect(); return await fn(client); }
  finally { try { await client.end(); } catch { /* retain primary result */ } }
}
function guard(info: TestInfo) {
  if (!info.config.configFile?.endsWith('/e2e/b008-preview-private-playwright.config.ts') || info.project.use.trace !== 'off' || info.project.use.video !== 'off' || info.project.use.screenshot !== 'off' || info.config.reporter.length !== 1 || info.config.reporter[0][0] !== 'line' || process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1' || process.env.B008_PRIVATE_HTTP_CONFIG !== '1' || process.env.DEMO_MODE !== 'true') throw new Error('B008 private configuration required');
}
function safeFailure(phase: string, error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
  return `${phase}${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : ''}`;
}
async function reset(page: Page) {
  await signIn(page, ACCOUNTS.admin);
  let status = 0;
  try {
    const response = await page.request.post(`${origin}/api/demo/reset`, { data: {}, maxRedirects: 0 });
    if (new URL(response.url()).origin !== origin) throw new Error('unexpected origin');
    status = response.status();
  } catch { throw new Error('B008 local reset failed'); }
  expect(status).toBe(200);
  await signIn(page, ACCOUNTS.admin);
}
async function capture(): Promise<Saved> {
  return db(async client => {
    const control = (await client.query<Control>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='billing_previews'`)).rows[0];
    const orgs = (await client.query<{ feature_flags: unknown }>(`SELECT feature_flags FROM organizations WHERE id=$1`, [ORG_ID])).rows;
    const value = control?.value as { enabled?: unknown; allowed_org_ids?: unknown } | undefined;
    expect((control === undefined || (!!value && typeof value === 'object' && !Array.isArray(value) && value.enabled === false && Array.isArray(value.allowed_org_ids))) && orgs.length === 1).toBe(true);
    const flags = orgs[0].feature_flags as Record<string, unknown>;
    expect(flags && typeof flags === 'object' && !Array.isArray(flags) && flags.billing_previews !== true).toBe(true);
    const inbound = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND confrelid='public.platform_settings'::regclass`)).rows[0].n;
    expect(inbound === 0).toBe(true);
    return { control, flags };
  });
}
async function restore(saved: Saved) {
  await db(async client => {
    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM platform_settings WHERE key='billing_previews'`);
      if (saved.control) await client.query(`INSERT INTO platform_settings(key,value,description,updated_at) VALUES ('billing_previews',$1::jsonb,$2,$3::timestamptz)`, [JSON.stringify(saved.control.value), saved.control.description, saved.control.updated_at]);
      await client.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`, [ORG_ID, JSON.stringify(saved.flags)]);
      const control = (await client.query<Control>(`SELECT value,description,updated_at::text AS updated_at FROM platform_settings WHERE key='billing_previews'`)).rows;
      const orgs = (await client.query<{ feature_flags: unknown }>(`SELECT feature_flags FROM organizations WHERE id=$1`, [ORG_ID])).rows;
      expect(JSON.stringify(control) === JSON.stringify(saved.control ? [saved.control] : []) && orgs.length === 1 && JSON.stringify(orgs[0].feature_flags) === JSON.stringify(saved.flags)).toBe(true);
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* retain primary result */ } throw error; }
  });
}
async function off() {
  await db(client => client.query(`INSERT INTO platform_settings(key,value) VALUES ('billing_previews','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`));
}
async function top(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    window.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test('monthly rent detail stays scoped, read-only, and source-specific', async ({ page }, info) => {
  guard(info);
  const width = info.project.use.viewport?.width;
  if (width !== 390 && width !== 1280) throw new Error('B008 invalid viewport');
  const errors: string[] = [];
  page.on('pageerror', () => errors.push('page error'));
  page.on('console', message => { if (message.type() === 'error') errors.push('console error'); });
  page.on('response', response => { if (response.status() >= 500) errors.push('server error'); });
  await page.context().route('**/*', async route => {
    try { if (new URL(route.request().url()).origin === origin) { await route.continue(); return; } } catch { /* reject malformed URL */ }
    errors.push('off-origin request'); await route.abort();
  });
  let saved: Saved | undefined, primary: string | undefined, restoration: string | undefined;
  try {
    await reset(page);
    saved = await capture();
    await page.goto('/api/demo/locale?set=en&next=%2Fm%2Frent%2Fmonthly-preview%2F11111111-1111-4111-8111-111111111111%3Fmonth%3D2035-02');
    await off();
    await page.goto('/m/rent/monthly-preview/11111111-1111-4111-8111-111111111111?month=2035-02');
    await expect(page.getByTestId('monthly-rent-unavailable')).toContainText('Preview unavailable.');
    await expect(page.getByText('B008 rent detail', { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await top(page);
    await page.screenshot({ path: info.outputPath(`rent-detail-off-${width}.png`), fullPage: true });

    const fixtures = await db(async client => {
      await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`, [ORG_ID]);
      await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`, [ORG_ID]);
      const create = async (name: string, currency: string, amount: string, partyCount: number, archived = false, orgId = ORG_ID) => {
        const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,$2,$3,$4,'Asia/Taipei') RETURNING id::text`, [orgId, `B008 rent detail ${name}`, currency === 'TWD' ? 'TW' : 'US', currency])).rows[0].id;
        const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'Synthetic') RETURNING id::text`, [orgId, property])).rows[0].id;
        const lease = (await client.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,rent_frequency,due_day) VALUES ($1,$2,$3,$3,'active','2035-01-01',$4,$5,'monthly',31) RETURNING id::text`, [orgId, property, unit, currency, amount])).rows[0].id;
        const contacts: string[] = [];
        for (let i = 0; i < partyCount; i++) {
          const contact = (await client.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name,archived_at) VALUES ($1,true,$2,$3) RETURNING id::text`, [orgId, `B008 bill-to ${name} ${i + 1}`, archived && i === 0 ? new Date().toISOString() : null])).rows[0].id;
          contacts.push(contact);
          await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'primary')`, [orgId, lease, contact]);
        }
        return { lease, contacts };
      };
      return {
        twd: await create('TWD', 'TWD', '9876543210', 1),
        usd: await create('USD', 'USD', '12345', 1),
        missing: await create('No bill-to', 'TWD', '1000', 0),
        ambiguous: await create('Ambiguous', 'USD', '1000', 2),
        archived: await create('Archived', 'USD', '1000', 1, true),
        foreign: await create('Foreign organization secret fixture', 'USD', '99000', 1, false, ORG2_ID),
      };
    });

    await signIn(page, ACCOUNTS.manager);
    const month = '2035-02';
    await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(`/m/rent/monthly-preview?month=${month}`)}`);
    await expect(page.getByTestId('monthly-rows')).toBeVisible();
    const twdRow = page.getByTestId('monthly-rows').locator('tbody tr').filter({ hasText: 'B008 rent detail TWD · Synthetic' });
    const detailLink = twdRow.getByTestId('monthly-rent-detail-link');
    await expect(detailLink).toBeVisible();
    await detailLink.click();
    await expect(page).toHaveURL(new URL(`/m/rent/monthly-preview/${fixtures.twd.lease}?month=${month}`, origin).href);
    const detail = page.getByTestId('monthly-rent-detail');
    await expect(detail).toContainText('B008 rent detail TWD');
    await expect(detail).toContainText('B008 bill-to TWD 1');
    await expect(detail).toContainText('TWD 98765432.1');
    await expect(detail).toContainText('2035-02-01 – 2035-02-28');
    await expect(detail).toContainText('2035-02-28');
    await expect(detail).toContainText('Deposits, utilities, and other fees are excluded.');
    await expect(detail).toContainText('not a reservation');
    await expect(page.getByRole('button', { name: /generate|issue|post/i })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await top(page);
    await page.screenshot({ path: info.outputPath(`rent-detail-en-${width}.png`), fullPage: true });

    await db(client => client.query(`UPDATE leases SET rent_amount_minor='24680' WHERE id=$1 AND org_id=$2`, [fixtures.twd.lease, ORG_ID]));
    await page.reload();
    await expect(page.getByTestId('monthly-rent-detail')).toContainText('TWD 246.8');
    await db(async client => {
      await client.query(`DELETE FROM lease_parties WHERE lease_id=$1 AND contact_id=$2`, [fixtures.twd.lease, fixtures.twd.contacts[0]]);
      const contact = (await client.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES ($1,true,'B008 bill-to changed') RETURNING id::text`, [ORG_ID])).rows[0].id;
      await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'primary')`, [ORG_ID, fixtures.twd.lease, contact]);
    });
    await page.reload();
    await expect(page.getByTestId('monthly-rent-detail')).toContainText('B008 bill-to changed');

    await page.goto(`/m/rent/monthly-preview/${fixtures.usd.lease}?month=${month}`);
    await expect(page.getByTestId('monthly-rent-detail')).toContainText('B008 bill-to USD 1');
    await expect(page.getByTestId('monthly-rent-detail')).toContainText('USD 123.45');
    await page.goto(`/m/rent/monthly-preview/${fixtures.missing.lease}?month=${month}`);
    await expect(page.getByTestId('monthly-rent-unsupported')).toContainText('No bill-to contact is assigned');
    await page.goto(`/m/rent/monthly-preview/${fixtures.ambiguous.lease}?month=${month}`);
    await expect(page.getByTestId('monthly-rent-unsupported')).toContainText('More than one bill-to contact');
    await page.goto(`/m/rent/monthly-preview/${fixtures.archived.lease}?month=${month}`);
    await expect(page.getByTestId('monthly-rent-unsupported')).toContainText('bill-to contact is unavailable');
    await page.goto(`/m/rent/monthly-preview/${fixtures.twd.lease}?month=invalid`);
    await expect(page.getByTestId('monthly-rent-unavailable')).toBeVisible();
    await page.goto('/m/rent/monthly-preview/11111111-1111-4111-8111-111111111111?month=2035-02');
    await expect(page.getByTestId('monthly-rent-unavailable')).toBeVisible();
    await expect(page.getByText('B008 rent detail', { exact: false })).toHaveCount(0);
    await page.goto(`/m/rent/monthly-preview/${fixtures.foreign.lease}?month=${month}`);
    await expect(page.getByTestId('monthly-rent-unavailable')).toBeVisible();
    await expect(page.getByText('Foreign organization secret fixture', { exact: false })).toHaveCount(0);
    await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(`/m/rent/monthly-preview/${fixtures.twd.lease}?month=${month}`)}`);
    await expect(page.getByRole('heading', { name: '每月租金明細', exact: true })).toBeVisible();
    await expect(page.getByTestId('monthly-rent-detail')).toContainText('帳單對象');
    await expect(page.getByTestId('monthly-rent-detail')).toContainText('不包含押金、水電及其他費用。');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await top(page);
    await page.screenshot({ path: info.outputPath(`rent-detail-zh-${width}.png`), fullPage: true });
    await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(`/m/rent/monthly-preview/${fixtures.missing.lease}?month=${month}`)}`);
    await expect(page.getByTestId('monthly-rent-unsupported')).toContainText('No bill-to contact is assigned');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await top(page);
    await page.screenshot({ path: info.outputPath(`rent-detail-unsupported-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  } catch (error) { primary = safeFailure('monthly rent detail journey', error); }
  if (saved) try { await restore(saved); } catch (error) { restoration = safeFailure('control restoration', error); }
  if (primary || restoration) throw new Error([primary, restoration].filter(Boolean).join('; '));
});
