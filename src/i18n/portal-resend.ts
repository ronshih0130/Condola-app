import type { ResendStatus } from "../lib/portal-resend-state";
export type ResendLocale = "en" | "zh-TW";
const messages: Record<ResendLocale, Record<ResendStatus, string>> = {
  en: { disabled: "Unavailable while this feature is off.", unavailable: "Resending is not available.", already_connected: "Already connected; no request was made.", queued: "Request queued in the simulation.", processing: "Simulation in progress.", captured: "Captured locally in the simulation; delivery is not confirmed.", accepted: "Accepted by the simulated provider; delivery is not confirmed.", rejected: "The simulated provider rejected the request.", unknown: "The result is unknown. Do not assume rejection or retry safely.", conflict: "This request conflicts with another request." },
  "zh-TW": { disabled: "功能關閉，無法重寄。", unavailable: "目前無法重寄。", already_connected: "已連結，未發出請求。", queued: "模擬請求已排入。", processing: "模擬處理中。", captured: "模擬已在本機記錄；尚未確認送達。", accepted: "模擬服務已接受；尚未確認送達。", rejected: "模擬服務拒絕了請求。", unknown: "結果尚未確認，請勿假設已拒絕或可安全重試。", conflict: "此請求與其他請求衝突。" },
};
export const resendText = (locale: ResendLocale, status: ResendStatus) => messages[locale][status];

export const resendPreviewLabel = (locale: ResendLocale) => locale === "en" ? "Simulation preview" : "模擬預覽";
