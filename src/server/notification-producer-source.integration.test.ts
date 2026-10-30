import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { resetAndSeed } from './seed';
import { centerSessionItems } from './notification-center';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => {
  clone = await cloneTestDatabase();
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = 'true';
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    await resetAndSeed();
  } catch (error) { await clone.cleanup(); throw error; }
  finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
});
test.after(async () => { await clone?.cleanup(); });

test('typed sources enforce scope, payer snapshot, immutability and application-role denial', async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const source = (await c.query<{org:string; lease:string; invoice:string; actor:string; contact:string; principal:string}>(`SELECT i.org_id::text org,i.lease_id::text lease,i.id::text invoice,m.user_id::text actor,
      c.id::text contact,c.user_id::text principal
      FROM invoices i
      JOIN lease_parties lp ON lp.org_id=i.org_id AND lp.lease_id=i.lease_id AND lp.role='primary'
      JOIN contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id AND c.user_id IS NOT NULL
      JOIN org_members m ON m.org_id=i.org_id AND m.status='active'
      ORDER BY i.id,lp.contact_id,m.id LIMIT 1`)).rows[0];
    assert.ok(source);
    const tenant={contact:source.contact,principal:source.principal};
    assert.ok(tenant);
    await c.query('BEGIN');
    const event = (await c.query<{id:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
      VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp()) RETURNING id::text`, [source.org,source.lease,source.invoice,randomUUID()])).rows[0];
    const eventSource=(await c.query<{at:string;key:string}>(`SELECT occurred_at::text at,occurrence_key key FROM app.b017_occurrences WHERE id=$1`,[event.id])).rows[0];
    for (const [kind,at] of [['payment_confirmed',eventSource.at],['vendor_job_assigned',eventSource.at],['unsupported_family',eventSource.at],['rent_due','2000-01-01T00:00:00Z']]) {
      await c.query('SAVEPOINT bad_center');
      await assert.rejects((async()=>{await c.query(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,$2,$3,$4)`,[source.org,kind,event.id,at]);
        await c.query('SET CONSTRAINTS app.b028_center_source_valid IMMEDIATE');})());
      await c.query('ROLLBACK TO SAVEPOINT bad_center');
    }
    const center=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at)
      VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[source.org,event.id,eventSource.at])).rows[0];
    const recipient=(await c.query<{id:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id)
      VALUES($1,$2,'tenant',$3,$4) RETURNING id::text`,[source.org,center.id,tenant.principal,tenant.contact])).rows[0];
    await c.query('COMMIT');
    await assert.rejects(c.query(`UPDATE app.b017_occurrences SET occurrence_key='changed' WHERE id=$1`,[event.id]));
    assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_neutral($1,$2)`,[source.org,event.id])).rows,[{outcome:'existing_center',center_event_id:center.id}]);
    const sessionId=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sessionId,tenant.principal,randomUUID()]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[source.org]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[source.org]);
    const session:Session={userId:tenant.principal,sessionId,kind:'tenant',role:null,orgId:source.org,liveOrgId:source.org,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
    const listed=await centerSessionItems(session);
    assert.ok(listed.items.some(item=>item.recipient_id===recipient.id && item.kind==='rent_due'));
    assert.ok((await centerSessionItems(session,recipient.id)).items.some(item=>item.recipient_id===recipient.id && item.read_at!==null));
    const lateMember=(await c.query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,[source.org,source.actor])).rows[0];
    await assert.rejects(c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id)
      VALUES($1,$2,'staff',$3,$4)`,[source.org,center.id,source.actor,lateMember.id]),
      (error:unknown)=>(error as {code?:string;message?:string}).code==='23514' && (error as {message?:string}).message==='Historical recipient unavailable');

    await c.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb) WHERE key='notification_center_v2'`);

    const lateOld=(await c.query<{id:string;created_at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
      VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text`,[source.org,source.lease,source.invoice,eventSource.key])).rows[0];
    await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at)
      VALUES($1,'rent_due',$2,$3)`,[source.org,lateOld.id,lateOld.created_at]),(error:unknown)=>(error as {code?:string}).code==='23505');
    await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,neutral_source_id,occurred_at)
      VALUES($1,'rent_due',$2,$3,$4)`,[source.org,lateOld.id,event.id,eventSource.at]));


    await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
      VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp())`,[source.org,randomUUID(),source.invoice,randomUUID()]));
    await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,occurred_at)
      VALUES($1,$2,$3,'payment_confirmed',$4,$5,clock_timestamp())`,[source.org,source.lease,source.invoice,randomUUID(),source.actor]));
    await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date)
      VALUES($1,$2,$3,'rent_manual',$4,$5,current_date)`,[source.org,source.lease,source.invoice,randomUUID(),randomUUID()]),
      (error:unknown)=>(error as {code?:string}).code==='23503');
    await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
      VALUES($1,$2,$3,'rent_due',$4,current_date)`,[source.org,source.lease,randomUUID(),randomUUID()]),
      (error:unknown)=>(error as {code?:string}).code==='23503');
    await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,occurred_at)
      VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,randomUUID(),randomUUID()]),
      (error:unknown)=>(error as {code?:string}).code==='23503');
    const payer = (await c.query<{id:string;contact:string;principal:string|null}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,confirmed_by,confirmed_at)
      SELECT i.org_id,i.property_id,i.lease_id,ct.id,i.currency,100,current_date,'cash','confirmed','manager_entry',$2,clock_timestamp()
      FROM invoices i JOIN lease_parties lp ON lp.lease_id=i.lease_id AND lp.org_id=i.org_id AND lp.role='primary'
      JOIN contacts ct ON ct.id=lp.contact_id AND ct.org_id=lp.org_id WHERE i.id=$1 LIMIT 1
      RETURNING id::text,payer_contact_id::text contact,(SELECT user_id::text FROM contacts WHERE id=payer_contact_id) principal`,[source.invoice,source.actor])).rows[0];
    assert.ok(payer);
    const samePrincipal=(await c.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,confirmed_by,confirmed_at)
      SELECT i.org_id,i.property_id,i.lease_id,$2,i.currency,100,current_date,'cash','confirmed','manager_entry',$3,clock_timestamp() FROM invoices i WHERE i.id=$1 RETURNING id::text`,[source.invoice,payer.contact,tenant.principal])).rows[0];
    await c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at)
      VALUES($1,$2,$3,'payment_confirmed',$4,$5,$6,$5,clock_timestamp())`,[source.org,source.lease,samePrincipal.id,randomUUID(),tenant.principal,payer.contact]);
    await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at)
      VALUES($1,$2,$3,'payment_confirmed',$4,$5,$6,$7,clock_timestamp())`,[source.org,source.lease,payer.id,randomUUID(),source.actor,payer.contact,randomUUID()]),
      (error:unknown)=>(error as {code?:string}).code==='23503');

    await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at)
      VALUES($1,$2,$3,'payment_confirmed',$4,$5,$6,$7,clock_timestamp())`,[source.org,source.lease,payer.id,randomUUID(),source.actor,payer.contact,source.actor]),(error:unknown)=>(error as {code?:string}).code==='23514');
    await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at)
      VALUES($1,$2,$3,'payment_rejected',$4,$5,$6,$7,clock_timestamp())`,[source.org,source.lease,payer.id,randomUUID(),source.actor,payer.contact,payer.principal]));
    await c.query('BEGIN');
    await c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at)
      VALUES($1,$2,$3,'payment_confirmed',$4,$5,$6,$7,clock_timestamp())`,[source.org,source.lease,payer.id,randomUUID(),source.actor,payer.contact,payer.principal]);
    await c.query(`UPDATE payments SET status='rejected', rejected_reason='synthetic test' WHERE id=$1`,[payer.id]);
    await assert.rejects(c.query('SET CONSTRAINTS app.b017_occurrence_commit_valid IMMEDIATE'),(error:unknown)=>(error as {code?:string}).code==='23514');
    await c.query('ROLLBACK');
    const member=(await c.query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active' LIMIT 1`,[source.org,source.actor])).rows[0];
    await c.query('BEGIN');
    const snapshot=(await c.query<{id:string;at:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at)
      VALUES($1,$2,$3,'payment_confirmed',$4,$5,$6,$7,clock_timestamp()) RETURNING id::text,occurred_at::text at`,[source.org,source.lease,payer.id,randomUUID(),source.actor,payer.contact,payer.principal])).rows[0];
    const paymentCenter=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at)
      VALUES($1,'payment_confirmed',$2,$3) RETURNING id::text`,[source.org,snapshot.id,snapshot.at])).rows[0];
    await c.query('SAVEPOINT no_staff');
    await assert.rejects(c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id)
      VALUES($1,$2,'staff',$3,$4)`,[source.org,paymentCenter.id,source.actor,member.id]),(error:unknown)=>(error as {code?:string}).code==='23514');
    await c.query('ROLLBACK TO SAVEPOINT no_staff');
    const paymentRecipient=(await c.query<{id:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id)
      VALUES($1,$2,'tenant',$3,$4) RETURNING id::text`,[source.org,paymentCenter.id,payer.principal,payer.contact])).rows[0];
    await c.query('COMMIT');
    await assert.rejects(c.query(`UPDATE app.b017_occurrences SET payer_principal_user_id=NULL WHERE id=$1`,[snapshot.id]));
    assert.equal(payer.contact,tenant.contact); assert.equal(payer.principal,tenant.principal);
    await c.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','true'::jsonb) WHERE key='notification_center_v2'`);
    assert.ok((await centerSessionItems(session)).items.some(item=>item.recipient_id===paymentRecipient.id));
    await c.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[payer.contact,source.actor]);
    const replacementSessionId=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[replacementSessionId,source.actor,randomUUID()]);
    const replacement:Session={...session,userId:source.actor,sessionId:replacementSessionId};
    assert.ok(!(await centerSessionItems(replacement)).items.some(item=>item.recipient_id===paymentRecipient.id));
    await c.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[payer.contact,payer.principal]);
    await c.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb) WHERE key='notification_center_v2'`);


    const other=new Client({connectionString:process.env.DATABASE_URL}); await other.connect();
    try {
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM leases WHERE id=$1 FOR UPDATE`,[source.lease]);
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,randomUUID()]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date)`,[source.org,source.lease,source.invoice,randomUUID()]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM invoices WHERE id=$1 FOR UPDATE`,[source.invoice]);
      await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date)`,[source.org,source.lease,source.invoice,randomUUID()]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM payments WHERE id=$1 FOR UPDATE`,[payer.id]);
      await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id)
        VALUES($1,$2,$3,'payment_confirmed',$4,$5)`,[source.org,source.lease,payer.id,randomUUID(),source.actor]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM contacts WHERE id=$1 FOR UPDATE`,[payer.contact]);
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at)
        VALUES($1,$2,$3,'payment_confirmed',$4,$5,$6,$7,clock_timestamp())`,[source.org,source.lease,payer.id,randomUUID(),source.actor,payer.contact,payer.principal]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM auth.users WHERE id=$1 FOR UPDATE`,[tenant.principal]);
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,payment_id,kind,occurrence_key,actor_id,payer_contact_id,payer_principal_user_id,occurred_at)
        VALUES($1,$2,$3,'payment_confirmed',$4,$5,$6,$7,clock_timestamp())`,[source.org,source.lease,payer.id,randomUUID(),source.actor,payer.contact,payer.principal]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM auth.users WHERE id=$1 FOR UPDATE`,[source.actor]);
      await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date)`,[source.org,source.lease,source.invoice,randomUUID(),source.actor]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,randomUUID(),source.actor]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      await c.query('BEGIN');
      const pinEventSource=(await c.query<{id:string;at:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp()) RETURNING id::text,occurred_at::text at`,[source.org,source.lease,source.invoice,randomUUID()])).rows[0];
      const pinEvent=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[source.org,pinEventSource.id,pinEventSource.at])).rows[0];
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM auth.users WHERE id=$1 FOR UPDATE`,[tenant.principal]);
      await assert.rejects(c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id) VALUES($1,$2,'tenant',$3,$4)`,[source.org,pinEvent.id,tenant.principal,tenant.contact]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await c.query('ROLLBACK'); await other.query('ROLLBACK');
      assert.notEqual(source.actor,tenant.principal);
      for (const first of ['old','neutral'] as const) {
        const key=`manual:${randomUUID()}`;
        await c.query('BEGIN');
        if(first==='old') {
          await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date)
            VALUES($1,$2,$3,'rent_manual',$4,$5,current_date)`,[source.org,source.lease,source.invoice,key,source.actor]);
          await assert.rejects(other.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,occurred_at)
            VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,key,tenant.principal]),
            (error:unknown)=>(error as {code?:string}).code==='55P03');
        } else {
          await c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,occurred_at)
            VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,key,source.actor]);
          await assert.rejects(other.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date)
            VALUES($1,$2,$3,'rent_manual',$4,$5,current_date)`,[source.org,source.lease,source.invoice,key,tenant.principal]),
            (error:unknown)=>(error as {code?:string}).code==='55P03');
        }
        await c.query('ROLLBACK');
      }
      for (const kind of ['old','neutral'] as const) {
        const key=`manual:${randomUUID()}`;
        const statement=kind==='old'
          ? `INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date) VALUES($1,$2,$3,'rent_manual',$4,$5,current_date)`
          : `INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,occurred_at) VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,clock_timestamp())`;
        await c.query('BEGIN'); await c.query(statement,[source.org,source.lease,source.invoice,key,source.actor]);
        await assert.rejects(other.query(statement,[source.org,source.lease,source.invoice,key,tenant.principal]),
          (error:unknown)=>(error as {code?:string}).code==='55P03');
        await c.query('ROLLBACK');
      }
      const oldFirstKey=`manual:${randomUUID()}`;
      await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date)`,[source.org,source.lease,source.invoice,oldFirstKey,source.actor]);
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,oldFirstKey,tenant.principal]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_manual',$3,NULL,$4,$5)`,[source.org,source.lease,source.invoice,tenant.principal,oldFirstKey]),
        (error:unknown)=>(error as {code?:string}).code==='23514');
      const newFirstKey=`manual:${randomUUID()}`;
      await c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,newFirstKey,source.actor]);
      await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date)`,[source.org,source.lease,source.invoice,newFirstKey,tenant.principal]),
        (error:unknown)=>(error as {code?:string}).code==='23514');
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_manual',$3,NULL,$4,$5)`,[source.org,source.lease,source.invoice,tenant.principal,newFirstKey]),
        (error:unknown)=>(error as {code?:string}).code==='23514');
      const otherInvoice=(await c.query<{invoice:string;lease:string}>(`SELECT id::text invoice,lease_id::text lease FROM invoices WHERE org_id=$1 AND id<>$2 AND lease_id<>$3 LIMIT 1`,[source.org,source.invoice,source.lease])).rows[0];
      assert.ok(otherInvoice);
      const crossingKey=`manual:${randomUUID()}`;
      await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date),($1,$6,$7,'rent_manual',$4,$8,current_date)`,
        [source.org,source.lease,source.invoice,crossingKey,source.actor,otherInvoice.lease,otherInvoice.invoice,tenant.principal]);
      assert.equal((await c.query(`SELECT count(*)::int n FROM app.b010_source_events WHERE org_id=$1 AND kind='rent_manual' AND occurrence_key=$2 AND (actor_id=$3 OR invoice_id=$4)`,
        [source.org,crossingKey,source.actor,otherInvoice.invoice])).rows[0].n,2);
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_manual',$3,NULL,$4,$5)`,
        [source.org,otherInvoice.lease,otherInvoice.invoice,source.actor,crossingKey]),(error:unknown)=>(error as {code?:string}).code==='23514');
      const lookupKey=randomUUID();
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_due',$3,NULL,$4,$5)`,[source.org,source.lease,source.invoice,source.actor,lookupKey]),
        (error:unknown)=>(error as {code?:string}).code==='23514');
      await c.query('BEGIN');
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_due',$3,NULL,NULL,$4)`,[source.org,source.lease,source.invoice,lookupKey])).rows,[{outcome:'new',center_event_id:null}]);
      await assert.rejects(other.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date)`,[source.org,source.lease,source.invoice,lookupKey]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await c.query('ROLLBACK');
      const sharedKey=randomUUID();
      await c.query('BEGIN');
      const old=(await c.query<{id:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text`,[source.org,source.lease,source.invoice,sharedKey])).rows[0];
      assert.equal((await c.query(`SELECT 1 FROM app.b017_old_source_transactions WHERE tx_id=txid_current() AND source_id=$1`,[old.id])).rowCount,1);
      await assert.rejects(other.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,sharedKey]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await c.query(`DELETE FROM app.b010_source_events WHERE id=$1`,[old.id]);
      assert.equal((await c.query(`SELECT 1 FROM app.b017_old_source_transactions WHERE source_id=$1`,[old.id])).rowCount,0);
      await c.query('COMMIT');
      await other.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,sharedKey]);
      await c.query('BEGIN');
      await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date)`,[source.org,source.lease,source.invoice,randomUUID()]);
      await other.query('BEGIN'); await other.query(`SET LOCAL lock_timeout='100ms'`);
      await assert.rejects(other.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','true'::jsonb) WHERE key='notification_center_v2'`),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK'); await c.query('ROLLBACK');
      await other.query('BEGIN'); await other.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','true'::jsonb) WHERE key='notification_center_v2'`);
      await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date)`,[source.org,source.lease,source.invoice,randomUUID()]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      const reverseKey=randomUUID();
      await other.query('BEGIN');
      await other.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,reverseKey]);
      await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date)`,[source.org,source.lease,source.invoice,reverseKey]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      const committed=(await c.query<{id:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text`,[source.org,source.lease,source.invoice,reverseKey])).rows[0];
      assert.equal((await c.query(`SELECT 1 FROM app.b017_old_source_transactions WHERE source_id=$1 AND tx_id<>txid_current()`,[committed.id])).rowCount,1);
      await c.query('BEGIN');
      const ignored=await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) ON CONFLICT(org_id,kind,invoice_id,occurrence_key) WHERE invoice_id IS NOT NULL DO NOTHING`,
        [source.org,source.lease,source.invoice,reverseKey]);
      assert.equal(ignored.rowCount,0);
      assert.equal((await c.query(`SELECT 1 FROM app.b017_old_source_transactions WHERE tx_id=txid_current()`)).rowCount,0);
      await c.query('COMMIT');

      await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at)
        SELECT org_id,kind,id,created_at FROM app.b010_source_events WHERE id=$1`,[committed.id]),(error:unknown)=>(error as {code?:string}).code==='23505');
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,reverseKey]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,committed.id])).rows,[{outcome:'no_backfill',center_event_id:null}]);
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_due',$3,NULL,NULL,$4)`,[source.org,source.lease,source.invoice,reverseKey])).rows,[{outcome:'no_backfill',center_event_id:null}]);

      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,committed.id])).rows,[{outcome:'no_backfill',center_event_id:null}]);
      await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at)
        SELECT org_id,kind,id,created_at FROM app.b010_source_events WHERE id=$1`,[committed.id]),(error:unknown)=>(error as {code?:string}).code==='23505');
      await c.query('BEGIN');
      const sameKey=randomUUID();
      const sameTx=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[source.org,source.lease,source.invoice,sameKey])).rows[0];
      await c.query('SAVEPOINT wrong_time');
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,$5::timestamptz+interval '1 second')`,[source.org,source.lease,source.invoice,sameKey,sameTx.at]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      await c.query('ROLLBACK TO SAVEPOINT wrong_time');
      await c.query('SAVEPOINT wrong_date');
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date+1,$5)`,[source.org,source.lease,source.invoice,sameKey,sameTx.at]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      await c.query('ROLLBACK TO SAVEPOINT wrong_date');
      await c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,$5)`,[source.org,source.lease,source.invoice,sameKey,sameTx.at]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,sameTx.id]),
        (error:unknown)=>(error as {code?:string}).code==='23514');
      await c.query('ROLLBACK');
      for (const first of ['old','neutral'] as const) {
        await c.query('BEGIN'); const key=randomUUID();
        const os=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
          VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[source.org,source.lease,source.invoice,key])).rows[0];
        const ns=(await c.query<{id:string;at:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
          VALUES($1,$2,$3,'rent_due',$4,current_date,$5) RETURNING id::text,occurred_at::text at`,[source.org,source.lease,source.invoice,key,os.at])).rows[0];
        if(first==='old') {
          await c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,os.id,os.at]);
          await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,ns.id,ns.at]),
            (error:unknown)=>(error as {code?:string}).code==='23505');
        } else {
          await c.query(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,ns.id,ns.at]);
          await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,os.id,os.at]),
            (error:unknown)=>(error as {code?:string}).code==='23505');
        }
        await c.query('ROLLBACK');
      }
      await c.query('BEGIN');
      const dualKey=randomUUID();
      const dualOld=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[source.org,source.lease,source.invoice,dualKey])).rows[0];
      const dualNew=(await c.query<{id:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,$5) RETURNING id::text`,[source.org,source.lease,source.invoice,dualKey,dualOld.at])).rows[0];
      const dualCenter=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at)
        VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[source.org,dualNew.id,dualOld.at])).rows[0];
      await c.query('COMMIT');
      await assert.rejects(c.query(`INSERT INTO app.b017_center_resolutions(org_id,kind,lease_id,invoice_id,payment_id,actor_id,occurrence_key,local_date,occurred_at,old_source_id,center_event_id,outcome)
        SELECT org_id,kind,lease_id,invoice_id,payment_id,actor_id,occurrence_key,local_date,created_at,id,$2,'existing_center' FROM app.b010_source_events WHERE id=$1`,[dualOld.id,dualCenter.id]),
        (error:unknown)=>(error as {code?:string}).code==='23514');
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,dualOld.id])).rows,[{outcome:'existing_center',center_event_id:dualCenter.id}]);
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_neutral($1,$2)`,[source.org,dualNew.id])).rows,[{outcome:'existing_center',center_event_id:dualCenter.id}]);
      assert.equal((await c.query(`SELECT count(*)::int n FROM app.b017_center_resolutions WHERE org_id=$1 AND old_source_id=$2 AND neutral_source_id=$3`,[source.org,dualOld.id,dualNew.id])).rows[0].n,1);
      await c.query('BEGIN');
      const lateKey=randomUUID();
      const lateNew=(await c.query<{id:string;at:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp()) RETURNING id::text,occurred_at::text at`,[source.org,source.lease,source.invoice,lateKey])).rows[0];
      const lateCenter=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at)
        VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[source.org,lateNew.id,lateNew.at])).rows[0];
      await c.query('COMMIT');
      const lateSource=(await c.query<{id:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,created_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,$5) RETURNING id::text`,[source.org,source.lease,source.invoice,lateKey,lateNew.at])).rows[0];
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,lateSource.id])).rows,[{outcome:'existing_center',center_event_id:lateCenter.id}]);
      await c.query('BEGIN');
      const mismatchKey=randomUUID();
      const mismatch=(await c.query<{id:string;at:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp()) RETURNING id::text,occurred_at::text at`,[source.org,source.lease,source.invoice,mismatchKey])).rows[0];
      await c.query(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,mismatch.id,mismatch.at]);
      await c.query('COMMIT');
      const mismatchOld=(await c.query<{id:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,created_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,$5::timestamptz+interval '1 second') RETURNING id::text`,[source.org,source.lease,source.invoice,mismatchKey,mismatch.at])).rows[0];
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,mismatchOld.id]),(error:unknown)=>(error as {code?:string}).code==='23514');
      const neutralOnly=(await c.query<{id:string;at:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp()) RETURNING id::text,occurred_at::text at`,[source.org,source.lease,source.invoice,randomUUID()])).rows[0];
      await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,neutralOnly.id,neutralOnly.at]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      const neutralHistoryKey=(await c.query<{key:string}>(`SELECT occurrence_key key FROM app.b017_occurrences WHERE id=$1`,[neutralOnly.id])).rows[0].key;
      await c.query('BEGIN');
      const freshOld=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[source.org,source.lease,source.invoice,neutralHistoryKey])).rows[0];
      await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,freshOld.id,freshOld.at]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      await c.query('ROLLBACK');
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_neutral($1,$2)`,[source.org,neutralOnly.id])).rows,[{outcome:'no_backfill',center_event_id:null}]);
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_neutral($1,$2)`,[source.org,neutralOnly.id])).rows,[{outcome:'no_backfill',center_event_id:null}]);
      await assert.rejects(c.query(`INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,neutralOnly.id,neutralOnly.at]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      await c.query('BEGIN');
      const justCreated=(await c.query<{id:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at,created_tx_id)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp(),0) RETURNING id::text`,[source.org,source.lease,source.invoice,randomUUID()])).rows[0];
      assert.equal((await c.query(`SELECT created_tx_id=txid_current() AS actual FROM app.b017_occurrences WHERE id=$1`,[justCreated.id])).rows[0].actual,true);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_neutral($1,$2)`,[source.org,justCreated.id]),(error:unknown)=>(error as {code?:string}).code==='23514');
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      const manualKey=`manual:${randomUUID()}`;
      const manualNew=(await c.query<{id:string;at:string}>(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,clock_timestamp()) RETURNING id::text,occurred_at::text at`,[source.org,source.lease,source.invoice,manualKey,source.actor])).rows[0];
      for (const [lease,invoice,dateDelta,timeDelta] of [[otherInvoice.lease,source.invoice,0,0],[source.lease,otherInvoice.invoice,0,0],[source.lease,source.invoice,1,0],[source.lease,source.invoice,0,1]] as const) {
        await c.query('SAVEPOINT mismatch_old');
        await assert.rejects(c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,created_at)
          VALUES($1,$2,$3,'rent_manual',$4,$5,current_date+$6::int,$7::timestamptz+($8::int*interval '1 second'))`,[source.org,lease,invoice,manualKey,source.actor,dateDelta,manualNew.at,timeDelta]),
          (error:unknown)=>(error as {code?:string}).code==='23514');
        await c.query('ROLLBACK TO SAVEPOINT mismatch_old');
      }
      const manualOld=(await c.query<{id:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date,created_at)
        VALUES($1,$2,$3,'rent_manual',$4,$5,current_date,$6) RETURNING id::text`,[source.org,source.lease,source.invoice,manualKey,source.actor,manualNew.at])).rows[0];
      await c.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_manual',$2,$3)`,[source.org,manualOld.id,manualNew.at]);
      await c.query('ROLLBACK');
      const raceA=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[source.org,source.lease,source.invoice,randomUUID()])).rows[0];
      await c.query('BEGIN'); await c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,raceA.id]);
      await assert.rejects(other.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,raceA.id,raceA.at]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      await c.query('COMMIT');
      await assert.rejects(other.query(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3)`,[source.org,raceA.id,raceA.at]),
        (error:unknown)=>(error as {code?:string}).code==='23505');
      await c.query('BEGIN');
      const raceB=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[source.org,source.lease,source.invoice,randomUUID()])).rows[0];
      const raceCenter=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at)
        VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[source.org,raceB.id,raceB.at])).rows[0];
      await assert.rejects(other.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,raceB.id]),
        (error:unknown)=>(error as {code?:string}).code==='23514');
      await c.query('COMMIT');
      assert.deepEqual((await other.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,raceB.id])).rows,[{outcome:'existing_center',center_event_id:raceCenter.id}]);
      await c.query('BEGIN');
      const legacy=(await c.query<{id:string;created_at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
        VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text`,[source.org,source.lease,source.invoice,randomUUID()])).rows[0];
      const existing=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at)
        VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[source.org,legacy.id,legacy.created_at])).rows[0];
      await c.query('COMMIT');
      await assert.rejects(c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id)
        VALUES($1,$2,'staff',$3,$4)`,[source.org,existing.id,source.actor,lateMember.id]),
        (error:unknown)=>(error as {code?:string;message?:string}).code==='23514' && (error as {message?:string}).message==='Historical recipient unavailable');
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM app.b028_center_events WHERE id=$1 FOR UPDATE`,[existing.id]);
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,legacy.id]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,legacy.id])).rows,[{outcome:'existing_center',center_event_id:existing.id}]);
      assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,legacy.id])).rows,[{outcome:'existing_center',center_event_id:existing.id}]);
      await other.query('BEGIN'); await other.query(`LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE`);
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,legacy.id]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_neutral($1,$2)`,[source.org,neutralOnly.id]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_due',$3,NULL,NULL,$4)`,[source.org,source.lease,source.invoice,randomUUID()]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await assert.rejects(c.query(`INSERT INTO app.b017_center_resolutions(org_id,kind,lease_id,invoice_id,payment_id,actor_id,occurrence_key,local_date,occurred_at,old_source_id,center_event_id,outcome)
        SELECT org_id,kind,lease_id,invoice_id,payment_id,actor_id,occurrence_key,local_date,created_at,id,$2,'existing_center' FROM app.b010_source_events WHERE id=$1`,[legacy.id,existing.id]),
        (error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      await c.query('BEGIN'); await c.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_due',$3,NULL,NULL,$4)`,[source.org,source.lease,source.invoice,randomUUID()]);
      await other.query('BEGIN'); await other.query(`SET LOCAL lock_timeout='100ms'`);
      await assert.rejects(other.query(`LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE`),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK'); await c.query('ROLLBACK');
      await other.query('BEGIN'); await other.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[source.org]);
      await assert.rejects(c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[source.org,legacy.id]),(error:unknown)=>(error as {code?:string}).code==='55P03');
      await other.query('ROLLBACK');
      const legacyKey=(await c.query<{key:string}>(`SELECT occurrence_key key FROM app.b010_source_events WHERE id=$1`,[legacy.id])).rows[0].key;
      await assert.rejects(c.query(`INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at)
        VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp())`,[source.org,source.lease,source.invoice,legacyKey]),
        (error:unknown)=>(error as {code?:string}).code==='23505');


    } finally { await other.end(); }
    const acl = (await c.query<{denied:boolean;trusted:boolean}>(`SELECT bool_and(NOT has_table_privilege(r.rolname,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) denied,
      bool_and(o.rolname NOT IN ('anon','authenticated','service_role')) trusted FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_roles o ON o.oid=t.relowner CROSS JOIN pg_roles r WHERE n.nspname='app' AND t.relname IN ('b017_occurrences','b017_old_source_transactions','b017_center_resolutions')
      AND r.rolname IN ('anon','authenticated','service_role')`)).rows[0];
    assert.deepEqual(acl,{denied:true,trusted:true});
    const functions=(await c.query<{denied:boolean;trusted:boolean}>(`SELECT bool_and(NOT has_function_privilege(r.rolname,p.oid,'EXECUTE')) denied,
      bool_and(o.rolname NOT IN ('anon','authenticated','service_role')) trusted FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_roles o ON o.oid=p.proowner CROSS JOIN pg_roles r WHERE n.nspname='app' AND p.proname LIKE 'b017_%'
      AND r.rolname IN ('anon','authenticated','service_role')`)).rows[0];
    assert.deepEqual(functions,{denied:true,trusted:true});
  } finally { await c.end(); }
});
