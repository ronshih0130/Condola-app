import { unitQrCopy } from "@/i18n/lanes/unit-qr";
import { actionCompleteUnitQr } from "@/server/unit-qr-actions";
import type { UnitQrContext } from "@/server/unit-qr-signup";

export function UnitQrProfile({ context, locale, error }: { context: UnitQrContext; locale: string; error?: string }) {
  const copy = unitQrCopy(locale);
  if (context.done) return <p role="status">{copy.pending}</p>;
  if (!context.active) return <p role="alert">{copy.required}</p>;
  return <form action={actionCompleteUnitQr} className="col">
    <h1>{copy.profile}</h1><p>{copy.signup}</p>
    <p>{copy.invite}</p>
    {error ? <p role="alert">{copy.required}</p> : null}
    <input type="hidden" name="contextId" value={context.id} />
    <label>{copy.name}<input className="inp" name="contactName" autoComplete="name" required maxLength={120} /></label>
    <label>{copy.phone}<input className="inp" name="phone" type="tel" autoComplete="tel" required maxLength={32} /></label>
    <button className="btn pri">{copy.submit}</button>
  </form>;
}
