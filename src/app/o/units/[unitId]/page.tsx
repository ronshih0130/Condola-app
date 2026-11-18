import { notFound } from "next/navigation";
import { OwnerUnitError, OwnerUnitNoPerm, OwnerUnitView } from "@/components/v3/owner/unit";
import { ownerUnitHref } from "@/components/v3/owner/units";
import { ownerUnit } from "@/server/b092-owner-unit";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * B-092 / RO-UNIT (總覽 › 我的物件 › one space, OWN-33-AC2/AC4). Exists only under brand_v3; OFF is a 404.
 * The read is awaited before anything renders (no Suspense; the panel has no loading design, 缺 G-LOAD), so OFF and a
 * vacant space (no vacant design yet) are real 404s. Another owner's, an unknown or an unauthorised space is
 * B1-NOPERM in place (as RO-DECIDED / RO-RULES); a failed read is the O-STATES error with a retry to this URL.
 */
export default async function OwnerUnitRoute({ params, searchParams }: {
  params: Promise<{ unitId: string }>; searchParams: Promise<{ room?: string | string[] }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  if (!(await brandV3EnabledForOrg(session.orgId))) notFound();
  const { unitId } = await params;
  const { room } = await searchParams;
  const roomId = room ?? null;
  const result = await ownerUnit(session, unitId, roomId);
  if (result.state === "off") notFound();
  if (result.state === "forbidden") return <OwnerUnitNoPerm locale={session.locale} />;
  if (result.state !== "ready") {
    return <OwnerUnitError locale={session.locale} retryHref={typeof roomId === "string" || roomId === null ? ownerUnitHref({ unitId, roomId }) : "/o"} />;
  }
  if (result.unit.vacant) notFound();
  return <OwnerUnitView unit={result.unit} locale={session.locale} calendar={session.calendar} />;
}
