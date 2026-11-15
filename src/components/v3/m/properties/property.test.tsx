import React from "react";
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PropertyView, PropertyLoading } from "./property";
import { ArchiveEntry } from "../../../record-archive-entry";
import type { PropertyQuery } from "./page";
import { PropertyLegacyControls, type LegacyPropertyControls } from "./legacy-controls";
import { makeT } from "../../../../i18n";
import { archiveCopy } from "../../../../i18n/record-archive";
import { can } from "../../../../server/perms";
import { displaySampleName } from "../../../../server/sandbox-data";
import { moneyLabel } from "../../../../server/format";
import * as ui from "../../../ui";
import { propertyCopy } from "../../../../i18n/lanes/brand-v3-property";
import { propertyRoomState,propertyTotals } from "../../../../server/b3-property-rules";
import type { PropertyReady } from "../../../../server/b3-property";
// Next supplies the automatic JSX runtime; node/tsx uses classic JSX for the
// unchanged legacy ui module. Supply React only in this isolated test process.
const previousReact=Object.getOwnPropertyDescriptor(globalThis,"React");
before(()=>Object.defineProperty(globalThis,"React",{value:React,configurable:true}));
after(()=>{if(previousReact)Object.defineProperty(globalThis,"React",previousReact);else Reflect.deleteProperty(globalThis,"React");});
const c=propertyCopy("zh-TW");
const row=propertyRoomState({id:"r",unitId:"u",kind:"room",label:"A",unitLabel:"3F",roomType:null,addressReady:true,ownerReady:true,moneyReady:true,tenantReady:false,leaseStatus:null});
const data:PropertyReady={state:"ready",id:"p",name:"Sample",archived:false,canInvite:true,rows:[row],...propertyTotals([row])};
const render=(d:Parameters<typeof PropertyView>[0]["data"]=data,invites:{rowId:string;href:string}[]=[])=>renderToStaticMarkup(<PropertyView data={d} locale="zh-TW" id="p" invites={invites}/>);
test("exact loaded lead, zero occupancy, room labels and outline invitation",()=>{
  const html=render(data,[{rowId:"r",href:"/m/units/u/invite"}]);
  assert.ok(html.includes(c.lead.replace("{name}",data.name).replace("{n}","1").replace("{k}","3")));
  assert.ok(html.includes(c.occupancy.replace("{occupied}","0").replace("{rooms}","1")));
  for(const text of [c.room,c.type,c.status,c.pending,c.invite,c.unspecified,c.vacant])assert.ok(html.includes(text));
  assert.match(html,/href="\/m\/units\/u\/invite"/);assert.doesNotMatch(html,/class="[^"]*\bpri\b|<form|<button/);
});
test("accountant and archived views suppress invites while retaining back navigation",()=>{
  for(const d of [{...data,canInvite:false},{...data,archived:true,canInvite:false}]){
    const html=render(d,[{rowId:"r",href:"/m/units/u/invite"}]);
    assert.doesNotMatch(html,/href="\/m\/units\/u\/invite"|<form|<button/);
    assert.match(html,/href="\/m\/properties"/);
    for(const label of [c.bulkInvite,c.override,c.inherit,c.settings])assert.ok(!html.includes(label));
  }
});
test("unknown data never renders an exact pending total or false completion",()=>{
  const unknown=propertyRoomState({...row,moneyReady:null,tenantReady:null});
  const html=render({...data,rows:[unknown],...propertyTotals([unknown])});
  assert.ok(html.includes(c.incomplete));assert.ok(html.includes(c.unknown));
  assert.ok(!html.includes(c.lead.replace("{name}",data.name).replace("{n}","1").replace("{k}","1")));
});
test("loading, failure, forbidden and empty do not fabricate occupancy",()=>{
  for(const state of ["unavailable","off","forbidden"] as const){
    const html=render({state});assert.ok(!html.includes(c.occupancy.split(" ")[0]));
    assert.ok(html.includes(state==="forbidden"?c.permission:c.retry));
    if(state==="forbidden")assert.doesNotMatch(html,/<a/);
  }
  const loading=renderToStaticMarkup(<PropertyLoading locale="zh-TW"/>);assert.match(loading,/aria-busy="true"/);assert.ok(loading.includes(c.loading));
  const empty=render({...data,rows:[],...propertyTotals([])});assert.ok(!empty.includes(c.occupancy.split(" ")[0]));assert.doesNotMatch(empty,/<button|<form/);
  assert.match(empty,/href="\/m\/properties"/);
});

