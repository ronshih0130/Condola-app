import React from "react";
import type { repairApprovalCopy } from "@/i18n/repair-approval";
import { intentStatusLabel } from "@/server/repair-approval-rules";
import type { OwnerHistoryRow } from "@/server/repair-approval";
type Copy = ReturnType<typeof repairApprovalCopy>;

export function Intent({ label, at, copy }: { label: string; at: string | null; copy: Copy }) {
  return <p>{label}: {intentStatusLabel(at) === "—" ? "—" : copy.intentRecorded}
    {at ? <> · <time dateTime={at}>{at}</time></> : null}</p>;
}

export function Emergency({ row, copy }: { row: OwnerHistoryRow; copy: Copy }) {
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

