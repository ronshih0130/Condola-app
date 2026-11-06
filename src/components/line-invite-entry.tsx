"use client";
import { useState } from "react";
import { lineTenantCopy } from "@/i18n/line-tenant";
import type { Locale } from "@/i18n";

/** The invitation credential travels only in the same-origin POST body, never in a new URL. */
export function LineInviteEntry({ token, orgId, locale }: { token: string; orgId: string; locale: Locale }) {
 const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
 const copy = lineTenantCopy(locale);
 async function begin() {
  setBusy(true); setFailed(false);
  try {
   const bootstrap = await fetch(`/t/liff?org=${encodeURIComponent(orgId)}`, { credentials: "same-origin", cache: "no-store" });
   if (!bootstrap.ok) throw new Error("unavailable");
   const csrf = document.cookie.split(";").map(v => v.trim()).find(v => v.startsWith("condola_line_csrf="))?.split("=")[1];
   if (!csrf) throw new Error("unavailable");
   const response = await fetch("/api/line/flows", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "invite", inviteToken: token, csrf }) });
   const result = await response.json();
   if (!response.ok || !/^[\w-]{43}$/.test(result.flow)) throw new Error("unavailable");
   window.location.assign(`/t/liff?flow=${encodeURIComponent(result.flow)}`);
  } catch { setFailed(true); setBusy(false); }
 }
 return <div><button className="btn block" type="button" disabled={busy} onClick={begin}>{copy.bind}</button>{failed ? <p role="status">{copy.unavailable}</p> : null}</div>;
}
