"use client";

import { useActionState, useState } from "react";
import { unitQrCopy } from "@/i18n/lanes/unit-qr";
import { actionIssueUnitQr, actionRevokeUnitQr } from "@/server/unit-qr-actions";

export function UnitQrControl({ units, locale }: { units: { id: string; label: string }[]; locale: string }) {
  const copy = unitQrCopy(locale);
  const [result, action, pending] = useActionState(actionIssueUnitQr, null);
  const [copiedUrl, setCopiedUrl] = useState("");
  return <div className="col">
    <form action={action} className="col">
      <select name="unitId" className="inp" aria-label={copy.title} required>
        {units.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
      </select>
      <button className="btn pri" disabled={pending || !units.length}>{copy.generate}</button>
    </form>
    <p>{copy.hint}</p>
    {result ? <div className="col" key={result.id}>
      <input className="inp" readOnly value={result.url} aria-label={copy.title} onFocus={event => event.target.select()} />
      <button type="button" className="btn" onClick={async () => {
        try { await navigator.clipboard.writeText(result.url); setCopiedUrl(result.url); } catch { /* The selectable URL remains available. */ }
      }}>{copiedUrl === result.url ? copy.copied : copy.copy}</button>
      <form action={actionRevokeUnitQr}><input type="hidden" name="id" value={result.id} /><button className="btn">{copy.revoke}</button></form>
    </div> : null}
  </div>;
}
