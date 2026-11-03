import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OwnerTransfers } from '@/components/owner-transfers';
import { ownerTransferCopy } from '@/i18n/owner-transfer';
import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { ownerTransferView } from '@/server/owner-transfers';
export const dynamic='force-dynamic';
export default async function Page(){await requireCurrentConsent(undefined,'page');const s=await getSession(),view=await ownerTransferView(s);if(!view)notFound();return <><p><Link href="/m/statements">{ownerTransferCopy(s.locale).back}</Link></p><OwnerTransfers key={`${s.orgId}:${s.userId}:${s.environment}`} view={view} locale={s.locale} scope={`${s.orgId}:${s.userId}:${s.environment}`} expectedScope={{userId:s.userId,orgId:s.orgId,liveOrgId:s.liveOrgId,environment:s.environment}}/></>;}
