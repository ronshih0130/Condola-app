'use client';
import {useEffect,useRef,useState} from 'react';
import type {Locale} from '@/i18n';
import {ownerRepairOverrideCopy} from '@/i18n/lanes/repair-owner-override';
import {isOwnerRepairResult,isOwnerRepairView,ownerRepairAmount,parseOwnerRepairAmount} from '@/server/repair-owner-policy-input';
import type {OwnerRepairPolicyView,RepairDefaultResult} from '@/server/repair-owner-policy';
type Enabled=Extract<OwnerRepairPolicyView,{state:'enabled'}>;
type Phase='loading'|'idle'|'editing'|'pending'|'unknown'|'done'|'storage'|'unavailable';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function OwnerRepairOverrideEditor({locale,scope,propertyId,view}:{locale:Locale;scope:string;propertyId:string;view:OwnerRepairPolicyView}){
 const copy=ownerRepairOverrideCopy(locale),key=`b013-override:${scope}:${propertyId}`;
 const [phase,setPhase]=useState<Phase>('loading'),[requestId,setRequestId]=useState<string|null>(null),[result,setResult]=useState<RepairDefaultResult|null>(null);
 const [capture,setCapture]=useState<Enabled|null>(null),[action,setAction]=useState<'set'|'clear'>('set'),[amount,setAmount]=useState(''),[invalid,setInvalid]=useState(false);
 const active=useRef(false),generation=useRef(0),working=useRef(false),request=useRef<string|null>(null);
 function remember(id:string|null){request.current=id;setRequestId(id);}
 async function post(body:Record<string,string>){const response=await fetch('/api/owner-repair-override',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify(body)});if(!response.ok)throw new Error('Unconfirmed operation');return await response.json() as unknown;}
 async function send(mode:'change'|'status'|'close',id:string,payload:Record<string,string>={}){
  if(working.current||!active.current)return;
  try{if(sessionStorage.getItem(key)!==id){setPhase('storage');return;}}catch{setPhase('storage');return;}
  const epoch=generation.current;working.current=true;setPhase('pending');
  try{const value=await post({mode,propertyId,requestId:id,...payload});if(!active.current||epoch!==generation.current||request.current!==id)return;
   if(sessionStorage.getItem(key)!==id){setResult({status:'unknown'});setPhase('storage');return;}
   if(!isOwnerRepairResult(value,id)){setResult({status:'unknown'});setPhase('unknown');return;}
   setResult(value);setPhase(value.status==='recorded'?'done':'unknown');
  }catch{if(active.current&&epoch===generation.current&&request.current===id){setResult({status:'unknown'});setPhase('unknown');}}
  finally{if(epoch===generation.current)working.current=false;}
 }
 useEffect(()=>{
  active.current=true;generation.current++;working.current=false;
  try{const id=sessionStorage.getItem(key);if(id!==null){if(!uuid.test(id)){setPhase('storage');}else{remember(id);void send('status',id);}}else{remember(null);setPhase('idle');}}
  catch{setPhase('storage');}
  // This counter invalidates async replies; it is not a captured DOM ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return()=>{active.current=false;generation.current++;};
  // Page keys remount the complete company/principal/environment/property scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key]);
 async function start(){
  if(working.current||!active.current)return;
  try{const id=sessionStorage.getItem(key);if(id!==null){if(!uuid.test(id)){setPhase('storage');return;}if(phase!=='done'||request.current!==id){remember(id);setPhase('unknown');return;}sessionStorage.removeItem(key);if(sessionStorage.getItem(key)!==null)throw new Error('Storage unavailable');}}
  catch{setPhase('storage');return;}
  remember(null);setResult(null);const epoch=++generation.current;working.current=true;setPhase('pending');
  try{const fresh=await post({mode:'view',propertyId});if(!active.current||epoch!==generation.current)return;
   if(sessionStorage.getItem(key)!==null){const other=sessionStorage.getItem(key);if(other&&uuid.test(other)){remember(other);setPhase('unknown');}else setPhase('storage');return;}
   if(!isOwnerRepairView(fresh,propertyId)||fresh.state!=='enabled'){setCapture(null);setResult({status:'unavailable'});setPhase('unavailable');return;}
   setCapture(fresh);setAmount(fresh.effectiveSource==='property_override'&&fresh.overrideMinor!==null?ownerRepairAmount(fresh.overrideMinor,fresh.minorUnit):'');setAction('set');setInvalid(false);setPhase('editing');
  }catch{if(active.current&&epoch===generation.current){setResult({status:'unavailable'});setPhase('unavailable');}}
  finally{if(epoch===generation.current)working.current=false;}
 }
 function save(event:React.FormEvent){
  event.preventDefault();if(working.current||phase!=='editing'||!capture||view.state!=='enabled')return;const value=action==='clear'?'':parseOwnerRepairAmount(amount,capture.minorUnit);if(value===null){setInvalid(true);return;}
  let id:string;try{const prior=sessionStorage.getItem(key);if(prior!==null){if(uuid.test(prior)){remember(prior);setPhase('unknown');}else setPhase('storage');return;}id=crypto.randomUUID();sessionStorage.setItem(key,id);if(sessionStorage.getItem(key)!==id)throw new Error('Storage unavailable');}
  catch{setPhase('storage');return;}remember(id);void send('change',id,{expected:capture.snapshot,action,value});
 }
 const shown=view.state==='enabled'&&(phase==='idle'||phase==='editing')?(phase==='editing'&&capture?capture:view):null;
 function money(value:string|null){return value===null||!shown?copy.unknownAmount:`${shown.currency} ${ownerRepairAmount(value,shown.minorUnit)}`;}
 function source(value:string){return value==='owner_default'?copy.sourceOwner:value==='regional_default'?copy.sourceRegion:value==='property_override'?copy.sourceProperty:copy.sourceUnknown;}
 function message(){if(result?.status!=='recorded')return copy.unknown;return result.outcome==='changed'?copy.changed:result.outcome==='no_change'?copy.noChange:result.outcome==='cancelled'?copy.cancelled:result.outcome==='rejected_conflict'?copy.conflict:result.outcome==='rejected_invalid'?copy.invalid:result.outcome==='rejected_disabled'?copy.disabled:copy.unavailable;}
 return <section className="card pad" style={{padding:16,marginTop:16}} data-testid="owner-repair-override" data-policy-currency={view.state==='enabled'?view.currency:undefined} data-policy-scale={view.state==='enabled'?view.minorUnit:undefined} data-policy-snapshot={view.state==='enabled'?view.snapshot:undefined}>
  <h2>{copy.title}</h2><p style={{marginBlock:12}}>{copy.note}</p><p className="small" style={{marginBlock:12}}>{copy.newVersions}</p>
  {shown?<dl style={{display:'grid',gap:8}} data-testid="repair-policy-values"><dt>{copy.defaultLabel}</dt><dd style={{margin:0}} data-testid="repair-default-value">{money(shown.defaultMinor)} · {source(shown.defaultSource)}</dd><dt>{copy.effective}</dt><dd style={{margin:0}}>{money(shown.effectiveMinor)} · {source(shown.effectiveSource)}</dd>{shown.overrideMinor!==null?<><dt>{copy.override}</dt><dd style={{margin:0}}>{shown.effectiveSource==='legacy_confirmation_required'?copy.sourceUnknown:money(shown.overrideMinor)}</dd></>:null}{shown.effectiveSource==='legacy_confirmation_required'?<dd style={{margin:0}}>{copy.legacy}</dd>:null}</dl>:view.state!=='enabled'?<p role="status">{view.state==='disabled'?copy.disabled:copy.unavailable}</p>:null}
  {phase==='editing'&&capture&&view.state==='enabled'?<form onSubmit={save} style={{display:'grid',gap:16,marginTop:16}} data-testid="repair-override-form">
   <label style={{display:'grid',gap:6}}><span>{copy.action}</span><select className="inp" style={{minHeight:44}} value={action} onChange={e=>setAction(e.target.value as 'set'|'clear')}><option value="set">{copy.set}</option><option value="clear">{copy.clear}</option></select></label>
   {action==='set'?<label style={{display:'grid',gap:6}}><span>{copy.amount} ({capture.currency})</span><input className="inp" style={{minHeight:44}} name="threshold" inputMode="decimal" autoComplete="off" maxLength={64} value={amount} onChange={e=>{setAmount(e.target.value);setInvalid(false);}} required/></label>:<p>{copy.clearNote}</p>}
   {invalid?<p role="alert">{copy.invalid}</p>:null}<div style={{display:'flex',flexWrap:'wrap',gap:8}}><button className="btn pri" style={{minHeight:44}} type="submit">{copy.save}</button><button className="btn" style={{minHeight:44}} type="button" onClick={()=>{setCapture(null);setPhase('unavailable');}}>{copy.cancel}</button></div>
  </form>:null}
  {(phase==='idle'||phase==='loading')&&view.state==='enabled'?<button className="btn" type="button" style={{minHeight:44,marginTop:12}} disabled={phase==='loading'} onClick={()=>void start()}>{copy.edit}</button>:null}
  {phase==='unavailable'?<p role="alert">{copy.unavailable}</p>:null}
  {phase==='loading'||phase==='pending'?<p role="status">{copy.working}</p>:null}{phase==='storage'?<p role="alert">{copy.storage}</p>:null}
  {phase==='unknown'?<><p role="alert">{result?.status==='busy'?copy.busy:result?.status==='request_mismatch'?copy.mismatch:copy.unknown}</p><div style={{display:'flex',flexWrap:'wrap',gap:8}}><button className="btn" style={{minHeight:44}} type="button" disabled={!requestId} onClick={()=>requestId&&void send('status',requestId)}>{copy.check}</button><button className="btn" style={{minHeight:44}} type="button" disabled={!requestId} onClick={()=>requestId&&void send('close',requestId)}>{copy.close}</button></div></>:null}
  {phase==='done'?<><p role="status" data-testid="repair-override-result">{message()}</p>{view.state==='enabled'?<button className="btn" style={{minHeight:44}} type="button" onClick={()=>void start()}>{copy.newEdit}</button>:null}</>:null}
  {phase==='done'||phase==='unknown'||phase==='storage'||phase==='unavailable'||view.state!=='enabled'?<button className="btn" style={{minHeight:44,marginTop:12}} type="button" onClick={()=>window.location.reload()}>{copy.refresh}</button>:null}
 </section>;
}
