import type {OwnerRepairPolicyView,RepairDefaultResult} from './repair-owner-policy';
const max=BigInt('9223372036854775807');
function scaleValid(scale:number){return Number.isInteger(scale)&&scale>=0&&scale<=4;}
export function canonicalRepairMinor(value:unknown):value is string{return typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&value.length<=19&&BigInt(value)<=max;}
/** Exact decimal string, no spaces, grouping, signs, exponent or rounding. */
export function parseOwnerRepairAmount(value:string,scale:number):string|null{
 if(!scaleValid(scale)||value.length>64)return null;
 const parts=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);if(!parts||(parts[2]?.length??0)>scale)return null;
 const minor=BigInt(parts[1]+(parts[2]??'').padEnd(scale,'0')).toString();return canonicalRepairMinor(minor)?minor:null;
}
export function ownerRepairAmount(value:string,scale:number):string{
 if(!scaleValid(scale)||!canonicalRepairMinor(value))throw new Error('Invalid repair amount');
 if(scale===0)return value;const padded=value.padStart(scale+1,'0');return padded.slice(0,-scale)+'.'+padded.slice(-scale);
}
export function isOwnerRepairView(value:unknown,propertyId:string):value is OwnerRepairPolicyView{
 if(!value||typeof value!=='object')return false;const v=value as Record<string,unknown>;
 if(['disabled','unavailable','busy','recovery_only'].includes(v.state as string))return Object.keys(v).length===1;
 const defaults=['owner_default','owner_default_confirmation_required','regional_default','configuration_required'];
 return Object.keys(v).sort().join(',')==='currency,defaultMinor,defaultSource,effectiveMinor,effectiveSource,minorUnit,overrideMinor,ownershipId,propertyId,snapshot,state,verified'&&v.state==='enabled'&&v.propertyId===propertyId.toLowerCase()&&typeof v.ownershipId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.ownershipId)&&typeof v.currency==='string'&&/^[A-Z]{3}$/.test(v.currency)&&typeof v.minorUnit==='number'&&scaleValid(v.minorUnit)&&[v.defaultMinor,v.overrideMinor,v.effectiveMinor].every(x=>x===null||canonicalRepairMinor(x))&&defaults.includes(v.defaultSource as string)&&[...defaults,'property_override','legacy_confirmation_required'].includes(v.effectiveSource as string)&&typeof v.verified==='boolean'&&typeof v.snapshot==='string'&&/^[a-f0-9]{64}$/.test(v.snapshot);
}
export function isOwnerRepairResult(value:unknown,requestId:string):value is RepairDefaultResult{
 if(!value||typeof value!=='object')return false;const v=value as Record<string,unknown>;
 if(v.status==='recorded')return Object.keys(v).sort().join(',')==='outcome,recorded_at,request_id,status'&&v.request_id===requestId&&['changed','no_change','cancelled','rejected_conflict','rejected_disabled','rejected_invalid','rejected_unavailable'].includes(v.outcome as string)&&typeof v.recorded_at==='string'&&Number.isFinite(Date.parse(v.recorded_at));
 return Object.keys(v).length===1&&['unknown','busy','unavailable','request_mismatch','invalid'].includes(v.status as string);
}
