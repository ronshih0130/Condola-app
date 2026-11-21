import React from "react";
import { brandTenants, type TenantsInput } from "../../../../server/b3-tenants";
import { FlowError, logServerError } from "../../../../server/errors";
import type { Session } from "../../../../server/types";
import { readSetupStep } from "../../../../server/onboarding-progress";
import { emptyPageAction, emptyActionAllowed } from "../../../../lib/empty-cta";
import { TenantsView } from "./tenants";

export async function TenantsV3Page({ session,params }: { session: Session; params: TenantsInput }) {
  try {
    const data = await brandTenants(session,params);
    let canInvite = false;
    if (data.state==="ready" && data.total===0 && !data.q && data.filter==="all") {
      const setup = await readSetupStep(session);
      canInvite = emptyActionAllowed(emptyPageAction("TEN"),setup,key => setup.permissions.includes(key));
    }
    return <TenantsView data={data} locale={session.locale} params={params} canInvite={canInvite} />;
  } catch (error) {
    const forbidden = error instanceof FlowError && error.key==="errors.forbidden";
    if (!forbidden) logServerError("b3_tenants_page",error);
    return <TenantsView data={{state:forbidden ? "forbidden" : "unavailable"}} locale={session.locale} params={params} />;
  }
}
