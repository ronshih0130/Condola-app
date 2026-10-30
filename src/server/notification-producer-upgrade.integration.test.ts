import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from 'pg';
import { disposableDbUrl, withDatabase } from './test-disposable-db';
import { resetAndSeed } from './seed';
import { centerSessionItems } from './notification-center';
import type { Session } from './types';

const source=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
const previousUrl=process.env.DATABASE_URL;
const fixtureName=`condola_b017_upgrade_${randomUUID().replaceAll('-','')}`;
let owned=false;
async function admin(sql:string){const c=new Client({connectionString:withDatabase(source,'postgres')});try{await c.connect();await c.query(sql);}finally{await c.end();}}
async function cleanup(){if(previousUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousUrl;if(owned){await admin(`DROP DATABASE "${fixtureName}"`);owned=false;}}
test.before(async()=>{
 const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
 try {
  const manifest=JSON.parse(await readFile(new URL('./fixtures/b017-pre17-source.json',import.meta.url),'utf8')) as {source_commit:string;stub:{file:string;sha256:string};migrations:{file:string;sha256:string}[]};
  assert.equal(manifest.source_commit,'4e43104f45c3acf0dae76e40c7b577bd7ffb8ea6');assert.equal(manifest.migrations.length,89);
  const root=fileURLToPath(new URL('../..',import.meta.url));
  const files=[manifest.stub,...manifest.migrations];
  for(const file of files){assert.match(file.file,/^supabase\/(?:stub|migrations)\/[a-zA-Z0-9_.-]+\.sql$/);const bytes=await readFile(new URL(`../../${file.file}`,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,'published fixture source drift');}
  await admin(`CREATE DATABASE "${fixtureName}"`);owned=true;
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV??'test',PGHOST:source.hostname.replace(/^\[|\]$/g,''),PGPORT:source.port,PGDATABASE:fixtureName,...(source.username?{PGUSER:decodeURIComponent(source.username)}:{}),...(source.password?{PGPASSWORD:decodeURIComponent(source.password)}:{})};
  for(const file of files){const result=spawnSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-f',file.file],{cwd:root,env,stdio:'pipe'});if(result.status!==0)throw new Error(`Published pre17 replay failed: ${file.file.split('/').at(-1)}`);}
  process.env.DATABASE_URL=withDatabase(source,fixtureName);
  process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();
 } catch(error){await cleanup();throw error;}
 finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(cleanup);

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
