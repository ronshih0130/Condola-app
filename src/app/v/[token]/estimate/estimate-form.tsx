"use client";
import { useState } from "react";
import { vendorEstimateCopy as copy } from "@/i18n/vendor-estimates";
import type { VendorEstimateContext } from "@/lib/vendor-estimate-types";

export function EstimateForm({ token, requestId, context }: {
  token: string; requestId: string; context: VendorEstimateContext;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [saved, setSaved] = useState(false);
  return <form onSubmit={async event => {
    event.preventDefault();
    if (busy || saved) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const response = await fetch("/api/vendor-estimate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, requestId, expectedHeadId: context.headId,
          amountMinor: form.get("amountMinor"), currency: context.currency, minorUnit: context.minorUnit,
          workScope: form.get("workScope"), evidence: form.getAll("photo").map(id => ({ id })) }),
      });
      const data = await response.json();
      if (response.ok && data.status === "recorded") {
        setSaved(true); setResult(data.requires_owner_decision ? copy.pending : copy.saved);
      } else setResult(copy.failed);
    } catch { setResult(copy.failed); } finally { setBusy(false); }
  }}>
    <fieldset disabled={busy || saved}>
      <label>{copy.amount} ({context.currency}, 10<sup>−{context.minorUnit}</sup>)
        <input className="inp" name="amountMinor" inputMode="numeric" pattern="[0-9]+" required />
      </label>
      <label>{copy.scope}<textarea className="inp" name="workScope" maxLength={8000} required /></label>
      {context.photos.length ? <fieldset><legend>{copy.photos}</legend>{context.photos.map((photo, index) =>
        <label key={photo.id}><input type="checkbox" name="photo" value={photo.id} />
          <a href={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`}>{copy.photos} {index + 1}</a>
        </label>)}</fieldset> : null}
      <button type="submit" className="btn pri">{copy.submit}</button>
    </fieldset>
    <p role="status">{result}</p>
  </form>;
}
