import type { ReactNode } from "react";
import { requireCurrentConsent } from "@/server/consent-gate";
import { selectedLease } from "@/lib/tenant-lease";
import { EsignDenied, esignEnabled } from "@/server/esign/access";
import { esignFlow } from "@/server/esign/flow";
import { EsignSection } from "@/components/esign-section";

export const dynamic = "force-dynamic";

export default async function TenantEsignLayout({ children }: { children: ReactNode }) {
  await requireCurrentConsent(undefined, "page");
  if (!esignEnabled()) return children;
  const { session, lease } = await selectedLease();
  if (!lease) return children;
  try {
    const view = await esignFlow.list(session, lease.lease_id);
    return <>{children}<EsignSection view={view} locale={session.locale} /></>;
  } catch (error) {
    if (error instanceof EsignDenied) return children;
    throw error;
  }
}
