import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeUnknownV2 } from "./settlement-v2-unknown";
const leaseId=randomUUID(),key=randomUUID(),evidenceId=randomUUID();
const input={leaseId,attributionIds:[],items:[{key,label:"Synthetic",reason:"Evidence",amountMinor:100,evidenceId,invoiceLineId:null}]};
test("complete UNKNOWN is deterministic, order independent and never authoritative",()=>{
 const source={verifiedCandidate:false as const,reason:"rent_period_unknown",fingerprint:"a".repeat(64)},a=encodeUnknownV2(input,source,{b:2,a:1}),b=encodeUnknownV2({...input,items:[{...input.items[0],reason:" Evidence "}]},source,{a:1,b:2});
 assert.equal(a.state,"unknown");assert.deepEqual(a,b);if(a.state==="unknown"){assert.equal(a.calculation.authoritative,false);assert.equal(a.calculation.netMinor,null);assert.notEqual(a.fingerprint,encodeUnknownV2(input,source,{a:1,b:3}).state==="unknown"?(encodeUnknownV2(input,source,{a:1,b:3}) as {fingerprint:string}).fingerprint:"");}
});
test("incomplete or malformed source never gets a fingerprint",()=>{
 assert.deepEqual(encodeUnknownV2(input,{verifiedCandidate:false,reason:"source_changed"},[]),{state:"unavailable"});
 assert.deepEqual(encodeUnknownV2(input,{verifiedCandidate:false,reason:"capacity"},[]),{state:"unavailable"});
 assert.deepEqual(encodeUnknownV2(input,{verifiedCandidate:false,reason:"bad",fingerprint:"bad"},[]),{state:"unavailable"});
 assert.deepEqual(encodeUnknownV2(input,{verifiedCandidate:false,reason:"capacity",fingerprint:"a".repeat(64)},[]),{state:"unavailable"});
});
test("a complete positive candidate still produces UNKNOWN, not publication authority",()=>{
 const result=encodeUnknownV2(input,{verifiedCandidate:true,fingerprint:"b".repeat(64)},[]);assert.equal(result.state,"unknown");if(result.state==="unknown")assert.deepEqual(result.calculation,{authoritative:false,netMinor:null});
});

test("invalid JSON values and missing line identity are rejected",()=>{
 const source={verifiedCandidate:false as const,reason:"unsupported",fingerprint:"a".repeat(64)};
 for(const value of [NaN,Infinity,undefined,new Date(),Array(1)])assert.throws(()=>encodeUnknownV2(input,source,value as never),TypeError);
 const sparse=Array(1);Object.defineProperty(sparse,"x",{value:1,enumerable:true});assert.throws(()=>encodeUnknownV2(input,source,sparse),TypeError);
 const missing={...input,items:[{...input.items[0],invoiceLineId:undefined}]};assert.throws(()=>encodeUnknownV2(missing as never,source,[]),TypeError);
});
