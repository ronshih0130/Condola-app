import {brandV3EnabledForOrg} from '@/server/brand-v3';
import {ArchiveDetailV3} from '@/components/v3/m/archive/controls';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {ArchivePanel} from '@/components/record-archive';
import {archiveCopy} from '@/i18n/record-archive';
import {isArchiveRef} from '@/lib/record-archive';
import {requireCurrentConsent} from '@/server/consent-gate';
import {archiveScope,archiveView} from '@/server/record-archive';
import {getSession} from '@/server/session';
export const dynamic='force-dynamic';
type PageProps={params:Promise<{kind:string;id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>};
export default async function Page({params}:PageProps){await requireCurrentConsent(undefined,'page');const s=await getSession(),ref=await params;if(!isArchiveRef(ref))notFound();const v3=await brandV3EnabledForOrg(s.orgId);const v=await archiveView(s,ref,v3);if(v.state!=='ready')notFound();const scope=archiveScope(s);
if(v3) {
 // eslint-disable-next-line @next/next/no-css-tags
 return <><link rel="stylesheet" href="/brand/v3/archive.css"/><ArchiveDetailV3 key={`${scope.orgId}:${scope.actorId}:${scope.environment}:${ref.kind}:${ref.id}`} initial={v} scope={scope} locale={s.locale} role={s.role}/></>;
}
return <><p><Link href="/m/archive">{archiveCopy(s.locale).back}</Link></p><ArchivePanel key={`${scope.orgId}:${scope.actorId}:${scope.environment}:${ref.kind}:${ref.id}`} initial={v} scope={scope} locale={s.locale}/></>;}
