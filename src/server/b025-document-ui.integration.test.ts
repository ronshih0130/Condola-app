import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test, { mock } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import nextHeaders from 'next/headers';
import { Client } from 'pg';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { ORG_ID, ORG2_ID, USERS } from './ids';
import { SESSION_COOKIE } from './auth';
import { ENV_COOKIE, ORG_COOKIE } from './org-scope';
import { buildStoredConsent } from './consent';
import { getSession, sessionTokenHash } from './session';
import { actionCreateVendorDocumentInvite, actionRevokeVendorDocumentInvite } from './vendor-document-invite-actions';
import { vendorDocumentInvitesView } from './vendor-document-invites';
import { POST } from '../app/api/vendor-documents/route';
import { POST as SCAN } from '../app/api/vendor-documents/scan/route';
import { POST as PDF } from '../app/api/vendor-documents/pdf/route';
import VendorPage from '../app/v/documents/[token]/page';
import TicketLayout from '../app/m/tickets/[id]/layout';
import { VendorDocumentsPanel, type VendorDocumentsView } from '../components/vendor-documents-panel';

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
let sessionToken = '', orgCookie = ORG_ID;
const envKeys = ['APP_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const sealPaths = new Set<string>();
const font = readFileSync(new URL('../../public/fonts/DroidSansFallback-subset.ttf', import.meta.url));
const seal = readFileSync(new URL('../../public/favicon-32x32.png', import.meta.url));
const assets = createServer((req, res) => {
  if (req.url === '/fonts/DroidSansFallback-subset.ttf') res.end(font);
  else if (sealPaths.has(req.url ?? '')) res.end(seal);
  else { res.statusCode = 404; res.end(); }
});
// Only the Next request cookie/header adapter is substituted. Real session lookup,
// consent, membership, server actions, SQL gateways and HTTP handlers execute.
mock.method(nextHeaders, 'cookies', async () => ({ get(name: string) {
  const value = name === SESSION_COOKIE ? sessionToken : name === ORG_COOKIE ? orgCookie : name === ENV_COOKIE ? 'live' : name === 'condola_locale' ? 'en' : '';
  return value ? { value } : undefined;
} }));
mock.method(nextHeaders, 'headers', async () => new Headers({ 'x-pathname': '/m/tickets' }));
test.before(async () => {
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  await new Promise<void>((resolve) => assets.listen(0, '127.0.0.1', resolve));
  const address = assets.address(); assert.ok(address && typeof address !== 'string');
  process.env.APP_URL = process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-fixture-only';
});
test.after(async () => {
  await new Promise<void>((resolve, reject) => assets.close((error) => error ? reject(error) : resolve()));
  for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  mock.restoreAll(); await db?.end(); await clone?.cleanup();
});
async function login(userId: string, orgId = ORG_ID) {
  sessionToken = randomUUID(); orgCookie = orgId;
  await db.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`, [userId, sessionTokenHash(sessionToken)]);
  const consent = buildStoredConsent('reconsent');
  await db.query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,
    [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  const session = await getSession(); assert.equal(session.userId, userId); assert.equal(session.orgId, orgId);
  return session;
}
async function flag(on: boolean) {
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text,$3::text)) WHERE key='vendor_documents'`, [on, ORG_ID, ORG2_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('vendor_documents',$1::boolean) WHERE id=ANY($2::uuid[])`, [on, [ORG_ID, ORG2_ID]]);
}
async function fixture(orgId = ORG_ID, kind: 'business' | 'individual' = 'business') {
  const property = (await db.query(`SELECT id FROM properties WHERE org_id=$1 AND archived_at IS NULL AND address_display IS NOT NULL LIMIT 1`, [orgId])).rows[0].id;
  const owner = (await db.query(`INSERT INTO contacts(org_id,is_owner,display_name,receipt_title) VALUES($1,true,'Owner fixture','Owner supplied title') RETURNING id`, [orgId])).rows[0].id;
  await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,is_primary) VALUES($1,$2,$3,false)`, [orgId, property, owner]);
  const contact = (await db.query(`INSERT INTO contacts(org_id,is_vendor,display_name) VALUES($1,true,'UI Vendor') RETURNING id`, [orgId])).rows[0].id;
  const file = randomUUID(), sealPath = `org/${orgId}/tickets/${randomUUID()}/${file}.png`;
  sealPaths.add(`/storage/v1/object/ticket-photos-private/${sealPath}`);
  await db.query(`INSERT INTO files(id,org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes) VALUES($1,$2,'ticket-photos-private',$3,'seal.png','image/png',$4)`, [file, orgId, sealPath, seal.length]);
  const profile = (await db.query(`INSERT INTO vendor_profiles(org_id,contact_id,vendor_code,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id)
    VALUES($1,$2,'UI',$4,'UI Vendor',CASE WHEN $4='business' THEN 'Original business' END,CASE WHEN $4='business' THEN 'Representative' END,CASE WHEN $4='business' THEN '04595257' END,'+12025550125','Original address',now(),CASE WHEN $4='business' THEN $3::uuid END) RETURNING id`, [orgId, contact, file, kind])).rows[0].id;
  await db.query(`INSERT INTO vendor_profile_versions(org_id,vendor_profile_id,version,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id)
    SELECT org_id,id,1,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,qualification_attested_at,seal_file_id FROM vendor_profiles WHERE id=$1`, [profile]);
  const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,status,title,assigned_vendor_contact_id,currency,final_cost_minor,type_fields)
    VALUES($1,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),$2,'closed','UI work',$3,'TWD',120000,'{"pricing":{"mode":"lump_sum"}}') RETURNING id`, [orgId, property, contact])).rows[0].id;
  await db.query(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,created_by,vendor_contact_id)
    VALUES($1,$2,'UI Vendor','+12025550125','Fixture',$3,now()+interval '1 day',$4,$5)`, [orgId, ticket, randomUUID().replaceAll('-', '').padEnd(64, '0'), orgId === ORG_ID ? USERS.admin : USERS.coastAdmin, contact]);
  return { ticket, profile, owner };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function create(f: Fixture) { return actionCreateVendorDocumentInvite({ ticketId: f.ticket, profileId: f.profile, buyer: { kind: 'owner', contactId: f.owner } }); }
