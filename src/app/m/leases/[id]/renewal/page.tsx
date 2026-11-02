import Link from "next/link";
import { notFound } from "next/navigation";
import { RenewalComparison } from "@/components/renewal-comparison";
import { renewalCopy } from "@/i18n/renewal";
import { requireCurrentConsent } from "@/server/consent-gate";
import { renewalComparisonView } from "@/server/renewal-comparison";
import { getSession } from "@/server/session";
export const dynamic="force-dynamic";
export default async function Page({params}:{params:Promise<{id:string}>}) {
 await requireCurrentConsent(undefined,"page");const session=await getSession(),{id}=await params,view=await renewalComparisonView(session,id);if(!view)notFound();
 return <><p><Link href={`/m/leases/${id}`}>{renewalCopy(session.locale).back}</Link></p><RenewalComparison key={`${id.toLowerCase()}:${view.fingerprint}`} leaseId={id} current={view.terms} fingerprint={view.fingerprint} locale={session.locale} calendar={session.calendar}/></>;
}
