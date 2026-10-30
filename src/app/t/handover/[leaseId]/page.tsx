import { notFound } from "next/navigation";
import { HandoverPage } from "@/components/handover-page";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ leaseId: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession(); if (session.kind !== "tenant") notFound();
  const { leaseId } = await params;
  try { return await HandoverPage({ session, leaseId }); } catch { notFound(); }
}
