import { Suspense } from "react";
import { notFound } from "next/navigation";
import { DecidedLoading } from "@/components/v3/o/decided/decided";
import { DecidedListPage } from "@/components/v3/o/decided/page";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-093 / RO-DECIDED (更多 › 核准紀錄, OWN-35). Exists only under brand_v3; OFF is a 404. */
export default async function OwnerDecidedPage({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  if (!(await brandV3EnabledForOrg(session.orgId))) notFound();
  const { after } = await searchParams;
  return <Suspense key={typeof after === "string" ? after : "first"} fallback={<DecidedLoading locale={session.locale} />}>
    <DecidedListPage session={session} after={after} />
  </Suspense>;
}
