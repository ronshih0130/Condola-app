import assert from 'node:assert/strict';
import test from 'node:test';
import {NextRequest} from 'next/server';
import {sameOriginMutation} from './request-origin';
function request(url='https://app.example.test/api/local',headers:Record<string,string>={}){const target=new URL(url);return new Request(url,{method:'POST',headers:{origin:target.origin,host:target.host,...headers}});}
test('exact origin and consistent Host accept canonical DNS, ports and ordinary URL normalization',()=>{
 assert.equal(sameOriginMutation(request()),true);assert.equal(sameOriginMutation(request(undefined,{'sec-fetch-site':'same-origin'})),true);assert.equal(sameOriginMutation(request('http://localhost:43129/api/local')),true);assert.equal(sameOriginMutation(request('https://app.example.test/api/local',{host:'APP.EXAMPLE.TEST:443'})),true);assert.equal(sameOriginMutation(request('http://127.0.0.1:43129/api/local')),true,'ordinary unnormalized Request has an internally consistent IP origin');
});
test('installed Next loopback URL normalization cannot authorize the other transport Host',()=>{
 const alias=new NextRequest('http://127.0.0.1:43129/api/local',{method:'POST',headers:{origin:'http://localhost:43129',host:'127.0.0.1:43129'}});assert.equal(new URL(alias.url).hostname,'localhost','records the installed Next behavior');assert.equal(alias.headers.get('host'),'127.0.0.1:43129');assert.equal(sameOriginMutation(alias),false);
 const ipv6=new NextRequest('http://[::1]:43129/api/local',{method:'POST',headers:{origin:'http://localhost:43129',host:'[::1]:43129'}});assert.equal(sameOriginMutation(ipv6),false);
 const canonical=new NextRequest('http://localhost:43129/api/local',{method:'POST',headers:{origin:'http://localhost:43129',host:'localhost:43129'}});assert.equal(sameOriginMutation(canonical),true);
});
test('missing Host and Origin, cross-site signals and noncanonical origin are denied',()=>{
 const credentialTarget={url:'https://user:synthetic@app.example.test/api/local',headers:new Headers({origin:'https://app.example.test',host:'app.example.test'})} as unknown as Request;assert.equal(sameOriginMutation(credentialTarget),false);
 for(const field of ['origin','host']){const r=request();r.headers.delete(field);assert.equal(sameOriginMutation(r),false);}
 for(const origin of ['null','https://evil.test','https://app.example.test/','https://user@app.example.test','http://app.example.test','https://app.example.test:444','https://app.example.test, https://evil.test'])assert.equal(sameOriginMutation(request(undefined,{origin})),false,origin);
 for(const site of ['same-site','cross-site','none'])assert.equal(sameOriginMutation(request(undefined,{'sec-fetch-site':site})),false);
});
test('malformed or visibly ambiguous Host representation never supplies replacement authority',()=>{
 for(const host of ['evil.test','app.example.test:444','app.example.test, evil.test','user@app.example.test','app.example.test/','app.example.test\\evil','app.example.test?x','app.example.test#x','[bad','app.example.test:99999'])assert.equal(sameOriginMutation(request(undefined,{host})),false,host);
 // Request Headers may trim/reject raw controls. This exercises representations
 // supplied by an adapter; it does not claim access to discarded wire bytes.
 for(const host of [' app.example.test','app.example.test ','app.example.test\t','app.example.test\u0000']){const r={url:'https://app.example.test/api/local',headers:{get:(name:string)=>name==='host'?host:name==='origin'?'https://app.example.test':null}} as unknown as Request;assert.equal(sameOriginMutation(r),false);}
});
test('forwarded headers do not rescue mismatching Host, origin or protocol in this helper',()=>{
 assert.equal(sameOriginMutation(request(undefined,{host:'evil.test','x-forwarded-host':'app.example.test','forwarded':'host=app.example.test;proto=https'})),false);
 assert.equal(sameOriginMutation(request('http://localhost:43129/api/local',{origin:'https://localhost:43129','x-forwarded-proto':'https','x-forwarded-host':'localhost:43129'})),false);
 assert.equal(sameOriginMutation(request(undefined,{origin:'https://evil.test','x-forwarded-host':'evil.test'})),false);
});
