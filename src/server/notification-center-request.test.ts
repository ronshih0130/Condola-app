import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readMarkRequest } from "./notification-center-request";
import { newVendorToken } from "./vendor-repair-rules";

const base="https://app.example.test/api/notification-center/mark";
function request(body:string,options?:{origin?:string|null;site?:string|null;type?:string;length?:string}) {
  const headers=new Headers({"content-type":options?.type??"application/json"});
  if(options?.origin!==null) headers.set("origin",options?.origin??"https://app.example.test");
  if(options?.site) headers.set("sec-fetch-site",options.site);
  if(options?.length) headers.set("content-length",options.length);
  return new Request(base,{method:"POST",headers,body});
}
test("mark request accepts only exact scoped JSON and a canonical same origin",async()=>{
 const id=randomUUID(),token=newVendorToken();
 assert.deepEqual(await readMarkRequest(request(JSON.stringify({recipientId:id})),false),{ok:true,input:{recipientId:id}});
 assert.deepEqual(await readMarkRequest(request(JSON.stringify({recipientId:id,token})),true),{ok:true,input:{recipientId:id,token}});
 for(const origin of [null,"null","https://evil.example.test","https://app.example.test/","https://user@app.example.test","https://app.example.test?x=1","https://app.example.test#x","https://app.example.test:444","https://app.example.test, https://evil.example.test"]) {
  assert.deepEqual(await readMarkRequest(request(JSON.stringify({recipientId:id}),{origin}),false),{ok:false,status:403});
 }
 assert.deepEqual(await readMarkRequest(request(JSON.stringify({recipientId:id}),{site:"cross-site"}),false),{ok:false,status:403});
 for(const body of ["{}","[]","null","not json",JSON.stringify({recipientId:id,orgId:randomUUID()}),JSON.stringify({recipientId:4}),JSON.stringify({recipientId:"not-a-uuid"}),JSON.stringify({recipientId:id,token:"bad"})]) {
  assert.equal((await readMarkRequest(request(body),false)).ok,false);
 }
 assert.deepEqual(await readMarkRequest(request(JSON.stringify({recipientId:id}),{type:"text/plain"}),false),{ok:false,status:400});
 assert.deepEqual(await readMarkRequest(request(JSON.stringify({recipientId:id}),{length:"2049"}),false),{ok:false,status:413});
 assert.deepEqual(await readMarkRequest(request(JSON.stringify({recipientId:id,extra:"x".repeat(3000)})),false),{ok:false,status:413});
 const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode("x".repeat(3000)));controller.close();}});
 const streamed=new Request(base,{method:"POST",headers:{origin:"https://app.example.test","content-type":"application/json"},body:stream,duplex:"half"} as RequestInit & {duplex:"half"});
 assert.deepEqual(await readMarkRequest(streamed,false),{ok:false,status:413});
 const spoof=new Request(base,{method:"POST",headers:{origin:"https://evil.example.test","x-forwarded-host":"evil.example.test","content-type":"application/json"},body:JSON.stringify({recipientId:id})});
 assert.deepEqual(await readMarkRequest(spoof,false),{ok:false,status:403});
 assert.deepEqual(await readMarkRequest(request(JSON.stringify({recipientId:id,token:` ${token}`})),true),{ok:false,status:400});
});
