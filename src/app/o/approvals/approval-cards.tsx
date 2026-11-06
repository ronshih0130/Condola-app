"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { repairApprovalCopy } from "@/i18n/repair-approval";
import {
  approvalAmount, decisionLabel, intentStatusLabel, reapprovalHint,
} from "@/server/repair-approval-rules";
import type { ManagerApprovalRow, OwnerHistoryRow, OwnerPendingRow } from "@/server/repair-approval";

export type ApprovalCardRow = OwnerPendingRow & { emergency: OwnerHistoryRow | null };
type Copy = ReturnType<typeof repairApprovalCopy>;

function Intent({ label, at, copy }: { label: string; at: string | null; copy: Copy }) {
  return <p>{label}: {intentStatusLabel(at) === "—" ? "—" : copy.intentRecorded}
    {at ? <> · <time dateTime={at}>{at}</time></> : null}</p>;
}

function Emergency({ row, copy }: { row: OwnerHistoryRow; copy: Copy }) {
  if (!row.emergency_category) return null;
  const category = row.emergency_category as "water" | "electricity" | "safety";
  return <section>
    <h4>{copy.emergency}: {copy[category]}</h4>
    <p>{row.emergency_reason}</p>
    <p>{copy.photos}: {row.emergency_photo_refs.length}</p>
    <ul>{row.emergency_photo_refs.map((ref, i) => <li key={i}>{ref.id}</li>)}</ul>
    <Intent label={copy.notice} at={row.emergency_notice_intent_at} copy={copy} />
  </section>;
}

function DecisionForm({ versionId, copy }: { versionId: string; copy: Copy }) {
  const router = useRouter();
  const [decision, setDecision] = useState("approved");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/owner-repair-decision", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId, decision, reason: reason.trim() || null }),
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

export function ApprovalCards({ rows, locale }: { rows: ApprovalCardRow[]; locale: string }) {
  const copy = repairApprovalCopy(locale);
  return <div className="grid2">{rows.map(row => <article className="card pad" key={row.version_id}>
    <h3>{copy.version} {row.version_no}</h3>
    <p>{copy.amount}: {approvalAmount(row.amount_minor, row.currency, row.minor_unit)}</p>
    <p>{copy.threshold}: {approvalAmount(row.captured_threshold_minor, row.currency, row.minor_unit)}
      {" · "}{copy[row.threshold_source as "property_override" | "owner_default" | "regional_default"]}</p>
    <h4>{copy.scope}</h4><p>{row.work_scope}</p>
    <p>{copy.evidence}: {row.evidence_snapshot.length}</p>
    <ul>{row.evidence_snapshot.map((ref, i) => <li key={i}>{ref.id}</li>)}</ul>
    <p>{copy.submittedAt}: <time dateTime={row.submitted_at}>{row.submitted_at}</time></p>
    <Intent label={copy.reminder} at={row.reminder_intent_at} copy={copy} />
    {row.emergency ? <Emergency row={row.emergency} copy={copy} /> : null}
    <DecisionForm versionId={row.version_id} copy={copy} />
    <Link href={"/o/approvals/" + row.ticket_id}>{copy.history}</Link>
  </article>)}</div>;
}

export function ApprovalHistoryCards({ rows, locale }: {
  rows: (OwnerHistoryRow | ManagerApprovalRow)[]; locale: string;
}) {
  const copy = repairApprovalCopy(locale);
  return <div>{rows.length ? rows.map(row => {
    const manager = "appointment_event_kind" in row ? row : null;
    return <article className="card pad" key={row.version_id}>
      <h3>{copy.version} {row.version_no}</h3>
      <p>{copy.amount}: {approvalAmount(row.amount_minor, row.currency, row.minor_unit)}</p>
      <p>{copy.threshold}: {approvalAmount(row.captured_threshold_minor, row.currency, row.minor_unit)}</p>
      <p>{copy.submittedAt}: <time dateTime={row.submitted_at}>{row.submitted_at}</time></p>
      <p>{row.requires_owner_decision ? copy[decisionLabel(row.decision)] : copy.policyQualified}</p>
      {row.decided_at ? <p>{copy.decidedAt}: <time dateTime={row.decided_at}>{row.decided_at}</time></p> : null}
      {row.decision_reason ? <p>{row.decision_reason}</p> : null}
      {reapprovalHint(row.is_current) ? <p>{copy.reapproval}</p> : null}
      <Emergency row={row} copy={copy} />
      {manager ? <>
        <Intent label={copy.reminder} at={manager.reminder_intent_at} copy={copy} />
        {manager.appointment_event_kind ? <p>{copy.appointment}: {
          copy[manager.appointment_event_kind as "vendor_proposed" | "company_confirmed" | "vendor_rejected" | "vendor_completion_submitted"]
        } · {manager.appointment_occurred_at}</p> : null}
      </> : null}
    </article>;
  }) : <p>{copy.empty}</p>}</div>;
}