const session:LegacyPropertyControls["session"]={userId:"user",sessionId:"session",email:"",name:"",kind:"staff",role:"manager",orgId:"org",liveOrgId:"org",environment:"live",locale:"zh-TW",calendar:"gregorian",leaseId:null};
const detail:LegacyPropertyControls["detail"]={
  property:{id:"p",name:"Sample",address_display:"Address",currency:"TWD",rental_mode:"by_room",archiveState:"active"},
  owner:{id:"association",contact_id:"owner",name:"Owner",phone_visible:true},
  rooms:[{id:"r",unit_label:"3F",label:"A",room_type:"suite",base_rent_minor:"1000",lease_id:"lease",tenant:"Tenant"}],
  wholes:[],byRoomUnits:[{id:"u",label:"3F"},{id:"zero-room-unit",label:"Empty unit"}],meterSerial:"M123",
  repairs:[{id:"ticket",number:"10",title:"Repair",status:"open",place:"A",vendor_name:null,scheduled_on:null,completed_on:null,final_cost:null,currency:null}],
};
const actions:Pick<LegacyPropertyControls,"actionSetMeter"|"actionPhoneVisibility">={actionSetMeter:async()=>{assert.fail("Render must not submit meter");},actionPhoneVisibility:async()=>{assert.fail("Render must not submit visibility");}};
const nativeRequire=createRequire(import.meta.url);
// Compile the real route with only I/O mocked, so role/label parity is checked
// against the shipped OFF JSX rather than a duplicate expected implementation.
function loadRoute(file:string,mocks:Record<string,unknown>) {
  const code=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const exports:Record<string,unknown>={};
  runInNewContext(code,{exports,URLSearchParams,require:(name:string)=>name in mocks?mocks[name]:nativeRequire(name)});
  return exports;
}
function auditComponent(s:typeof session,query:PropertyQuery={}) {
  const loaded=loadRoute("src/components/audit-log.tsx",{
    "@/i18n":{makeT},"@/sample-name":{displaySampleName},
    "@/server/session":{getSession:async()=>s},
    "@/server/demo":{showDemoLineCopy:()=>false},
    "@/server/audit-read":{loadAuditHistory:async(actual:typeof session,table:string,id:string,cursor?:string)=>{
      assert.equal(actual,s);assert.equal(table,"properties");assert.equal(id,"p");assert.equal(cursor,query.audit);
      return {hasMore:true,entries:[{cursor:"next +/&",who:"Actor",actionKey:"i_edit",recordKey:"i_owner",recordText:"Sample",found:true,fields:[],other:false,masked:false,reason:null,href:null,when:"2026-11-15"}]};
    }},
  });
  return loaded.AuditHistory as (props:Record<string,unknown>)=>Promise<React.ReactElement|null>;
}
const auditProps=(query:PropertyQuery)=>({table:"properties",rowId:"p",cursor:query.audit,path:"/m/properties/p",preserve:{error:query.error}});
async function v3Page(s:typeof session,d:typeof detail,ready:PropertyReady,query:PropertyQuery={}) {
  const AuditHistory=auditComponent(s,query);
  const loaded=loadRoute("src/components/v3/m/properties/page.tsx",{
    "next/navigation":{notFound:()=>assert.fail("Unexpected not found")},
    "../../../../server/b3-property":{brandProperty:async()=>ready},
    "../../../../server/b040-staff-ui":{staffInviteVisible:async()=>false},
    "../../../../server/errors":{FlowError:Error,logServerError:()=>assert.fail("Unexpected error")},
    "../../../../server/queries":{propertyDetail:async()=>d},
    "../../../../server/actions":actions,"./property":{PropertyView},
    "../../../audit-log":{AuditHistory},
  });
  const node=await (loaded.PropertyV3Page as (props:unknown)=>Promise<React.ReactElement<React.ComponentProps<typeof PropertyView>>>)({session:s,id:"p",query});
  const audit=node.props.auditHistory as React.ReactElement<Record<string,unknown>>;
  assert.equal(audit.type,AuditHistory);
  assert.deepEqual({...audit.props,preserve:{...(audit.props.preserve as Record<string,unknown>)}},auditProps(query));
  return React.cloneElement(node,{auditHistory:await AuditHistory(audit.props)});
}
async function legacyPage(s:typeof session,d:typeof detail,query:PropertyQuery={}) {
  const audit=await auditComponent(s,query)(auditProps(query));
  const loaded=loadRoute("src/app/m/properties/[id]/page.tsx",{
    "@/server/brand-v3":{brandV3EnabledForOrg:async()=>false},
    "@/components/v3/m/properties/page":{},"@/components/v3/m/properties/property":{},
    "@/server/consent-gate":{requireCurrentConsent:async()=>{}},
    "next/navigation":{notFound:()=>assert.fail("Unexpected not found")},
    "@/components/record-archive-entry":{ArchiveEntry},
    "@/i18n/record-archive":{archiveCopy},"@/i18n":{makeT},"@/server/actions":actions,
    "@/components/audit-log":{AuditHistory:(props:Record<string,unknown>)=>{assert.deepEqual({...props,preserve:{...(props.preserve as Record<string,unknown>)}},auditProps(query));return audit;}},"@/components/ui":ui,
    "@/server/sandbox-data":{displaySampleName},"@/server/format":{moneyLabel},"@/server/perms":{can},
    "@/server/queries":{propertyDetail:async()=>d},"@/server/session":{getSession:async()=>s},
  });
  return (loaded.default as (props:unknown)=>Promise<React.ReactElement>)({params:Promise.resolve({id:"p"}),searchParams:Promise.resolve(query)});
}
function elements(node:React.ReactNode):React.ReactElement<Record<string,unknown>>[] {
  if(Array.isArray(node))return node.flatMap(elements);
  if(!React.isValidElement<Record<string,unknown>>(node))return [];
  return [node,...elements(node.props.children as React.ReactNode)];
}
function controls(html:string) {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(([,href,label])=>({href,label:label.replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim()}))
    .sort((a,b)=>a.href.localeCompare(b.href));
}
const formMarkup=(node:React.ReactElement)=>renderToStaticMarkup(node).replace('class="small v3-property-phone-visibility"','class="small"');
function sections(html:string) {
  return [...html.matchAll(/data-testid="(by-room-unit|whole-unit-saved|repair-history|property-repair-[^"]+|shared-meter|meter-number(?:-prompt)?|audit-history(?:-list|-latest|-next)?)"/g)].map(match=>match[1]).sort();
}
function textParts(html:string) {
  return html.split(/<[^>]*>/).map(text=>text.replace(/\s+/g," ").trim()).filter(Boolean);
}
test("v3 preserves real legacy archive, audit, forms and section inventory for every role",async()=>{
  for(const locale of ["zh-TW","en"] as const)for(const role of ["admin","manager","accountant"] as const)for(const archived of [false,true]){
    const s={...session,role,locale};
    const whole=propertyRoomState({...row,id:"whole",unitId:"whole",kind:"whole_unit",label:"Whole",unitLabel:"Whole"});
    const d={...detail,byRoomUnits:archived?[]:detail.byRoomUnits,wholes:[{id:"whole",label:"Whole",base_rent_minor:"123456"}],property:{...detail.property,archiveState:archived?"archived" as const:"active" as const}};
    const query={audit:"previous cursor",error:"forbidden",created:"1"};
    const legacy=await legacyPage(s,d,query);
    const props={session:s,detail:d,...actions};
    const v3=await v3Page(s,d,{...data,rows:[row,whole],...propertyTotals([row,whole]),archived,canInvite:role!=="accountant"&&!archived},query);
    const html=renderToStaticMarkup(v3);
    const oldHtml=renderToStaticMarkup(legacy);
    assert.deepEqual(controls(html),controls(oldHtml),`${locale}/${role}/${archived}`);
    assert.deepEqual(sections(html),sections(oldHtml));
    const visibleText=textParts(html).join(" ");
    for(const text of textParts(oldHtml))assert.ok(visibleText.includes(text),`Missing legacy text: ${locale}/${role}/${text}`);
    for(const key of ["s_a757163","i_owner","i_repair_history","s_66a6e8b"] as const)assert.ok(html.includes(renderToStaticMarkup(<h3>{makeT(locale)(key)}</h3>)),`${locale}/${role}/${key}`);
    assert.ok(html.includes(d.property.address_display));
    for(const saved of [...d.rooms,...d.wholes])assert.ok(html.includes(moneyLabel(Number(saved.base_rent_minor),d.property.currency,locale)));
    assert.equal(controls(html).filter(link=>link.href.startsWith("/m/archive/")).length,archived?1:3);
    assert.equal(html.includes('href="/m/archive/unit/zero-room-unit"'),!archived);
    assert.equal(html.includes('data-testid="audit-history"'),role==="admin");
    if(role==="admin"){
      assert.ok(controls(html).some(link=>link.href==="/m/properties/p?error=forbidden"));
      assert.ok(controls(html).some(link=>link.href==="/m/properties/p?error=forbidden&amp;audit=next+%2B%2F%26"));
    }
    const oldForms=elements(legacy).filter(e=>e.type==="form");
    const newForms=elements(PropertyLegacyControls(props)).filter(e=>e.type==="form");
    assert.equal(newForms.length,oldForms.length);
    assert.equal(newForms.length,role==="accountant"||archived?0:2);
    for(const form of oldForms){
      const next=newForms.find(e=>e.props.action===form.props.action);
      assert.ok(next);
      assert.equal(formMarkup(next),formMarkup(form));
    }
    const rowHtml=html.match(/<tr><th scope="row">[\s\S]*?<\/tr>/)?.[0]??"";
    assert.match(rowHtml,/href="\/m\/leases\/lease"/);
    assert.doesNotMatch(rowHtml,/class="btn[^\"]*"/);
    if(role==="accountant"){
      assert.doesNotMatch(html,/href="\/m\/owners\/owner"|href="\/m\/properties\/p\/edit"|<form/);
      assert.equal(html.includes('href="/m/leases/new"'),!archived);
    }
  }
});
test("custom edit restrictions and unchecked visibility retain the legacy conditions",async()=>{
  const s:typeof session={...session,customRole:{orgId:session.orgId,userId:session.userId,sessionId:session.sessionId,nativeRole:session.role,keys:["props.view"],photos:false,audit:false}};
  const d={...detail,owner:{...detail.owner!,phone_visible:false},rooms:[]};
  const props={session:s,detail:d,...actions};
  const html=renderToStaticMarkup(<PropertyView data={{...data,rows:[],...propertyTotals([]),canInvite:false}} locale={s.locale} id="p" legacy={props}/>);
  const old=await legacyPage(s,d);
  assert.deepEqual(controls(html),controls(renderToStaticMarkup(old)));
  assert.doesNotMatch(html,/href="\/m\/owners\/owner"|href="\/m\/properties\/p\/edit"|checked=""/);
  const oldForms=elements(old).filter(e=>e.type==="form");
  const newForms=elements(PropertyLegacyControls(props)).filter(e=>e.type==="form");
  assert.equal(newForms.length,2); // Legacy checks native role for these forms.
  for(const form of oldForms)assert.equal(formMarkup(newForms.find(e=>e.props.action===form.props.action)!),formMarkup(form));
});
test("real phone checkbox belongs to a v3 label with a 44px hit area",()=>{
  for(const role of ["admin","manager"] as const){
    const tree=PropertyLegacyControls({session:{...session,role},detail,...actions});
    const wrapper=elements(tree).find(e=>e.type==="label" && elements(e.props.children as React.ReactNode).some(child=>child.type==="input" && child.props.name==="canView"));
    assert.ok(wrapper);
    assert.equal(wrapper.props.className,"small v3-property-phone-visibility");
    assert.match(renderToStaticMarkup(wrapper),/<input type="checkbox" name="canView" checked=""/);
    const css=readFileSync("public/brand/v3/property.css","utf8");
    assert.match(css,/html\[data-brand="v2"\]\[data-brand-v3\] \.v3-property \.v3-property-phone-visibility \{[^}]*display:inline-flex;[^}]*min-height:44px;[^}]*min-width:44px;/);
  }
});
test("zero-room units survive an empty rentable list with the real archive entry",async()=>{
  const d={...detail,rooms:[],wholes:[],byRoomUnits:[detail.byRoomUnits[1]]};
  for(const role of ["admin","manager","accountant"] as const){
    const s={...session,role};
    const html=renderToStaticMarkup(await v3Page(s,d,{...data,rows:[],...propertyTotals([])}));
    const old=renderToStaticMarkup(await legacyPage(s,d));
    assert.deepEqual(controls(html),controls(old));
    assert.deepEqual(sections(html),sections(old));
    assert.match(html,/data-testid="by-room-unit"/);
    assert.match(html,/href="\/m\/archive\/unit\/zero-room-unit"/);
    assert.ok(html.includes(d.byRoomUnits[0].label));
  }
});
test("legacy room and whole-unit rents keep currency formatting for every role",async()=>{
  const whole=propertyRoomState({...row,id:"whole",unitId:"whole",kind:"whole_unit",label:"Whole",unitLabel:"Whole"});
  for(const currency of ["TWD","USD","JPY"])for(const locale of ["zh-TW","en"] as const)for(const role of ["admin","manager","accountant"] as const){
    const s={...session,locale,role};
    const d={...detail,property:{...detail.property,currency},rooms:[{...detail.rooms[0],base_rent_minor:"123456"}],wholes:[{id:"whole",label:"Whole",base_rent_minor:"987654"}]};
    const html=renderToStaticMarkup(await v3Page(s,d,{...data,rows:[row,whole],...propertyTotals([row,whole])}));
    const old=renderToStaticMarkup(await legacyPage(s,d));
    assert.ok(html.includes(d.property.address_display));
    for(const saved of [...d.rooms,...d.wholes]){
      const rent=moneyLabel(Number(saved.base_rent_minor),currency,locale);
      assert.ok(old.includes(rent));assert.ok(html.includes(rent));
    }
  }
});
test("unavailable and forbidden views cannot expose supplied legacy controls",()=>{
  for(const state of ["forbidden","off","unavailable"] as const){
    const html=renderToStaticMarkup(<PropertyView data={{state}} locale={session.locale} id="p" legacy={{session,detail,...actions}}/>);
    assert.doesNotMatch(html,/<form|href="\/m\/(?:leases|owners|tickets)|href="\/m\/properties\/p\/edit"/);
    assert.ok(!html.includes(detail.owner!.name));
  }
});
test("missing owner, lease, meter and repairs preserve legacy empty controls",async()=>{
  const d={...detail,owner:null,meterSerial:null,repairs:[],rooms:[{...detail.rooms[0],lease_id:null,tenant:null}]};
  const props={session,detail:d,...actions};
  const html=renderToStaticMarkup(<PropertyView data={data} locale={session.locale} id="p" legacy={props}/>);
  assert.deepEqual(controls(html),controls(renderToStaticMarkup(await legacyPage(session,d))));
  assert.doesNotMatch(html,/name="propertyOwnerId"|href="\/m\/leases\/lease"/);
  assert.match(html,/data-testid="meter-number-prompt"/);
  assert.ok(html.includes(makeT(session.locale)("i_repair_none")));
  const forms=elements(PropertyLegacyControls(props)).filter(e=>e.type==="form");
  assert.deepEqual(forms.map(e=>e.props.action),[actions.actionSetMeter]);
});
test("v3 wrapper wires the existing reader/actions and preserves action error query",async()=>{
  let reads=0;
  const query={error:"forbidden",created:"1",audit:"previous cursor"};
  const loaded=loadRoute("src/components/v3/m/properties/page.tsx",{
    "next/navigation":{notFound:()=>assert.fail("Unexpected not found")},
    "../../../../server/b3-property":{brandProperty:async()=>data},
    "../../../../server/b040-staff-ui":{staffInviteVisible:async()=>false},
    "../../../../server/errors":{FlowError:Error,logServerError:()=>assert.fail("Unexpected error")},
    "../../../../server/queries":{propertyDetail:async(s:typeof session,id:string)=>{assert.equal(s,session);assert.equal(id,"p");reads++;return detail;}},
    "../../../../server/actions":actions,"./property":{PropertyView},
    "../../../audit-log":{AuditHistory:()=> <div data-testid="audit-slot"/>},
  });
  const node=await (loaded.PropertyV3Page as (props:unknown)=>Promise<React.ReactElement<React.ComponentProps<typeof PropertyView>>>)({session,id:"p",query});
  assert.equal(reads,1);assert.equal(node.type,PropertyView);assert.equal(node.props.query,query);
  assert.equal(node.props.legacy?.actionSetMeter,actions.actionSetMeter);
  assert.equal(node.props.legacy?.actionPhoneVisibility,actions.actionPhoneVisibility);
  const html=renderToStaticMarkup(node);
  assert.match(html,/data-testid="error-banner"/);assert.match(html,/data-testid="property-created"/);
  assert.match(html,/data-testid="audit-slot"/);
  const audit=node.props.auditHistory as React.ReactElement<Record<string,unknown>>;
  assert.deepEqual({...audit.props,preserve:{...(audit.props.preserve as Record<string,unknown>)}},auditProps(query));
  const route=readFileSync("src/app/m/properties/[id]/page.tsx","utf8");
  assert.match(route,/<PropertyV3Page session=\{session\} id=\{id\} query=\{query\}/);
  const css=readFileSync("public/brand/v3/property.css","utf8");
  assert.match(css,/html\[data-brand="v2"\]\[data-brand-v3\] \.v3-property \.v3-property-legacy-forms \.btn \{ background:transparent; color:var\(--c-brand-ink\); border:1px solid var\(--c-border\); box-shadow:none; \}/);
});
test("whole-home fallback, collapsed completed tasks and literal user text",()=>{
  const whole=propertyRoomState({...row,kind:"whole_unit",label:"",tenantReady:true,leaseStatus:"active"});
  const html=render({...data,name:"<script>bad</script>",rows:[whole],...propertyTotals([whole])});
  assert.ok(html.includes(c.whole));assert.ok(html.includes(c.done));assert.doesNotMatch(html,/<details open|<script>/);assert.match(html,/&lt;script&gt;/);
});
test("responsive cards, token styling, focus and 44px targets; only existing gated invitations",()=>{
  const css=readFileSync("public/brand/v3/property.css","utf8");
  assert.match(css,/@media/);assert.match(css,/min-height:44px/);assert.match(css,/:focus-visible/);assert.match(css,/var\(--c-tint-soft\)/);assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b/i);
  const page=readFileSync("src/components/v3/m/properties/page.tsx","utf8");
  assert.match(page,/data.canInvite && await staffInviteVisible\(session\)/);
  assert.match(page,/staffInviteEntries\(session,targets\)/);
  assert.match(page,/r.kind==="whole_unit"/);
  assert.doesNotMatch(page,/issueInvite\(|mutateStaffInvite\(|fetch\(/);
});

test("R2-PROP: audit next/latest links sit in the 44px-scoped wrapper (Codex r2)", () => {
  const css = readFileSync("public/brand/v3/property.css", "utf8");
  assert.match(css, /\.v3-property :is\([^)]*\.v3-property-audit a[^)]*\)\s*\{[^}]*min-height:44px/);
  const tsx = readFileSync("src/components/v3/m/properties/property.tsx", "utf8");
  assert.match(tsx, /<div className="v3-property-audit">\{auditHistory\}<\/div>/);
});
