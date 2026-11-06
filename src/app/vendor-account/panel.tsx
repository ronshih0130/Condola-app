"use client";
import { useCallback, useEffect, useState } from "react";
import { vendorAccountCopy as c } from "@/i18n/vendor-accounts";
import type { VendorAccountHistory } from "@/lib/vendor-account-types";
export default function VendorAccountPanel() {
  const [data, setData] = useState<VendorAccountHistory | null>(null);
  const [invitation, setInvitation] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (claim?: string) => {
    setBusy(true); setMessage("");
    try {
      const result = await fetch("/api/vendor-account", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(claim ? { action: "claim", invitation: claim } : { action: "sync" }) });
      if (!result.ok) throw new Error(result.status === 403 ? c.denied : c.unavailable);
      if ((await result.json()).status === "disabled") throw new Error(c.unavailable);
      const response = await fetch("/api/vendor-account", { cache: "no-store" });
      if (!response.ok) throw new Error(c.denied);
      setData(await response.json()); setInvitation("");
    } catch (error) { setData(null); setMessage(error instanceof Error ? error.message : c.unavailable); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <h1>{c.title}</h1><a href="/login?next=%2Fvendor-account">{c.login}</a>
    <form onSubmit={event => { event.preventDefault(); void refresh(invitation); }}>
      <label>{c.invitation}<input type="password" autoComplete="off" value={invitation} onChange={event => setInvitation(event.target.value)} /></label>
      <button disabled={busy || !invitation}>{c.claim}</button>
    </form>
    {message && <p role="alert">{message}</p>}
    <h2>{c.settings}</h2>
    {data?.settings.map(item => <p key={`${item.orgId}/${item.contactId}`}>{item.name} · {c.linked}</p>)}
    <h2>{c.history}</h2><button disabled={busy} onClick={() => void refresh()}>{c.refresh}</button>
    {data && data.jobs.length === 0 && <p>{c.empty}</p>}
    <ul>{data?.jobs.map(job => <li key={job.jobId}>{job.description}{job.readOnly && ` · ${c.closed}`}</li>)}</ul>
  </main>;
}
