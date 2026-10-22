import { makeT } from "../../../src/i18n";
import { formatTwd } from "../../../src/server/payment-rules";
import { civilPeriodLabel } from "../../../src/server/rent-settlement-math";

const t = makeT("zh-TW");

function nt(amount: number): string {
  return formatTwd(amount);
}

function grouped(amount: number): string {
  return Math.abs(amount).toLocaleString("en-US");
}

/** Production catalog only. Numeric params are formatted here; the sentences live in zh-TW.json. */
export function uiCopy(key: string, params: Record<string, string | number> = {}): string {
  switch (key) {
    case "global.disclaimer":
      return t("i_stmt_disclaimer");
    case "payments.leaseRequired":
      return t("i_pay_err_lease");
    case "payments.amountPositive":
      return t("i_pay_err_amount");
    case "payments.futureDate":
      return t("i_pay_err_date");
    case "payments.typeRequired":
      return t("i_pay_err_kind");
    case "payments.periodRequired":
      return t("i_pay_err_period");
    case "payments.errorSummary":
      return t("i_pay_err_summary");
    case "payments.requiredSummary":
      return t("i_pay_err_required");
    case "payments.duplicate":
      return t("i_pay_dup", { amount: nt(Number(params.amount)) });
    case "payments.reversePermission":
      return t("i_pay_reverse_role");
    case "payments.reversed":
      return t("i_pay_reversed");
    case "payments.reversalReason":
      return t("i_pay_reverse_note", { reason: String(params.reason ?? "") });
    case "payments.pending":
      return t("i_pay_pending");
    case "payments.confirm":
      return t("i_pay_confirm");
    case "payments.decline":
      return t("i_pay_skip");
    case "payments.readonly":
      return t("i_stmt_readonly");
    case "payments.recipient":
      return t("i_pay_col_payee");
    case "payments.ownerRecipient":
      return t("i_stmt_payee_owner");
    case "payments.companyRecipient":
      return t("i_stmt_payee_firm");
    case "payments.partial":
      return t("i_pay_partial");
    case "payments.remaining":
      return t("i_partial_left", { left: nt(Number(params.amount)) });
    case "payments.partialExplanation":
      return t("i_partial_note", {
        paid: nt(Number(params.paid)),
        period: civilPeriodLabel(`${params.year}-${String(params.month).padStart(2, "0")}`),
      });
    case "payments.overdue":
      return t("i_pay_overdue", {
        date: `${String(params.month).padStart(2, "0")}/${String(params.day).padStart(2, "0")}`,
        days: Number(params.days),
      });
    case "tenant.total":
      return t("i_tenant_total", { amount: grouped(Number(params.amount)) });
    case "statement.title":
      return t("i_stmt_doc_title", {
        owner: String(params.owner ?? ""),
        period: civilPeriodLabel(`${params.year}-${String(params.month).padStart(2, "0")}`),
      });
    case "statement.payouts":
      return t("i_payouts");
    case "statement.opening":
      return t("i_opening");
    case "statement.closing":
      return t("i_closing");
    case "statement.handledRent":
      return t("i_stmt_firm_rent");
    case "statement.negative":
      return t("owner_owes");
    case "statement.negativeWarning":
      return t("i_stmt_negative", { amount: grouped(Number(params.amount)) });
    case "statement.changed":
      return t("i_stmt_changed");
    case "statement.history":
      return t("i_stmt_history");
    case "statement.regenerate":
      return t("i_stmt_regen");
    case "statement.previous":
      return t("i_stmt_before");
    case "statement.changedNotice":
      return t("i_pay_stmt_changed_note");
    case "statement.footer":
      return t("i_stmt_footer");
    case "statement.formula":
      return t("i_stmt_formula", {
        opening: nt(Number(params.opening)),
        firm: nt(Number(params.rent)),
        costs: nt(Number(params.expenses)),
        payouts: nt(Number(params.payouts)),
        closing: nt(Number(params.closing)),
      });
    case "moveout.formula":
      return t("i_move_out_formula", {
        rent: grouped(Number(params.rent)),
        days: Number(params.days),
        amount: grouped(Number(params.amount)),
      });
    case "moveout.override":
      return t("i_move_out_override", { actor: String(params.actor ?? ""), timestamp: String(params.timestamp ?? "") });
    case "moveout.amountChange":
      return t("i_move_out_amount_change", {
        original: grouped(Number(params.original)),
        updated: grouped(Number(params.updated)),
      });
    case "moveout.shortfallTitle":
      return t("i_deposit_shortfall");
    case "moveout.shortfall":
      return t("i_deposit_shortfall_due", { amount: grouped(Number(params.amount)) });
    case "period.rent":
      return t("i_period_rent", { period: civilPeriodLabel(`${params.year}-${String(params.month).padStart(2, "0")}`) });
    case "line.previewPrivacy":
      return t("i_line_preview_privacy");
    case "line.rentDue":
      return t("i_line_rent_due");
    case "line.rentUnpaid":
      return t("i_line_rent_unpaid");
    case "line.leaseExpiry":
      return t("i_line_lease_expiry");
    case "line.repair":
      return t("i_line_repair");
    case "line.statement":
      return t("i_line_statement");
    case "pricing.trialMonths":
      return t("i_price_trial_months", { count: Number(params.count) });
    case "pricing.trialDays":
      return t("i_price_trial_days", { count: Number(params.count) });
    case "pricing.annual":
      return t("i_price_annual_badge");
    case "pricing.footer":
      return t("i_price_record_only");
    default:
      return t(key);
  }
}
