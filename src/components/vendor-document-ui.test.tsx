import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { VendorDocumentsPanel, type VendorDocumentsView } from './vendor-documents-panel';
import { VendorDocumentInvites } from './vendor-document-invites';
import { FixedDataForm, PaperScanForm, TradeItemsForm, documentAttachment } from './vendor-document-forms';
import { vendorDocumentsCopy } from '@/i18n/vendor-documents';

const profile = { kind: 'business' as const, display_name: 'Current name', business_name: 'Current business', representative_name: 'Representative', phone_e164: '+12025550125', address: 'Current address' };
const view: VendorDocumentsView = {
  profile, profileVersion: 3, ticketNumber: '123', totalMinor: '1200', receivedMinor: '0', marks: [],
  items: [{ name: 'Work', quantity: '2.5', unit: 'hour', unit_price_minor: '480', amount_minor: '1200' }],
  buyer: { kind: 'owner', titlePresent: true }, eligibleKind: 'receipt',
  documents: [{ id: 'document', kind: 'receipt', doc_no: 'TEST-1', status: 'issued', issued_at: '2026-11-06', reissued_from: null }],
  history: [{ id: 'document', version: 1, issuerName: 'Original business', fixedData: { ...profile, address: 'Original address' }, sealPresent: true,
    items: [], scans: [{ id: 'scan', mime_type: 'application/pdf' }] }],
};
function render(element: React.ReactElement) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { value: React, configurable: true });
  try { return renderToStaticMarkup(element); }
  finally { if (previous) Object.defineProperty(globalThis, 'React', previous); else Reflect.deleteProperty(globalThis, 'React'); }
}

