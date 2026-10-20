import type { OrgEnvironment } from "./org-scope";

/** Appended to sandbox notice and invite audits. Nothing is delivered. */
export const SANDBOX_NOT_SENT = "（測試模式：未實際傳送）";

/** Real LINE pushes and emails are allowed only outside the sandbox. */
export function canSendReal(environment: OrgEnvironment) {
  return environment !== "sandbox";
}

export type DeliveryPlan = {
  sent: false;
  status: "skipped";
  provider: "sandbox_log" | "demo_line";
  error: string;
};

/**
 * The app has no live LINE or email provider yet. Sandbox is still a hard
 * gate: callers must use this plan and must not open a network send when
 * `canSendReal` is false.
 */
export function deliveryPlan(environment: OrgEnvironment): DeliveryPlan {
  if (!canSendReal(environment)) {
    return { sent: false, status: "skipped", provider: "sandbox_log", error: SANDBOX_NOT_SENT };
  }
  return { sent: false, status: "skipped", provider: "demo_line", error: "demo_not_sent" };
}

export function outboundNote(environment: OrgEnvironment | undefined) {
  return environment === "sandbox" ? SANDBOX_NOT_SENT : null;
}
