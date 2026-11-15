import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
import ts from 'typescript';
import {renderToStaticMarkup as render} from 'react-dom/server';
import {ArchiveListView,ArchiveDetailView,ArchiveBlocker,archiveHref} from '../components/v3/m/archive/views';
import {archiveV3Copy,archiveText} from '../i18n/lanes/brand-v3-archive';
import {archiveCopy} from '../i18n/record-archive';
import * as contract from '../lib/record-archive';
import type {ArchiveReady,ArchiveList,ArchiveItem,ArchiveCommandInput,ArchiveOutcome} from '../lib/record-archive';
import legacy from './fixtures/b3-archive-legacy.json';
const req=createRequire(import.meta.url),c=archiveV3Copy('zh-TW'),t=archiveCopy('zh-TW');
const ref={kind:'property' as const,id:'00000000-0000-4000-8000-000000000001'};
const scope={orgId:randomUUID(),actorId:randomUUID(),liveOrgId:randomUUID(),environment:'live' as const};
const active:ArchiveReady={state:'ready',observed:{ref,propertyId:ref.id,unitId:null,roomId:null,mode:null,name:'Sample',propertyName:'Sample',unitLabel:null,roomLabel:null,archivedAtUtc:null,inherited:[],version:'a'.repeat(64)},writeEnabled:true,canArchive:true,canRestore:false,blockers:[],warnings:[],coverage:[],history:[]};
const archived:ArchiveReady={...active,canArchive:false,canRestore:true,observed:{...active.observed,archivedAtUtc:'2026-11-15T01:02:03.000000Z',archivedBy:'Member',restoreEligible:true},history:[{category:'leases',label:'lease_history',href:'/m/leases/sample'},{category:'finance',label:'finance_history',href:'/m/payments'}]};
const list:ArchiveList={state:'ready',rows:[archived.observed],hasMore:false,nextCursor:null,counts:{property:1,unit:0,owner:0,total:1}};
function load(source:string,mocks:Record<string,unknown>={},globals:Record<string,unknown>={}) {
 const mod={exports:{} as Record<string,unknown>};
 runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{module:mod,exports:mod.exports,require:(id:string)=>id in mocks?mocks[id]:req(id),React,...globals});
 return mod.exports;
}
const source=(path:string)=>readFileSync(path,'utf8');
const controlsPath='src/components/v3/m/archive/controls.tsx';
function controller(initial=archived,extra:Record<string,unknown>={}) {
 return {t,current:initial,pending:null,ready:true,storageError:false,reason:'Reason',setReason:()=>{},message:'',reviewed:false,busy:false,effectiveArchived:!!initial.observed.archivedAtUtc,submit:()=>{},review:()=>{},newDecision:()=>{},...extra};
}
function controls(state=controller()) {
 return load(source(controlsPath),{
  '../../../../i18n/record-archive':{archiveCopy},'../../../../i18n/lanes/brand-v3-archive':{archiveV3Copy},
  '../../../../server/record-archive-actions':{archiveViewAction:()=>assert.fail('Unexpected read')},
  '../../../record-archive':{useArchiveController:()=>state},
  './views':{ArchiveDetailView,ArchiveBlocker,ArchiveHistory:({items}:{items:ArchiveItem[]})=><ul>{items.map(x=><li key={x.label}>{x.label}</li>)}</ul>},
 });
}
test('list roles, exact headline, all tabs, dates and author, outline restore only',()=>{
 for(const role of ['admin','manager','accountant','maintenance']){
  const html=render(<ArchiveListView data={list} locale="zh-TW" admin={role==='admin'}/>);
  assert.ok(html.includes(archiveText(c.lead,{n:1,a:1,b:0,c:0})));assert.ok(html.includes(c.retained));
  for(const label of [c.all,c.property,c.unit,c.owner,c.name,c.kind,c.archived,c.view,'Member','2026-11-15'])assert.ok(html.includes(label));
  assert.equal(html.includes(t.restore),role==='admin');assert.doesNotMatch(html,/class="[^"]*\bpri\b/);
 }
 const inherited={...archived.observed,archivedAtUtc:null,restoreEligible:false,inherited:[{ref,archivedAtUtc:archived.observed.archivedAtUtc!}]};
 assert.ok(!render(<ArchiveListView data={{...list,rows:[inherited]}} locale="zh-TW" admin/>).includes(t.restore));
 assert.equal(archiveHref('unit','room:x'),'/m/archive?tab=unit&after=room%3Ax');
});
test('empty and error do not show false counts or an empty-state action',()=>{
 const empty=render(<ArchiveListView data={{...list,rows:[],counts:{property:0,unit:0,owner:0,total:0}}} locale="zh-TW"/>);
 assert.ok(empty.includes(c.empty));assert.doesNotMatch(empty,/<button|\?restore=/);
 const error=render(<ArchiveListView data={{state:'unavailable'}} locale="zh-TW"/>);
 assert.ok(error.includes(c.failed));assert.ok(!error.includes(c.empty));assert.ok(!error.includes(archiveText(c.lead,{n:0,a:0,b:0,c:0})));
});
test('detail retains only actual history links; admin alone gets restore',()=>{
 for(const role of ['admin','manager','accountant','maintenance']){
  const Component=controls().ArchiveDetailV3 as React.ComponentType<Record<string,unknown>>;
  const html=render(<Component initial={archived} scope={scope} locale="zh-TW" role={role}/>);
  assert.ok(html.includes(archiveText(c.detailLead,{name:'Sample'})));assert.ok(html.includes(archiveText(c.detailHint,{date:'2026-11-15',name:'Member'})));
  assert.match(html,/href="\/m\/leases\/sample"/);assert.match(html,/href="\/m\/payments"/);
  assert.equal(html.includes(t.restore),role==='admin');assert.doesNotMatch(html,/\/edit|type="submit"/);
 }
});
test('each existing blocker supplies exactly one solid destination and close, with the real lease count',()=>{
 const blockers:ArchiveItem[]=[{category:'leases',label:'lease_active',count:2,href:'/m/leases/a'},{category:'signing',label:'signing_active',href:'/m/leases/b'},{category:'repairs',label:'repair_active',href:'/m/tickets/a'},{category:'dispatch',label:'dispatch_active',href:'/m/tickets/b'},{category:'utilities',label:'utility_active',href:'/m/rent/utilities'}];
 for(const blocker of blockers){
  const initial={...active,canArchive:false,blockers:[blocker]};
  const Component=controls(controller(initial)).ArchiveDialogBody as React.ComponentType<Record<string,unknown>>;
  const html=render(<Component initial={initial} scope={scope} locale="zh-TW" role="manager" close={()=>{}}/>);
  assert.ok(html.includes(c.blocked));assert.ok(html.includes(c.close));assert.equal((html.match(/class="btn pri"/g)??[]).length,1);assert.ok(html.includes(`href="${blocker.href}"`));assert.doesNotMatch(html,/<textarea/);
  if(blocker.category==='leases')assert.ok(html.includes(archiveText(c.activeLease,{n:2})));
 }
});
test('dialog and entry role boundaries; no restore offered by archive dialog',()=>{
 for(const role of ['admin','manager','accountant','maintenance']){
  const exports=controls(controller(active));const Body=exports.ArchiveDialogBody as React.ComponentType<Record<string,unknown>>,Entry=exports.ArchiveEntryV3 as React.ComponentType<Record<string,unknown>>;
  const html=render(<Body initial={active} scope={scope} locale="zh-TW" role={role} close={()=>{}}/>);
  assert.equal(html.includes('<textarea'),role==='admin'||role==='manager');assert.ok(!html.includes(t.restore+'</button>'));
  const entry=render(<Entry refValue={ref} scope={scope} locale="zh-TW" role={role}/>);
  assert.equal(entry.includes('<button'),role==='admin'||role==='manager');
 }
});

