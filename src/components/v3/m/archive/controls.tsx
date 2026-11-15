'use client';
import React,{useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {archiveCopy} from '../../../../i18n/record-archive';
import {archiveV3Copy} from '../../../../i18n/lanes/brand-v3-archive';
import type {ArchiveReady,ArchiveRef,ArchiveView,RenderedArchiveScope} from '../../../../lib/record-archive';
import {archiveViewAction} from '../../../../server/record-archive-actions';
import {useArchiveController} from '../../../record-archive';
import {ArchiveBlocker,ArchiveDetailView,ArchiveHistory} from './views';

type Controller=ReturnType<typeof useArchiveController>;
function IntentStatus({state}:{state:Controller}) {
 const {t,pending,busy,storageError,review,reviewed,effectiveArchived,newDecision,message}=state;
 return <>{storageError&&<p role="alert">{t.storage}</p>}{pending&&!busy&&<div><p role="status">{t.uncertain}</p><button className="btn" onClick={review}>{t.review}</button>{reviewed&&<><p>{t.current}: {effectiveArchived?t.archived:t.active}</p><button className="btn" onClick={newDecision}>{t.startNew}</button></>}</div>}{message&&<p role="status">{message}</p>}{busy&&<p role="status">{t.working}</p>}</>;
}
function Decision({state,desired}:{state:Controller;desired:'archived'|'active'}) {
 const {t,reason,setReason,busy,ready,submit}=state;
 return <div className="v3-archive-decision"><label>{t.reason}<textarea maxLength={500} value={reason} disabled={busy||!ready} onChange={event=>setReason(event.target.value)}/></label><p>{t.reasonHint}</p><button className="btn pri" disabled={busy||!ready} onClick={()=>submit(desired)}>{desired==='active'?t.restore:t.archive}</button></div>;
}
export function ArchiveDialogBody({initial,scope,locale,role,close}:{initial:ArchiveReady;scope:RenderedArchiveScope;locale:string;role:string|null;close:()=>void}) {
 const state=useArchiveController({initial,scope,locale}),c=archiveV3Copy(locale),{current,t}=state;
 const blocked=current.blockers[0],archived=!!current.observed.archivedAtUtc||current.observed.inherited.length>0;
 const allowed=(role==='admin'||role==='manager')&&current.writeEnabled;
 const deciding=allowed&&!blocked&&!archived&&!state.pending&&!state.storageError&&current.canArchive;
 return <div className="v3-archive" aria-busy={state.busy}>
  {blocked&&!archived?<ArchiveBlocker item={blocked} locale={locale}/>:<><h2>{archived?t.archived:t.archive}</h2>{!archived&&<><p>{c.confirm}</p>{current.observed.ref.kind==='property'&&<p>{c.inherit}</p>}</>}</>}
  {current.warnings.length>0&&<><h3>{t.warnings}</h3><ArchiveHistory items={current.warnings} locale={locale}/></>}
  <IntentStatus state={state}/>{deciding&&<Decision state={state} desired="archived"/>}
  {!allowed&&<p>{t.readOnly}</p>}
  <button className="v3-archive-text" disabled={state.busy} onClick={close}>{deciding?c.cancel:c.close}</button>
 </div>;
}
export function ArchiveEntryV3({refValue,scope,locale,role,archived=false}:{refValue:ArchiveRef;scope:RenderedArchiveScope;locale:string;role:string|null;archived?:boolean}) {
 const [open,setOpen]=useState(false),[view,setView]=useState<ArchiveView|null>(null),[failed,setFailed]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),generation=useRef(0);
 const c=archiveV3Copy(locale),t=archiveCopy(locale),editable=role==='admin'||role==='manager';
 useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
 useEffect(()=>()=>{generation.current++;},[]);
 function close(){generation.current++;setOpen(false);trigger.current?.focus();}
 async function load(){const attempt=++generation.current;setView(null);setFailed(false);setOpen(true);try{const data=await archiveViewAction(refValue,scope);if(attempt===generation.current)setView(data);}catch{if(attempt===generation.current)setFailed(true);}}
 if(!editable||archived)return <span className="v3-archive"><Link className="v3-archive-text" href={`/m/archive/${refValue.kind}/${refValue.id}`}>{c.view}</Link></span>;
 return <span className="v3-archive">
  <button ref={trigger} type="button" className="btn" onClick={load}>{t.archive}</button>
  <dialog ref={dialog} className="v3-archive-dialog" aria-label={t.archive} onCancel={event=>{event.preventDefault();close();}}>
   {view?.state==='ready'?<ArchiveDialogBody key={`${refValue.kind}:${refValue.id}:${open}`} initial={view} scope={scope} locale={locale} role={role} close={close}/>:<div className="v3-archive">
    <p role={failed||view?.state==='unavailable'?'alert':'status'}>{failed||view?.state==='unavailable'?t.unavailable:c.loading}</p>
    {(failed||view?.state==='unavailable')&&<button className="btn" onClick={load}>{c.retry}</button>}
    <button className="v3-archive-text" onClick={close}>{c.close}</button></div>}
  </dialog>
 </span>;
}
export function ArchiveDetailV3({initial,scope,locale,role}:{initial:ArchiveReady;scope:RenderedArchiveScope;locale:string;role:string|null}) {
 const state=useArchiveController({initial,scope,locale}),{current}=state;
 return <ArchiveDetailView data={current} locale={locale} controls={<>
  <IntentStatus state={state}/>
  {role==='admin'&&current.writeEnabled&&current.canRestore&&!state.pending&&!state.storageError&&<Decision state={state} desired="active"/>}
  {!current.observed.archivedAtUtc&&!current.observed.inherited.length&&<ArchiveEntryV3 refValue={current.observed.ref} scope={scope} locale={locale} role={role}/>}
 </>}/>;
}
