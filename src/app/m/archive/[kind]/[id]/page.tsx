import Link from 'next/link';
import {notFound} from 'next/navigation';
import {ArchivePanel} from '@/components/record-archive';
import {archiveCopy} from '@/i18n/record-archive';
import {isArchiveRef} from '@/lib/record-archive';
import {requireCurrentConsent} from '@/server/consent-gate';
import {archiveScope,archiveView} from '@/server/record-archive';
import {getSession} from '@/server/session';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{kind:string;id:string}>}){await requireCurrentConsent(undefined,'page');const s=await getSession(),ref=await params;if(!isArchiveRef(ref))notFound();const v=await archiveView(s,ref);if(v.state!=='ready')notFound();const scope=archiveScope(s);return <><p><Link href="/m/archive">{archiveCopy(s.locale).back}</Link></p><ArchivePanel key={`${scope.orgId}:${scope.actorId}:${scope.environment}:${ref.kind}:${ref.id}`} initial={v} scope={scope} locale={s.locale}/></>;}
