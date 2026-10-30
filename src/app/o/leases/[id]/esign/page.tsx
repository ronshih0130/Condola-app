import { notFound } from "next/navigation";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { EsignDenied, EsignUnavailable, esignAvailableFor, esignEnabled } from "@/server/esign/access";
import { esignFlow } from "@/server/esign/flow";
import { EsignSection } from "@/components/esign-section";

export const dynamic = "force-dynamic";

export default async function OwnerEsignPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCurrentConsent(undefined, "page");
  if (!esignEnabled()) notFound();
  const session = await getSession();
  if (session.kind !== "owner") notFound();
  if (!(await esignAvailableFor(session))) notFound();
  const { id } = await params;
  try {
    return <EsignSection view={await esignFlow.list(session, id)} locale={session.locale} />;
  } catch (error) {
    if (error instanceof EsignDenied || error instanceof EsignUnavailable) notFound();
    throw error;
  }
}
