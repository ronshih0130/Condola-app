import { notFound } from "next/navigation";
import { SettlementPage } from "@/components/settlement-page";
import { SettlementV2RecoveryShell } from "@/components/settlement-v2-recovery";
import { settlementV2PageContext } from "@/server/settlement-v2-page-context";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{leaseId:string}>;searchParams:Promise<{version?:string}>}) {
  await requireCurrentConsent(undefined,"page"); const session=await getSession();
  if(session.kind!=="staff") notFound();
  const {leaseId}=await params, {version}=await searchParams;
  try {const mode=await settlementV2PageContext(session,leaseId);if(mode!=="on"){const scope={actorId:session.userId.toLowerCase(),orgId:session.orgId.toLowerCase(),liveOrgId:session.liveOrgId.toLowerCase(),environment:session.environment,leaseId:leaseId.toLowerCase()};return <SettlementV2RecoveryShell scope={scope} locale={session.locale} unavailable={mode==="unavailable"}/>;}return await SettlementPage({session,leaseId,selected:version});}catch{notFound();}
}