test('OFF baseline: staff ticket page is byte-for-byte unchanged and layout returns the children', () => {
  const page = readFileSync(new URL('../app/m/tickets/[id]/page.tsx', import.meta.url));
  assert.equal(createHash('sha256').update(page).digest('hex'), '8255de8c1c492cffe9c28f9521f0d2611f4b478545ecc40fa5d1161a83901f56');
  const layout = readFileSync(new URL('../app/m/tickets/[id]/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /if \(!view\) return children;/);
  const pageSource = readFileSync(new URL('../app/v/documents/[token]/page.tsx', import.meta.url), 'utf8');
  assert.match(pageSource, /if \(!context\) notFound\(\)/);
});

test('ON: staff renders invite state and authorized create/revoke controls without capability hrefs', () => {
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  const html = render(<AppRouterContext.Provider value={router}><VendorDocumentInvites ticketId="ticket" locale="en" view={{
    profileId: 'profile', vendorName: 'Vendor', ready: true, owners: [{ id: 'owner', name: 'Owner' }],
    invites: [{ id: 'one', state: 'active', expiresAt: '2026-11-10' }, { id: 'two', state: 'revoked', expiresAt: '2026-11-10' }, { id: 'three', state: 'expired', expiresAt: '2026-11-01' }],
  }} /></AppRouterContext.Provider>);
  for (const label of ['Create document invitation', 'Revoke invitation', 'Active', 'Expired', 'Revoked']) assert.ok(html.includes(label));
  assert.equal((html.match(/Revoke invitation/g) ?? []).length, 1);
  assert.doesNotMatch(html, /href=|token_hash|\?token/);
});

test('ON: individual fixed data asks no company or seal fields; business uses versioned seal update', () => {
  const business = render(<FixedDataForm profile={profile} version={3} locale="en" pending={false} save={() => {}} />);
  const individual = render(<FixedDataForm profile={{ ...profile, kind: 'individual' }} version={3} locale="en" pending={false} save={() => {}} />);
  assert.match(business, /New seal image/); assert.match(business, /image\/png,image\/jpeg/);
  assert.match(business, /Issuer snapshot version<!-- --> 3|Issuer snapshot version 3/);
  assert.doesNotMatch(individual, /New seal image|Business name|Representative|tax|identity document/i);
  assert.match(individual, /Phone with country code/);
});

test('ON: token panel shows immutable history, sibling controls and receipt disclaimer without rendering the token', () => {
  const token = 'SENSITIVE_CAPABILITY_SENTINEL';
  const html = render(<VendorDocumentsPanel token={token} initial={view} locale="en" />);
  for (const label of ['Original address', 'Original business', 'Seal saved with this version', 'Attach paper scan', 'Paper scan', 'A receipt is not a tax invoice.', 'Edit quantities and units']) assert.ok(html.includes(label), label);
  assert.ok(!html.includes(token)); assert.doesNotMatch(html, /href=|\?token|owner.prepay|internal.settlement/i);
  const statement = render(<VendorDocumentsPanel token={token} initial={{ ...view, documents: [{ ...view.documents[0], kind: 'completion_statement' }] }} locale="en" />);
  assert.doesNotMatch(statement, /Attach paper scan/);
});

test('trade editor renders exact decimal strings and prices beyond float precision', () => {
  const rows = [{ name: 'Exact', quantity: '0.000001', unit: 'hour', unit_price_minor: '9007199254740993', category: 'labor' as const }];
  const html = render(<TradeItemsForm rows={rows} setRows={() => {}} pending={false} locale="en" totalMinor="9007199255" />);
  assert.match(html, /value="0.000001"/); assert.match(html, /value="9007199254740993"/);
  assert.match(html, /Work order total: 9007199255/); assert.doesNotMatch(html, /type="number"/);
  const invalid = render(<TradeItemsForm rows={[{ ...rows[0], quantity: '1e-6' }]} setRows={() => {}} pending={false} locale="en" totalMinor="9007199255" />);
  assert.match(invalid, /Enter valid quantities/);
});

test('scan upload accepts only bounded PNG/JPEG/PDF, retains exact bytes and starts disabled', async () => {
  const html = render(<PaperScanForm pending={false} locale="en" upload={async () => true} />);
  assert.match(html, /accept="image\/png,image\/jpeg,application\/pdf"/);
  assert.match(html, /disabled=""/);
  const result = await documentAttachment(new File(['%PDF-test'], 'scan.pdf', { type: 'application/pdf' }));
  assert.equal(atob(result.base64), '%PDF-test');
  await assert.rejects(documentAttachment(new File(['x'], 'x.html', { type: 'text/html' })));
  await assert.rejects(documentAttachment(new File(['%PDF-test'], 'scan.pdf', { type: 'application/pdf' }), true));
  await assert.rejects(documentAttachment(new File([new Uint8Array(5242881)], 'large.png', { type: 'image/png' })));
});

test('both copy lanes expose the same keys and approved language', () => {
  const en = vendorDocumentsCopy('en'), zh = vendorDocumentsCopy('zh-TW');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.doesNotMatch(Object.values(zh).join(' '), /收款|收租|入帳|已收|統一編號/);
});

// Real React event handling in an installed local browser. Every request is
// intercepted; neither a running app, external network nor a DB is required.
test('issuance and fixed-data interaction regressions', { timeout: 120000 }, async (t) => {
  const { build } = await import('esbuild');
  const { chromium, expect } = await import('@playwright/test');
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { VendorDocumentsPanel } from './src/components/vendor-documents-panel';
      import { FixedDataForm } from './src/components/vendor-document-forms';
      window.mount = (view, form) => createRoot(document.getElementById('root')).render(form
        ? <FixedDataForm profile={view.profile} version={view.profileVersion} pending={false} locale="en"
            save={(update) => window.saved.push(update)} />
        : <VendorDocumentsPanel initial={view} token="local-test-capability" locale="en" />);
      window.saved = [];
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  // Clean CI runners install Chromium only after test:unit; skip (explicitly) rather than fail there.
  const { existsSync } = await import('node:fs');
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium is not installed on this runner (installed later for e2e)'); return; }
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  type RequestBody = { action: string; kind: 'receipt' | 'completion_statement'; idempotencyKey?: string; documentId?: string;
    tradeItems?: Array<{ quantity: string; unit_price_minor: string }>; received?: { requestId: string; amountMinor: string } };
  async function mount(initial: VendorDocumentsView, options: { form?: boolean; fail?: number; refreshFails?: boolean } = {}) {
    const page = await browser.newPage();
    const context = structuredClone(initial), requests: RequestBody[] = [];
    let failures = options.fail ?? 0;
    await page.route('**/*', async (route) => {
      if (route.request().method() !== 'POST') {
        if (route.request().url() === 'http://127.0.0.1/') await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
        else await route.abort();
        return;
      }
      assert.equal(new URL(route.request().url()).hostname, '127.0.0.1');
      const body = route.request().postDataJSON() as RequestBody;
      if (body.action === 'context') {
        await route.fulfill({ status: options.refreshFails ? 503 : 200, json: context }); return;
      }
      requests.push(body);
      if (failures-- > 0) { await route.abort(); return; }
      if (body.action === 'void') context.documents.find((d) => d.id === body.documentId)!.status = 'voided';
      else if (body.action === 'issue' || body.action === 'reissue') {
        context.documents.push({ id: `issued-${requests.length}`, kind: body.kind, status: 'issued', doc_no: `TEST-${requests.length}`,
          issued_at: '2026-11-06', reissued_from: body.documentId ?? null });
        if (body.received) context.receivedMinor = context.totalMinor;
      }
      await route.fulfill({ json: { document: context.documents.at(-1) } });
    });
    await page.goto('http://127.0.0.1/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(({ initial, form }) => {
      (window as unknown as { mount: (v: VendorDocumentsView, f: boolean) => void }).mount(initial, form);
    }, { initial, form: !!options.form });
    await page.getByTestId(options.form ? 'vendor-fixed-data' : 'vendor-documents').waitFor();
    return { page, requests };
  }
  const fresh = { ...view, documents: [], history: [], receivedMinor: '1200' };
  async function edit(page: import('@playwright/test').Page, quantity: string, price: string) {
    await page.getByLabel('Edit quantities and units').check();
    await page.getByLabel('Quantity', { exact: true }).fill(quantity);
    await page.getByLabel('Unit price (integer minor units)', { exact: true }).fill(price);
  }
  for (const kind of ['receipt', 'completion_statement'] as const) {
    await t.test(`${kind}: issue, edit same total, block fresh issue, void and reissue changed rows`, async () => {
      const { page, requests } = await mount(fresh);
      try {
        const issueButton = page.getByRole('button', { name: kind === 'receipt' ? 'Issue receipt' : 'Issue completion statement', exact: true });
        await issueButton.click(); await page.getByText('Done.', { exact: true }).waitFor();
        await edit(page, '5', '240');
        await expect(issueButton).toBeDisabled(); assert.equal(requests.length, 1);
        await page.getByLabel('Reason for voiding', { exact: true }).fill('Correct quantities');
        await page.getByRole('button', { name: 'Void', exact: true }).click();
        await page.getByRole('button', { name: 'Reissue', exact: true }).waitFor();
        await expect(issueButton).toBeDisabled();
        await page.getByRole('button', { name: 'Reissue', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Reissue', exact: true })).toBeDisabled();
        assert.equal(requests[2].action, 'reissue'); assert.equal(requests[2].tradeItems?.[0].quantity, '5');
        assert.equal(requests[2].tradeItems?.[0].unit_price_minor, '240');
        assert.notEqual(requests[2].idempotencyKey, requests[0].idempotencyKey);
      } finally { await page.close(); }
    });
  }
  for (const mode of ['receipt', 'one-step', 'reissue'] as const) {
    await t.test(`${mode}: uncertain response retries exact payload; changed same-total draft cannot replay`, async () => {
      const initial: VendorDocumentsView = mode === 'reissue'
        ? { ...fresh, documents: [{ ...view.documents[0], status: 'voided' }] }
        : { ...fresh, receivedMinor: mode === 'one-step' ? '0' : '1200' };
      const { page, requests } = await mount(initial, { fail: 2 });
      try {
        await edit(page, '2.5', '480');
        const button = page.getByRole('button', { name: mode === 'receipt' ? 'Issue receipt' : mode === 'one-step' ? 'Confirm paid in full on site and issue receipt' : 'Reissue', exact: true });
        await button.click(); await expect(page.getByRole('alert')).toHaveText(vendorDocumentsCopy('en').unavailable);
        await button.click(); await expect(page.getByRole('alert')).toHaveText(vendorDocumentsCopy('en').unavailable);
        assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
        await edit(page, '5', '240'); await button.click();
        await expect(page.getByRole('alert')).toHaveText(vendorDocumentsCopy('en').retryUnchanged);
        assert.equal(requests.length, 2);
        await edit(page, '2.5', '480'); await button.click();
        await page.getByText('Done.', { exact: true }).waitFor();
        assert.deepEqual(requests[2], requests[0]);
        if (mode === 'one-step') assert.equal(requests[0].received?.amountMinor, '1200');
      } finally { await page.close(); }
    });
  }
  await t.test('successful issuance stays disabled when context refresh fails, including one-step', async () => {
    const { page, requests } = await mount({ ...fresh, receivedMinor: '0' }, { refreshFails: true });
    try {
      const button = page.getByRole('button', { name: 'Confirm paid in full on site and issue receipt', exact: true });
      await button.click(); await page.getByText('Done.', { exact: true }).waitFor();
      await edit(page, '5', '240'); await expect(button).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Issue receipt', exact: true })).toBeDisabled();
      assert.equal(requests.length, 1);
    } finally { await page.close(); }
  });
  await t.test('individual clears optional address to null alongside other edits; phone validation is field-specific', async () => {
    const { page } = await mount({ ...fresh, profile: { ...profile, kind: 'individual' } }, { form: true });
    try {
      await page.getByLabel('Address', { exact: true }).fill('   ');
      await page.getByLabel('Name', { exact: true }).fill('Changed name');
      const phone = page.getByLabel('Phone with country code', { exact: true });
      await phone.fill('bad'); await page.getByRole('button', { name: 'Save new version' }).click();
      await expect(phone).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('alert')).toHaveText(vendorDocumentsCopy('en').phoneInvalid);
      assert.deepEqual(await page.evaluate(() => (window as unknown as { saved: unknown[] }).saved), []);
      await phone.fill('+12025550126'); await page.getByRole('button', { name: 'Save new version' }).click();
      assert.deepEqual(await page.evaluate(() => (window as unknown as { saved: unknown[] }).saved),
        [{ expectedVersion: 3, display_name: 'Changed name', phone_e164: '+12025550126', address: null }]);
    } finally { await page.close(); }
  });
  await t.test('business blank address shows its own validation and submits nothing', async () => {
    const { page } = await mount(fresh, { form: true });
    try {
      const address = page.getByLabel('Address', { exact: true });
      await address.fill(''); await page.getByRole('button', { name: 'Save new version' }).click();
      await expect(address).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('alert')).toHaveText(vendorDocumentsCopy('en').fieldRequired);
      assert.deepEqual(await page.evaluate(() => (window as unknown as { saved: unknown[] }).saved), []);
    } finally { await page.close(); }
  });
});
