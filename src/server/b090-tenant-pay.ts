import { logServerError } from "./errors";
import { tenantPayee } from "./payee";
import { tenantPayeeDisplay, type PayeeAccount } from "./payee-rules";
import { tenantPaymentHistory } from "./tenant-payment-history";
import { tenantPayRead } from "./b090-tenant-pay-reader";
import { payHistoryLines, tenantPayState, type PayHistoryLine, type TenantPayState } from "./b090-tenant-pay-rules";
import type { Session } from "./types";

/**
 * Brand 3.0 B-090 slice 2, RT-PAY / RT-REPORT (TEN-52, TEN-53). Called only under brand_v3. Adds no write path and
 * composes three readers for the tenant's own selected lease:
 *  - tenantPayRead (v3-only: the bill, the lease-wide waiting total, the own last 帳號末五碼, the property's date and the
 *    complete per-month totals of the own reports);
 *  - tenantPaymentHistory (existing, called exactly as it can be called on origin/main: { view: "current", turn: true };
 *    whether the lease can be reported on, whether the payee card shows, and the TEN-51 「輪到你・重新回報」 turn);
 *  - tenantPayee (the payee account the company set for this lease, via the existing payee gateway).
 * "off" (tenant_payment_history not live for the org) hands the page back to the existing body.
 */
export type TenantPayAccount =
  | { kind: "account"; holder: string | null; bank: string | null; bankCode: string | null; number: string; swift: string | null; routing: string | null; payee: "owner" | "company" }
  | { kind: "legacy"; last5: string }
  | { kind: "none" }
  | { kind: "error" };
export type TenantPayView =
  | { state: "off" }
  | { state: "error" }
  | {
    state: "ready"; currency: string; pay: TenantPayState; today: string; lastLast5: string | null;
    redo: { reason: string | null } | null; account: TenantPayAccount | null; history: PayHistoryLine[]; olderMonths: boolean;
  };

type Deps = { read?: typeof tenantPayRead; history?: typeof tenantPaymentHistory; payee?: typeof tenantPayee };

function accountOf(account: PayeeAccount, number: string): TenantPayAccount {
  const text = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
  return {
    kind: "account", holder: text(account.holder_name), bank: text(account.bank_name), bankCode: text(account.bank_code), number,
    swift: text(account.details?.swift), routing: text(account.details?.routing),
    // TEN-52-AC2: the wording follows who the account belongs to (屋主 when it is an owner's, else 管理方).
    payee: account.owner_contact_id ? "owner" : "company",
  };
}

export async function tenantPayView(session: Session, leaseId: string, deps: Deps = {}): Promise<TenantPayView> {
  const read = deps.read ?? tenantPayRead, readHistory = deps.history ?? tenantPaymentHistory, readPayee = deps.payee ?? tenantPayee;
  try {
    const facts = await read(session, leaseId);
    if (facts.state === "off") return { state: "off" };
    if (facts.state !== "ready") return { state: "error" };
    const history = await readHistory(session, leaseId, { view: "current", turn: true });
    if (history.state !== "ready" || !history.turn) return { state: "error" };
    const pay = tenantPayState(facts.bill, facts.facts, history.lease.canReport);
    // TEN-52-AC5: a failed payee read shows the error in that card only, never a wrong account.
    let account: TenantPayAccount | null = null;
    if (history.lease.legacyPayeeVisible) {
      try {
        const display = tenantPayeeDisplay(await readPayee(session, leaseId, true));
        account = display.kind === "account" ? accountOf(display.account, display.number) : display;
      } catch (error) {
        logServerError("b090_tenant_pay_payee", error);
        account = { kind: "error" };
      }
    }
    // TEN-53-AC5 (TEN-51): the lease's latest refused report is the caller's own and nothing is waiting.
    const newestRejected = history.reports.find(r => r.status === "rejected");
    const redo = history.turn.reReport && pay.canReport ? { reason: newestRejected?.rejectionReason ?? null } : null;
    return {
      state: "ready", currency: facts.bill.currency, pay, today: facts.pay.today, lastLast5: facts.pay.lastLast5, redo, account,
      // TEN-52-AC3: complete month totals from the v3 reader's SQL aggregate, never from the paged report list.
      history: payHistoryLines(facts.pay.months), olderMonths: facts.pay.olderMonths,
    };
  } catch (error) {
    logServerError("b090_tenant_pay", error);
    return { state: "error" };
  }
}
