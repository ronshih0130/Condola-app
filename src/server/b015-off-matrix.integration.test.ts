import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { ArchiveRef } from '@/lib/record-archive';
import { buildStoredConsent } from './consent';
import { query, withClient } from './db';
import { uploadSignedLeasePdf } from './domain';
import { FlowError } from './errors';
import { ORG_ID, ORG2_ID, USERS } from './ids';
import { createLeaseFromForm } from './lease-form';
import { archiveCommand, archiveScope, archiveView } from './record-archive';
import { resetAndSeed } from './seed';
import { directoryContactEditView, editDirectoryContact } from './tenant-directory-edit';
import { tenantEndedLeaseDetail, tenantEndedLeaseList, tenantEndedLeaseSignedPdf } from './tenant-lease-history';
import { insertTestAuthSession } from './test-auth-session';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import type { Session } from './types';

// Reuse the isolated clone/seed, ancestry, contact snapshot and lease-form fixture
// contracts from record-archive, tenant-directory-edit, tenant-lease and
// tenant-lease-history.integration.test.ts. Never toggle the source database.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const featureKeys = ['record_archive', 'tenant_directory_edit'] as const;
const controlKeys = [...featureKeys, 'tenant_signed_pdf'];
const enabled = { enabled: true, allowed_org_ids: [ORG_ID] };
const globals = [
  { name: 'missing', value: undefined },
  { name: 'boolean false', value: false },
  { name: 'enabled false', value: { ...enabled, enabled: false } },
  { name: 'malformed null', value: null },
  { name: 'malformed enabled string', value: { ...enabled, enabled: 'true' } },
  { name: 'malformed allowlist', value: { enabled: true, allowed_org_ids: 'all' } },
  { name: 'empty allowlist', value: { enabled: true, allowed_org_ids: [] } },
  { name: 'enabled', value: enabled },
];
const optIns = ['absent', 'false', 'true'] as const;
type OptIn = typeof optIns[number];
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let staff: Session, tenant: Session, contactId: string, foreignContactId: string;
let history: Awaited<ReturnType<typeof ancestry>> & { lease: string; pdf: string };
let targets: Array<{ ref: ArchiveRef; desired: 'active' | 'archived' }>;
const pdfBytes = new TextEncoder().encode('%PDF-1.4 B015 OFF synthetic history');
const previousPdfEnv = process.env.TENANT_SIGNED_PDF_ENABLED;

