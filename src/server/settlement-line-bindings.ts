import { writeAudit } from "./audit";
import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess,settlementDeadline,settlementRequestLock,settlementUuid } from "./settlement-access";
import type { Session } from "./types";
type Input={leaseId:string;lineId:string;classification:"rent"|"related_adjustment"|"unrelated";cycleId:string|null;evidenceId:string;reason:string;expectedPriorId:string|null;requestId:string};
/** Human scope assertion only: never establishes paid cash, cancels an invoice,
 * waives an outstanding balance, or allocates a multi-cycle adjustment. */
export async function bindSettlementLine(session:Session,input:Input) {
  [input.leaseId,input.lineId,input.evidenceId,input.requestId].forEach(settlementUuid);
  if(input.expectedPriorId)settlementUuid(input.expectedPriorId);if(input.cycleId)settlementUuid(input.cycleId);
  if(!["rent","related_adjustment","unrelated"].includes(input.classification)||((input.classification==="unrelated")!==(input.cycleId===null))||!input.reason.trim()||input.reason.trim().length>1000)throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    await settlementAccess(client,session,input.leaseId,"prepare");await settlementRequestLock(client,session,input.leaseId,"line_binding",input.requestId);
    const prior=(await client.query<{id:string;root_id:string;line_id:string;classification:string;cycle_id:string|null;evidence_id:string;reason:string;expected_prior_id:string|null;source_invoice_version:string;source_line_version:string}>(`SELECT b.id,b.root_id,r.invoice_line_id AS line_id,b.classification,b.cycle_id,b.evidence_id,b.reason,b.expected_prior_id,b.source_invoice_version,b.source_line_version FROM app.settlement_line_bindings b JOIN app.settlement_line_roots r ON r.id=b.root_id WHERE b.org_id=$1 AND b.lease_id=$2 AND b.created_by=$3 AND b.request_id=$4`,[session.orgId,input.leaseId,session.userId,input.requestId])).rows[0];
    if(prior) {
      if(prior.line_id!==input.lineId||prior.classification!==input.classification||prior.cycle_id!==input.cycleId||prior.evidence_id!==input.evidenceId||prior.reason!==input.reason.trim()||prior.expected_prior_id!==input.expectedPriorId)throw new FlowError("errors.generic");
      let stale=false,freshnessUnavailable=false,current:boolean|null=null;
      await client.query("SAVEPOINT line_replay_freshness");
      try {
        const admitted=(await client.query<{ok:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok`,[`b011:rent-cycle:${session.orgId}:${input.leaseId}`])).rows[0].ok;
        if(!admitted)freshnessUnavailable=true;
        else {
          const source=(await client.query<{invoice_version:string;line_version:string}>(`SELECT i.xmin::text AS invoice_version,l.xmin::text AS line_version FROM public.invoice_lines l JOIN public.invoices i ON i.org_id=l.org_id AND i.id=l.invoice_id WHERE l.id=$1 AND l.org_id=$2 AND i.lease_id=$3 FOR SHARE OF i,l NOWAIT`,[input.lineId,session.orgId,input.leaseId])).rows[0];
          const latest=(await client.query<{id:string}>(`SELECT id FROM app.settlement_line_bindings WHERE root_id=$1 ORDER BY revision DESC LIMIT 1`,[prior.root_id])).rows[0];
          current=latest?.id===prior.id;stale=!source||source.invoice_version!==prior.source_invoice_version||source.line_version!==prior.source_line_version;
        }
        await client.query("RELEASE SAVEPOINT line_replay_freshness");
      } catch(error) {if((error as {code?:string})?.code!=="55P03")throw error;await client.query("ROLLBACK TO SAVEPOINT line_replay_freshness");await client.query("RELEASE SAVEPOINT line_replay_freshness");freshnessUnavailable=true;}
      await settlementDeadline(client,session,input.leaseId);return {id:prior.id,recovered:true,current,stale,...(freshnessUnavailable?{freshnessUnavailable:true as const}:{})};
    }
    const admitted=(await client.query<{ok:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok`,[`b011:rent-cycle:${session.orgId}:${input.leaseId}`])).rows[0].ok;
    if(!admitted)throw new FlowError("errors.generic");await settlementDeadline(client,session,input.leaseId);
    const source=(await client.query<{charge_type:string;invoice_version:string;line_version:string}>(`SELECT l.charge_type::text,i.xmin::text AS invoice_version,l.xmin::text AS line_version FROM public.invoice_lines l JOIN public.invoices i ON i.org_id=l.org_id AND i.id=l.invoice_id WHERE l.id=$1 AND l.org_id=$2 AND i.lease_id=$3 FOR SHARE OF i,l NOWAIT`,[input.lineId,session.orgId,input.leaseId])).rows[0];
    if(!source||(input.classification==="rent"&&source.charge_type!=="rent")||(input.classification==="related_adjustment"&&!['credit','adjustment'].includes(source.charge_type)))throw new FlowError("errors.required");
    if(input.cycleId && !(await client.query(`SELECT 1 FROM app.settlement_rent_cycles WHERE org_id=$1 AND lease_id=$2 AND id=$3`,[session.orgId,input.leaseId,input.cycleId])).rowCount)throw new FlowError("errors.notFound");
    if(!(await client.query(`SELECT 1 FROM app.settlement_evidence e WHERE e.org_id=$1 AND e.lease_id=$2 AND e.id=$3 AND EXISTS(SELECT 1 FROM app.settlement_evidence_links l WHERE l.org_id=e.org_id AND l.lease_id=e.lease_id AND l.evidence_id=e.id)`,[session.orgId,input.leaseId,input.evidenceId])).rowCount)throw new FlowError("errors.notFound");
    const timeout=(await client.query<{value:string}>("SELECT current_setting('lock_timeout') AS value")).rows[0].value;await client.query("SET LOCAL lock_timeout = '25ms'");
    await client.query(`INSERT INTO app.settlement_line_roots(org_id,lease_id,invoice_line_id,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[session.orgId,input.leaseId,input.lineId,session.userId]);
    const root=(await client.query<{id:string}>(`SELECT id FROM app.settlement_line_roots WHERE org_id=$1 AND lease_id=$2 AND invoice_line_id=$3 FOR UPDATE NOWAIT`,[session.orgId,input.leaseId,input.lineId])).rows[0];
    if(!root)throw new FlowError("errors.notFound");
    const current=(await client.query<{id:string;revision:number}>(`SELECT id,revision FROM app.settlement_line_bindings WHERE root_id=$1 ORDER BY revision DESC LIMIT 1`,[root.id])).rows[0];
    if((current?.id??null)!==input.expectedPriorId)throw new FlowError("errors.generic");
    const result=(await client.query<{id:string}>(`INSERT INTO app.settlement_line_bindings(org_id,lease_id,root_id,revision,classification,cycle_id,evidence_id,reason,source_invoice_version,source_line_version,expected_prior_id,created_by,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[session.orgId,input.leaseId,root.id,(current?.revision??0)+1,input.classification,input.cycleId,input.evidenceId,input.reason.trim(),source.invoice_version,source.line_version,input.expectedPriorId,session.userId,input.requestId])).rows[0];
    await client.query("SELECT set_config('lock_timeout',$1,true)",[timeout]);
    await writeAudit(session.orgId,session.userId,"settlement_line_scope_asserted",{lease_id:input.leaseId,binding_id:result.id},client);await settlementDeadline(client,session,input.leaseId);
    return {id:result.id,recovered:false,current:true,stale:false};
  });
}
