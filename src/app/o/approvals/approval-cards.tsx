import "server-only";
import * as crypto from "node:crypto";
import Link from "next/link";
import { repairApprovalCopy } from "@/i18n/repair-approval";
import {
  approvalAmount, decisionLabel, intentStatusLabel, reapprovalHint,
} from "@/server/repair-approval-rules";
import type { ManagerApprovalRow, OwnerHistoryRow, OwnerPendingRow } from "@/server/repair-approval";

import { DecisionForm } from "./decision-form";

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
    <DecisionForm key={row.version_id} versionId={row.version_id} copy={copy}>
      <input type="hidden" name="requestId" value={crypto.randomUUID()} />
    </DecisionForm>
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
