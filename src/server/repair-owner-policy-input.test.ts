import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {canonicalRepairMinor,isOwnerRepairResult,isOwnerRepairView,ownerRepairAmount,parseOwnerRepairAmount} from './repair-owner-policy-input';
import {readOwnerRepairRequest} from './repair-owner-policy-request';

test('exact major/minor conversion round-trips every supported scale and bigint boundary without rounding',()=>{
 for(let scale=0;scale<=4;scale++){for(const minor of ['0','1','500000','9223372036854775807'])assert.equal(parseOwnerRepairAmount(ownerRepairAmount(minor,scale),scale),minor);assert.equal(parseOwnerRepairAmount('1',scale),'1'+'0'.repeat(scale));}
 assert.equal(ownerRepairAmount('500000',2),'5000.00');assert.equal(ownerRepairAmount('1',4),'0.0001');assert.equal(parseOwnerRepairAmount('92233720368547758.07',2),'9223372036854775807');assert.equal(parseOwnerRepairAmount('92233720368547758.08',2),null);
});
test('blank, signs, grouping, exponent, whitespace, leading zero and excess precision have no implicit interpretation',()=>{
 for(const value of ['',' ',' 1','1 ','01','00','+1','-1','1,000','1e3','.5','1.','0.001','1\n','1_000','NaN','Infinity'])assert.equal(parseOwnerRepairAmount(value,2),null,value);
 assert.equal(parseOwnerRepairAmount('1.0',0),null);assert.equal(parseOwnerRepairAmount('1',-1),null);assert.equal(parseOwnerRepairAmount('1',5),null);assert.equal(parseOwnerRepairAmount('1',1.5),null);assert.equal(canonicalRepairMinor('9223372036854775808'),false);
});
test('response schemas require exact scope/request, canonical integer strings and typed source metadata',()=>{
 const propertyId=randomUUID(),requestId=randomUUID(),view={state:'enabled',propertyId,ownershipId:randomUUID(),currency:'TWD',minorUnit:2,defaultMinor:'500000',defaultSource:'regional_default',overrideMinor:null,effectiveMinor:'500000',effectiveSource:'regional_default',verified:true,snapshot:'a'.repeat(64)};
 assert.equal(isOwnerRepairView(view,propertyId),true);for(const change of [{propertyId:randomUUID()},{minorUnit:5},{defaultMinor:500000},{defaultMinor:'05'},{currency:'twd'},{effectiveSource:'invented'},{ownershipId:'-'.repeat(36)},{actorId:randomUUID()}])assert.equal(isOwnerRepairView({...view,...change},propertyId),false);
 const result={status:'recorded',request_id:requestId,outcome:'changed',recorded_at:'2026-10-30T07:00:00Z'};assert.equal(isOwnerRepairResult(result,requestId),true);assert.equal(isOwnerRepairResult(result,randomUUID()),false);assert.equal(isOwnerRepairResult({...result,outcome:'delivered'},requestId),false);assert.equal(isOwnerRepairResult({...result,raw:'bad'},requestId),false);assert.equal(isOwnerRepairResult({status:'busy'},requestId),true);
});
const propertyId=randomUUID(),requestId=randomUUID();
function request(body:unknown,headers:Record<string,string>={}){return new Request('http://localhost:43127/api/owner-repair-policy',{method:'POST',headers:{host:'localhost:43127',origin:'http://localhost:43127','content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});}
test('strict same-origin parser accepts only exact view/change/status/close envelopes',async()=>{
 for(const body of [{mode:'view',propertyId},{mode:'status',propertyId,requestId},{mode:'close',propertyId,requestId},{mode:'change',propertyId,requestId,expected:'a'.repeat(64),action:'set',value:'500000'}])assert.equal((await readOwnerRepairRequest(request(body))).ok,true);
 for(const extra of [{actorId:randomUUID()},{orgId:randomUUID()},{sessionId:randomUUID()},{currency:'USD'},{value:'1'}])assert.equal((await readOwnerRepairRequest(request({mode:'status',propertyId,requestId,...extra}))).ok,false);
 for(const body of [[],null,{}, {mode:'view',propertyId:'bad'},{mode:'change',propertyId,requestId,expected:'bad',action:'set',value:'1'},{mode:'change',propertyId,requestId,expected:'a'.repeat(64),action:'other',value:'1'}])assert.equal((await readOwnerRepairRequest(request(body))).ok,false);
});
test('cross-origin and missing origin are denied before reading body',async()=>{
 for(const origin of ['http://evil.test','null','http://localhost:43127/','http://user@localhost:43127'])assert.deepEqual(await readOwnerRepairRequest(request({mode:'view',propertyId},{origin})),{ok:false,status:403});assert.deepEqual(await readOwnerRepairRequest(request({mode:'view',propertyId},{'sec-fetch-site':'cross-site'})),{ok:false,status:403});const missing=request({mode:'view',propertyId});missing.headers.delete('origin');assert.deepEqual(await readOwnerRepairRequest(missing),{ok:false,status:403});
});
test('content length and actual UTF-8 bytes are bounded independently, with malformed bytes denied',async()=>{
 assert.deepEqual(await readOwnerRepairRequest(request({mode:'view',propertyId},{'content-length':'4097'})),{ok:false,status:413});assert.deepEqual(await readOwnerRepairRequest(request('中'.repeat(1500))),{ok:false,status:413});assert.deepEqual(await readOwnerRepairRequest(request('{')), {ok:false,status:400});assert.deepEqual(await readOwnerRepairRequest(request({mode:'view',propertyId},{'content-type':'text/plain'})),{ok:false,status:400});
 const invalid=new Request('http://localhost:43127/api/owner-repair-policy',{method:'POST',headers:{host:'localhost:43127',origin:'http://localhost:43127','content-type':'application/json'},body:new Uint8Array([0xff])});assert.deepEqual(await readOwnerRepairRequest(invalid),{ok:false,status:400});
});
