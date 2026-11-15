import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { brandProperty, PROPERTY_ADMISSION_SQL as ADMIT, PROPERTY_SQL as PROPERTY, PROPERTY_ROOMS_SQL as ROOMS } from "./b3-property";
import { propertyRoomState, propertyTotals, type PropertyRoomFacts } from "./b3-property-rules";
import type { tx } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const session:Session={userId:id(1),sessionId:id(2),orgId:id(3),liveOrgId:id(3),environment:"live",kind:"staff",role:"manager",locale:"en",calendar:"gregorian",leaseId:null,name:"Synthetic",email:""};
const saved=process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(()=>{process.env.CUSTOM_ROLES_ORG_ALLOWLIST="";});
test.after(()=>{if(saved===undefined)delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;else process.env.CUSTOM_ROLES_ORG_ALLOWLIST=saved;});
const on={v3:async()=>true};
const never:typeof tx=async()=>{assert.fail("Unexpected transaction");};
const denied=(e:unknown)=>e instanceof FlowError && e.key==="errors.forbidden";
const facts:PropertyRoomFacts={id:id(4),unitId:id(5),kind:"room",label:"A",unitLabel:"U",roomType:null,addressReady:false,ownerReady:false,moneyReady:false,tenantReady:false,leaseStatus:null};
function mock(rows:PropertyRoomFacts[]=[],role="manager",property:unknown={id:id(6),name:"Synthetic",archived:false}):typeof tx {
  return async(user,fn,scope,options)=>{
    assert.equal(user,session.userId);assert.deepEqual(scope,{orgId:session.orgId,environment:"live"});
    assert.deepEqual(options,{isolation:"repeatable read",readOnly:true});
    let first=true;
    return fn({query:async(sql:string,args:unknown[]=[])=>{
      if(first){first=false;assert.equal(sql,"SET LOCAL statement_timeout = '2s'");return {rows:[]};}
      if(sql===ADMIT){assert.deepEqual(args,[session.orgId,session.sessionId,session.userId,"live",session.liveOrgId]);return {rows:role?[{role}]:[]};}
      assert.deepEqual(args,[session.orgId,id(6)]);
      if(sql===PROPERTY)return {rows:property?[property]:[]};
      assert.equal(sql,ROOMS);return {rows};
    }} as unknown as Client);
  };
}
test("all six split-room pending tasks derive from facts; whole homes omit room type",()=>{
  assert.deepEqual(propertyRoomState(facts).pending,["roomType","tenant","address","owner","money","lease"]);
  assert.deepEqual(propertyRoomState({...facts,kind:"whole_unit"}).pending,["tenant","address","owner","money","lease"]);
  const ready=propertyRoomState({...facts,roomType:"suite",tenantReady:true,addressReady:true,ownerReady:true,moneyReady:true,leaseStatus:"active"});
  assert.deepEqual(ready.pending,[]);assert.deepEqual(ready.unknown,[]);assert.equal(ready.occupied,true);
  // Inherited or overridden money is complete only when explicitly proven.
  assert.deepEqual(propertyRoomState({...facts,moneyReady:true}).pending.filter(k=>k==="money"),[]);
  const unknown=propertyRoomState({...facts,tenantReady:null,moneyReady:null});
  assert.deepEqual(unknown.unknown,["tenant","money"]);assert.equal(unknown.pending.length,4);
});
test("uncapped totals, current occupancy parity and distinct room states",()=>{
  const rows=Array.from({length:125},(_,n)=>propertyRoomState({...facts,id:id(n+10),leaseStatus:n===0?"active":n===1?"pending_signature":n===2?"draft":null}));
  assert.deepEqual(propertyTotals(rows),{rooms:125,occupied:2,pending:747,unknown:0});
  assert.deepEqual(rows.slice(0,4).map(r=>r.status),["active","pending_signature","draft","vacant"]);
  assert.deepEqual(propertyTotals([]),{rooms:0,occupied:0,pending:0,unknown:0});
});
test("shared property/unit facts repeat in each affected room, not counted once or capped",()=>{
  const rows=Array.from({length:5},(_,n)=>propertyRoomState({...facts,id:id(n+10),roomType:"suite",tenantReady:true,moneyReady:true,leaseStatus:"active"}));
  assert.deepEqual(propertyTotals(rows),{rooms:5,occupied:5,pending:10,unknown:0});
});
test("flag OFF returns before data/permission work; lookup/SQL failures are unavailable",async()=>{
  assert.deepEqual(await brandProperty({...session,kind:"tenant"},"bad",{v3:async()=>false,transaction:never}),{state:"off"});
  assert.deepEqual(await brandProperty(session,id(6),{v3:async()=>{throw Error("synthetic");},transaction:never}),{state:"unavailable"});
  assert.deepEqual(await brandProperty(session,id(6),{...on,transaction:async()=>{throw Error("synthetic timeout");}}),{state:"unavailable"});
});
test("reader remains org-scoped read-only and uses actual membership to suppress accountant controls",async()=>{
  const outbound=test.mock.method(globalThis,"fetch",async()=>{assert.fail("No outbound");});
  try{
    for(const role of ["admin","manager","accountant"]){
      const result=await brandProperty(session,id(6),{...on,transaction:mock([facts],role)});
      if(result.state!=="ready")assert.fail();assert.equal(result.canInvite,role!=="accountant");
      assert.equal(result.rooms,1);assert.equal(result.pending,6);
    }
    const archived=await brandProperty(session,id(6),{...on,transaction:mock([facts],"manager",{id:id(6),name:"Archive",archived:true})});
    if(archived.state!=="ready")assert.fail();assert.equal(archived.canInvite,false);
    assert.equal(outbound.mock.callCount(),0);
  }finally{outbound.mock.restore();}
});
test("original page permission, invalid identity and missing resources",async()=>{
  for(const s of [{...session,role:"maintenance" as const},{...session,role:null},{...session,kind:"tenant" as const},{...session,kind:"owner" as const},{...session,needsSandbox:true}])
    await assert.rejects(brandProperty(s,id(6),{...on,transaction:never}),denied);
  await assert.rejects(brandProperty(session,id(6),{...on,transaction:mock([],"")}),denied);
  assert.deepEqual(await brandProperty(session,"bad",{...on,transaction:never}),{state:"not_found"});
  assert.deepEqual(await brandProperty(session,id(6),{...on,transaction:mock([],"manager",null)}),{state:"not_found"});
});
test("OFF route bytes/reads preserved; required Next PageProps and registry/test registration",()=>{
  const source=readFileSync("src/app/m/properties/[id]/page.tsx","utf8");
  const stripped=source.replace(/^import \{ Suspense \}[^\n]*\nimport \{ brandV3EnabledForOrg \}[^\n]*\nimport \{ PropertyV3Page \}[^\n]*\nimport \{ PropertyLoading \}[^\n]*\n/,"")
    .replace(/  if \(await brandV3EnabledForOrg\(session.orgId\)\) \{\n[\s\S]*?\n  \}\n/,"");
  assert.equal(createHash("sha256").update(stripped).digest("hex"),"2e82d9f9ccf5332064f3e4345d840eadaf7f757f663b67cf3234ebb640927e65");
  assert.match(source,/params: Promise</);assert.match(source,/searchParams: Promise</);assert.doesNotMatch(source,/searchParams\??[^\n]*=\s*\{/);
  assert.ok(source.indexOf("if (await brandV3EnabledForOrg")<source.indexOf("const detail = await propertyDetail"));
  assert.equal(JSON.parse(readFileSync("src/server/b017-entry-permissions.json","utf8"))["src/server/b3-property.ts#brandProperty"],"props.view");
  const pkg=JSON.parse(readFileSync("package.json","utf8"));
  for(const file of ["src/server/b3-property.test.ts","src/components/v3/m/properties/property.test.tsx"])
    assert.ok(pkg.scripts["test:unit"].split("&&")[0].includes(file));
  assert.ok(pkg.scripts["test:rls"].split("&&").some((s:string)=>s.trim()==="tsx --test --test-concurrency=1 src/server/b3-property.integration.test.ts"));
});
