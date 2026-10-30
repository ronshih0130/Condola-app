import React from "react";
import type { ResendResult } from "../lib/portal-resend-state";
import { resendText, type ResendLocale } from "../i18n/portal-resend";

export function PortalResendResult({ result, locale, company, audience }: { result: ResendResult; locale: ResendLocale; company: string; audience: "owner" | "tenant" }) {
  const label = locale === "en" ? (audience === "owner" ? "Owner" : "Tenant") : (audience === "owner" ? "屋主" : "租客");
  return <section className="card pad" style={{ marginBottom: 12 }} data-testid="resend-result" aria-live="polite">
    <p>{locale === "en" ? "Simulation preview" : "模擬預覽"}</p>
    <p>{company} · {label}</p>
    <p data-testid="resend-status">{resendText(locale, result.status)}</p>
  </section>;
}
