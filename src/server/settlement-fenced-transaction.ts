import type { Client,QueryResult,QueryResultRow } from "pg";
import { withClient } from "./db";
import { FlowError,logServerError,mapDbError } from "./errors";
import { settlementUuid } from "./settlement-access";

/** Diagnostic prototype only: this is not an authorization gateway and is not
 * wired to settlement commits. Preparation must authorize and acquire all
 * earlier locks. The bounded facade must perform every operation after fencing. */
export async function withSettlementFencePrototype<T>(actorId:string,prepare:(client:Client)=>Promise<void>,fenced:(query:<R extends QueryResultRow = QueryResultRow>(sql:string,params?:unknown[])=>Promise<QueryResult<R>>)=>Promise<T>):Promise<T> {
  settlementUuid(actorId);
  return withClient(async client=>{
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`,[actorId]);
      await client.query("SET LOCAL ROLE service_role");
      await prepare(client);
      // A local test budget, not a production contention or latency target.
      const deadline=performance.now()+1500;
      async function refresh() {
        const remaining=Math.floor(deadline-performance.now());
        if(remaining<=0)throw new FlowError("errors.generic");
        await client.query(`SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$1,true)`,[`${remaining}ms`,`${Math.min(25,remaining)}ms`]);
      }
      async function boundedQuery<R extends QueryResultRow = QueryResultRow>(sql:string,params?:unknown[]):Promise<QueryResult<R>> {await refresh();const result=await client.query<R>(sql,params);await refresh();return result;}
      const result=await fenced(boundedQuery);
      // Fire pending deferred constraints while statement timeout still applies;
      // no data writes are permitted between this statement and COMMIT.
      await refresh();await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await refresh();await client.query("COMMIT");return result;
    } catch(error) {
      try {await client.query("ROLLBACK");} catch(rollbackError){logServerError("rollback",rollbackError);}
      // A lost COMMIT acknowledgement is uncertain; callers must recover by
      // their exact request ID instead of assuming this rollback proves absence.
      throw mapDbError(error);
    }
  });
}