// PostgreSQL JSON preserves full timestamp precision (pg Date would lose the
// microseconds). Capture ALL columns, row presence and every org's whole flags.
async function controlsSnapshot() {
  return {
    settings: (await query<{ row: { key: string } }>(
      `SELECT to_jsonb(p) AS row FROM platform_settings p ORDER BY key`,
    )).rows.map(r => r.row),
    organizations: (await query<{ id: string; flags: unknown }>(
      `SELECT id::text, feature_flags AS flags FROM organizations ORDER BY id`,
    )).rows,
  };
}
async function withRestoredControls(work: () => Promise<void>) {
  const before = await controlsSnapshot();
  try {
    await work();
  } finally {
    await withClient(async c => {
      await c.query('BEGIN');
      try {
        await c.query(`DELETE FROM platform_settings WHERE key=ANY($1::text[])`, [controlKeys]);
        await c.query(`INSERT INTO platform_settings SELECT * FROM jsonb_populate_recordset(NULL::platform_settings,$1::jsonb)`,
          [JSON.stringify(before.settings.filter(row => controlKeys.includes(row.key)))]);
        await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,
          [ORG_ID, JSON.stringify(before.organizations.find(row => row.id === ORG_ID)!.flags)]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    });
    assert.deepEqual(await controlsSnapshot(), before, 'restore exact control rows, absent rows and whole org flags');
  }
}
async function setControl(key: string, value: unknown, optIn: OptIn) {
  if (value === undefined) await query(`DELETE FROM platform_settings WHERE key=$1`, [key]);
  else await query(`INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify(value)]);
  await query(`UPDATE organizations SET feature_flags=coalesce(feature_flags,'{}'::jsonb)-$2::text WHERE id=$1`, [ORG_ID, key]);
  if (optIn !== 'absent') await query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,ARRAY[$2::text],$3::jsonb) WHERE id=$1`, [ORG_ID, key, optIn]);
}
async function ancestry() {
  const property = (await query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone)
    VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`, [ORG_ID, `B015 OFF ${randomUUID()}`])).rows[0].id;
  const unit = (await query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode)
    VALUES($1,$2,'one','by_room') RETURNING id::text`, [ORG_ID, property])).rows[0].id;
  const room = (await query<{ id: string }>(`INSERT INTO rooms(org_id,unit_id,label)
    VALUES($1,$2,'room') RETURNING id::text`, [ORG_ID, unit])).rows[0].id;
  return { property, unit, room };
}
async function ready(ref: ArchiveRef) {
  const view = await archiveView(staff, ref);
  assert.equal(view.state, 'ready');
  if (view.state !== 'ready') throw new Error('Archive fixture unavailable');
  return view;
}
async function command(ref: ArchiveRef, desired: 'active' | 'archived') {
  const view = await ready(ref);
  return archiveCommand(staff, { ref, desired, expectedVersion: view.observed.version,
    renderedScope: archiveScope(staff), reason: 'Synthetic OFF matrix', requestId: randomUUID() });
}
async function editIntent() {
  const expected = (await query<{ snapshot: string }>(`SELECT app.b015_contact_snapshot($1,$2) AS snapshot`, [ORG_ID, contactId])).rows[0].snapshot;
  return { contactId, requestId: randomUUID(), expected, name: 'OFF must not change this',
    email: `${randomUUID()}@example.test`, phone: '+19995550222' };
}
async function businessSnapshot() {
  // Full rows, including timestamps, identity links and PDF content. Rejection
  // command receipts are intentional metadata, not business mutation audits.
  const tables = ['properties', 'units', 'rooms', 'contacts', 'leases', 'lease_parties',
    'lease_signatures', 'invoices', 'payments', 'identity_documents', 'files', 'lease_signed_pdfs',
    'profiles', 'auth.users'] as const;
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  rows.auditCount = (await query(`SELECT count(*)::text AS count FROM audit_log`)).rows[0].count;
  return rows;
}
function leaseForm(roomId: string, tenantMode: string) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ roomId, tenantMode,
    tenantName: '', tenantPhone: '', tenantEmail: '', lineUserId: '',
    startDate: '2092-01-01', months: '12', rent: '10000', depositMonths: '2',
    depositReason: '', dueDay: '5', splitMethod: 'even', billTotal: '',
    usage: '', rate: '', overrideReason: '' })) form.set(key, value);
  return form;
}

