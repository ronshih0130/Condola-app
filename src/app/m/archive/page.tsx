import Link from 'next/link';
import {notFound} from 'next/navigation';
import {archiveCopy} from '@/i18n/record-archive';
import {requireCurrentConsent} from '@/server/consent-gate';
import {archiveList} from '@/server/record-archive';
import {getSession} from '@/server/session';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<{after?:string|string[]}>}){await requireCurrentConsent(undefined,'page');const s=await getSession(),{after}=await searchParams;if(Array.isArray(after))notFound();const v=await archiveList(s,after),t=archiveCopy(s.locale);if(v.state!=='ready')notFound();return <main><h1>{t.list}</h1>{!v.rows.length&&(after===undefined?<p>{t.empty}</p>:<><p>{t.emptyPage}</p><Link href='/m/archive'>{t.firstPage}</Link></>)}<ul>{v.rows.map(x=><li key={`${x.ref.kind}:${x.ref.id}`}><Link href={`/m/archive/${x.ref.kind}/${x.ref.id}`}>{x.propertyName}{x.unitLabel?` / ${x.unitLabel}`:''}{x.roomLabel?` / ${x.roomLabel}`:''}</Link> — {x.archivedAtUtc?t.archived:t.inherited}</li>)}</ul>{v.nextCursor&&<Link href={{pathname:'/m/archive',query:{after:v.nextCursor}}}>{t.next}</Link>}</main>;}
