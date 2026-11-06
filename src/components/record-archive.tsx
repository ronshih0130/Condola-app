"use client";
import Link from 'next/link';
import {useEffect,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {archiveCommandAction,archiveViewAction} from '@/server/record-archive-actions';
import {isArchiveRef,isRenderedArchiveScope,sameArchiveScope,type ArchiveCommandInput,type ArchiveReady,type ArchiveRef,type RenderedArchiveScope} from '@/lib/record-archive';
import {archiveCopy} from '@/i18n/record-archive';
type Pending=Omit<ArchiveCommandInput,'reason'>;
function pendingFromStorage(raw:string|null,scope:RenderedArchiveScope,ref:ArchiveRef):Pending|null {
 if(raw===null)return null;if(raw.length>4096)throw new Error('Invalid pending data');const v:unknown=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid pending data');const p=v as Pending;
 if(Object.keys(p).sort().join(',')!=='desired,expectedVersion,ref,renderedScope,requestId'||!isArchiveRef(p.ref)||Object.keys(p.ref).sort().join(',')!=='id,kind'||p.ref.kind!==ref.kind||p.ref.id!==ref.id||!isRenderedArchiveScope(p.renderedScope)||Object.keys(p.renderedScope).sort().join(',')!=='actorId,environment,liveOrgId,orgId'||!sameArchiveScope(p.renderedScope,scope)||(p.desired!=='archived'&&p.desired!=='active')||typeof p.expectedVersion!=='string'||!/^[a-f0-9]{64}$/.test(p.expectedVersion)||typeof p.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.requestId))throw new Error('Invalid pending data');return p;
}
export function ArchivePanel({initial,scope,locale}:{initial:ArchiveReady;scope:RenderedArchiveScope;locale:string}){
 const t=archiveCopy(locale),router=useRouter(),ref=initial.observed.ref,key=`record-archive:${scope.orgId}:${scope.actorId}:${scope.environment}:${ref.kind}:${ref.id}`;
 const [current,setCurrent]=useState(initial),[pending,setPending]=useState<Pending|null>(null),[ready,setReady]=useState(false),[storageError,setStorageError]=useState(false),[reason,setReason]=useState(''),[message,setMessage]=useState(''),[reviewed,setReviewed]=useState(false),[busy,start]=useTransition();
 useEffect(()=>{try{setPending(pendingFromStorage(sessionStorage.getItem(key),scope,ref));setReady(true);}catch{setStorageError(true);setReady(true);}},[key,scope.actorId,scope.orgId,scope.liveOrgId,scope.environment,ref.kind,ref.id]);
 const effectiveArchived=!!current.observed.archivedAtUtc||current.observed.inherited.length>0;
 function clearPending(intent:Pending){const saved=pendingFromStorage(sessionStorage.getItem(key),scope,ref);if(!saved||JSON.stringify(saved)!==JSON.stringify(intent))throw new Error('Pending data changed');sessionStorage.removeItem(key);}
 function submit(desired:'archived'|'active'){
  if(!ready||busy||storageError||pending)return;if(!reason.trim()||reason.length>500){setMessage(t.reasonRequired);return;}
  const intent:Pending={ref,desired,expectedVersion:current.observed.version,renderedScope:scope,requestId:crypto.randomUUID()};
  try{if(pendingFromStorage(sessionStorage.getItem(key),scope,ref))throw new Error('Pending');sessionStorage.setItem(key,JSON.stringify(intent));}catch{setStorageError(true);return;}
  setPending(intent);setMessage('');setReviewed(false);start(async()=>{try{const result=await archiveCommandAction({...intent,reason});if(result.state==='changed'){clearPending(intent);setPending(null);setReason('');setMessage(t.changed);const fresh=await archiveViewAction(ref,intent.renderedScope);if(fresh.state==='ready')setCurrent(fresh);router.refresh();}else if(result.state==='unknown'||result.state==='stale'||result.state==='already_in_desired_state'){setMessage(result.state==='stale'?t.stale:result.state==='already_in_desired_state'?t.already:t.uncertain);}else {clearPending(intent);setPending(null);setMessage(result.state==='busy'?t.busy:result.state==='blocked'?t.blocked:result.state==='disabled'?t.disabled:result.state==='conflict'?t.conflict:t.unavailable);}}catch{setMessage(t.uncertain);}});
 }
 function review(){if(busy||!pending)return;start(async()=>{try{const v=await archiveViewAction(ref,pending.renderedScope);if(v.state==='ready'){setCurrent(v);setReviewed(true);}else setMessage(t.unavailable);}catch{setMessage(t.unavailable);}});}
 function newDecision(){if(!reviewed||!pending||busy)return;try{clearPending(pending);setPending(null);setReviewed(false);setReason('');setMessage('');}catch{setStorageError(true);}}
 return <section data-testid="archive-panel"><h1>{current.observed.name}</h1><p>{current.observed.propertyName}{current.observed.unitLabel?` / ${current.observed.unitLabel}`:''}{current.observed.roomLabel?` / ${current.observed.roomLabel}`:''}</p><p data-testid="archive-state">{current.observed.archivedAtUtc?t.own:current.observed.inherited.length?t.inherited:t.noOwn}</p>{current.observed.archivedAtUtc&&<p>{current.observed.archivedAtUtc}</p>}{current.observed.inherited.map(x=><p key={`${x.ref.kind}:${x.ref.id}`}>{t.inherited}: {x.archivedAtUtc}</p>)}<p>{t.finance}</p>
 <h2>{t.coverage}</h2><ul>{current.coverage.map(x=><li key={x.category}>{t.category[x.category]}: {x.state==='verified'?t.verified:t.unknownCoverage}</li>)}</ul>
 {([['blockers',t.blockers,current.blockers],['warnings',t.warnings,current.warnings],['history',t.history,current.history]] as const).map(([id,label,items])=><section key={id} data-testid={`archive-${id}`}><h2>{label}</h2><ul>{items.map((item,i)=><li key={`${item.category}:${i}`}>{item.href?<Link href={item.href}>{t.labels[item.label]??t.category[item.category]}</Link>:(t.labels[item.label]??t.category[item.category])}</li>)}</ul></section>)}
 {storageError&&<p role="alert">{t.storage}</p>}{pending&&!busy&&<div><p role="status">{t.uncertain}</p><button type="button" className="btn" disabled={busy} onClick={review}>{t.review}</button>{reviewed&&<><p>{t.current}: {effectiveArchived?t.archived:t.active}</p><button type="button" className="btn" disabled={busy} onClick={newDecision}>{t.startNew}</button></>}</div>}
 {message&&<p role="status">{message}</p>}{busy&&<p role="status">{t.working}</p>}
 {!pending&&!storageError&&current.writeEnabled&&(current.canArchive||current.canRestore)&&<div><label>{t.reason}<textarea className="inp" maxLength={500} value={reason} disabled={busy||!ready} onChange={e=>setReason(e.target.value)} /></label><p>{t.reasonHint}</p>{current.canArchive&&<button type="button" className="btn" disabled={busy||!ready} onClick={()=>submit('archived')}>{t.archive}</button>}{current.canRestore&&<button type="button" className="btn" disabled={busy||!ready} onClick={()=>submit('active')}>{t.restore}</button>}</div>}
 {!current.writeEnabled&&<p>{t.readOnly}</p>}</section>;
}
