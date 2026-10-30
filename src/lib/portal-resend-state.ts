/** Reference states only. Eligibility is based on an already trusted snapshot. */
export type ResendStatus = "disabled" | "unavailable" | "already_connected" | "queued" | "processing" | "captured" | "accepted" | "rejected" | "unknown" | "conflict";
export type ResendResult = Readonly<{ simulation: true; status: ResendStatus }>;
export type TrustedResendSnapshot = Readonly<{ enabled: boolean; available: boolean; connected: boolean }>;
export const simulatedResult = (status: ResendStatus): ResendResult => Object.freeze({ simulation: true as const, status });
export function resendEligibility(snapshot: TrustedResendSnapshot): ResendResult | null {
  if (!snapshot.enabled) return simulatedResult("disabled");
  if (snapshot.connected) return simulatedResult("already_connected");
  if (!snapshot.available) return simulatedResult("unavailable");
  return null;
}
export function settleResend(current: ResendResult, outcome: "captured" | "accepted" | "rejected" | "unknown"): ResendResult {
  return current.status === "processing" ? simulatedResult(outcome) : current;
}
