import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { stableStringify } from "../idempotency";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});test.after(async()=>{if(clone)await clone.cleanup();});

test('experimental fixed SQL digest matches existing JS canonical command payload for representative valid strings',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  const cases=[
   {leaseId:'ABCDEF00-1111-4111-8111-111111111111',amount:1,paidOn:'2026-10-30',last5:'01234',reference:''},
   {leaseId:'abcdef00-1111-4111-8111-111111111111',amount:123456789,paidOn:'2026-10-30',last5:'00000',reference:'測試 "quoted" \\ slash\nline\t🙂'},
   {leaseId:'abcdef00-1111-4111-8111-111111111111',amount:Number.MAX_SAFE_INTEGER,paidOn:'2026-10-30',last5:'',reference:'\u2028\u2029 café'},
  ];
  for(const input of cases){
   const js=createHash('sha256').update(stableStringify(input)).digest('hex');
   const sql=(await c.query<{digest:string}>(`SELECT encode(public.digest(convert_to('{"amount":'||$2::bigint::text||',"last5":'||to_json($4::text)::text||',"leaseId":'||to_json($1::text)::text||',"paidOn":'||to_json($3::text)::text||',"reference":'||to_json($5::text)::text||'}','UTF8'),'sha256'),'hex') digest`,[input.leaseId,input.amount,input.paidOn,input.last5,input.reference])).rows[0].digest;
   assert.equal(sql,js);
  }
 } finally {await c.end();}
});

test('isolated surrogate illustrates SQL text transport cannot blindly reproduce every JS string digest',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  const input={leaseId:'abcdef00-1111-4111-8111-111111111111',amount:1,paidOn:'2026-10-30',last5:'',reference:'\ud800'};
  const js=createHash('sha256').update(stableStringify(input)).digest('hex');
  const sql=(await c.query<{digest:string}>(`SELECT encode(public.digest(convert_to('{"amount":'||$2::bigint::text||',"last5":'||to_json($4::text)::text||',"leaseId":'||to_json($1::text)::text||',"paidOn":'||to_json($3::text)::text||',"reference":'||to_json($5::text)::text||'}','UTF8'),'sha256'),'hex') digest`,[input.leaseId,input.amount,input.paidOn,input.last5,input.reference])).rows[0].digest;
  assert.notEqual(sql,js);
 } finally {await c.end();}
});
