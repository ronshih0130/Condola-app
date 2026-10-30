/** Disposable-clone-only experiment. Never import from runtime or accept supplied canonical bytes. */
import { createHash } from "node:crypto";
import { Client } from "pg";
import { stableStringify } from "../../idempotency";
import { disposableDbUrl } from "../test-disposable-db";
import { cloneTestDatabase } from "../test-database-clone";

type Input = { leaseId:string; amount:number; paidOn:string; last5:string; reference:string };
const invalid=()=>new Error("Prototype input unavailable");
function scalarString(s:string):boolean {
 for(let i=0;i<s.length;i++){const n=s.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const m=s.charCodeAt(++i);if(!(m>=0xdc00&&m<=0xdfff))return false;}else if(n>=0xdc00&&n<=0xdfff)return false;}
 return true;
}
export function localCanonicalBytes(input:Input):Buffer {
 if(!input || typeof input.leaseId!=="string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.leaseId) || !Number.isSafeInteger(input.amount) || input.amount<=0 || typeof input.paidOn!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) || typeof input.last5!=="string" || typeof input.reference!=="string" || ![input.leaseId,input.paidOn,input.last5,input.reference].every(scalarString)) throw invalid();
 const result=Buffer.from(stableStringify({leaseId:input.leaseId,amount:input.amount,paidOn:input.paidOn,last5:input.last5,reference:input.reference}),"utf8");
 if(result.length>65536)throw invalid();return result;
}
/** Actual authorized begin on a named owned clone; ALWAYS rolls back. No payload is returned or stored by this wrapper. */
async function localCanonicalOperation(ownedUrl:string,input:Input,ctx:{org:string;session:string;actor:string;request:string}):Promise<"recorded"|"unknown"|"new_rollback_only"> {
 if(process.env.DEMO_MODE!=="true")throw invalid();const target=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
 if(target.href!==ownedUrl || !/^condola_test_[0-9a-f]{32}$/.test(decodeURIComponent(target.pathname.slice(1))))throw invalid();
 const bytes=localCanonicalBytes(input);const digest=createHash("sha256").update(bytes).digest("hex");const c=new Client({connectionString:target.href});
 try {await c.connect();await c.query("BEGIN");
  const verified=(await c.query<{ok:boolean}>(`SELECT encode(public.digest($1::bytea,'sha256'),'hex')=$2 AND convert_from($1::bytea,'UTF8')::jsonb=jsonb_build_object('leaseId',$3::text,'amount',$4::bigint,'paidOn',$5::text,'last5',$6::text,'reference',$7::text) AS ok`,[bytes,digest,input.leaseId,input.amount,input.paidOn,input.last5,input.reference])).rows[0].ok;if(!verified)throw invalid();
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[ctx.actor]);await c.query("SET LOCAL ROLE service_role");
  const r=(await c.query<{disposition:string}>(`SELECT disposition FROM app.b019_begin_probe($1,$1,'live',$2,$3,'admin',$4,$5,$6,$7,$8)`,[ctx.org,ctx.session,input.leaseId,ctx.request,input.amount,input.paidOn,input.last5,input.reference])).rows[0];
  if(!r || !["recorded","unknown","new"].includes(r.disposition))throw invalid();
  if(r.disposition==="new") {let rejected=false;try{await c.query('SET CONSTRAINTS app.b019_begin_probe_never_commit IMMEDIATE');}catch(e){if((e as {code?:string}).code!=="23514")throw e;rejected=true;}if(!rejected)throw invalid();}
  await c.query("ROLLBACK");return r.disposition==="new"?"new_rollback_only":r.disposition as "recorded"|"unknown";
 } catch(e){try{await c.query("ROLLBACK");}catch{/* propagate original */}throw e;} finally {await c.end();}
}

/** Owns the clone itself; its operation cannot be rebound to a different database. */
export async function createLocalCanonicalProbe(){
 if(process.env.DEMO_MODE!=="true")throw invalid();disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
 const clone=await cloneTestDatabase();
 return {url:clone.url,run:(input:Input,ctx:{org:string;session:string;actor:string;request:string})=>localCanonicalOperation(clone.url,input,ctx),cleanup:clone.cleanup};
}
