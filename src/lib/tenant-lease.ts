import { redirect } from "next/navigation";
import { tenantLeases } from "@/server/queries";
import { getSession } from "@/server/session";

export async function selectedLease() {
  const session = await getSession();
  const leases = await tenantLeases(session);
  if (leases.length > 1 && !session.leaseId) redirect("/t");
  const lease = leases.find((item) => item.lease_id === session.leaseId) ?? leases[0] ?? null;
  return { session, lease };
}
