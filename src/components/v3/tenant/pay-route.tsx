import React, { Suspense, type ReactNode } from "react";
import { tenantPayView } from "../../../server/b090-tenant-pay";
import type { Session } from "../../../server/types";
import { TenantPayLoading, TenantPayState, type TenantPayMode } from "./pay";
import type { ReportAction } from "./pay-client";

type Props = { session: Session; leaseId: string; place: string; company: string; brand: string; report: boolean; errorKey: string | undefined; action: ReportAction; legacy: () => Promise<ReactNode> };

/** RT-PAY / RT-REPORT data in its own boundary so the skeleton shows while the readers run (TEN-52-AC5). */
async function TenantPayBody({ session, leaseId, place, company, brand, report, errorKey, action, legacy }: Props) {
  const view = await tenantPayView(session, leaseId);
  // A fresh id per server render remounts the report form after each send, so a failed send restores its draft.
  const mode: TenantPayMode = { report, errorKey, renderId: globalThis.crypto.randomUUID() };
  return <TenantPayState view={view} locale={session.locale} place={place} company={company} brand={brand} owner={{ userId: session.userId, orgId: session.orgId, leaseId }} mode={mode} action={action}
    legacy={view.state === "off" ? await legacy() : null} />;
}

export function TenantPayV3Route(props: Props) {
  return <Suspense fallback={<TenantPayLoading />}><TenantPayBody {...props} /></Suspense>;
}
