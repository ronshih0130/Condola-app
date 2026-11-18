import { Suspense } from "react";
import { notFound } from "next/navigation";
import { OwnerUnitLoading } from "@/components/v3/owner/unit";
import { OwnerUnitPage } from "@/components/v3/owner/unit-page";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-092 / RO-UNIT (總覽 › 我的物件 › one space, OWN-33-AC2/AC4). Exists only under brand_v3; OFF is a 404. */
export default async function OwnerUnitRoute({ params, searchParams }: {
  params: Promise<{ unitId: string }>; searchParams: Promise<{ room?: string | string[] }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  if (!(await brandV3EnabledForOrg(session.orgId))) notFound();
  const { unitId } = await params;
  const { room } = await searchParams;
  return <Suspense key={`${unitId}:${typeof room === "string" ? room : ""}`} fallback={<OwnerUnitLoading locale={session.locale} />}>
    <OwnerUnitPage session={session} unitId={unitId} roomId={room ?? null} />
  </Suspense>;
}