test('OFF list, detail, panel and entry render byte-identically to the captured main renderers',async()=>{
 const panelPath='src/components/record-archive.tsx',entryPath='src/components/record-archive-entry.tsx';
 const mocks={'next/navigation':{useRouter:()=>({refresh:()=>{}}),notFound:()=>{throw new Error('NOT_FOUND');}},'@/server/record-archive-actions':{},'@/lib/record-archive':contract,'@/i18n/record-archive':{archiveCopy}};
 const panels=[legacy[panelPath],source(panelPath)].map(s=>load(s,mocks).ArchivePanel as React.ComponentType<Record<string,unknown>>);
 for(const initial of [active,archived,{...archived,writeEnabled:false,canRestore:false}])assert.equal(render(React.createElement(panels[0],{initial,scope,locale:'zh-TW'})),render(React.createElement(panels[1],{initial,scope,locale:'zh-TW'})));
 const entries=[legacy[entryPath],source(entryPath)].map(s=>load(s,mocks).ArchiveEntry as React.ComponentType<Record<string,unknown>>);
 for(const locale of ['zh-TW','en'])assert.equal(render(React.createElement(entries[0],{refValue:ref,locale})),render(React.createElement(entries[1],{refValue:ref,locale})));
 for(const locale of ['zh-TW','en'])for(const rows of [[],[archived.observed]])for(const after of [undefined,'property:'+ref.id]){
  const deps={...mocks,'@/server/brand-v3':{brandV3EnabledForOrg:async()=>false},'@/components/v3/m/archive/pages':{},'@/components/v3/m/archive/views':{},'@/components/v3/m/archive/controls':{},'@/server/consent-gate':{requireCurrentConsent:async()=>{}},'@/server/session':{getSession:async()=>({locale})},'@/server/record-archive':{archiveList:async()=>({...list,rows,nextCursor:rows.length?'property:'+ref.id:null}),archiveView:async()=>archived,archiveScope:()=>scope},'@/components/record-archive':{ArchivePanel:panels[1]}};
  for(const path of ['src/app/m/archive/page.tsx','src/app/m/archive/[kind]/[id]/page.tsx'] as const){
   const out=[];for(const src of [legacy[path],source(path)]){const Page=load(src,deps).default as (p:unknown)=>Promise<React.ReactElement>;out.push(render(await Page({searchParams:Promise.resolve({after}),params:Promise.resolve(ref)})));}assert.equal(out[0],out[1]);
  }
 }
});

