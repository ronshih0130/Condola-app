import React from "react";
import { notFound } from "next/navigation";
import { brandLease, brandLeases, type LeasesInput } from "../../../../server/b3-leases";
import { FlowError, logServerError } from "../../../../server/errors";
import { readHandover } from "../../../../server/handover";
import { landingV3 } from "../../../../server/nav-v3";
import { readSetupStep } from "../../../../server/onboarding-progress";
import type { Session } from "../../../../server/types";
import { emptyActionAllowed, emptyPageAction } from "../../../../lib/empty-cta";
import { LeasesView } from "./leases";
import { LeaseView, leaseV3Tab } from "./lease";

export async function LeasesV3Page({ session, params }: { session: Session; params: LeasesInput }) {
  try {
    const data = await brandLeases(session, params);
    let canCreate = false;
    if (data.state === "ready" && data.total === 0 && !data.q) {
      // The existing create flow's own admission (leases.edit + its loaders), as on R2-TEN-ONE.
      const setup = await readSetupStep(session);
      canCreate = emptyActionAllowed(emptyPageAction("LEASE"), setup, key => setup.permissions.includes(key));
    }
    return <LeasesView data={data} locale={session.locale} params={params} canCreate={canCreate} />;
  } catch (error) {
    const forbidden = error instanceof FlowError && error.key === "errors.forbidden";
    if (!forbidden) logServerError("b3_leases_page", error);
    return <LeasesView data={{ state: forbidden ? "forbidden" : "unavailable" }} locale={session.locale} params={params} />;
  }
}

/** Same check as the existing HandoverEntry: the destination's own gateway admits this session. */
async function handoverReadable(session: Session, leaseId: string) {
  try { await readHandover(session, leaseId); return true; } catch { return false; }
}

export async function LeaseV3Page({ session, id, tab }: { session: Session; id: string; tab?: string }) {
  const view = leaseV3Tab(tab);
  let data;
  let handover = false;
  try {
    data = await brandLease(session, id);
    if (data.state === "ready") handover = await handoverReadable(session, data.id);
  } catch (error) {
    const forbidden = error instanceof FlowError && error.key === "errors.forbidden";
    if (!forbidden) logServerError("b3_lease_page", error);
    return <LeaseView data={{ state: forbidden ? "forbidden" : "unavailable" }} locale={session.locale} id={id} tab={view} home={landingV3(session)} />;
  }
  if (data.state === "not_found") notFound();
  return <LeaseView data={data} locale={session.locale} id={id} tab={view} handover={handover} home={landingV3(session)} />;
}
