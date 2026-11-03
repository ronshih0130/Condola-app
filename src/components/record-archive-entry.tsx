import Link from 'next/link';
import type {ArchiveRef} from '@/lib/record-archive';
import {archiveCopy} from '@/i18n/record-archive';
export function ArchiveEntry({refValue,locale}:{refValue:ArchiveRef;locale:string}) {const t=archiveCopy(locale);return <Link className="btn" href={`/m/archive/${refValue.kind}/${refValue.id}`}>{t.entry}</Link>;}
