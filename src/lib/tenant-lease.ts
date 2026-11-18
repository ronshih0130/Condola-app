import { redirect } from "next/navigation";
import { tenantLeases } from "@/server/queries";
import { getSession } from "@/server/session";
import type { Session } from "@/server/types";

/** The tenant's selected lease. A page that already read the session (to read a flag first) passes it in. */
export async function selectedLease(current?: Session) {
  const session = current ?? await getSession();
  const leases = await tenantLeases(session);
  if (leases.length > 1 && !session.leaseId) redirect("/t");
  const lease = leases.find((item) => item.lease_id === session.leaseId) ?? leases[0] ?? null;
  return { session, lease };
}