function req(body: Record<string, unknown>) { return new Request('http://127.0.0.1/api/vendor-documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
async function call(token: string, body: Record<string, unknown>) { return POST(req({ token, ...body })); }
async function domain() {
  const result: Record<string, unknown> = {};
  for (const table of ['vendor_document_grants', 'vendor_documents', 'vendor_profile_versions', 'vendor_document_pdf_bytes', 'app.b025_paper_scans', 'app.b025_received_marks', 'audit_log']) {
    result[table] = (await db.query(`SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY row_to_json(t)::text),'')) AS hash FROM ${table} t`)).rows[0].hash;
  }
  return result;
}
function render(element: React.ReactElement) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'React');
  Object.defineProperty(globalThis, 'React', { value: React, configurable: true });
  try { return renderToStaticMarkup(element); }
  finally { if (previous) Object.defineProperty(globalThis, 'React', previous); else Reflect.deleteProperty(globalThis, 'React'); }
}

test('real invite actions: strict flags, backend staff roles, foreign org and revocation', async (t) => {
  const f = await fixture(); let grant = '', token = '';
  const admin = await login(USERS.admin);
  await t.test('OFF and malformed flags return the exact original children; actions have zero domain writes; vendor page/routes 404', async () => {
    await flag(true); const existing = await create(f); assert.ok(existing.ok); grant = existing.grantId; token = existing.url.split('/').at(-1)!;
    for (const value of [null, { enabled: false, allowed_org_ids: [ORG_ID] }, { enabled: 'true', allowed_org_ids: [ORG_ID] }, { enabled: true, allowed_org_ids: ORG_ID }, { enabled: true, allowed_org_ids: [] }]) {
      await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='vendor_documents'`, [JSON.stringify(value)]);
      const before = await domain();
      assert.equal(await vendorDocumentInvitesView(admin, f.ticket), null);
      const children = React.createElement('main', null, 'original ticket');
      assert.equal(await TicketLayout({ children, params: Promise.resolve({ id: f.ticket }) }), children);
      assert.deepEqual(await create(f), { ok: false }); assert.deepEqual(await actionRevokeVendorDocumentInvite(grant), { ok: false });
      await assert.rejects(VendorPage({ params: Promise.resolve({ token }) }), (e: unknown) => String((e as { digest: string }).digest).includes('404'));
      for (const handler of [POST, SCAN, PDF]) assert.equal((await handler(req({ token, action: 'context', scanId: randomUUID(), documentId: randomUUID() }))).status, 404);
      assert.deepEqual(await domain(), before);
    }
    await flag(true);
    for (const value of [false, 'true', null]) {
      await db.query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{vendor_documents}',$1::jsonb) WHERE id=$2`, [JSON.stringify(value), ORG_ID]);
      const before = await domain(); assert.equal(await vendorDocumentInvitesView(admin, f.ticket), null);
      assert.deepEqual(await create(f), { ok: false }); assert.deepEqual(await actionRevokeVendorDocumentInvite(grant), { ok: false });
      assert.deepEqual(await domain(), before);
    }
  });
  await t.test('admin, manager and maintenance create/revoke; accountant and portal users denied', async () => {
    await flag(true);
    for (const user of [USERS.admin, USERS.manager, USERS.maintenance]) {
      const session = await login(user); const result = await create(f); assert.ok(result.ok);
      assert.match(result.url, /^\/v\/documents\/[A-Za-z0-9_-]+$/); assert.ok(!result.url.includes('?'));
      const view = await vendorDocumentInvitesView(session, f.ticket); assert.ok(view?.ready);
      assert.ok(view.invites.some((i) => i.id === result.grantId && i.state === 'active'));
      assert.doesNotMatch(JSON.stringify(view), /token_hash|\/v\/documents\//);
      assert.deepEqual(await actionRevokeVendorDocumentInvite(result.grantId), { ok: true });
      assert.ok((await vendorDocumentInvitesView(session, f.ticket))?.invites.some((i) => i.id === result.grantId && i.state === 'revoked'));
      assert.equal((await call(result.url.split('/').at(-1)!, { action: 'context' })).status, 404);
    }
    for (const user of [USERS.accountant, USERS.tenant, USERS.owner]) {
      await login(user); const before = await domain();
      assert.deepEqual(await create(f), { ok: false }); assert.deepEqual(await actionRevokeVendorDocumentInvite(grant), { ok: false });
      assert.deepEqual(await domain(), before);
    }
  });
  await t.test('foreign org cannot read, create or revoke even with both orgs allowlisted', async () => {
    const outsider = await login(USERS.coastAdmin, ORG2_ID); const before = await domain();
    assert.equal(await vendorDocumentInvitesView(outsider, f.ticket), null);
    assert.deepEqual(await create(f), { ok: false }); assert.deepEqual(await actionRevokeVendorDocumentInvite(grant), { ok: false });
    assert.deepEqual(await domain(), before);
  });
  await t.test('new invitation revokes prior capability; expiry appears in safe metadata', async () => {
    const session = await login(USERS.admin); const first = await create(f); assert.ok(first.ok);
    const second = await create(f); assert.ok(second.ok);
    assert.equal((await call(first.url.split('/').at(-1)!, { action: 'context' })).status, 404);
    await db.query(`UPDATE vendor_document_grants SET expires_at=now()-interval '1 second' WHERE id=$1`, [second.grantId]);
    assert.ok((await vendorDocumentInvitesView(session, f.ticket))?.invites.some((i) => i.id === second.grantId && i.state === 'expired'));
  });
});

