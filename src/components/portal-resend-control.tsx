"use client";
import { useActionState } from "react";
import { actionResendPortalInvite } from "@/server/portal-resend-actions";
import { resendPreviewLabel, resendText } from "@/i18n/portal-resend";
import { PortalResendResult } from "./portal-resend-result";
import { useLocale, useT } from "./locale";

export function PortalResendControl({ sourceId, requestId, company, audience }: {
  sourceId: string; requestId: string; company: string; audience: "owner" | "tenant";
}) {
  const [result, action, pending] = useActionState(actionResendPortalInvite, null);
  const locale = useLocale(), t = useT();
  return <div data-testid="portal-resend-control">
    <form action={action}>
      <input type="hidden" name="sourceId" value={sourceId} />
      <input type="hidden" name="requestId" value={requestId} />
      <button className="btn sm" disabled={pending} type="submit">{t("i_resend")} · {resendPreviewLabel(locale)}</button>
    </form>
    {pending ? <p role="status">{resendText(locale, "processing")}</p> : null}
    {result ? <PortalResendResult result={result} locale={locale} company={company} audience={audience} /> : null}
  </div>;
}
