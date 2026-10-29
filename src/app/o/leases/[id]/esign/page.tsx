import { notFound } from "next/navigation";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { EsignDenied, esignEnabled } from "@/server/esign/access";
import { esignFlow } from "@/server/esign/flow";
import { EsignSection } from "@/components/esign-section";

export const dynamic = "force-dynamic";

export default async function OwnerEsignPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCurrentConsent(undefined, "page");
  if (!esignEnabled()) notFound();
  const session = await getSession();
  if (session.kind !== "owner") notFound();
  const { id } = await params;
  try {
    return <EsignSection view={await esignFlow.list(session, id)} locale={session.locale} />;
  } catch (error) {
    if (error instanceof EsignDenied) notFound();
    throw error;
  }
}
