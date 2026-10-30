import assert from "node:assert/strict";
import test from "node:test";
import { query } from "./db";
import { ORG_ID, USERS } from "./ids";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
import { prepareUtilityRun } from "./utility-posting";
import { utilityReconciliation } from "./utility-reconciliation";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
const admin: Session = {userId:USERS.admin,sessionId:"b008-utility",email:"admin@example.invalid",name:"B008",kind:"staff",role:"admin",orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"en",calendar:"gregorian",leaseId:null};
test("saved synthetic utility runs reconcile tenant, vacant, public and signed gaps in TWD and USD without writes", async () => {
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  try {
    const contact=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 LIMIT 1`,[ORG_ID,USERS.tenant])).rows[0].id;
    const ids: string[]=[];
    for (const currency of ["TWD","USD"]) {
      const property=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES ($1,$2,$3,$4,'Asia/Taipei','by_room') RETURNING id::text`,[ORG_ID,`B008 ${currency}`,currency === "TWD" ? "TW" : "US",currency])).rows[0].id;
      for (const bill of [390,400,410]) {
        const unit=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,$3,'by_room') RETURNING id::text`,[ORG_ID,property,String(bill)])).rows[0].id;
        const rooms=(await query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label,electricity_method) VALUES ($1,$2,'A','submeter'),($1,$2,'B','submeter') RETURNING id::text`,[ORG_ID,unit])).rows.map((r)=>r.id);
        const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$4,'active','2099-08-01','2099-08-31',$5,0) RETURNING id::text`,[ORG_ID,property,unit,rooms[0],currency])).rows[0].id;
        await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id) VALUES ($1,$2,$3)`,[ORG_ID,lease,contact]);
        const prepared=await prepareUtilityRun(admin,{unitId:unit,periodStart:"2099-08-01",periodEnd:"2099-08-31",rateMajor:4,totalKwh:100,billTotalMajor:bill,overrideReason:"fixture",readings:[{spaceId:rooms[0],kwh:60},{spaceId:rooms[1],kwh:20}]});
        ids.push(prepared.runId);
      }
      const evenUnit=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'even','by_room') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
      await query(`INSERT INTO rooms(org_id,unit_id,label,electricity_method) VALUES ($1,$2,'A','even'),($1,$2,'B','even'),($1,$2,'C','even')`,[ORG_ID,evenUnit]);
      const even=await prepareUtilityRun(admin,{unitId:evenUnit,periodStart:"2099-08-01",periodEnd:"2099-08-31",rateMajor:4,totalKwh:null,billTotalMajor:100,overrideReason:"",readings:[]});
      ids.push(even.runId);
    }
    const before=(await query(`SELECT (SELECT count(*) FROM utility_allocation_runs)::int AS runs,(SELECT count(*) FROM utility_allocation_lines)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audit`)).rows;
    const results=await utilityReconciliation(admin,"2099-08"); assert.ok(results);
    const ours=results.filter((row)=>ids.includes(row.id)); assert.equal(ours.length,8);
    for (const row of ours) { const result=row.reconciliation; assert.ok(result); assert.equal(result.difference,0); if (row.unit === "even") { assert.equal(result.remainder,row.currency === "TWD" ? 100 : 1); assert.equal(result.owner+result.remainder,10000); } else { assert.equal(result.tenant,24000); assert.equal(result.owner,8000); assert.equal(result.publicAmount,8000); assert.equal(result.gap,(Number(row.unit)-400)*100); } }
    assert.deepEqual((await query(`SELECT (SELECT count(*) FROM utility_allocation_runs)::int AS runs,(SELECT count(*) FROM utility_allocation_lines)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audit`)).rows,before);
    const altered=ours.find((row) => row.unit !== "even")!; await query(`UPDATE utility_allocation_lines SET amount_minor=amount_minor+100 WHERE run_id=$1 AND bearer='owner'`,[altered.id]);
    const after=await utilityReconciliation(admin,"2099-08"); assert.equal(after?.find((r)=>r.id===altered.id)?.reconciliation?.difference,-100);
  } finally {
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  }
});
