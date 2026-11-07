import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { ORG_ID, USERS } from './ids';
import { createProperty, uploadSignedLeasePdf, confirmPayment, rejectPayment, type PropertyInput } from './domain';
import { dispatchVendor, __setVendorLinkKillSwitchForTests } from './vendor-repair';
import { captureManualReminders, captureScheduledReminders } from './local-reminder-capture';
import { queueManualReminder } from './manual-reminders';
import { recordUsage, recordStoredFileUsage, type UsageInput } from './usage-events';
import { tx, svc } from './db';
import { ensureSandbox } from './sandbox';
import { EsignRepo, type Actor } from './esign/repo';
import { publishHandover, prepareHandoverUpload, uploadHandoverBytes, finalizeHandoverUpload } from './handover';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID,
  environment: 'live', kind: 'staff', role: 'admin', locale: 'en', calendar: 'gregorian', leaseId: null,
  email: 'synthetic@example.test', name: 'Synthetic' };
const recorder = 'app.prop07_record_usage(uuid,text,bigint,timestamptz,text,text,text)';
test.before(async () => {
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')`, [admin.sessionId, admin.userId, randomUUID()]);
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });

async function property(session: Session) {
  const input: PropertyInput = { submitToken: randomUUID(), name: `Usage ${randomUUID()}`, city: '台北市', district: '大安區', street: `測試路${randomUUID()}`,
    currency: 'TWD', ownerMode: 'new', ownerName: 'Synthetic owner', ownerPhone: '', ownerEmail: '', canViewTenantPhone: false,
    unitLabel: '1', floor: '1', rentalMode: 'whole_unit', rooms: [{ label: '1', roomType: 'whole_home', baseRentMajor: 100 }] };
  const created = await createProperty(session, input);
  assert.equal((await createProperty(session, input)).propertyId, created.propertyId);
  const unitId = (await db.query<{ id: string }>(`SELECT id::text FROM units WHERE property_id=$1`, [created.propertyId])).rows[0].id;
  return { ...created, unitId };
}
async function lease(session: Session, p: Awaited<ReturnType<typeof property>>, imported: boolean) {
  const id = randomUUID();
  await db.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor,esign_status)
    VALUES($1,$2,$3,$4,$4,'2026-11-01','2027-10-31','TWD',10000,0,$5)`, [id, session.orgId, p.propertyId, p.unitId, imported ? 'imported' : 'not_sent']);
  return id;
}
async function electronic(session: Session, p: Awaited<ReturnType<typeof property>>) {
  const leaseId = await lease(session, p, false), caseId = randomUUID(), versionId = randomUUID();
  const contact = (await db.query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant`, [session.orgId, USERS.tenant])).rows[0]?.id ?? (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name,email,user_id)
    VALUES($1,true,'Usage tenant',$2,$3) RETURNING id::text`, [session.orgId, `usage-${randomUUID()}@example.test`, USERS.tenant])).rows[0].id;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [session.orgId, leaseId, contact]);
  const owner = (await db.query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_owner`, [session.orgId, USERS.owner])).rows[0];
  if (owner) await db.query(`UPDATE property_owners SET owner_contact_id=$2 WHERE property_id=$1`, [p.propertyId, owner.id]);
  else await db.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`, [p.ownerContactId, USERS.owner]);
  const doc = (await db.query<{ id: string }>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by)
    VALUES($1,$2,$3,'passport','A**789',$4,'fixture-key','pending_review',$5) RETURNING id::text`, [session.orgId, contact, leaseId, `${session.orgId}/${leaseId}/doc`, USERS.admin])).rows[0].id;
  for (const slot of ['front', 'selfie']) await db.query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256)
    VALUES($1,$2,$3,$4,'image/jpeg',4,'abc')`, [session.orgId, doc, slot, `${session.orgId}/${leaseId}/${slot}`]);
  const actors: Actor[] = [];
  for (const [userId, kind] of [[USERS.owner, 'owner'], [USERS.tenant, 'tenant']] as const) {
    const sessionId = randomUUID();
    await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')`, [sessionId, userId, randomUUID()]);
    actors.push({ ...session, userId, sessionId, kind, role: null });
  }
  const repo = new EsignRepo({ check: async () => true });
  let state = await repo.createCase(session as Actor, { caseId, leaseId, versionId, body: 'Synthetic contract', pdfBytes: Buffer.from('%PDF-1.4 synthetic'),
    signers: [{ id: USERS.owner, role: 'owner', email: 'owner@example.test' }, { id: USERS.tenant, role: 'tenant', email: 'tenant@example.test' }] });
  const at = new Date().toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString();
  await repo.apply(session as Actor, caseId, { type: 'send', versionId, at, presumedConsentDeadline: expiresAt, termsVersion: 'synthetic-v1' });
  for (const [index, actor] of actors.entries()) {
    await repo.apply(actor, caseId, { type: 'consent', versionId, signerId: actor.userId, kind: 'explicit', at });
    await repo.apply(actor, caseId, { type: 'issue_identity', versionId, signerId: actor.userId, method: 'email', expiresAt, attemptCap: 3, at });
    await repo.recordEmailStep(actor, caseId, { versionId, signerId: actor.userId, response: 'synthetic', at });
    await repo.apply(actor, caseId, { type: 'review', versionId, signerId: actor.userId, scrolledToEnd: true, at });
    state = await repo.recordSignature(actor, caseId, { versionId, signerId: actor.userId, at,
      strokes: [[{ x: 0, y: 0 }, { x: 8, y: 12 }, { x: 20, y: 4 }]], imageBytes: Buffer.from('synthetic-image'),
      documentDigest: state.versions[0].documentDigest, ip: '127.0.0.1', device: 'synthetic', userAgent: 'synthetic',
      ...(index === 1 ? { finalPdfBytes: Buffer.from('%PDF-1.4 signed synthetic') } : {}) });
  }
  assert.equal(state.versions[0].status, 'completed');
  assert.equal((await db.query(`SELECT status FROM leases WHERE id=$1`, [leaseId])).rows[0].status, 'active');
  return { versionId, leaseId };
}

