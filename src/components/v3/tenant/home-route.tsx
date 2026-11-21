import React, { Suspense, type ReactNode } from "react";
import { tenantHomeView } from "../../../server/b090-tenant-home";
import type { Session } from "../../../server/types";
import { TenantHomeLoading, TenantHomeState } from "./home";

/** RT-HOME data in its own boundary so the skeleton shows while the readers run (TEN-54-AC4). */
async function TenantHomeBody({ session, leaseId, company, legacy }: { session: Session; leaseId: string; company: string; legacy: () => Promise<ReactNode> }) {
  const view = await tenantHomeView(session, leaseId);
  return <TenantHomeState view={view} locale={session.locale} name={session.name} company={company} legacy={view.state === "off" ? await legacy() : null} />;
}

export function TenantHomeV3Route(props: { session: Session; leaseId: string; company: string; legacy: () => Promise<ReactNode> }) {
  return <Suspense fallback={<TenantHomeLoading />}><TenantHomeBody {...props} /></Suspense>;
}
