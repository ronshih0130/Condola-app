import { logServerError } from "./errors";
import { tenantRepairs } from "./queries";
import { tenantHomeRead } from "./b090-tenant-home-reader";
import { homeRepairs, tenantHomeHeadline, tenantHomeWaiting, type HomeRepairStep, type TenantHomeHeadline } from "./b090-tenant-home-rules";
import type { Session } from "./types";

/**
 * Brand 3.0 B-090 slice 1, RT-HOME (TEN-54). Called only under brand_v3. Composes two readers:
 *  - tenantHomeRead (v3-only: the selected lease's bill, billing months and the lease's waiting reports);
 *  - tenantRepairs (existing: the selected lease's repairs, under the tenant's own RLS).
 * "off" (tenant_payment_history not live for the org) hands the page back to the existing home body.
 */
export type TenantHomeRepair = { id: string; title: string; step: HomeRepairStep };
export type TenantHomeView =
  | { state: "off" }
  | { state: "error" }
  | { state: "ready"; headline: TenantHomeHeadline; waiting: boolean; currency: string; repairs: TenantHomeRepair[] };

type Deps = { read?: typeof tenantHomeRead; repairs?: typeof tenantRepairs };

export async function tenantHomeView(session: Session, leaseId: string, deps: Deps = {}): Promise<TenantHomeView> {
  const read = deps.read ?? tenantHomeRead, readRepairs = deps.repairs ?? tenantRepairs;
  try {
    const home = await read(session, leaseId);
    if (home.state === "off") return { state: "off" };
    if (home.state !== "ready") return { state: "error" };
    const headline = tenantHomeHeadline(home.bill, home.facts);
    const repairs = homeRepairs(await readRepairs(session, leaseId)).map(r => ({ id: r.id, title: r.title, step: r.step }));
    return { state: "ready", headline, waiting: tenantHomeWaiting(headline, home.facts), currency: home.bill.currency, repairs };
  } catch (error) {
    logServerError("b090_tenant_home", error);
    return { state: "error" };
  }
}
