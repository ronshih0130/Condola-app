import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {readDirectoryEditRequest} from './tenant-directory-edit-request';
const input={mode:'edit',requestId:randomUUID(),contactId:randomUUID(),expected:'a'.repeat(64),name:'Synthetic',email:'example@example.test',phone:'+19995550123'};
function request(body:unknown=input,headers:Record<string,string>={}){return new Request('http://localhost:43123/api/tenant-directory/edit',{method:'POST',headers:{origin:'http://localhost:43123','content-type':'application/json',...headers},body:JSON.stringify(body)});}
test('explicit same-origin edit/status/close parse with no actor or org authority',async()=>{
 assert.deepEqual(await readDirectoryEditRequest(request()),{ok:true,input});
 for(const mode of ['status','close']){const body={mode,requestId:input.requestId,contactId:input.contactId};assert.deepEqual(await readDirectoryEditRequest(request(body)),{ok:true,input:body});}
 for(const field of ['actor','role','orgId','sessionId','liveOrgId','environment'])assert.deepEqual(await readDirectoryEditRequest(request({...input,[field]:'forged'})),{ok:false,status:400});
});
test('cross-site, forged origins and proxy headers cannot authorize a command',async()=>{
 for(const origin of ['null','http://localhost:43123/','http://127.0.0.1:43123','http://localhost:43124','https://localhost:43123','http://user@localhost:43123','http://localhost:43123.evil.test'])assert.deepEqual(await readDirectoryEditRequest(request(input,{origin,'x-forwarded-host':'localhost:43123'})),{ok:false,status:403});
 for(const site of ['cross-site','same-site','none'])assert.deepEqual(await readDirectoryEditRequest(request(input,{'sec-fetch-site':site})),{ok:false,status:403});
});
test('bounded actual streamed bytes and strict body fields reject malformed or oversized input',async()=>{
 for(const body of [null,[],{}, {...input,mode:'anything'}, {...input,contactId:'invalid'}, {...input,requestId:null},{...input,name:'x'.repeat(1025)}])assert.deepEqual(await readDirectoryEditRequest(request(body)),{ok:false,status:400});
 assert.deepEqual(await readDirectoryEditRequest(request(input,{'content-type':'text/plain'})),{ok:false,status:400});assert.deepEqual(await readDirectoryEditRequest(request(input,{'content-length':'4097'})),{ok:false,status:413});
 const streamed=new Request('http://localhost:43123/api/tenant-directory/edit',{method:'POST',headers:{origin:'http://localhost:43123','content-type':'application/json'},body:' '.repeat(4097)});assert.deepEqual(await readDirectoryEditRequest(streamed),{ok:false,status:413});
 const invalid=new Request('http://localhost:43123/api/tenant-directory/edit',{method:'POST',headers:{origin:'http://localhost:43123','content-type':'application/json'},body:new Uint8Array([255])});assert.deepEqual(await readDirectoryEditRequest(invalid),{ok:false,status:400});
});
