import assert from "node:assert/strict";
import test,{mock} from "node:test";
import { Client } from "pg";
import nextHeaders from "next/headers";
import { createV2UnknownDraftAction,previewV2UnknownAction,saveV2UnknownAction,resolveV2StatementAction } from "./settlement-v2-actions";
const user="11111111-1111-4111-8111-111111111111",org="22222222-2222-4222-8222-222222222222",sid="33333333-3333-4333-8333-333333333333",lease="44444444-4444-4444-8444-444444444444",request="55555555-5555-4555-8555-555555555555";
test("v2 actions stop at the actual stale-consent gate before settlement work",async()=>{
 const queries:string[]=[],observed:string[]=[];let consent:Record<string,string>|null=null;
 mock.method(nextHeaders,"cookies",async()=>({get:(name:string)=>name==="condola_session"?{value:"synthetic-local-session"}:name==="condola_env"?{value:"live"}:undefined}));
 mock.method(nextHeaders,"headers",async()=>new Headers({"x-pathname":"/m/settlement"}));mock.method(Client.prototype,"connect",async()=>{});mock.method(Client.prototype,"end",async()=>{});
 mock.method(Client.prototype,"query",async(sql:string)=>{queries.push(sql);if(sql.includes("FROM auth_sessions s")){observed.push(consent?.terms_version??"missing");return {rows:[{session_id:sid,user_id:user,name:"Synthetic",email:"synthetic@example.invalid",consent}]};}if(sql.includes("UPDATE auth_sessions"))return {rows:[]};if(sql.includes("FROM org_members m"))return {rows:[{org_id:org,role:"admin",live_enabled:true,has_live_data:true}]};if(sql.includes("design_partner_consent_gate"))return {rows:[]};throw new Error("Unexpected data operation before consent");});
 try{const input={leaseId:lease,attributionIds:[],items:[]};for(const state of [null,{accepted_at:"2020-01-01T00:00:00.000Z",terms_version:"outdated",privacy_version:"outdated",source:"reconsent"}]){consent=state;for(const call of [()=>createV2UnknownDraftAction(lease,null,request),()=>previewV2UnknownAction(input),()=>saveV2UnknownAction(input,"a".repeat(64),null,request,false),()=>resolveV2StatementAction(lease,request,true),()=>resolveV2StatementAction(lease,request,false)])await assert.rejects(call(),(error:unknown)=>typeof(error as {digest?:unknown}).digest==="string"&&String((error as {digest:string}).digest).includes("NEXT_REDIRECT")&&String((error as {digest:string}).digest).includes("/consent"));}assert.equal(observed.filter(value=>value==="missing").length,5);assert.equal(observed.filter(value=>value==="outdated").length,5);assert.ok(queries.length>0);assert.equal(queries.some(sql=>sql.includes("settlement_versions")||sql.includes("settlement_pin_source")||sql.includes("ledger_transactions")),false);}
 finally{mock.restoreAll();}
});
