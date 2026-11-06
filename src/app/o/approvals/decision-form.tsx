"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { repairApprovalCopy } from "@/i18n/repair-approval";

type Copy = ReturnType<typeof repairApprovalCopy>;

export function DecisionForm({ versionId, copy, children }: {
  versionId: string; copy: Copy; children: ReactNode;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState("approved");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const requestId = new FormData(event.currentTarget).get("requestId");
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/owner-repair-decision", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, versionId, decision, reason: reason.trim() || null }),
      });
      const result: { status?: string } = await response.json();
      const status = result.status;
      setMessage(status === "recorded" ? copy.recorded
        : status === "rejected_conflict" ? copy.rejected_conflict
        : status === "rejected_disabled" ? copy.rejected_disabled
        : status === "rejected_invalid" ? copy.rejected_invalid : copy.unavailable);
      if (status === "recorded" || status === "rejected_conflict") router.refresh();
    } catch {
      setMessage(copy.unavailable);
    } finally {
      setBusy(false);
    }
  }
  return <form onSubmit={submit}>
    {children}
    <label>{copy.decision}
      <select className="inp" value={decision} onChange={e => setDecision(e.target.value)} disabled={busy}>
        <option value="approved">{copy.approve}</option>
        <option value="rejected">{copy.reject}</option>
        <option value="more_information">{copy.requestInformation}</option>
      </select>
    </label>
    <label>{copy.reason}
      <textarea className="inp" value={reason} onChange={e => setReason(e.target.value)}
        required={decision !== "approved"} maxLength={4000} disabled={busy} />
    </label>
    <button className="btn pri" type="submit" disabled={busy}>{copy.save}</button>
    <p role="status">{message}</p>
  </form>;
}
