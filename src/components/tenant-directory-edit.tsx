'use client';
import {useEffect,useRef,useState} from 'react';
import type {Locale} from '@/i18n';
import {directoryEditCopy} from '@/i18n/lanes/tenant-directory-edit';
import type {DirectoryEditResult,DirectoryEditView} from '@/server/tenant-directory-edit';

type Props={locale:Locale;scope:string;contactId:string;view:DirectoryEditView};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function TenantDirectoryEditor({locale,scope,contactId,view}:Props){
 const copy=directoryEditCopy(locale),key=`b015-edit:${scope}:${contactId}`;
 const [phase,setPhase]=useState<'loading'|'idle'|'editing'|'pending'|'unknown'|'done'|'storage'>('loading');
 const [requestId,setRequestId]=useState<string|null>(null),[result,setResult]=useState<DirectoryEditResult|null>(null);
 const [name,setName]=useState(view.state==='enabled'?view.name:''),[email,setEmail]=useState(view.state==='enabled'?view.email??'':''),[phone,setPhone]=useState(view.state==='enabled'?view.phone??'':'');
 const [expected,setExpected]=useState(view.state==='enabled'?view.expected:'');
 const working=useRef(false);
 async function send(body:Record<string,string>,reload:boolean){
  if(working.current)return;working.current=true;setPhase('pending');
  try{
   const response=await fetch('/api/tenant-directory/edit',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
   const value:DirectoryEditResult=response.ok?await response.json():{status:'unknown'};
   if(value.status==='recorded'&&value.request_id===body.requestId){setResult(value);setPhase('done');if(reload)window.location.reload();}
   else{setResult(value);setPhase('unknown');}
  }catch{setResult({status:'unknown'});setPhase('unknown');}
  finally{working.current=false;}
 }
 useEffect(()=>{
  let stored:string|null;
  try{stored=sessionStorage.getItem(key);}catch{setPhase('storage');return;}
  if(stored!==null){if(!UUID.test(stored)){setPhase('storage');return;}setRequestId(stored);void send({mode:'status',contactId,requestId:stored},false);}
  else setPhase('idle');
  // The scope/contact key defines one mounted command lifecycle. Its own status
  // call is read-only; no mutation is retried by mount or hydration.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key]);
 function start(){
  if(working.current||view.state!=='enabled')return;
  try{const stored=sessionStorage.getItem(key);if(stored!==null&&(!UUID.test(stored))){setPhase('storage');return;}
   if(stored!==null&&(phase!=='done'||stored!==requestId)){setRequestId(stored);setPhase('unknown');return;}
   if(phase==='done'){sessionStorage.removeItem(key);if(sessionStorage.getItem(key)!==null)throw new Error('Storage unavailable');}}
  catch{setPhase('storage');return;}
  setRequestId(null);setResult(null);setName(view.name);setEmail(view.email??'');setPhone(view.phone??'');setExpected(view.expected);setPhase('editing');
 }
 function save(event:React.FormEvent){
  event.preventDefault();if(working.current||phase!=='editing'||view.state!=='enabled')return;
  let id:string;try{const prior=sessionStorage.getItem(key);if(prior!==null){if(!UUID.test(prior))throw new Error('Storage unavailable');setRequestId(prior);setPhase('unknown');return;}id=crypto.randomUUID();sessionStorage.setItem(key,id);if(sessionStorage.getItem(key)!==id)throw new Error('Storage unavailable');}catch{setPhase('storage');return;}
  setRequestId(id);void send({mode:'edit',requestId:id,contactId,expected,name,email,phone},true);
 }
 function recordedMessage(){if(result?.status!=='recorded')return copy.unknown;switch(result.outcome){case 'changed':return copy.changed;case 'no_change':return copy.noChange;case 'cancelled':return copy.cancelled;case 'rejected_conflict':return copy.conflict;case 'rejected_invalid':return copy.invalid;case 'rejected_disabled':return copy.disabled;case 'rejected_unavailable':return copy.missing;case 'rejected_email_exists':return copy.emailExists;}}
 if((phase==='idle'||phase==='loading')&&view.state==='disabled')return null;
 return <section className="card pad" data-testid="directory-editor" aria-label={copy.title} style={{padding:16,marginTop:16}}>
  <h3>{copy.title}</h3><p style={{marginBlock:12}}>{copy.note}</p>
  {view.state==='enabled'&&(view.isOwner||view.isVendor)?<p data-testid="directory-shared-contact" style={{marginBlock:12}}>{copy.shared}</p>:null}
  {phase==='editing'&&view.state==='enabled'?<form onSubmit={save} data-testid="directory-edit-form" style={{display:'grid',gap:16}}>
   <label style={{display:'grid',gap:6}}><span className="f">{copy.name}</span><input className="inp" name="name" value={name} onChange={e=>setName(e.target.value)} maxLength={120} required autoComplete="off"/></label>
   <label style={{display:'grid',gap:6}}><span className="f">{copy.email}</span><input className="inp" name="email" type="email" value={email} onChange={e=>setEmail(e.target.value)} maxLength={320} autoComplete="off"/></label>
   <label style={{display:'grid',gap:6}}><span className="f">{copy.phone}</span><input className="inp" name="phone" type="tel" value={phone} onChange={e=>setPhone(e.target.value)} maxLength={32} autoComplete="off"/></label>
   <div className="acts" style={{display:'flex',flexWrap:'wrap',gap:8}}><button className="btn primary" type="submit">{copy.save}</button><button className="btn" type="button" onClick={()=>setPhase('idle')}>{copy.cancel}</button></div>
  </form>:null}
  {phase==='loading'||phase==='pending'?<p role="status">{copy.working}</p>:null}
  {phase==='storage'?<p role="alert">{copy.storage}</p>:null}
  {phase==='unknown'?<><p role="alert">{result?.status==='busy'?copy.busy:result?.status==='request_mismatch'?copy.mismatch:copy.unknown}</p><div className="acts" style={{display:'flex',flexWrap:'wrap',gap:8,marginBlock:12}}><button className="btn" type="button" disabled={!requestId} onClick={()=>requestId&&void send({mode:'status',contactId,requestId},true)}>{copy.check}</button><button className="btn" type="button" disabled={!requestId} onClick={()=>requestId&&void send({mode:'close',contactId,requestId},true)}>{copy.close}</button></div></>:null}
  {phase==='done'?<><p role="status" data-testid="directory-edit-result">{recordedMessage()}</p>{view.state==='enabled'?<button className="btn" type="button" onClick={start}>{copy.newEdit}</button>:null}</>:null}
  {(phase==='idle'||phase==='loading')&&view.state==='enabled'?<button className="btn" type="button" disabled={phase==='loading'} onClick={start}>{copy.edit}</button>:null}
  {phase==='idle'&&['busy','unavailable','recovery_only'].includes(view.state)?<p role="status">{copy.unavailable}</p>:null}
  {['done','storage','unknown'].includes(phase)||view.state==='busy'||view.state==='unavailable'||view.state==='recovery_only'?<button className="btn" type="button" onClick={()=>window.location.reload()}>{copy.refresh}</button>:null}
 </section>;
}