for (const mode of ['off', 'on', 'failure', 'sandbox'] as const) test(`real hooks: ${mode}, committed business results and dedupe`, async () => {
  const session = mode === 'sandbox' ? { ...admin, orgId: await ensureSandbox(admin), environment: 'sandbox' as const } : admin;
  const org = session.orgId, enabled = mode !== 'off';
  process.env.ESIGN_ENABLED = 'true';
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('usage_events',true,'esign',true,'rent_reminders_v2',true,'vendor_link',true,'handover_records',true,'notification_center_v2',true),settings=settings-'email_tenant_rent_overdue' WHERE id=$1`, [org]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='usage_events'`, [org, enabled]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`, [org]);
  for (const key of ['handover_records', 'notification_center_v2']) await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key=$2`, [org, key]);
  __setVendorLinkKillSwitchForTests(true);
  // A sandbox needs the ordinary reminder configuration, without sending anything.
  await db.query(`INSERT INTO reminder_rules(org_id,event_type,is_enabled,channels) VALUES($1,'rent_overdue',true,ARRAY['email']::channel_type[]) ON CONFLICT(org_id,event_type) DO UPDATE SET is_enabled=true,channels=ARRAY['email']::channel_type[]`, [org]);
  const logs: unknown[][] = [], original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  if (mode === 'failure') await db.query(`REVOKE EXECUTE ON FUNCTION ${recorder} FROM service_role`);
  try {
    const p = await property(session), paperLease = await lease(session, p, true);
    const pdf = Buffer.from('%PDF-1.4\nusage fixture\n%%EOF\n');
    assert.deepEqual(await uploadSignedLeasePdf(session, paperLease.toUpperCase(), { bytes: pdf, fileName: 'synthetic.pdf' }), { activated: false, invoiceId: null });
    assert.deepEqual(await uploadSignedLeasePdf(session, paperLease, { bytes: pdf, fileName: 'synthetic-retry.pdf' }), { activated: false, invoiceId: null });
    const files = (await db.query<{ id: string }>(`SELECT file_id::text AS id FROM lease_signed_pdfs WHERE lease_id=$1`, [paperLease])).rows;
    assert.equal(files.length, 2); // The legacy upload still stores each submitted file.
    const ep = await property(session), signed = await electronic(session, ep);
    const ticketId = (await db.query<{ id: string }>(`INSERT INTO maintenance_tickets(org_id,property_id,unit_id,lease_id,category,title,description,reported_by_user,ticket_number)
      VALUES($1,$2,$3,$4,'plumbing','Usage fixture','Synthetic',$5,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1)) RETURNING id::text`, [org, ep.propertyId, ep.unitId, signed.leaseId, USERS.admin])).rows[0].id;
    const job = await dispatchVendor(session, ticketId, { vendorName: 'Synthetic vendor', vendorTrade: 'plumbing', vendorPhone: '0912000111', contactWindow: 'Synthetic' }, 'http://127.0.0.1:43123');
    assert.ok((await db.query(`SELECT id FROM repair_vendor_jobs WHERE id=$1`, [job.jobId])).rowCount);
    const dispatchInput = { vendorName: 'Synthetic vendor', vendorTrade: 'plumbing', vendorPhone: '0912000111', contactWindow: 'Synthetic' };
    const retry = await dispatchVendor(session, ticketId, dispatchInput, 'http://127.0.0.1:43123');
    assert.notEqual(retry.jobId, job.jobId); // Legacy link replacement still happens.
    const reassigned = await dispatchVendor(session, ticketId, { ...dispatchInput, vendorName: 'Other synthetic vendor' }, 'http://127.0.0.1:43123');
    const reassignedRetry = await dispatchVendor(session, ticketId, { ...dispatchInput, vendorName: 'Other synthetic vendor' }, 'http://127.0.0.1:43123');
    const returned = await dispatchVendor(session, ticketId, dispatchInput, 'http://127.0.0.1:43123');
    const returnedRetry = await dispatchVendor(session, ticketId, dispatchInput, 'http://127.0.0.1:43123');
    assert.equal((await db.query(`SELECT count(*)::int n FROM app.usage_events u JOIN repair_vendor_jobs j ON j.id::text=u.source_id WHERE u.org_id=$1 AND u.dimension='vendor_jobs' AND j.ticket_id=$2`, [org, ticketId])).rows[0].n, mode === 'off' || mode === 'failure' ? 0 : 3);
    for (const id of [retry.jobId, reassignedRetry.jobId, returnedRetry.jobId]) assert.equal((await db.query(`SELECT 1 FROM app.usage_events WHERE org_id=$1 AND source_id=$2`, [org, id])).rowCount, 0);

    const version = await publishHandover(session, signed.leaseId, 'move_in', 'Synthetic handover', null);
    const intent = await prepareHandoverUpload(session, signed.leaseId, version.id, { fileName: 'handover.pdf', mime: 'application/pdf', size: pdf.length });
    const savedFetch = globalThis.fetch, savedUrl = process.env.SUPABASE_URL, savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let attachment: { id: string };
    try {
      process.env.SUPABASE_URL = 'http://127.0.0.1:1'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-only';
      const objects = new Map<string, Buffer>();
      globalThis.fetch = (async (input, init) => {
        const url = String(input); assert.ok(url.startsWith('http://127.0.0.1:1/storage/'));
        if (init?.method === 'POST') { objects.set(url, Buffer.from(init.body as Uint8Array)); return new Response('', { status: 200 }); }
        const bytes = objects.get(url); return new Response(bytes ? new Uint8Array(bytes) : null, { status: bytes ? 200 : 404 });
      }) as typeof fetch;
      await uploadHandoverBytes(session, signed.leaseId, intent.intentId, pdf);
      assert.equal((await db.query(`SELECT 1 FROM app.handover_attachments WHERE intent_id=$1`, [intent.intentId])).rowCount, 0);
      attachment = await finalizeHandoverUpload(session, signed.leaseId, intent.intentId);
      assert.deepEqual(await finalizeHandoverUpload(session, signed.leaseId, intent.intentId), attachment);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = savedUrl;
      if (savedKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    }
    const recipients: { id: string }[] = [];
    const payer = (await db.query<{ id: string }>(`SELECT contact_id::text AS id FROM lease_parties WHERE lease_id=$1 AND role='primary'`, [signed.leaseId])).rows[0].id;
    for (const action of ['confirm', 'reject'] as const) {
      const payment = (await db.query<{ id: string }>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES($1,$2,$3,$4,'TWD',100,'2026-11-01','bank_transfer','submitted','tenant_portal',$5) RETURNING id::text`, [org, ep.propertyId, signed.leaseId, payer, USERS.tenant])).rows[0].id;
      for (let replay = 0; replay < 2; replay++) {
        if (action === 'confirm') await confirmPayment(session, payment);
        else if (replay === 0) await rejectPayment(session, payment, 'Synthetic rejection');
        else await assert.rejects(rejectPayment(session, payment, 'Synthetic rejection'), /errors.paymentState/);
      }
      const inserted = (await db.query<{ id: string }>(`SELECT r.id::text FROM app.b028_center_recipients r JOIN app.b028_center_events e ON e.id=r.event_id JOIN app.b017_occurrences n ON n.id=e.neutral_source_id WHERE n.payment_id=$1`, [payment])).rows;
      assert.equal(inserted.length, 1); recipients.push(...inserted);
    }
    // Invoice produced by the real e-sign activation is the notification source.
    const invoiceId = (await db.query<{ id: string }>(`SELECT id::text FROM invoices WHERE lease_id=$1`, [signed.leaseId])).rows[0].id;
    const event = await queueManualReminder(session, signed.leaseId, invoiceId, randomUUID());
    const captured = await captureManualReminders(session, signed.leaseId, event);
    assert.ok(captured > 0);
    assert.equal(await captureManualReminders(session, signed.leaseId, event, () => assert.fail('duplicate capture')), 0);
    const claims = (await db.query<{ id: string }>(`SELECT id::text FROM app.b028_recipient_claims WHERE event_id=$1 AND state='captured'`, [event])).rows;
    assert.equal(claims.length, captured);
    await db.query(`UPDATE reminder_rules SET offsets_days=ARRAY[1]::smallint[] WHERE org_id=$1 AND event_type='rent_overdue'`, [org]);
    const at = new Date((await db.query<{ at: string }>(`SELECT (((i.due_date+1)::timestamp+interval '12 hours') AT TIME ZONE o.timezone)::text AS at
      FROM invoices i JOIN organizations o ON o.id=i.org_id WHERE i.id=$1`, [invoiceId])).rows[0].at);
    const scheduled = (await db.query<{ id: string }>(`SELECT app.b010_schedule_rent($1,$2,$3)::text AS id`, [org, invoiceId, at.toISOString()])).rows[0].id;
    if (mode === 'sandbox') assert.equal(scheduled, null); // Cron deliberately excludes sandbox organizations.
    else {
      assert.ok(scheduled);
      assert.ok(await captureScheduledReminders(org, scheduled, at) > 0);
      assert.equal(await captureScheduledReminders(org, scheduled, at, () => assert.fail('duplicate scheduled capture')), 0);
      claims.push(...(await db.query<{ id: string }>(`SELECT id::text FROM app.b028_recipient_claims WHERE event_id=$1 AND state='captured'`, [scheduled])).rows);
    }
    const sources = [['units', 'units', p.unitId], ['units', 'units', ep.unitId], ['signatures', 'leases', paperLease],
      ['signatures', 'esign_versions', signed.versionId], ['vendor_jobs', 'repair_vendor_jobs', job.jobId], ['vendor_jobs', 'repair_vendor_jobs', reassigned.jobId], ['vendor_jobs', 'repair_vendor_jobs', returned.jobId],
      ['stored_bytes', 'handover_attachments', attachment.id], ...recipients.map(r => ['notifications', 'b028_center_recipients', r.id]),
      ...files.map(f => ['stored_bytes', 'files', f.id]), ...claims.map(c => ['notifications', 'b028_recipient_claims', c.id])];
    for (const [dimension, table, id] of sources) {
      const rows = (await db.query(`SELECT *,occurred_at::text AS at FROM app.usage_events WHERE org_id=$1 AND dimension=$2 AND source_table=$3 AND source_id=$4`, [org, dimension, table, id])).rows;
      if (mode === 'off' || mode === 'failure') { assert.equal(rows.length, 0, `${dimension}/${table}`); continue; }
      assert.equal(rows.length, 1, `${dimension}/${table}`);
      const row = rows[0];
      assert.equal(row.quantity, dimension === 'stored_bytes' ? String(pdf.length) : '1');
      assert.equal(row.sandbox, mode === 'sandbox');
      // Replay the exact stored source payload, preserving sub-millisecond precision.
      const input: UsageInput = { orgId: org, dimension: row.dimension, quantity: BigInt(row.quantity), occurredAt: row.at,
        sourceTable: row.source_table, sourceId: row.source_id, dedupeKey: row.dedupe_key };
      assert.equal((await svc(null, c => recordUsage(c, input))).state, 'recorded');
      assert.equal((await db.query(`SELECT count(*)::int n FROM app.usage_events WHERE org_id=$1 AND dimension=$2 AND source_id=$3`, [org, dimension, id])).rows[0].n, 1);
    }
    if (mode === 'sandbox') assert.deepEqual(await tx(session.userId, async c => (await c.query(`SELECT * FROM app.prop07_usage_summary($1,'2000-01-01','2100-01-01')`, [org])).rows, { orgId: org, environment: 'sandbox' }), []);
    if (mode === 'failure') {
      assert.ok(logs.length >= sources.length);
      assert.ok(logs.every(([tag, metadata]) => tag === 'usage_event failed' && (metadata as { code: string }).code === '42501'));
      assert.ok(!JSON.stringify(logs).includes(paperLease));
    } else assert.deepEqual(logs, []);
  } finally {
    console.error = original;
    __setVendorLinkKillSwitchForTests(false);
    if (mode === 'failure') await db.query(`GRANT EXECUTE ON FUNCTION ${recorder} TO service_role`);
  }
});

test('savepoint protects flag-read and recorder errors, restores roles/claims, and follows business rollback', async () => {
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='usage_events'`, [ORG_ID]);
  const input: UsageInput = { orgId: ORG_ID, dimension: 'units', quantity: BigInt(1), occurredAt: '2026-11-01T00:00:00Z', sourceTable: 'units', sourceId: randomUUID(), dedupeKey: randomUUID() };
  for (const role of ['authenticated', 'service_role']) {
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true),set_config('app.active_org_id',$3,true),set_config('app.env','live',true)`, [USERS.admin, role, ORG_ID]);
      await db.query(`SET LOCAL ROLE ${role}`);
      assert.equal((await recordUsage(db, input)).state, 'recorded');
      const original = console.error; console.error = () => {};
      try { assert.equal((await recordUsage(db, { ...input, quantity: BigInt(-1), dedupeKey: randomUUID() })).state, 'failed'); }
      finally { console.error = original; }
      assert.deepEqual((await db.query(`SELECT current_user AS role,current_setting('request.jwt.claim.role') AS claim,current_setting('request.jwt.claim.sub') AS sub`)).rows[0], { role, claim: role, sub: USERS.admin });
      await db.query(`UPDATE organizations SET name=name WHERE id=$1`, [ORG_ID]);
    } finally { await db.query('ROLLBACK'); }
  }
  assert.equal((await db.query(`SELECT 1 FROM app.usage_events WHERE dedupe_key=$1`, [input.dedupeKey])).rowCount, 0);
  // Missing flag relation is a telemetry failure, never an aborted business transaction.
  await db.query('BEGIN');
  const original = console.error; console.error = () => {};
  try {
    await db.query('ALTER TABLE platform_settings RENAME TO b029_test_settings');
    assert.equal((await recordUsage(db, input)).state, 'failed');
    assert.equal((await db.query('SELECT 1 AS alive')).rows[0].alive, 1);
  } finally { console.error = original; await db.query('ROLLBACK'); }
  // Central file hook retains exact bigint precision, and a zero-byte file adds no positive usage.
  await db.query('BEGIN');
  try {
    for (const bytes of ['9007199254740993', '0']) {
      const id = (await db.query<{ id: string }>(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,size_bytes) VALUES($1,'synthetic',$2,'synthetic',$3) RETURNING id::text`, [ORG_ID, randomUUID(), bytes])).rows[0].id;
      assert.equal((await recordStoredFileUsage(db, ORG_ID, id)).state, bytes === '0' ? 'empty' : 'recorded');
      if (bytes !== '0') assert.equal((await db.query(`SELECT quantity::text FROM app.usage_events WHERE source_id=$1`, [id])).rows[0].quantity, bytes);
    }
  } finally { await db.query('ROLLBACK'); }
});
