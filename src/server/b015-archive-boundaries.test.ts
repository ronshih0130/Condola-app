import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Client } from 'pg';
import { makeT } from '@/i18n';
import { archiveCopy } from '@/i18n/record-archive';
import { errorText } from '@/i18n/errors';
import { ArchiveEntry } from '@/components/record-archive-entry';
import { OwnerForm } from '@/components/owner-form';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { FlowError, mapDbError } from './errors';
import { tx } from './db';
import { archiveCommand, archiveScope } from './record-archive';
import type { Session } from './types';

const requireHere=createRequire(import.meta.url);
// Execute the real page/action module, replacing only its request/IO boundaries.
function load(source:string,mocks:Record<string,unknown>) {
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const loaded={exports:{} as Record<string, (...args: never[])=>Promise<unknown>>};
 new Function('require','module','exports',output)((id:string)=>id in mocks?mocks[id]:id==='react/jsx-runtime'?requireHere(id):{},loaded,loaded.exports);
 return loaded.exports;
}
const session={userId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000002',orgId:'00000000-0000-4000-8000-000000000003',liveOrgId:'00000000-0000-4000-8000-000000000003',kind:'staff',role:'manager',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'',name:'Synthetic'} satisfies Session;
function render(node:unknown){const previous=Object.getOwnPropertyDescriptor(globalThis,'React');Object.defineProperty(globalThis,'React',{value:React,configurable:true});try{return renderToStaticMarkup(node as React.ReactNode);}finally{if(previous)Object.defineProperty(globalThis,'React',previous);else Reflect.deleteProperty(globalThis,'React');}}

for(const locale of ['en','zh-TW'] as const)test(`rendered owner/archive pages with feature OFF match pre-owner HTML byte-for-byte (${locale})`,async()=>{
 const ownerPath='src/app/m/owners/[id]/page.tsx',archivePath='src/app/m/archive/page.tsx';let enabled=false;
 const s={...session,locale,role:'accountant'};
 const mocks:Record<string,unknown>={
  '@/server/consent-gate':{requireCurrentConsent:async()=>{}},'@/server/session':{getSession:async()=>s},
  '@/i18n':{makeT},'@/i18n/record-archive':{archiveCopy},'@/components/record-archive-entry':{ArchiveEntry},
  '@/components/owner-form':{OwnerForm},'@/components/ui':{ErrorBanner,PageHeader},
  '@/server/actions':{actionUpdateOwner:async()=>{}},'@/server/portal-invite':{portalLoginReady:async()=>false},
  '@/server/repair-rules':{isUuid:()=>true},'next/navigation':{notFound:()=>{throw new Error('Unexpected notFound');}},
  '@/server/queries':{ownerEditor:async()=>({id:session.userId,name:'Synthetic',email:'',phone:'',propertyIds:[]}),listProperties:async()=>[]},
  '@/server/record-archive':{recordArchiveEnabled:async()=>enabled,archiveList:async()=>({state:'ready',rows:[],nextCursor:null})},
 };
 for(const path of [ownerPath,archivePath]){
  const args={params:Promise.resolve({id:session.userId}),searchParams:Promise.resolve({})};
  // Frozen pre-owner HTML, rendered from the original HEAD page in the same harness.
  const oldHtml=readFileSync(`src/server/fixtures/b015-${path===ownerPath?'owner':'archive'}-off-${locale}.html`,'utf8');
  const current=load(readFileSync(path,'utf8'),mocks);
  const offHtml=render(await current.default(args as never));
  assert.equal(offHtml,oldHtml);assert.ok(!offHtml.includes('/m/archive/owner/'));
  enabled=true;const onHtml=render(await current.default(args as never));assert.notEqual(onHtml,offHtml);
  if(path===ownerPath)assert.ok(onHtml.includes('/m/archive/owner/'));else assert.ok(onHtml.includes(locale==='en'?'spaces and owners':'空間與屋主'));
  enabled=false;
 }
});

for(const code of ['55P03','40P01'])for(const enabled of [false,true])test(`real action callers preserve OFF fallbacks and scope ON busy for ${code}, enabled=${enabled}`,async t=>{
 t.mock.method(console,'error',()=>{});
 let calls=0;
 const statements:string[]=[];
 t.mock.method(Client.prototype,'connect',async()=>{});t.mock.method(Client.prototype,'end',async()=>{});
 t.mock.method(Client.prototype,'query',(async(sql:string)=>{
  statements.push(sql);
  if(sql==='SELECT synthetic_guarded_write()')throw Object.assign(new Error('Synthetic lock failure'),{code,...(enabled?{detail:'b015_archive_enabled_contention'}:{})});
  return {rows:[],rowCount:0};
 }) as Client['query']);
 const fail=async()=>{calls++;return tx(session.userId,c=>c.query('SELECT synthetic_guarded_write()'),{orgId:session.orgId,environment:session.environment});};
 assert.equal((mapDbError(Object.assign(new Error('Synthetic lock failure'),{code})) as FlowError).key,'errors.generic');
 const expected=enabled?'errors.busy':'errors.generic';
 const actions=load(readFileSync('src/server/actions.ts','utf8'),{
  './consent-gate':{requireCurrentConsent:async()=>{}},'./session':{getSession:async()=>session},
  './errors':{FlowError,logServerError:()=>{}},'./portfolio':{createOwner:fail,updateOwner:fail,createSpace:fail,updateSpace:fail,updateProperty:fail},
  './repairs':{saveRepairRecord:fail},
  './domain':{createProperty:fail,createTicket:fail,updateTicket:fail,updateLease:fail},'./lease-form':{createLeaseFromForm:fail},
  './lease-rules':{normalizePhone:()=>({ok:true,phone:''})},'@/property-address':{typedStreet:()=>''},
  'next/navigation':{redirect:(location:string)=>{throw Object.assign(new Error(location),{digest:`NEXT_REDIRECT;${location}`});}},
 });
 const form=new FormData();for(const key of ['ownerId','propertyId','spaceId','ticketId','leaseId'])form.set(key,session.userId);form.set('currency','TWD');
 for(const name of ['actionCreateOwner','actionUpdateOwner','actionCreateSpace','actionUpdateSpace','actionUpdateProperty','actionTicket','actionUpdateTicket','actionSaveRepair']){
  const before=calls;
  await assert.rejects(()=>actions[name](form as never),e=>e instanceof Error&&e.message.endsWith(`error=${expected}`));
  assert.equal(calls,before+1,'one attempt; no unbounded retries');
 }
 for(const name of ['actionCreateProperty','actionCreateLease','actionUpdateLease']){
  const before=calls;assert.deepEqual(await actions[name]({error:''} as never,form as never),{error:enabled?'errors.busy':name==='actionCreateProperty'?'errors.generic':'errors.leaseFailed'});assert.equal(calls,before+1);
 }
 const sequence=['BEGIN',"SELECT set_config('request.jwt.claim.sub', $1, true)","SELECT set_config('request.jwt.claim.role', 'authenticated', true)","SELECT set_config('app.active_org_id', $1, true)","SELECT set_config('app.env', $1, true)",'SET LOCAL ROLE authenticated','SELECT synthetic_guarded_write()','ROLLBACK'];
 assert.deepEqual(statements,Array.from({length:calls},()=>sequence).flat(),'identical query sequence and one rollback per failed caller; no flag lookup/retry');
 for(const locale of ['en','zh-TW'] as const){
  const t=makeT(locale);assert.equal(errorText(t,'errors.busy'),archiveCopy(locale).busy);
  assert.notEqual(errorText(t,'errors.busy'),errorText(t,'errors.generic'));
 }
});

for(const code of ['55P03','40P01'])for(const phase of ['before-enable','disabled','enabled'] as const)test(`archiveCommand scopes busy to ON after rollback for ${code}: ${phase}`,async t=>{
 let rollbacks=0;
 t.mock.method(console,'error',()=>{});t.mock.method(Client.prototype,'connect',async()=>{});t.mock.method(Client.prototype,'end',async()=>{});
 t.mock.method(Client.prototype,'query',(async(sql:string)=>{
  if(sql.includes('FROM public.organizations o JOIN public.org_members')) {
   if(phase==='before-enable')throw Object.assign(new Error('Synthetic conflict'),{code});
   return {rows:[{role:session.role}],rowCount:1};
  }
  if(sql.includes('JOIN public.platform_settings'))return {rows:phase==='enabled'?[{}]:[],rowCount:phase==='enabled'?1:0};
  if(sql.includes("set_config('lock_timeout'"))throw Object.assign(new Error('Synthetic conflict'),{code});
  if(sql==='ROLLBACK')rollbacks++;
  return {rows:[],rowCount:0};
 }) as Client['query']);
 assert.deepEqual(await archiveCommand(session,{ref:{kind:'property',id:session.userId},desired:'archived',expectedVersion:'a'.repeat(64),renderedScope:archiveScope(session),reason:'Synthetic',requestId:session.sessionId}),{state:phase==='enabled'?'busy':phase==='disabled'?'disabled':'unknown'});
 assert.equal(rollbacks,phase==='disabled'?0:1);
});

for(const locale of ['en','zh-TW'] as const)test(`populated archive owner links expose the owner name (${locale})`,async()=>{
 const name=locale==='en'?'Synthetic owner':'測試屋主';
 const rows=[{ref:{kind:'owner',id:session.userId},name,propertyName:'',unitLabel:null,roomLabel:null,archivedAtUtc:'2026-11-06T00:00:00Z'},
  {ref:{kind:'room',id:session.sessionId},name:'Unused',propertyName:'Property',unitLabel:'Unit',roomLabel:'Room',archivedAtUtc:null}];
 const page=load(readFileSync('src/app/m/archive/page.tsx','utf8'),{
  '@/server/consent-gate':{requireCurrentConsent:async()=>{}},'@/server/session':{getSession:async()=>({...session,locale})},
  '@/i18n/record-archive':{archiveCopy},'next/navigation':{notFound:()=>{throw new Error('Unexpected notFound');}},
  'next/link':{default:({href,children}:{href:string;children:React.ReactNode})=>React.createElement('a',{href},children)},
  '@/server/record-archive':{recordArchiveEnabled:async()=>true,archiveList:async()=>({state:'ready',rows,nextCursor:null})},
 });
 const html=render(await page.default({searchParams:Promise.resolve({})} as never));
 assert.ok(html.includes(`<a href="/m/archive/owner/${session.userId}">${name}</a> — ${archiveCopy(locale,true).archived}`));
 assert.ok(html.includes(`<a href="/m/archive/room/${session.sessionId}">Property / Unit / Room</a>`));
 assert.ok(!/<a[^>]*><\/a>/.test(html));
});
