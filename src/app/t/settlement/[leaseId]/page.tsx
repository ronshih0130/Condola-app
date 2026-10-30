import { notFound } from "next/navigation";
import { SettlementPage } from "@/components/settlement-page";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{leaseId:string}>;searchParams:Promise<{version?:string}>}) {
  await requireCurrentConsent(undefined,"page"); const session=await getSession();
  if(session.kind!=="tenant") notFound();
  const {leaseId}=await params, {version}=await searchParams;
  try {return await SettlementPage({session,leaseId,selected:version});}catch{notFound();}
}
