import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import { brandTenantOne, TENANT_ONE_CONTACT_SQL as CONTACT, TENANT_ONE_LEASES_SQL as LEASES } from "./b3-tenant-one";
import { TENANTS_ADMISSION_SQL as ADMIT } from "./b3-tenants";
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
const contact={id:id(4),name:"Synthetic tenant",phone:"+19995550123",email:"tenant@example.test",lineLinked:true};
const lease={id:id(5),place:"Synthetic unit",status:"active",endDate:"2031-01-01"};
function mock(handler:(sql:string,args:unknown[])=>unknown[],role="manager",mobileRequired: boolean | null=true,directory=true):typeof tx {
  return async (user,fn,scope,options)=>{
    assert.equal(user,session.userId);assert.deepEqual(scope,{orgId:session.orgId,environment:"live"});
    assert.deepEqual(options,{isolation:"repeatable read",readOnly:true});
    let first=true;
    return fn({query:async(sql:string,args:unknown[]=[])=>{
      if(first){first=false;assert.equal(sql,"SET LOCAL statement_timeout = '2s'");return {rows:[]};}
      if(sql===ADMIT){assert.deepEqual(args,[session.orgId,session.sessionId,session.userId,"live",session.liveOrgId]);return {rows:role?[{role,directory,...(mobileRequired===null?{}:{mobileRequired})}]:[]};}
      return {rows:handler(sql,args)};
    }} as unknown as Client);
  };
}
test("brand OFF returns before permissions/SQL; bad lookup is unavailable",async()=>{
  assert.deepEqual(await brandTenantOne({...session,kind:"tenant"},"bad",{v3:async()=>false,transaction:never}),{state:"off"});
  assert.deepEqual(await brandTenantOne(session,id(4),{v3:async()=>{throw Error("synthetic");},transaction:never}),{state:"unavailable"});
});
test("admin/manager read admitted org in one read-only snapshot; no adapter invocation",async()=>{
  const fetchMock=test.mock.method(globalThis,"fetch",async()=>{assert.fail("No outbound allowed");});
  try {
    for(const role of ["admin","manager"] as const){
      const result=await brandTenantOne({...session,role},id(4),{...on,transaction:mock((sql,args)=>{
        assert.deepEqual(args,[session.orgId,id(4),true]);return sql===CONTACT?[contact]:[lease];
      },role)});
      assert.deepEqual(result,{state:"ready",...contact,canViewContact:true,mobileRequired:true,legacyPhoneNotice:true,phoneHistory:true,leases:[lease]});
    }
    assert.equal(fetchMock.mock.callCount(),0);
  } finally { fetchMock.mock.restore(); }
});
test("actual accountant membership omits all contact fields even if session claims admin",async()=>{
  const result=await brandTenantOne({...session,role:"admin"},id(4),{...on,transaction:mock((sql,args)=>{
    if(sql===CONTACT){assert.equal(args[2],false);return [contact];}return [];
  },"accountant")});
  if(result.state!=="ready")assert.fail();assert.equal(result.canViewContact,false);
  for(const key of ["phone","email","legacyPhoneNotice","verified","source","pendingChange","phoneHistory"])assert.equal(key in result,false);
});
test("B-076a: 「查看改號紀錄」 only for native admin/manager with contact access while tenant_directory_edit is on",async()=>{
  const read=(role:string,directory:boolean)=>brandTenantOne({...session,role:"manager"},id(4),{...on,transaction:mock(sql=>sql===CONTACT?[contact]:[],role,true,directory)});
  for(const role of ["admin","manager"]){const on1=await read(role,true);if(on1.state!=="ready")assert.fail();assert.equal(on1.phoneHistory,true);
    const off=await read(role,false);if(off.state!=="ready")assert.fail();assert.equal("phoneHistory" in off,false);}
  const acc=await read("accountant",true);if(acc.state!=="ready")assert.fail();assert.equal("phoneHistory" in acc,false);
});
test("maintenance, portals, anon role and sandbox-required sessions cannot read",async()=>{
  for(const s of [{...session,role:"maintenance" as const},{...session,role:null},{...session,kind:"tenant" as const},
    {...session,kind:"owner" as const},{...session,needsSandbox:true}])
    await assert.rejects(brandTenantOne(s,id(4),{...on,transaction:never}),denied);
  await assert.rejects(brandTenantOne(session,id(4),{...on,transaction:mock(()=>assert.fail(),"")}),denied);
});
test("item OFF/absent retains permitted number but omits assumed verification/source notice",async()=>{
  for(const mobile of [false,null]){
    const result=await brandTenantOne(session,id(4),{...on,transaction:mock(sql=>sql===CONTACT?[contact]:[],"manager",mobile)});
    if(result.state!=="ready")assert.fail();assert.equal(result.phone,contact.phone);assert.equal(result.mobileRequired,false);assert.equal("legacyPhoneNotice" in result,false);
  }
  const missing=await brandTenantOne(session,id(4),{...on,transaction:mock(sql=>sql===CONTACT?[{...contact,phone:null}]:[])});
  if(missing.state!=="ready")assert.fail();assert.equal("legacyPhoneNotice" in missing,false);
});
test("missing/malformed contact, empty history and directory population",async()=>{
  assert.deepEqual(await brandTenantOne(session,"bad",{...on,transaction:never}),{state:"not_found"});
  assert.deepEqual(await brandTenantOne(session,id(4),{...on,transaction:mock(sql=>{assert.equal(sql,CONTACT);return [];})}),{state:"not_found"});
  for(const directory of [true,false]){
    const result=await brandTenantOne(session,id(4),{...on,transaction:mock((sql,args)=>{
      if(sql===CONTACT)return [contact];assert.equal(sql,LEASES);assert.equal(args[2],directory);return [];
    },"manager",true,directory)});
    if(result.state!=="ready")assert.fail();assert.deepEqual(result.leases,[]);
  }
});
test("no fabricated pending-change state or action imports while MGT-76 is absent",async()=>{
  const result=await brandTenantOne(session,id(4),{...on,transaction:mock(sql=>sql===CONTACT?[{...contact,pendingChange:{phone:"secret"},verified:true}]:[])});
  assert.doesNotMatch(JSON.stringify(result),/pendingChange|secret|verified/);
  for(const file of ["src/server/b3-tenant-one.ts","src/components/v3/m/tenants/tenant-one.tsx","src/components/v3/m/tenants/tenant-one-page.tsx"]){
    const source=readFileSync(file,"utf8");
    assert.doesNotMatch(source,/^import .*?(?:actions|adapter|sms|twilio|tenant-directory-edit)/m);
    assert.doesNotMatch(source,/fetch\(|sendSms\(|sendSMS\(|editDirectoryContact\(|["']use server["']/);
  }
});
test("OFF page bytes and reads preserved, required PageProps, authority and test registration",()=>{
  const source=readFileSync("src/app/m/tenants/[id]/page.tsx","utf8");
  const stripped=source.replace(/^import \{ Suspense \}[^\n]*\nimport \{ brandV3EnabledForOrg \}[^\n]*\nimport \{ TenantOneV3Page \}[^\n]*\nimport \{ TenantOneLoading \}[^\n]*\n/,"")
    .replace(/  if \(await brandV3EnabledForOrg\(session.orgId\)\) \{\n[\s\S]*?\n  \}\n/,"");
  assert.equal(createHash("sha256").update(stripped).digest("hex"),"425f42ca6a674084cb14684310821c65bdf220196c08e9937931cc9373050cb4");
  assert.match(source,/params: Promise</);assert.match(source,/searchParams: Promise</);assert.doesNotMatch(source,/searchParams\??[^\n]*=\s*\{/);
  assert.ok(source.indexOf("if (await brandV3EnabledForOrg")<source.indexOf("const directory="));
  const registry=JSON.parse(readFileSync("src/server/b017-entry-permissions.json","utf8"));
  assert.equal(registry["src/server/b3-tenant-one.ts#brandTenantOne"],"props.view");
  const pkg=JSON.parse(readFileSync("package.json","utf8"));
  for(const file of ["src/server/b3-tenant-one.test.ts","src/components/v3/m/tenants/tenant-one.test.tsx"])
    assert.ok(pkg.scripts["test:unit"].split("&&")[0].includes(file));
  assert.ok(pkg.scripts["test:rls"].split("&&").some((s:string)=>s.trim()==="tsx --test --test-concurrency=1 src/server/b3-tenant-one.integration.test.ts"));
});
