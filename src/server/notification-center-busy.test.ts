import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { centerSessionAdmission } from "./notification-center";
import type { Session } from "./types";

function session():Session {const id=randomUUID();return {userId:id,sessionId:randomUUID(),kind:"staff",role:"manager",orgId:id,liveOrgId:id,environment:"live",locale:"en",calendar:"gregorian",leaseId:null,email:"synthetic@example.test",name:"Synthetic"};}
function dbError(code:string) {return Object.assign(new Error("synthetic database failure"),{code});}

test("only a rolled-back lock conflict retries in a fresh transaction",async t=>{
  let connections=0,gates=0,rollbacks=0,ends=0;
  const log=t.mock.method(console,"error",()=>{});
  t.mock.method(Client.prototype,"connect",async()=>{connections++;});
  t.mock.method(Client.prototype,"end",async()=>{ends++;});
  t.mock.method(Client.prototype,"query",(async (sql:string)=>{
    if(sql.includes("to_regprocedure")) return {rows:[{ok:true}]};
    if(sql.includes("b028_center_session_enabled")) {if(++gates===1) throw dbError("55P03"); return {rows:[{enabled:true}]};}
    if(sql==="ROLLBACK") rollbacks++;
    return {rows:[]};
  }) as Client["query"]);
  assert.equal(await centerSessionAdmission(session()),"enabled");
  assert.equal(connections,2);assert.equal(gates,2);assert.equal(rollbacks,1);assert.equal(ends,2);assert.equal(log.mock.callCount(),0);
});

test("rollback or cleanup failure and commit uncertainty never become busy or success",async t=>{
  for(const failure of ["rollback","cleanup","commit","other","permission","begin"] as const) {
    await t.test(failure,async st=>{
      let connections=0,gates=0;
      st.mock.method(console,"error",()=>{});
      st.mock.method(Client.prototype,"connect",async()=>{connections++;});
      st.mock.method(Client.prototype,"end",async()=>{if(failure==="cleanup") throw new Error("synthetic close failure");});
      st.mock.method(Client.prototype,"query",(async (sql:string)=>{
        if(sql==="BEGIN" && failure==="begin") throw dbError("55P03");
        if(sql.includes("to_regprocedure")) return {rows:[{ok:true}]};
        if(sql.includes("b028_center_session_enabled")) {gates++;if(failure!=="commit") throw dbError(failure==="other"?"23514":failure==="permission"?"42501":"55P03");return {rows:[{enabled:true}]};}
        if(sql==="ROLLBACK" && failure==="rollback") throw dbError("08006");
        if(sql==="COMMIT" && failure==="commit") throw dbError("55P03");
        return {rows:[]};
      }) as Client["query"]);
      await assert.rejects(centerSessionAdmission(session()));
      assert.equal(connections,1);assert.equal(gates,failure==="begin"?0:1);
    });
  }
});

test("a delayed physical close may outlive confirmed rollback and a bounded retry",async t=>{
  let connections=0,ends=0,gates=0,firstClosed=false,secondStartedBeforeClose=false;
  t.mock.method(Client.prototype,"connect",async()=>{connections++;if(connections===2) secondStartedBeforeClose=!firstClosed;});
  t.mock.method(Client.prototype,"end",async()=>{if(++ends===1){await new Promise(resolve=>setTimeout(resolve,350));firstClosed=true;}});
  t.mock.method(Client.prototype,"query",(async (sql:string)=>{
    if(sql.includes("to_regprocedure")) return {rows:[{ok:true}]};
    if(sql.includes("b028_center_session_enabled")){if(++gates===1) throw dbError("55P03");return {rows:[{enabled:true}]};}
    return {rows:[]};
  }) as Client["query"]);
  assert.equal(await centerSessionAdmission(session()),"enabled");
  assert.equal(connections,2);assert.equal(secondStartedBeforeClose,true);
});
