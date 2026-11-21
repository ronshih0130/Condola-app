import {Suspense} from 'react';
import {brandV3EnabledForOrg} from '@/server/brand-v3';
import {ArchiveListPageV3} from '@/components/v3/m/archive/pages';
import {ArchiveLoading} from '@/components/v3/m/archive/views';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {archiveCopy} from '@/i18n/record-archive';
import {requireCurrentConsent} from '@/server/consent-gate';
import {archiveList} from '@/server/record-archive';
import {getSession} from '@/server/session';
export const dynamic='force-dynamic';
type PageProps={searchParams:Promise<{after?:string|string[];tab?:string|string[]}>};
export default async function Page({searchParams}:PageProps){await requireCurrentConsent(undefined,'page');const s=await getSession(),{after,tab}=await searchParams;if(Array.isArray(after))notFound();
if(await brandV3EnabledForOrg(s.orgId)) {
 if(Array.isArray(tab)||tab!==undefined&&!['all','property','unit','owner'].includes(tab))notFound();
 // eslint-disable-next-line @next/next/no-css-tags
 return <><link rel="stylesheet" href="/brand/v3/archive.css"/><Suspense key={`${tab??'all'}:${after??''}`} fallback={<ArchiveLoading locale={s.locale}/>}><ArchiveListPageV3 session={s} after={after} tab={tab as 'all'|'property'|'unit'|'owner'|undefined}/></Suspense></>;
}
const v=await archiveList(s,after),t=archiveCopy(s.locale);if(v.state!=='ready')notFound();return <main><h1>{t.list}</h1>{!v.rows.length&&(after===undefined?<p>{t.empty}</p>:<><p>{t.emptyPage}</p><Link href='/m/archive'>{t.firstPage}</Link></>)}<ul>{v.rows.map(x=><li key={`${x.ref.kind}:${x.ref.id}`}><Link href={`/m/archive/${x.ref.kind}/${x.ref.id}`}>{x.propertyName}{x.unitLabel?` / ${x.unitLabel}`:''}{x.roomLabel?` / ${x.roomLabel}`:''}</Link> — {x.archivedAtUtc?t.archived:t.inherited}</li>)}</ul>{v.nextCursor&&<Link href={{pathname:'/m/archive',query:{after:v.nextCursor}}}>{t.next}</Link>}</main>;}
