import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { brandTenants, TENANTS_ADMISSION_SQL as ADMIT, TENANTS_SUMMARY_SQL as SUMMARY, TENANTS_LIST_SQL as LIST } from "./b3-tenants";
import type { tx } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";
const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const session:Session = {userId:id(1),sessionId:id(2),orgId:id(3),liveOrgId:id(3),environment:"live",kind:"staff",role:"manager",locale:"en",calendar:"gregorian",leaseId:null,name:"Synthetic",email:""};
const on = {v3:async()=>true};
const saved=process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
test.before(()=>{process.env.CUSTOM_ROLES_ORG_ALLOWLIST="";});
test.after(()=>{if(saved===undefined) delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;else process.env.CUSTOM_ROLES_ORG_ALLOWLIST=saved;});
const denied=(e:unknown)=>e instanceof FlowError && e.key==="errors.forbidden";
const never:typeof tx=async()=>{assert.fail("Unexpected transaction");};
function mock(handler:(sql:string,args:unknown[])=>unknown[],role="manager",valid=true,mobileRequired: boolean | null=true):typeof tx {
  return async (user,fn,scope,options)=>{
    assert.equal(user,session.userId); assert.deepEqual(scope,{orgId:session.orgId,environment:"live"});
    assert.deepEqual(options,{isolation:"repeatable read",readOnly:true});
    let first=true;
    return fn({query:async(sql:string,args:unknown[]=[])=>{
      if(first){first=false;assert.equal(sql,"SET LOCAL statement_timeout = '2s'");return {rows:[]};}
      if(sql===ADMIT) return {rows:valid?[{role,directory:true,...(mobileRequired===null?{}:{mobileRequired})}]:[]};
      return {rows:handler(sql,args)};
    }} as unknown as Client);
  };
}
const row=(n:number)=>({id:id(n),name:`Person ${n}`,place:"Unit",phone:"+19995550123",duplicateName:"Other tenant",lineLinked:false});
const summary={total:103,missing:3,filteredCount:101};
test("OFF avoids data and permission work; lookup error becomes unavailable",async()=>{
  assert.deepEqual(await brandTenants({...session,kind:"tenant"},{filter:"invalid"},{v3:async()=>false,transaction:never}),{state:"off"});
  assert.deepEqual(await brandTenants(session,{}, {v3:async()=>{throw Error("synthetic");},transaction:never}),{state:"unavailable"});
});
test("existing props.view permission rejects maintenance, portals and anonymous role",async()=>{
  for(const s of [{...session,role:"maintenance" as const},{...session,role:null},{...session,kind:"tenant" as const},{...session,kind:"owner" as const},{...session,needsSandbox:true}])
    await assert.rejects(brandTenants(s,{}, {...on,transaction:never}),denied);
});
test("uncapped counts, 50-row pages and scoped cursor",async()=>{
  const first=await brandTenants(session,{q:"Person"},{...on,transaction:mock((sql,args)=>{
    if(sql===SUMMARY)return [summary];assert.equal(sql,LIST);assert.deepEqual(args.slice(1),["%Person%",true,true,false,true,null,null,51]);
    return Array.from({length:51},(_,n)=>row(n+10));
  })});
  assert.equal(first.state,"ready");if(first.state!=="ready")assert.fail();
  assert.equal(first.total,103);assert.equal(first.missing,3);assert.equal(first.rows.length,50);assert.ok(first.nextCursor);
  assert.equal(first.rows[0].verified,false);assert.equal(first.rows[0].staffUpdated,true);
  const second=await brandTenants(session,{q:"Person",cursor:first.nextCursor},{...on,transaction:mock((sql,args)=>{
    if(sql===SUMMARY)return [summary];assert.deepEqual(args.slice(6),["Person 59",id(59),51]);return [row(60)];
  })});
  assert.equal(second.state,"ready");if(second.state!=="ready")assert.fail();assert.equal(second.nextCursor,null);
  for(const changed of [{q:"other"},{q:"Person",filter:"missing"}]){
    assert.equal((await brandTenants(session,{...changed,cursor:first.nextCursor},{...on,transaction:mock(()=>assert.fail("cursor should fail before data"))})).state,"unavailable");
  }
});
test("actual accountant membership overrides forged role; DTO omits phone and its metadata",async()=>{
  const data=await brandTenants(session,{q:"+19995550123"},{...on,transaction:mock((sql,args)=>{
    assert.equal(args[3],false);
    return sql===SUMMARY?[{total:103,missing:null,filteredCount:0}]:[];
  },"accountant")});
  assert.equal(data.state,"ready");if(data.state!=="ready")assert.fail();assert.equal(data.canViewPhone,false);assert.equal(data.missing,null);
  const names=await brandTenants(session,{}, {...on,transaction:mock(sql=>sql===SUMMARY?[summary]:[row(10)],"accountant")});
  if(names.state!=="ready")assert.fail();assert.equal(names.missing,null);for(const key of ["phone","verified","staffUpdated","duplicateName"])assert.equal(key in names.rows[0],false);
  await assert.rejects(brandTenants(session,{filter:"missing"},{...on,transaction:mock(()=>assert.fail(),"accountant")}),denied);
});
test("invalid scope/session is forbidden; invalid filter and cursor are unavailable",async()=>{
  await assert.rejects(brandTenants(session,{}, {...on,transaction:mock(()=>assert.fail(),"manager",false)}),denied);
  assert.equal((await brandTenants(session,{filter:"oops"},{...on,transaction:never})).state,"unavailable");
  for(const cursor of ["bad", "!", "A".repeat(4097)]) assert.equal((await brandTenants(session,{cursor},{...on,transaction:mock(()=>assert.fail())})).state,"unavailable");
});
test("literal wildcard search and missing filter are bound before pagination",async()=>{
  await brandTenants(session,{q:"%_\\",filter:"missing"},{...on,transaction:mock((sql,args)=>{
    assert.equal(args[1],"%\\%\\_\\\\%");assert.equal(args[4],true);return sql===SUMMARY?[summary]:[];
  })});
  assert.match(LIST,/ORDER BY name,id LIMIT \$9/);assert.match(SUMMARY,/count\(\*\)::int FROM population/);
});
test("legacy branch stays byte-identical after removing the v3 gate; required PageProps; registered authority",()=>{
  const file="src/app/m/tenants/page.tsx";
  const originalHash="0451263189dcdc2bc4496f6f3d36b553a33c1d9b05013bd6d9d5d5667626a3d5"; // Pre-R2-TEN legacy page, frozen independently of HEAD.
  const current=readFileSync(file,"utf8");
  const stripped=current.replace(/^import \{ Suspense \}[^\n]*\nimport \{ brandV3EnabledForOrg \}[^\n]*\nimport \{ TenantsV3Page \}[^\n]*\nimport \{ TenantsLoading \}[^\n]*\n/,"")
    .replace("; filter?: string; cursor?: string","")
    .replace(/  if \(await brandV3EnabledForOrg\(session.orgId\)\) \{\n[\s\S]*?\n  \}\n/,"");
  assert.equal(createHash("sha256").update(stripped).digest("hex"),originalHash);assert.doesNotMatch(current,/searchParams[^\n]*=\s*\{/);
  const registry=JSON.parse(readFileSync("src/server/b017-entry-permissions.json","utf8"));
  assert.equal(registry["src/server/b3-tenants.ts#brandTenants"],"props.view");
});

test("mobile item OFF/absent ignores crafted missing URL, preserves phone, and omits item metadata",async()=>{
  for(const mobile of [false,null]) for(const role of ["manager","accountant"]){
    const transaction=mock((sql,args)=>{
      assert.equal(args[4],false);assert.equal(args[5],false);
      return sql===SUMMARY?[summary]:[row(10)];
    },role,true,mobile);
    const data=await brandTenants(session,{filter:"missing"},{...on,transaction});
    if(data.state!=="ready")assert.fail();
    assert.equal(data.mobileRequired,false);assert.equal(data.filter,"all");assert.equal(data.missing,null);
    assert.equal(data.rows[0].phone,role==="manager"?"+19995550123":undefined);
    for(const key of ["verified","staffUpdated","duplicateName"])assert.equal(key in data.rows[0],false);
  }
});
test("ON returns duplicate hint only with contact permission, from pre-filter org population",async()=>{
  const data=await brandTenants(session,{}, {...on,transaction:mock(sql=>sql===SUMMARY?[summary]:[row(10)])});
  if(data.state!=="ready")assert.fail();assert.equal(data.mobileRequired,true);assert.equal(data.rows[0].duplicateName,"Other tenant");
  // Same org, every unarchived tenant contact (not just the listed population), same normalised number (Codex r2).
  assert.match(LIST,/SELECT d.display_name FROM contacts d WHERE d.org_id=\$1 AND d.is_tenant AND d.archived_at IS NULL/);
  assert.match(LIST,/AND d.id<>f.id AND nullif\(btrim\(d.phone_e164\),''\)=f.phone/);
  assert.match(LIST,/ORDER BY d.display_name,d.id LIMIT 1/);
  assert.match(LIST,/WHERE c.org_id=\$1 AND c.is_tenant/);
});

test("cursor cannot carry mobile-gated state across an item toggle",async()=>{
  const first=await brandTenants(session,{}, {...on,transaction:mock(sql=>sql===SUMMARY?[summary]:Array.from({length:51},(_,n)=>row(n+10)))});
  if(first.state!=="ready" || !first.nextCursor)assert.fail();
  const off=await brandTenants(session,{cursor:first.nextCursor},{...on,transaction:mock(()=>assert.fail("changed gate must reject cursor before list query"),"manager",true,false)});
  assert.equal(off.state,"unavailable");
});