test.before(async () => {
  clone = await cloneTestDatabase();
  const names = ['DEMO_MODE', 'ID_DOC_ENCRYPTION_KEY', 'ID_DOC_HMAC_KEY', 'ID_DOC_SIGNING_SECRET', 'CRON_SECRET'] as const;
  const saved = Object.fromEntries(names.map(key => [key, process.env[key]]));
  try {
    process.env.DEMO_MODE = 'true';
    for (const key of names.slice(1)) process.env[key] = randomBytes(32).toString('hex');
    await resetAndSeed();
  } finally {
    for (const key of names) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  process.env.TENANT_SIGNED_PDF_ENABLED = 'true';
  staff = { userId: USERS.admin, sessionId: await withClient(c => insertTestAuthSession(c, USERS.admin)),
    email: '', name: 'Admin', kind: 'staff', role: 'admin', orgId: ORG_ID, liveOrgId: ORG_ID,
    environment: 'live', locale: 'en', calendar: 'gregorian', leaseId: null };
  const userId = randomUUID(), email = `${randomUUID()}@example.test`, consent = buildStoredConsent('signup');
  await query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [userId, email]);
  await query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,
    [userId, consent.accepted_at, consent.terms_version, consent.privacy_version, consent.source]);
  contactId = (await query<{ id: string }>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name,email,phone_e164)
    VALUES($1,$2,true,'OFF tenant',$3,'+19995550111') RETURNING id::text`, [ORG_ID, userId, email])).rows[0].id;
  tenant = { ...staff, userId, sessionId: await withClient(c => insertTestAuthSession(c, userId)),
    kind: 'tenant', role: null, name: 'OFF tenant', email, consent };
  foreignContactId = (await query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name)
    VALUES($1,true,'Foreign OFF tenant') RETURNING id::text`, [ORG2_ID])).rows[0].id;
  targets = [];
  for (const kind of ['property', 'unit', 'room'] as const) {
    for (const desired of ['archived', 'active'] as const) {
      const tree = await ancestry();
      targets.push({ ref: { kind, id: tree[kind] }, desired });
    }
  }
  const tree = await ancestry();
  const lease = (await query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor)
    VALUES($1,$2,$3,$4,'ended','imported','2090-01-01','2090-12-31','TWD',0) RETURNING id::text`, [ORG_ID, tree.property, tree.unit, tree.room])).rows[0].id;
  await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [ORG_ID, lease, contactId]);
  await uploadSignedLeasePdf(staff, lease, { bytes: pdfBytes, fileName: 'off-history.pdf' });
  const pdf = (await query<{ id: string }>(`SELECT id::text FROM lease_signed_pdfs WHERE lease_id=$1`, [lease])).rows[0].id;
  history = { ...tree, lease, pdf };
});
test.after(async () => {
  if (previousPdfEnv === undefined) delete process.env.TENANT_SIGNED_PDF_ENABLED;
  else process.env.TENANT_SIGNED_PDF_ENABLED = previousPdfEnv;
  await clone?.cleanup();
});

test('positive controls prove valid archive/restore/edit and exact historical bytes before OFF cases', async () => {
  await withRestoredControls(async () => {
    for (const key of featureKeys) await setControl(key, enabled, 'true');
    await setControl('tenant_signed_pdf', true, 'true');
    for (const target of targets) {
      assert.equal((await ready(target.ref)).canArchive, true);
      assert.equal((await command(target.ref, 'archived')).state, 'changed');
      assert.equal((await ready(target.ref)).canRestore, true);
      assert.equal((await command(target.ref, 'active')).state, 'changed');
      if (target.desired === 'active') assert.equal((await command(target.ref, 'archived')).state, 'changed');
    }
    assert.equal((await directoryContactEditView(staff, contactId)).state, 'enabled');
    const result = await editDirectoryContact(staff, await editIntent());
    assert.equal(result.status, 'recorded');
    if (result.status === 'recorded') assert.equal(result.outcome, 'changed');
    for (const kind of ['room', 'unit', 'property'] as const) {
      assert.equal((await command({ kind, id: history[kind] }, 'archived')).state, 'changed');
    }
    const pdf = await tenantEndedLeaseSignedPdf(tenant, history.lease, history.pdf);
    assert.ok(pdf);
    assert.deepEqual(Uint8Array.from(pdf.content), pdfBytes);
  });
});

for (const global of globals) for (const optIn of optIns) {
  if (global.name === 'enabled' && optIn === 'true') continue;
  test(`OFF matrix: global ${global.name}; organization ${optIn}`, async () => {
    await withRestoredControls(async () => {
      for (const key of featureKeys) await setControl(key, global.value, optIn);
      await setControl('tenant_signed_pdf', false, 'true');
      const configured = await controlsSnapshot();
      const before = await businessSnapshot();
      for (const { ref, desired } of targets) {
        const view = await ready(ref);
        assert.equal(view.writeEnabled, false);
        assert.equal(view.observed.archivedAtUtc !== null, desired === 'active');
        assert.deepEqual(view.observed.inherited, []);
        assert.deepEqual(view.blockers, []);
        assert.equal((await command(ref, desired)).state, 'disabled');
      }
      assert.equal((await directoryContactEditView(staff, contactId)).state, 'disabled');
      const result = await editDirectoryContact(staff, await editIntent());
      assert.equal(result.status, 'recorded');
      if (result.status === 'recorded') assert.equal(result.outcome, 'rejected_disabled');
      const list = await tenantEndedLeaseList(tenant);
      assert.equal(list.state, 'ready');
      if (list.state === 'ready') assert.ok(list.items.some(row => row.leaseId === history.lease));
      const detail = await tenantEndedLeaseDetail(tenant, history.lease);
      assert.equal(detail.state, 'ready');
      if (detail.state === 'ready') {
        assert.deepEqual(detail.lease.archive, { property: true, unit: true, room: true });
        assert.equal(detail.pdfAvailability, 'unavailable');
        assert.deepEqual(detail.pdfs, []);
      }
      assert.equal(await tenantEndedLeaseSignedPdf(tenant, history.lease, history.pdf), null);
      assert.deepEqual(await businessSnapshot(), before, 'disabled mutations/history reads preserve all business rows and audit count');

      // The same otherwise-valid room accepts the local contact after rejecting
      // a foreign contact. Compare the entire rejection window before success.
      const room = await ancestry();
      const beforeForeign = await businessSnapshot();
      await assert.rejects(createLeaseFromForm(staff, leaseForm(room.room, foreignContactId)),
        (error: unknown) => error instanceof FlowError && error.key === 'errors.notFound');
      assert.deepEqual(await businessSnapshot(), beforeForeign, 'foreign contact rejection leaves no business or mutation-audit writes');
      const resultLease = await createLeaseFromForm(staff, leaseForm(room.room, contactId));
      assert.equal(resultLease.tenantUserId, tenant.userId);
      const parties = (await query<{ contact_id: string; user_id: string }>(`SELECT lp.contact_id::text,c.user_id::text
        FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id
        WHERE lp.lease_id=$1 AND lp.role='primary'`, [resultLease.leaseId])).rows;
      assert.deepEqual(parties, [{ contact_id: contactId, user_id: tenant.userId }]);
      const afterReuse = await businessSnapshot();
      assert.deepEqual(afterReuse.contacts, beforeForeign.contacts, 'no new or edited contact');
      assert.deepEqual(afterReuse['auth.users'], beforeForeign['auth.users'], 'no new or edited portal identity');
      assert.deepEqual(await controlsSnapshot(), configured, 'requests never mutate control rows or any org flags');
    });
  });
}

// Asymmetric controls: each feature must read its OWN gate. With one feature
// fully ON and the other's organization opt-in false, only the ON feature writes.
for (const [onKey, offKey] of [['record_archive', 'tenant_directory_edit'], ['tenant_directory_edit', 'record_archive']] as const) {
  test(`asymmetric controls: ${onKey} ON while ${offKey} OFF`, async () => {
    await withRestoredControls(async () => {
      await setControl(onKey, enabled, 'true');
      await setControl(offKey, enabled, 'false');
      const configured = await controlsSnapshot();
      const target = targets.find(t => t.ref.kind === 'property' && t.desired === 'archived');
      assert.ok(target, 'an active property target exists');
      if (onKey === 'record_archive') {
        assert.equal((await ready(target.ref)).writeEnabled, true);
        assert.equal((await command(target.ref, 'archived')).state, 'changed');
        assert.equal((await command(target.ref, 'active')).state, 'changed');
        const before = await businessSnapshot();
        assert.equal((await directoryContactEditView(staff, contactId)).state, 'disabled');
        const result = await editDirectoryContact(staff, await editIntent());
        assert.equal(result.status, 'recorded');
        if (result.status === 'recorded') assert.equal(result.outcome, 'rejected_disabled');
        assert.deepEqual(await businessSnapshot(), before, 'directory edit stays disabled under its own OFF gate');
      } else {
        const before = await businessSnapshot();
        assert.equal((await ready(target.ref)).writeEnabled, false);
        assert.equal((await command(target.ref, 'archived')).state, 'disabled');
        assert.deepEqual(await businessSnapshot(), before, 'archive stays disabled under its own OFF gate');
        assert.equal((await directoryContactEditView(staff, contactId)).state, 'enabled');
        const result = await editDirectoryContact(staff, await editIntent());
        assert.equal(result.status, 'recorded');
        if (result.status === 'recorded') assert.equal(result.outcome, 'changed');
      }
      assert.deepEqual(await controlsSnapshot(), configured, 'requests never mutate control rows or any org flags');
    });
  });
}

test('control cleanup restores a genuinely absent row and microsecond timestamps even on failure', async () => {
  await withRestoredControls(async () => {
    await setControl('record_archive', undefined, 'absent');
    await query(`UPDATE platform_settings SET description='OFF matrix precision sentinel',
      updated_at='2001-02-03T04:05:06.123456Z' WHERE key='tenant_directory_edit'`);
    const before = await controlsSnapshot();
    const sentinel = new Error('Synthetic assertion failure');
    await assert.rejects(withRestoredControls(async () => {
      for (const key of featureKeys) await setControl(key, enabled, 'true');
      throw sentinel;
    }), error => error === sentinel);
    assert.deepEqual(await controlsSnapshot(), before);
    assert.equal((await query(`SELECT 1 FROM platform_settings WHERE key='record_archive'`)).rowCount, 0);
  });
});
