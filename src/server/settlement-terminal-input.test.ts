import assert from "node:assert/strict";
import test from "node:test";
import { readSettlementTerminalInput } from "./settlement-terminal-input";
const origin="http://127.0.0.1:43129",leaseId="44444444-4444-4444-8444-444444444444",requestId="55555555-5555-4555-8555-555555555555",value={mode:"close",leaseId,requestId};
function request(body:string,headers:Record<string,string>={}) {return new Request(`${origin}/api/settlement/draft-command`,{method:"POST",headers:{origin,host:"127.0.0.1:43129","content-type":"application/json",...headers},body});}
test("terminal input enforces origin, MIME, exact fields and UUIDs",async()=>{
 assert.deepEqual(await readSettlementTerminalInput(request(JSON.stringify(value))),value);
 for(const req of [request(JSON.stringify(value),{origin:"http://localhost:43129"}),request(JSON.stringify(value),{origin:"null"}),request(JSON.stringify(value),{"content-type":"text/plain"}),request(JSON.stringify({...value,actorId:leaseId})),request(JSON.stringify({...value,mode:"save"})),request(JSON.stringify({...value,leaseId:"bad"})),request(JSON.stringify(value),{"content-length":"4097"}),new Request(`${origin}/api/settlement/draft-command`,{method:"POST",headers:{host:"127.0.0.1:43129","content-type":"application/json"},body:JSON.stringify(value)})])await assert.rejects(readSettlementTerminalInput(req));
});
test("terminal input caps streamed bytes without trusting advertised size",async()=>{
 let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode("{"+"a".repeat(4096)));},cancel(){cancelled=true;}});const req=new Request(`${origin}/api/settlement/draft-command`,{method:"POST",headers:{origin,host:"127.0.0.1:43129","content-type":"application/json","content-length":"1"},body:stream,duplex:"half"} as RequestInit);await assert.rejects(readSettlementTerminalInput(req));assert.equal(cancelled,true);
});
