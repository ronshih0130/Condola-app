import React from 'react';
import Link from 'next/link';
import {archiveCopy} from '../../../../i18n/record-archive';
import {archiveV3Copy,archiveText} from '../../../../i18n/lanes/brand-v3-archive';
import type {ArchiveItem,ArchiveList,ArchiveReady,ArchiveTab} from '../../../../lib/record-archive';
export function archiveHref(tab:ArchiveTab='all',after?:string|null) {
 const query=new URLSearchParams();if(tab!=='all')query.set('tab',tab);if(after)query.set('after',after);
 return `/m/archive${query.size?`?${query}`:''}`;
}
export function ArchiveLoading({locale}:{locale:string}) {
 return <section className="v3-archive" aria-busy="true"><p role="status">{archiveV3Copy(locale).loading}</p></section>;
}
export function ArchiveListView({data,locale,tab='all',admin=false}:{data:ArchiveList;locale:string;tab?:ArchiveTab;admin?:boolean}) {
 const c=archiveV3Copy(locale),t=archiveCopy(locale);
 if(data.state!=='ready'||!data.counts)return <section className="v3-archive"><h1>{c.title}</h1><div role="alert"><p>{c.failed}</p><Link className="btn" href={archiveHref(tab)}>{c.retry}</Link></div></section>;
 const {counts}=data;
 return <main className="v3-archive" data-testid="v3-archive-list">
  <header className="v3-archive-lead"><h1>{archiveText(c.lead,{n:counts.total,a:counts.property,b:counts.unit,c:counts.owner})}</h1><p>{c.retained}</p></header>
  <nav aria-label={c.title}>{(['all','property','unit','owner'] as const).map(kind=><Link className="btn" key={kind} aria-current={kind===tab?'page':undefined} href={archiveHref(kind)}>{c[kind]}</Link>)}</nav>
  {/* P52 (PENDING-RON PR-018): never imply unsupported owner records were queried. */}
  <p className="muted">{c.ownerUnavailable}</p>
  {!data.rows.length?<p role="status">{c.empty}</p>:<div className="v3-archive-card"><table><thead><tr><th scope="col">{c.name}</th><th scope="col">{c.kind}</th><th scope="col">{c.archived}</th><th scope="col"><span className="sr-only">{c.view}</span></th></tr></thead>
   <tbody>{data.rows.map(row=>{
    const href=`/m/archive/${row.ref.kind}/${row.ref.id}`,date=row.archivedAtUtc??row.inherited[0]?.archivedAtUtc;
    return <tr key={`${row.ref.kind}:${row.ref.id}`}><th scope="row"><Link href={href}>{row.propertyName}{row.unitLabel?` / ${row.unitLabel}`:''}{row.roomLabel?` / ${row.roomLabel}`:''}</Link></th>
     <td data-label={c.kind}>{row.ref.kind==='property'?c.property:c.unit}</td><td data-label={c.archived}>{date?<time dateTime={date}>{date.slice(0,10)}</time>:c.unknownDate}<span className="v3-archive-by">{row.archivedBy??c.unknownActor}</span>{!row.archivedAtUtc&&<span className="v3-archive-by">{t.inherited}</span>}</td>
     <td>{admin&&row.restoreEligible&&<Link className="btn" href={`${href}?restore=1`}>{t.restore}</Link>}<Link className="v3-archive-text" href={href}>{c.view}</Link></td></tr>;
   })}</tbody></table></div>}
  {data.nextCursor&&<Link className="btn" href={archiveHref(tab,data.nextCursor)}>{t.next}</Link>}
 </main>;
}
export function ArchiveHistory({items,locale}:{items:ArchiveItem[];locale:string}) {
 const t=archiveCopy(locale);
 return <ul>{items.map((item,i)=><li key={`${item.category}:${i}`}>{item.href?<Link href={item.href}>{t.labels[item.label]??t.category[item.category]}</Link>:t.labels[item.label]??t.category[item.category]}</li>)}</ul>;
}
export function ArchiveDetailView({data,locale,controls}:{data:ArchiveReady;locale:string;controls?:React.ReactNode}) {
 const c=archiveV3Copy(locale),t=archiveCopy(locale),o=data.observed,date=o.archivedAtUtc??o.inherited[0]?.archivedAtUtc;
 return <section className="v3-archive" data-testid="v3-archive-detail"><Link href="/m/archive">{t.back}</Link>
  <header className="v3-archive-lead"><h1>{date?archiveText(c.detailLead,{name:o.name}):o.name}</h1>
   {date&&<p>{archiveText(c.detailHint,{date:date.slice(0,10),name:o.archivedBy??c.unknownActor})}</p>}
   {o.inherited.length>0&&<p>{t.inherited}</p>}
   <p>{t.finance}</p>
  </header>{controls}
  <section className="v3-archive-card"><h2>{c.leases}</h2><ArchiveHistory items={data.history.filter(x=>x.category==='leases')} locale={locale}/></section>
  <section className="v3-archive-card"><h2>{c.other}</h2><ArchiveHistory items={data.history.filter(x=>x.category!=='leases')} locale={locale}/></section>
 </section>;
}
export function ArchiveBlocker({item,locale}:{item:ArchiveItem;locale:string}) {
 const c=archiveV3Copy(locale),t=archiveCopy(locale);
 const action={leases:c.leaseAction,signing:c.signingAction,repairs:c.repairAction,dispatch:c.dispatchAction,utilities:c.utilityAction,finance:t.category.finance,invitations:t.category.invitations}[item.category];
 // No fabricated count: older responses can still reuse their existing sentence.
 return <><h2>{c.blocked}</h2><p>{item.label==='lease_active'&&item.count!==undefined?archiveText(c.activeLease,{n:item.count}):t.labels[item.label]??t.category[item.category]}</p>{item.href&&<Link className="btn pri" href={item.href}>{action}</Link>}</>;
}
