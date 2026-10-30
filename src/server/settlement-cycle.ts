import { writeAudit } from "./audit";
import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess,settlementDeadline,settlementRequestLock,settlementUuid } from "./settlement-access";
import { calculateFinalRent } from "./settlement-calculation";
import type { Session } from "./types";
type Input={leaseId:string;periodStart:string;periodEnd:string;evidenceId:string;requestId:string;fullPeriodAsserted:true};
/** Admin's evidenced assertion; this does not determine a paid amount or post a charge. */
export async function assertSettlementRentCycle(session:Session,input:Input) {
  settlementUuid(input.leaseId);settlementUuid(input.evidenceId);settlementUuid(input.requestId);
  if(input.fullPeriodAsserted!==true)throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    const {lease}=await settlementAccess(client,session,input.leaseId,"publish");
    await settlementRequestLock(client,session,input.leaseId,"cycle",input.requestId);
    const admission=(await client.query<{ok:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok`,[`b011:rent-cycle:${session.orgId}:${input.leaseId}`])).rows[0].ok;
    if(!admission)throw new FlowError("errors.generic");await settlementDeadline(client,session,input.leaseId);
    const old=(await client.query<{id:string;period_start:string;period_end:string;evidence_id:string;agreed_monthly_minor:string;currency:string;source_lease_start:string;source_move_out:string;source_country:string}>(`SELECT id,period_start::text,period_end::text,evidence_id,agreed_monthly_minor::text,currency::text,source_lease_start::text,source_move_out::text,source_country FROM app.settlement_rent_cycles WHERE org_id=$1 AND lease_id=$2 AND asserted_by=$3 AND request_id=$4`,[session.orgId,input.leaseId,session.userId,input.requestId])).rows[0];
    if(old) {
      if(old.period_start!==input.periodStart||old.period_end!==input.periodEnd||old.evidence_id!==input.evidenceId)throw new FlowError("errors.generic");
      let stale=old.agreed_monthly_minor!==lease.rent_amount_minor||old.currency!==lease.currency||lease.rent_frequency!=="monthly"||old.source_lease_start!==lease.start_date||old.source_move_out!==lease.moved_out_on;
      await client.query("SAVEPOINT cycle_replay_freshness");
      try {
        const property=(await client.query<{country_code:string}>(`SELECT country_code::text FROM public.properties WHERE id=$1 AND org_id=$2 FOR SHARE NOWAIT`,[lease.property_id,session.orgId])).rows[0];
        stale ||= !property || property.country_code!==old.source_country || property.country_code!=="TW";
        await client.query("RELEASE SAVEPOINT cycle_replay_freshness");
      } catch(error) {
        if((error as {code?:string})?.code!=="55P03")throw error;
        await client.query("ROLLBACK TO SAVEPOINT cycle_replay_freshness");await client.query("RELEASE SAVEPOINT cycle_replay_freshness");stale=true;
      }
      await settlementDeadline(client,session,input.leaseId);return {id:old.id,recovered:true,stale};
    }
    const property=(await client.query<{country_code:string}>(`SELECT country_code::text FROM public.properties WHERE id=$1 AND org_id=$2 FOR SHARE NOWAIT`,[lease.property_id,session.orgId])).rows[0];
    const evidence=await client.query(`SELECT 1 FROM app.settlement_evidence e WHERE e.org_id=$1 AND e.lease_id=$2 AND e.id=$3 AND EXISTS(SELECT 1 FROM app.settlement_evidence_links l WHERE l.org_id=e.org_id AND l.lease_id=e.lease_id AND l.evidence_id=e.id)`,[session.orgId,input.leaseId,input.evidenceId]);
    if(!property||!evidence.rowCount||!lease.moved_out_on)throw new FlowError("errors.required");
    try {calculateFinalRent({country:property.country_code,currency:lease.currency,frequency:lease.rent_frequency,monthlyMinor:Number(lease.rent_amount_minor),periodStart:input.periodStart,periodEnd:input.periodEnd,leaseStart:lease.start_date,moveOut:lease.moved_out_on});}catch{throw new FlowError("errors.required");}
    // A concurrent uncooperative writer cannot leave the exclusion check waiting.
    const timeout=(await client.query<{value:string}>("SELECT current_setting('lock_timeout') AS value")).rows[0].value;
    await client.query("SET LOCAL lock_timeout = '1ms'");
    const row=(await client.query<{id:string}>(`INSERT INTO app.settlement_rent_cycles(org_id,lease_id,currency,period_start,period_end,agreed_monthly_minor,source_lease_start,source_move_out,source_country,evidence_id,asserted_by,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[session.orgId,input.leaseId,lease.currency,input.periodStart,input.periodEnd,lease.rent_amount_minor,lease.start_date,lease.moved_out_on,property.country_code,input.evidenceId,session.userId,input.requestId])).rows[0];
    await client.query("SELECT set_config('lock_timeout',$1,true)",[timeout]);
    await writeAudit(session.orgId,session.userId,"settlement_rent_cycle_asserted",{lease_id:input.leaseId,cycle_id:row.id},client);
    await settlementDeadline(client,session,input.leaseId);return {id:row.id,recovered:false,stale:false};
  });
}
