import { logServerError } from "./errors";
import { tenantRepairs } from "./queries";
import { tenantPaymentHistory } from "./tenant-payment-history";
import { homeRepairs, tenantHomeHeadline, tenantHomeWaiting, type HomeRepairStep, type TenantHomeHeadline } from "./b090-tenant-home-rules";
import type { Session } from "./types";

/**
 * Brand 3.0 B-090 slice 1, RT-HOME (TEN-54). Composes two existing tenant readers and adds no query of its own:
 *  - tenantPaymentHistory (own selected lease, own reports; `home: true` adds the waiting sum and billing months);
 *  - tenantRepairs (the selected lease's repairs, under the tenant's own RLS).
 * "off" (tenant_payment_history not live for the org) hands the page back to the existing home body.
 */
export type TenantHomeRepair = { id: string; title: string; step: HomeRepairStep };
export type TenantHomeView =
  | { state: "off" }
  | { state: "error" }
  | { state: "ready"; headline: TenantHomeHeadline; waiting: boolean; currency: string; repairs: TenantHomeRepair[] };

type Deps = { history?: typeof tenantPaymentHistory; repairs?: typeof tenantRepairs };

export async function tenantHomeView(session: Session, leaseId: string, deps: Deps = {}): Promise<TenantHomeView> {
  const readHistory = deps.history ?? tenantPaymentHistory, readRepairs = deps.repairs ?? tenantRepairs;
  try {
    const history = await readHistory(session, leaseId, { view: "current", home: true });
    if (history.state === "off") return { state: "off" };
    if (history.state !== "ready" || !history.home) return { state: "error" };
    const headline = tenantHomeHeadline(history.bill, history.home);
    const repairs = homeRepairs(await readRepairs(session, leaseId)).map(r => ({ id: r.id, title: r.title, step: r.step }));
    return { state: "ready", headline, waiting: tenantHomeWaiting(headline, history.home), currency: history.bill.currency, repairs };
  } catch (error) {
    logServerError("b090_tenant_home", error);
    return { state: "error" };
  }
}
