import React from "react";
import { brandLeases, type LeasesInput } from "../../../../server/b3-leases";
import { FlowError, logServerError } from "../../../../server/errors";
import { readSetupStep } from "../../../../server/onboarding-progress";
import type { Session } from "../../../../server/types";
import { emptyActionAllowed, emptyPageAction } from "../../../../lib/empty-cta";
import { LeasesView } from "./leases";

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

