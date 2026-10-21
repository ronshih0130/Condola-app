import type { T } from "./index";

export const ERRORS: Record<string, string> = {
  "errors.forbidden": "i_forbidden",
  "errors.required": "i_required",
  "errors.generic": "i_generic",
  "errors.leaseFailed": "i_lease_failed",
  "errors.wholeUnit": "i_lease_whole_unit",
  "errors.notFound": "i_not_found",
  "errors.capReason": "s_ab3ec53",
  "errors.needRooms": "i_need_rooms",
  "errors.depositCap": "lease_deposit_cap",
  "errors.leaseLocked": "lease_terms_locked",
  "errors.staleLease": "lease_terms_stale",
  "errors.lineId": "lease_line_invalid",
  "errors.pdf": "lease_pdf_invalid",
  "errors.ledger": "i_ledger",
  "errors.consentRequired": "i_consent_required",
  "errors.alreadySigned": "i_already_signed",
  "errors.noInvoice": "i_no_invoice",
  "errors.amount": "i_amount",
  "errors.last5": "s_da160ee",
  "errors.csv": "i_csv",
  "errors.occupied": "i_occupied",
  "errors.paymentState": "i_pay_state",
  "errors.matchState": "i_match_state",
  "errors.currency": "i_currency",
  "errors.amountTooHigh": "i_amount_high",
  "errors.email": "i_email",
  "errors.emailTaken": "i_email_taken",
  "errors.phone": "i_phone",
  "errors.meter": "i_meter",
  "errors.billExists": "i_bill_exists",
  "errors.lastAdmin": "i_last_admin",
  "errors.ownRole": "i_own_role",
  "errors.mismatch": "i_pw_mismatch",
  "errors.weakPassword": "i_pw_weak",
  "errors.authInvalid": "i_auth_invalid",
  "errors.mfaRequired": "i_mfa_required_err",
  "errors.confirm": "i_confirm_needed",
  "errors.planLimit": "i_plan_limit",
  "errors.seatLimit": "i_seat_limit",
};

export function errorText(t: T, key: string | undefined) {
  if (!key) return "";
  const mapped = ERRORS[key];
  if (!mapped) return t("i_generic");
  const text = t(mapped);
  if (!text || text === mapped) return t("i_generic");
  return text;
}
