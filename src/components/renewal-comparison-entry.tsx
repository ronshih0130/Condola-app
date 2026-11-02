import Link from "next/link";
import { renewalCopy } from "@/i18n/renewal";
import { renewalComparisonView } from "@/server/renewal-comparison";
import type { Session } from "@/server/types";
export async function RenewalComparisonEntry({session,leaseId}:{session:Session;leaseId:string}) {
 if(!await renewalComparisonView(session,leaseId))return null;
 return <p><Link className="btn" data-testid="renewal-entry" href={`/m/leases/${leaseId}/renewal`}>{renewalCopy(session.locale).entry}</Link></p>;
}