// A small hook harness exercises the SAME controller used by both renderers,
// including persistent intent, exact action input, and no automatic retry.
function harness(outcome:ArchiveOutcome['state'],throws=false){
 let cursor=0,initialized=false;const values:unknown[]=[],effects:(()=>void)[]=[],jobs:Promise<void>[]=[];
 const saved=new Map<string,string>(),calls:ArchiveCommandInput[]=[];let refreshes=0;
 const hooks={...React,useState:(init:unknown)=>{const i=cursor++;if(!initialized)values[i]=init;return [values[i],(value:unknown)=>{values[i]=value;}];},useEffect:(fn:()=>void)=>{if(!initialized)effects.push(fn);},useTransition:()=>[false,(fn:()=>Promise<void>)=>jobs.push(fn())]};
 const exports=load(source('src/components/record-archive.tsx'),{'react':hooks,'next/navigation':{useRouter:()=>({refresh:()=>{refreshes++;}})},'@/server/record-archive-actions':{archiveCommandAction:async(input:ArchiveCommandInput)=>{calls.push(input);if(throws)throw new Error('Lost response');return {state:outcome};},archiveViewAction:async()=>archived},'@/lib/record-archive':contract,'@/i18n/record-archive':{archiveCopy}},{crypto:{randomUUID},sessionStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)}});
 const hook=exports.useArchiveController as (p:unknown)=>ReturnType<typeof controller>;
 function rerender(){cursor=0;const result=hook({initial:active,scope,locale:'zh-TW'});initialized=true;for(const effect of effects.splice(0))effect();return result;}
 rerender();return {rerender,calls,saved,jobs,refreshes:()=>refreshes};
}
test('shared controller sends exact preconditions/reason/request ID, retains uncertain intent, never retries',async()=>{
 for(const outcome of ['changed','stale','already_in_desired_state','unknown','blocked','disabled','conflict','forbidden','busy'] as const){
  const h=harness(outcome);let state=h.rerender();(state.setReason as (s:string)=>void)('Review reason');state=h.rerender();(state.submit as (s:string)=>void)('archived');await Promise.all(h.jobs);
  assert.equal(h.calls.length,1);const input=h.calls[0];assert.equal(input.desired,'archived');assert.equal(input.reason,'Review reason');assert.deepEqual(input.ref,ref);assert.deepEqual(input.renderedScope,scope);assert.equal(input.expectedVersion,active.observed.version);assert.ok(contract.isArchiveCommand(input));
  state=h.rerender();const uncertain=['stale','already_in_desired_state','unknown'].includes(outcome);assert.equal(!!state.pending,uncertain);assert.equal(h.saved.size,uncertain?1:0);assert.equal(h.refreshes(),outcome==='changed'?1:0);
  if(uncertain){(state.submit as (s:string)=>void)('archived');assert.equal(h.calls.length,1);}
 }
 const h=harness('unknown',true);let state=h.rerender();(state.setReason as (s:string)=>void)('Reason');state=h.rerender();(state.submit as (s:string)=>void)('archived');await Promise.all(h.jobs);assert.ok(h.rerender().pending);assert.equal(h.calls.length,1);
});
test('v3 has no new write path and test registration has a separate integration segment',()=>{
 const originalCommand=source('src/server/record-archive.ts').split('export async function archiveCommand')[1];assert.equal(createHash('sha256').update('export async function archiveCommand'+originalCommand).digest('hex'),'e5c499d966f91edde722fc38b961c82b1c41eb79f7ab32cbdfb6f92d9ceb946f'); // re-pinned for app #175: admin-only restore (hub OQ-070)
 const s=source(controlsPath);assert.match(s,/useArchiveController/);assert.doesNotMatch(s,/fetch\(|UPDATE |INSERT |DELETE /);
 const scripts=JSON.parse(source('package.json')).scripts;assert.ok(scripts['test:unit'].split('&&')[0].includes('src/server/b3-archive.test.tsx'));assert.ok(scripts['test:rls'].split('&&').some((segment:string)=>segment.trim()==='tsx --test --test-concurrency=1 src/server/b3-archive.integration.test.ts'));
});

test('actual dialog and restore buttons dispatch the intended existing-controller command',()=>{
 for(const desired of ['archived','active'] as const){
  const calls:string[]=[],initial=desired==='active'?archived:active;
  const exports=controls(controller(initial,{submit:(value:string)=>calls.push(value)}));
  const Component=exports[desired==='active'?'ArchiveDetailV3':'ArchiveDialogBody'] as (p:Record<string,unknown>)=>React.ReactElement;
  const tree=Component({initial,scope,locale:'zh-TW',role:'admin',close:()=>{}});
  function buttons(node:React.ReactNode):React.ReactElement<Record<string,unknown>>[]{
   if(Array.isArray(node))return node.flatMap(buttons);
   if(!React.isValidElement<Record<string,unknown>>(node))return [];
   if(typeof node.type==='function')return buttons((node.type as (props:unknown)=>React.ReactNode)(node.props));
   return [...(node.type==='button'?[node]:[]),...buttons(node.props.children as React.ReactNode)];
  }
  const label=desired==='active'?t.restore:t.archive;
  const button=buttons(tree).find(b=>b.props.children===label);assert.ok(button);(button.props.onClick as ()=>void)();assert.deepEqual(calls,[desired]);
 }
});

test('list route gates v3 before rendering it and validates Next searchParams without changing OFF queries',async()=>{
 let on=true;const captured:unknown[]=[];
 const deps={
  '@/server/brand-v3':{brandV3EnabledForOrg:async()=>on},
  '@/components/v3/m/archive/pages':{ArchiveListPageV3:(props:unknown)=>{captured.push(props);return <p>V3</p>;}},
  '@/components/v3/m/archive/views':{ArchiveLoading:()=>null},
  'next/navigation':{notFound:()=>{throw new Error('NOT_FOUND');}},
  '@/i18n/record-archive':{archiveCopy},'@/server/consent-gate':{requireCurrentConsent:async()=>{}},
  '@/server/record-archive':{archiveList:async()=>list},'@/server/session':{getSession:async()=>({locale:'zh-TW',role:'admin'})},
 };
 const Page=load(source('src/app/m/archive/page.tsx'),deps).default as (p:unknown)=>Promise<React.ReactElement>;
 const html=render(await Page({searchParams:Promise.resolve({tab:'unit',after:'room:'+ref.id})}));
 assert.match(html,/archive\.css/);assert.equal(captured.length,1);assert.equal((captured[0] as {tab:string}).tab,'unit');
 for(const tab of [['unit','owner'],'invalid'])await assert.rejects(()=>Page({searchParams:Promise.resolve({tab})}),/NOT_FOUND/);
 on=false;const old=render(await Page({searchParams:Promise.resolve({tab:['invalid']})}));assert.doesNotMatch(old,/archive\.css/);assert.equal(captured.length,1);
});

test('R2-ARCH-ONE: the detail controller remounts on each new server version (refresh after archive/restore, Codex r1)',()=>{
 const src=readFileSync('src/components/v3/m/archive/controls.tsx','utf8');
 // The exported detail is a thin wrapper keyed on the record and its optimistic version; the controller lives inside.
 assert.match(src,/export function ArchiveDetailV3\(props:ArchiveDetailProps\) \{\n return <ArchiveDetailV3Inner key=\{`\$\{props\.initial\.observed\.ref\.kind\}:\$\{props\.initial\.observed\.ref\.id\}:\$\{String\(props\.initial\.observed\.version\)\}`\} \{\.\.\.props\}\/>;/);
 assert.match(src,/function ArchiveDetailV3Inner\(\{initial,scope,locale,role\}:ArchiveDetailProps\) \{\n const state=useArchiveController\(\{initial,scope,locale\}\)/);
 const css=readFileSync('public/brand/v3/archive.css','utf8');
 assert.match(css,/\.v3-archive \.pri \{ color:var\(--c-on-primary\); background:var\(--c-primary\); border-color:var\(--c-primary\); \}/);
});
