import React from "react";
import { notFound } from "next/navigation";
import { brandTenantOne } from "../../../../server/b3-tenant-one";
import { FlowError, logServerError } from "../../../../server/errors";
import type { Session } from "../../../../server/types";
import { readSetupStep } from "../../../../server/onboarding-progress";
import { emptyPageAction, emptyActionAllowed } from "../../../../lib/empty-cta";
import { TenantOneView } from "./tenant-one";

export async function TenantOneV3Page({ session,id }: { session: Session; id: string }) {
  let data;
  let canAddLease = false;
  try {
    data = await brandTenantOne(session,id);
    if (data.state==="ready" && !data.leases.length) {
      const setup = await readSetupStep(session);
      canAddLease = emptyActionAllowed(emptyPageAction("TENID"),setup,key => setup.permissions.includes(key));
    }
  } catch (error) {
    const forbidden = error instanceof FlowError && error.key==="errors.forbidden";
    if (!forbidden) logServerError("b3_tenant_one_page",error);
    return <TenantOneView data={{state:forbidden ? "forbidden" : "unavailable"}} locale={session.locale} id={id} />;
  }
  if (data.state==="not_found") notFound();
  return <TenantOneView data={data} locale={session.locale} id={id} canAddLease={canAddLease} />;
}