test('real UI routes: exact trade strings, fixed-data/seal history and sibling scan upload/download', async (t) => {
  await flag(true); await login(USERS.admin); const f = await fixture(), invite = await create(f); assert.ok(invite.ok);
  const token = invite.url.split('/').at(-1)!;
  const trades = [{ name: 'Trade work', quantity: '2.5', unit: 'hour', unit_price_minor: '480', category: 'labor' }];
  const issue = { action: 'issue', kind: 'receipt', documentDate: '2026-11-06', tradeItems: trades };
  let documentId = '', original: Buffer;
  await t.test('fixed data appends a version; stale updates fail; no raw seal is sent to the UI', async () => {
    const update = { expectedVersion: 1, business_name: 'Version two business', seal: { mimeType: 'image/png', base64: seal.toString('base64') } };
    const result = await call(token, { action: 'update_fixed_data', update }); assert.equal(result.status, 200);
    assert.equal((await result.json()).version, 2);
    assert.equal((await call(token, { action: 'update_fixed_data', update })).status, 400);
    const context = await (await call(token, { action: 'context' })).json();
    assert.equal(context.profileVersion, 2); assert.equal(context.profile.business_name, 'Version two business');
    assert.doesNotMatch(JSON.stringify(context), /base64|token_hash|tax_id|prepay|settlement/);
  });
  await t.test('preview preserves sequence; exact decimal strings survive issuance; invalid floats and mismatched sums fail', async () => {
    const before = (await db.query('SELECT * FROM vendor_document_sequences t ORDER BY to_jsonb(t)::text')).rows;
    const preview = await call(token, { ...issue, action: 'preview' }); assert.equal(preview.status, 200);
    assert.deepEqual((await db.query('SELECT * FROM vendor_document_sequences t ORDER BY to_jsonb(t)::text')).rows, before);
    for (const tradeItems of [[{ ...trades[0], quantity: 2.5 }], [{ ...trades[0], unit_price_minor: 480 }], [{ ...trades[0], quantity: '1e2' }], [{ ...trades[0], unit_price_minor: '480.0' }], [{ ...trades[0], unit: '' }], [{ ...trades[0], unit_price_minor: '481' }]]) {
      assert.equal((await call(token, { ...issue, action: 'preview', tradeItems })).status, 400);
    }
    assert.equal((await call(token, { ...issue, idempotencyKey: randomUUID() })).status, 409);
    const issued = await call(token, { ...issue, idempotencyKey: randomUUID(), received: { requestId: randomUUID(), amountMinor: '1200' } });
    assert.equal(issued.status, 200); const stored = await issued.json(); documentId = stored.document.id;
    assert.equal(stored.document.items[0].quantity, '2.5'); assert.equal(stored.document.items[0].unit_price_minor, '480');
    const pdf = await PDF(req({ token, documentId })); assert.equal(pdf.status, 200); original = Buffer.from(await pdf.arrayBuffer());
  });
  await t.test('paper scan is an idempotent sibling, leaves electronic bytes/payment totals unchanged and rejects foreign capability', async () => {
    const payment = (await db.query('SELECT * FROM app.b025_received_marks ORDER BY id')).rows;
    const scan = { action: 'attach_scan', documentId, requestId: randomUUID(), mimeType: 'application/pdf', base64: Buffer.from('%PDF-fixture').toString('base64') };
    const response = await call(token, scan); assert.equal(response.status, 200); const { id } = await response.json();
    assert.equal((await (await call(token, scan)).json()).id, id);
    const download = await SCAN(req({ token, scanId: id })); assert.equal(download.status, 200); assert.equal(await download.text(), '%PDF-fixture');
    assert.deepEqual((await db.query('SELECT * FROM app.b025_received_marks ORDER BY id')).rows, payment);
    assert.deepEqual(Buffer.from(await (await PDF(req({ token, documentId }))).arrayBuffer()), original);
    await login(USERS.coastAdmin, ORG2_ID); const foreign = await create(await fixture(ORG2_ID)); assert.ok(foreign.ok);
    const foreignToken = foreign.url.split('/').at(-1)!;
    assert.equal((await call(foreignToken, { ...scan, requestId: randomUUID() })).status, 403);
    assert.equal((await SCAN(req({ token: foreignToken, scanId: id }))).status, 403);
  });
  await t.test('history renders the original fixed-data/seal snapshot after further updates', async () => {
    assert.equal((await call(token, { action: 'update_fixed_data', update: { expectedVersion: 2, business_name: 'Version three business', address: 'New address' } })).status, 200);
    const response = await call(token, { action: 'context' }); assert.equal(response.status, 200); const context = await response.json();
    const historical = context.history.find((h: { id: string }) => h.id === documentId);
    assert.equal(historical.version, 2); assert.equal(historical.issuerName, 'Version two business'); assert.equal(historical.fixedData.address, 'Original address');
    assert.equal(historical.sealPresent, true); assert.equal(historical.scans.length, 1);
    const html = render(React.createElement(VendorDocumentsPanel, { token, initial: context as VendorDocumentsView, locale: 'en' }));
    for (const expected of ['Version two business', 'Version three business', 'Original address', 'New address', 'Seal saved with this version', 'Paper scan']) assert.ok(html.includes(expected), expected);
    assert.ok(!html.includes(token)); assert.doesNotMatch(html, /href=|\?token|prepay|settlement/);
    assert.deepEqual(Buffer.from(await (await PDF(req({ token, documentId }))).arrayBuffer()), original);
  });
});


