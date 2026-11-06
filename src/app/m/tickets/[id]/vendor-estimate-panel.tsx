import React from "react";
import { managerVendorEstimates } from "@/server/vendor-estimates";
import { approvalAmount } from "@/server/repair-approval-rules";
import { vendorEstimateCopy as copy } from "@/i18n/vendor-estimates";
import type { Session } from "@/server/types";

export async function VendorEstimatePanel({ session, ticketId, enabled }: { session: Session; ticketId: string; enabled: boolean }) {
  if (!enabled) return null;
  if (session.kind !== "staff" || !["admin", "manager"].includes(session.role ?? "")) return null;
  const rows = await managerVendorEstimates(session, ticketId);
  if (!rows.length) return null;
  const states: Record<string, string> = { pending_approval: copy.pending, approved: copy.approved,
    rejected: copy.rejected, more_information: copy.moreInformation, policy_qualified: copy.qualified,
    superseded: copy.previous };
  return <section data-testid="vendor-estimate-comparison"><h2>{copy.comparison}</h2>
    {rows.map(row => <article className="card pad" key={row.versionId}>
      <h3>{copy.version} {row.versionNo} · {row.isCurrent ? copy.current : copy.previous}</h3>
      <p>{approvalAmount(row.amountMinor, row.currency, row.minorUnit)}</p>
      <p>{row.workScope}</p><p>{states[row.state]}</p>
      {row.photos.map((photo, index) => <a key={photo.id} href={`/api/tickets/photos/${photo.id}`}>
        {copy.photos} {index + 1}
      </a>)}
    </article>)}
  </section>;
}
