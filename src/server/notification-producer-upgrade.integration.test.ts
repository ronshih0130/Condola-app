import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from 'pg';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { resetAndSeed } from './seed';
import { centerSessionItems } from './notification-center';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async()=>{
 clone=await cloneTestDatabase(); const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
 try {process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}
 catch(error){await clone.cleanup();throw error;}
 finally {if(demo===undefined) delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined) delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{await clone?.cleanup();});

test('additive draft preserves a center event and entitlement that existed before migration',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  assert.equal((await c.query(`SELECT to_regclass('app.b017_occurrences') IS NULL AS absent`)).rows[0].absent,true);
  const row=(await c.query<{org:string;lease:string;invoice:string;contact:string;principal:string}>(`SELECT i.org_id::text org,i.lease_id::text lease,i.id::text invoice,ct.id::text contact,ct.user_id::text principal
   FROM invoices i JOIN lease_parties lp ON lp.org_id=i.org_id AND lp.lease_id=i.lease_id AND lp.role='primary'
   JOIN contacts ct ON ct.id=lp.contact_id AND ct.org_id=lp.org_id WHERE ct.user_id IS NOT NULL LIMIT 1`)).rows[0];assert.ok(row);
  const old=(await c.query<{id:string;at:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
   VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[row.org,row.lease,row.invoice,randomUUID()])).rows[0];
  const event=(await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at)
   VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[row.org,old.id,old.at])).rows[0];
  const recipient=(await c.query<{id:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,contact_id)
   VALUES($1,$2,'tenant',$3,$4) RETURNING id::text`,[row.org,event.id,row.principal,row.contact])).rows[0];
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,row.principal,randomUUID()]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[row.org]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[row.org]);
  const session:Session={userId:row.principal,sessionId:sid,kind:'tenant',role:null,orgId:row.org,liveOrgId:row.org,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
  assert.ok((await centerSessionItems(session)).items.some(item=>item.recipient_id===recipient.id));
  const sql=await readFile('supabase/migrations/20261031100217_b010_b028_source_foundation.sql','utf8');await c.query(sql);
  const unchanged=(await c.query(`SELECT id::text,b010_event_id::text,neutral_source_id FROM app.b028_center_events WHERE id=$1`,[event.id])).rows[0];
  assert.deepEqual(unchanged,{id:event.id,b010_event_id:old.id,neutral_source_id:null});
  assert.ok((await centerSessionItems(session)).items.some(item=>item.recipient_id===recipient.id));
  assert.deepEqual((await c.query(`SELECT * FROM app.b017_resolve_history($1,$2)`,[row.org,old.id])).rows,[{outcome:'existing_center',center_event_id:event.id}]);
 } finally {await c.end();}
});
