import type { Client } from "pg";
import type { ArchiveRef } from "@/lib/record-archive";
import { isArchiveRef } from "@/lib/record-archive";
import { FlowError } from "./errors";
import { isUuid } from "./repair-rules";

type Connection = Pick<Client,"query">;
export type ArchiveAncestry = { propertyId:string; unitId:string|null; roomId:string|null; propertyArchived:boolean; unitArchived:boolean; roomArchived:boolean; mode:string|null };

/** Discovery is under the caller's existing RLS. No client-supplied parent is authority. */
export async function archiveAncestry(c:Connection,orgId:string,ref:ArchiveRef):Promise<ArchiveAncestry> {
  if(!isUuid(orgId)||!isArchiveRef(ref))throw new FlowError("errors.notFound");
  const sql=ref.kind==="property"
    ? `SELECT p.id::text AS "propertyId",NULL::text AS "unitId",NULL::text AS "roomId",p.archived_at IS NOT NULL AS "propertyArchived",false AS "unitArchived",false AS "roomArchived",NULL::text AS mode FROM public.properties p WHERE p.org_id=$1 AND p.id=$2`
    : ref.kind==="unit"
    ? `SELECT p.id::text AS "propertyId",u.id::text AS "unitId",NULL::text AS "roomId",p.archived_at IS NOT NULL AS "propertyArchived",u.archived_at IS NOT NULL AS "unitArchived",false AS "roomArchived",u.rental_mode::text AS mode FROM public.units u JOIN public.properties p ON p.org_id=u.org_id AND p.id=u.property_id WHERE u.org_id=$1 AND u.id=$2`
    : `SELECT p.id::text AS "propertyId",u.id::text AS "unitId",r.id::text AS "roomId",p.archived_at IS NOT NULL AS "propertyArchived",u.archived_at IS NOT NULL AS "unitArchived",r.archived_at IS NOT NULL AS "roomArchived",u.rental_mode::text AS mode FROM public.rooms r JOIN public.units u ON u.org_id=r.org_id AND u.id=r.unit_id JOIN public.properties p ON p.org_id=u.org_id AND p.id=u.property_id WHERE r.org_id=$1 AND r.id=$2`;
  const row=(await c.query<ArchiveAncestry>(sql,[orgId,ref.id])).rows[0];
  if(!row)throw new FlowError("errors.notFound");
  return row;
}
function samePath(a:ArchiveAncestry,b:ArchiveAncestry) { return a.propertyId===b.propertyId && a.unitId===b.unitId && a.roomId===b.roomId; }
async function lockKey(c:Connection,orgId:string,kind:string,id:string,exclusive:boolean) {
  const key=`condola:record-archive:${orgId.toLowerCase()}:${kind}:${id.toLowerCase()}`;
  await c.query(exclusive?"SELECT pg_advisory_xact_lock(hashtextextended($1,0))":"SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[key]);
}
/** Locks must precede existing physical parent/lease/ticket/run locks. */
export async function lockArchiveAncestry(c:Connection,orgId:string,ref:ArchiveRef,exclusiveTarget:boolean):Promise<ArchiveAncestry> {
  const before=await archiveAncestry(c,orgId,ref);
  await lockKey(c,orgId,"property",before.propertyId,exclusiveTarget && ref.kind==="property");
  if(before.unitId)await lockKey(c,orgId,"unit",before.unitId,exclusiveTarget && ref.kind==="unit");
  if(before.roomId)await lockKey(c,orgId,"room",before.roomId,exclusiveTarget && ref.kind==="room");
  const after=await archiveAncestry(c,orgId,ref);
  if(!samePath(before,after))throw new FlowError("errors.notFound");
  return after;
}
export async function admitActiveArchiveAncestry(c:Connection,orgId:string,ref:ArchiveRef):Promise<ArchiveAncestry> {
  const a=await lockArchiveAncestry(c,orgId,ref,false);
  if(a.propertyArchived||a.unitArchived||a.roomArchived||(ref.kind==="room"&&a.mode!=="by_room"))throw new FlowError("errors.notFound");
  return a;
}

/** Resolve the same eligible target precedence as fresh lease creation before waiting. */
export async function admitFreshLeaseAncestry(c:Connection,orgId:string,targetId:string) {
  if (!isUuid(orgId) || typeof targetId !== 'string' || targetId.length > 80) throw new FlowError("errors.notFound");
  let canonical:string;
  try {canonical=(await c.query<{id:string}>(`SELECT $1::uuid::text AS id`,[targetId])).rows[0].id;}
  catch(error) {if((error as {code?:string})?.code==='22P02')throw new FlowError('errors.notFound');throw error;}
  const candidate = (await c.query<{kind:"room"|"unit"}>(`SELECT kind FROM (
    SELECT 'room'::text AS kind, 0 AS rank FROM public.rooms r
      JOIN public.units u ON u.id=r.unit_id AND u.org_id=r.org_id
      JOIN public.properties p ON p.id=u.property_id AND p.org_id=u.org_id
     WHERE r.id=$1 AND r.org_id=$2 AND r.archived_at IS NULL AND u.archived_at IS NULL AND p.archived_at IS NULL AND u.rental_mode='by_room'
    UNION ALL
    SELECT 'unit'::text AS kind, 1 AS rank FROM public.units u
      JOIN public.properties p ON p.id=u.property_id AND p.org_id=u.org_id
     WHERE u.id=$1 AND u.org_id=$2 AND u.archived_at IS NULL AND p.archived_at IS NULL AND u.rental_mode='whole_unit'
  ) candidates ORDER BY rank LIMIT 1`,[canonical,orgId])).rows[0];
  if (!candidate) throw new FlowError("errors.notFound");
  const ancestry=await admitActiveArchiveAncestry(c,orgId,{kind:candidate.kind,id:canonical});
  if (candidate.kind==='unit' && ancestry.mode!=='whole_unit') throw new FlowError("errors.notFound");
  return {kind:candidate.kind,ancestry};
}

/** Resolve and recheck the actual lease target; the caller must authorize the lease. */
export async function admitLeaseArchiveAncestry(c:Connection,orgId:string,leaseId:string) {
  if (!isUuid(orgId) || !isUuid(leaseId)) throw new FlowError("errors.notFound");
  const read=async()=> (await c.query<{property_id:string;unit_id:string;target_room_id:string|null}>(`SELECT property_id::text,unit_id::text,target_room_id::text FROM public.leases WHERE org_id=$1 AND id=$2`,[orgId,leaseId])).rows[0];
  const before=await read(); if(!before)throw new FlowError("errors.notFound");
  const ancestry=await admitActiveArchiveAncestry(c,orgId,before.target_room_id ? {kind:'room',id:before.target_room_id} : {kind:'unit',id:before.unit_id});
  const after=await read();
  if(!after || after.property_id!==before.property_id || after.unit_id!==before.unit_id || after.target_room_id!==before.target_room_id || ancestry.propertyId!==before.property_id || ancestry.unitId!==before.unit_id || (!before.target_room_id && ancestry.mode!=='whole_unit'))throw new FlowError("errors.notFound");
  return after;
}

/** Call only after the existing ticket authorization and before locking the ticket. */
export async function admitTicketArchiveAncestry(c:Connection,orgId:string,ticketId:string) {
  if (!isUuid(orgId) || !isUuid(ticketId)) throw new FlowError("errors.notFound");
  const read=async()=> (await c.query<{property_id:string;unit_id:string|null;room_id:string|null}>(`SELECT property_id::text,unit_id::text,room_id::text FROM public.maintenance_tickets WHERE org_id=$1 AND id=$2`,[orgId,ticketId])).rows[0];
  const before=await read();if(!before)throw new FlowError("errors.notFound");
  const ref:ArchiveRef=before.room_id ? {kind:'room',id:before.room_id} : before.unit_id ? {kind:'unit',id:before.unit_id} : {kind:'property',id:before.property_id};
  const ancestry=await admitActiveArchiveAncestry(c,orgId,ref);
  const after=await read();
  if(!after||after.property_id!==before.property_id||after.unit_id!==before.unit_id||after.room_id!==before.room_id||ancestry.propertyId!==before.property_id||ancestry.unitId!==before.unit_id||ancestry.roomId!==before.room_id)throw new FlowError("errors.notFound");
}

/** A room move uses sorted old/new unit keys before its own exclusive key. */
export async function admitRoomMove(c:Connection,orgId:string,roomId:string,floor:string) {
  const before=await archiveAncestry(c,orgId,{kind:'room',id:roomId});
  const destination=async()=> (await c.query<{id:string}>(`SELECT id::text FROM public.units WHERE org_id=$1 AND property_id=$2 AND label=$3 AND archived_at IS NULL`,[orgId,before.propertyId,floor])).rows[0]?.id ?? null;
  const next=await destination();
  await lockKey(c,orgId,'property',before.propertyId,false);
  for(const id of [...new Set([before.unitId!,next].filter((x):x is string=>Boolean(x)))].sort())await lockKey(c,orgId,'unit',id,false);
  await lockKey(c,orgId,'room',roomId,true);
  const after=await archiveAncestry(c,orgId,{kind:'room',id:roomId});
  if(!samePath(before,after)||after.propertyArchived||after.unitArchived||after.roomArchived||after.mode!=='by_room'||await destination()!==next)throw new FlowError('errors.notFound');
  if(next) { const dest=await archiveAncestry(c,orgId,{kind:'unit',id:next}); if(dest.propertyId!==before.propertyId||dest.propertyArchived||dest.unitArchived||dest.mode!=='by_room')throw new FlowError('errors.notFound'); }
  return next;
}

/** Batch writers take all properties, then units, then rooms in stable UUID order. */
export async function admitArchiveBatch(c:Connection,orgId:string,refs:ArchiveRef[],allowArchived=false) {
  const discovered=await Promise.all(refs.map(ref=>archiveAncestry(c,orgId,ref)));
  const keys=(select:(a:ArchiveAncestry)=>string|null)=>[...new Set(discovered.map(select).filter((x):x is string=>Boolean(x)))].sort();
  for(const id of keys(a=>a.propertyId))await lockKey(c,orgId,'property',id,false);
  for(const id of keys(a=>a.unitId))await lockKey(c,orgId,'unit',id,false);
  for(const id of keys(a=>a.roomId))await lockKey(c,orgId,'room',id,false);
  for(let i=0;i<refs.length;i++) {
    const a=await archiveAncestry(c,orgId,refs[i]);
    if(!samePath(a,discovered[i])||(!allowArchived&&(a.propertyArchived||a.unitArchived||a.roomArchived))||(refs[i].kind==='room'&&a.mode!=='by_room'))throw new FlowError('errors.notFound');
  }
}
