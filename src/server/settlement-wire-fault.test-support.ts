import assert from "node:assert/strict";
import { createServer,createConnection,type Socket } from "node:net";
import { disposableDbUrl } from "./test-disposable-db";
/** Owned-clone local PG wire experiment. Discards backend COMMIT response only after ReadyForQuery. */
export async function settlementCommitFault<T>(ownedDatabase:string,phase:"before"|"after",fn:()=>Promise<T>,afterCommit?:()=>Promise<void>,targetCommit=1) {
 const previous=process.env.DATABASE_URL!,url=disposableDbUrl(previous,process.env.CONDOLA_RLS_DISPOSABLE);assert.equal(url.hostname,"127.0.0.1");assert.equal(decodeURIComponent(url.pathname.slice(1)),ownedDatabase);assert.match(ownedDatabase,/^condola_b011_[a-f0-9]{32}$/);assert.equal(process.env.DEMO_MODE,"true");
 const sockets=new Set<Socket>();let tripped=false,commitSeen=false,readySeen=false,afterError:unknown,commitCount=0;const upstreamPort=Number(url.port);
 const server=createServer(front=>{const back=createConnection({host:"127.0.0.1",port:upstreamPort});sockets.add(front);sockets.add(back);for(const s of [front,back]){s.on("error",()=>{});s.on("close",()=>sockets.delete(s));}front.on("close",()=>back.destroy());back.on("close",()=>front.destroy());let startup=true,input:Buffer=Buffer.alloc(0),suppress=false,output:Buffer=Buffer.alloc(0);
  front.on("data",chunk=>{input=Buffer.concat([input,chunk]);let cut=false;while(input.length>=5){const length=startup?input.readInt32BE(0):input.readInt32BE(1)+1;if(length<5||length>1048576){front.destroy();back.destroy();return;}if(input.length<length)break;const frame=input.subarray(0,length);input=input.subarray(length);if(startup){startup=false;continue;}let sql="";if(frame[0]===81)sql=frame.subarray(5,-1).toString();else if(frame[0]===80){const end=frame.indexOf(0,5),endSql=frame.indexOf(0,end+1);if(end>=5&&endSql>end)sql=frame.subarray(end+1,endSql).toString();}if(sql==="COMMIT"&&!tripped&&++commitCount===targetCommit){commitSeen=true;if(phase==="before"){tripped=true;cut=true;front.destroy();back.destroy();break;}suppress=true;}}if(!cut)back.write(chunk);});
  back.on("data",chunk=>{if(!suppress){front.write(chunk);return;}output=Buffer.concat([output,chunk]);while(output.length>=5){const length=output.readInt32BE(1)+1;if(output.length<length)break;const type=output[0];output=output.subarray(length);if(type===90){readySeen=true;tripped=true;if(afterCommit)void afterCommit().then(()=>{front.destroy();back.destroy();},error=>{afterError=error;front.destroy();back.destroy();});else{front.destroy();back.destroy();}break;}}});
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");url.port=String(address.port);process.env.DATABASE_URL=url.toString();
 try {const result=await Promise.allSettled([fn()]);if(afterError)throw afterError;return {result:result[0],tripped,commitSeen,readySeen,commitCount};}
 finally {process.env.DATABASE_URL=previous;for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

/** Pause the second local DB connection before its startup packet, then perform
 * a test-only committed interleaving. Never observes or logs packet contents. */
export async function settlementSecondConnectionBarrier<T>(ownedDatabase:string,interleave:()=>Promise<void>,fn:()=>Promise<T>) {
 const previous=process.env.DATABASE_URL!,url=disposableDbUrl(previous,process.env.CONDOLA_RLS_DISPOSABLE);assert.equal(url.hostname,"127.0.0.1");assert.equal(decodeURIComponent(url.pathname.slice(1)),ownedDatabase);assert.match(ownedDatabase,/^condola_b011_[a-f0-9]{32}$/);assert.equal(process.env.DEMO_MODE,"true");
 const port=Number(url.port),sockets=new Set<Socket>();let count=0,interleaved=false,interleaveError:unknown;
 const server=createServer(front=>{count++;const current=count,back=createConnection({host:"127.0.0.1",port});sockets.add(front);sockets.add(back);for(const s of [front,back]){s.on("error",()=>{});s.on("close",()=>sockets.delete(s));}front.on("close",()=>back.destroy());back.on("close",()=>front.destroy());back.pipe(front);
  if(current!==2){front.pipe(back);return;}front.pause();void interleave().then(()=>{interleaved=true;front.pipe(back);front.resume();},error=>{interleaveError=error;front.destroy();back.destroy();});
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");url.port=String(address.port);process.env.DATABASE_URL=url.toString();
 try {const result=await Promise.allSettled([fn()]);if(interleaveError)throw interleaveError;return {result:result[0],interleaved,connections:count};}
 finally {process.env.DATABASE_URL=previous;for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