test('real preview route preserves a unit price beyond Number precision', async () => {
  await flag(true); await login(USERS.admin); const f = await fixture();
  await db.query('UPDATE maintenance_tickets SET final_cost_minor=$1 WHERE id=$2', ['900719925500', f.ticket]);
  const invite = await create(f); assert.ok(invite.ok);
  const response = await call(invite.url.split('/').at(-1)!, { action: 'preview', kind: 'completion_statement', documentDate: '2026-11-06',
    tradeItems: [{ name: 'Exact work', quantity: '0.000001', unit: 'hour', unit_price_minor: '9007199254740993', category: 'labor' }] });
  assert.equal(response.status, 200); const { document } = await response.json();
  assert.equal(document.items[0].quantity, '0.000001'); assert.equal(document.items[0].unit_price_minor, '9007199254740993');
  assert.equal(document.items[0].amount_minor, '9007199255'); assert.equal(String(document.total_minor), '9007199255');
});


test('individual optional address clears to null with other changes; required business address cannot clear', async () => {
  await flag(true); await login(USERS.admin);
  const f = await fixture(ORG_ID, 'individual'), invite = await create(f); assert.ok(invite.ok);
  const token = invite.url.split('/').at(-1)!;
  const response = await call(token, { action: 'update_fixed_data', update: { expectedVersion: 1, address: null, display_name: 'Updated name' } });
  assert.equal(response.status, 200);
  const context = await (await call(token, { action: 'context' })).json();
  assert.equal(context.profile.address, null); assert.equal(context.profile.display_name, 'Updated name'); assert.equal(context.profileVersion, 2);
  const versions = (await db.query('SELECT version,address,display_name FROM vendor_profile_versions WHERE vendor_profile_id=$1 ORDER BY version', [f.profile])).rows;
  assert.deepEqual(versions.map((v) => v.address), ['Original address', null]);
  assert.equal(versions[1].display_name, 'Updated name');
  for (const update of [{ address: '' }, { phone_e164: 'invalid' }, { display_name: null }]) {
    const before = await domain();
    assert.equal((await call(token, { action: 'update_fixed_data', update: { expectedVersion: 2, ...update } })).status, 400);
    assert.deepEqual(await domain(), before);
  }
  const business = await fixture(), businessInvite = await create(business); assert.ok(businessInvite.ok);
  const before = await domain();
  assert.equal((await call(businessInvite.url.split('/').at(-1)!, { action: 'update_fixed_data', update: { expectedVersion: 1, address: null, display_name: 'Rejected name' } })).status, 400);
  assert.deepEqual(await domain(), before);
});
