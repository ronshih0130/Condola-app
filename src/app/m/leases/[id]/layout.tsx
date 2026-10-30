import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { EsignUnavailable, esignAvailableFor, esignEnabled, management } from "@/server/esign/access";
import { esignFlow } from "@/server/esign/flow";
import { EsignSection } from "@/components/esign-section";

export const dynamic = "force-dynamic";

export default async function LeaseEsignLayout({ children, params }: {
  children: ReactNode; params: Promise<{ id: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  if (!esignEnabled()) return children;
  const session = await getSession();
  if (!management(session)) return children;
  if (!(await esignAvailableFor(session))) return children;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  try {
    const view = await esignFlow.list(session, id);
    return <>{children}<EsignSection view={view} locale={session.locale} /></>;
  } catch (error) {
    if (error instanceof EsignUnavailable) return children;
    throw error;
  }
}
