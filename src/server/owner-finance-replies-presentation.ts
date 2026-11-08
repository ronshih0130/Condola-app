import type { RepliesPanelView } from "@/components/owner-report-replies";
import { formatLedgerMinor } from "./owner-net-ledger-presentation";
import type { ownerTransferHistory, reportRepliesView } from "./owner-finance-replies";

type Transfers = Awaited<ReturnType<typeof ownerTransferHistory>>;
type Replies = Awaited<ReturnType<typeof reportRepliesView>>;

/** Transfers stay a separate list (never added into statement totals); amounts formatted from integer strings in BigInt. */
export function repliesPanelView(input: {
  statementId: string; locale: string; transfers: Transfers; replies: Replies; versionNumbers?: Map<string, number>;
  /** The version whose contents the page actually shows: null = original statement only; undefined = B-014 contents not shown. */
  displayedVersionId: string | null | undefined;
}): RepliesPanelView {
  const { transfers, replies } = input;
  const transferLines = transfers && transfers.minorUnit !== null ? transfers.rows.map((x) => ({
    id: x.id, kind: x.kind, effectiveDate: x.effective_date,
    amount: formatLedgerMinor((x.kind === "reversal" ? BigInt(-1) : BigInt(1)) * BigInt(x.amount_minor), x.currency, transfers.minorUnit as number, input.locale),
  })) : null;
  const versionNo = (id: string | null) => id === null ? 1 : replies && id === replies.latestVersionId ? replies.latestVersionNo : input.versionNumbers?.get(id) ?? null;
  return {
    statementId: input.statementId,
    transfers: transferLines,
    replies: replies ? {
      latestVersionId: replies.latestVersionId, latestVersionNo: replies.latestVersionNo,
      confirmedCurrent: replies.confirmedCurrent,
      // Reply only to the version on screen, and only when it is still the latest; the RPC re-checks.
      canReply: replies.canReply && (input.displayedVersionId === undefined ? replies.latestVersionId === null : input.displayedVersionId === replies.latestVersionId),
      stale: input.displayedVersionId === undefined ? replies.latestVersionId !== null : input.displayedVersionId !== replies.latestVersionId,
      displayedVersionId: input.displayedVersionId ?? null,
      // A confirmation of an earlier version is history only; it never confirms the current one.
      hadEarlierConfirm: replies.replies.some((r) => r.kind === "confirm" && r.version_id !== replies.latestVersionId),
      items: replies.replies.map((r) => ({ id: r.id, versionNo: versionNo(r.version_id), kind: r.kind, body: r.body, createdAt: r.created_at, byOwner: r.actor_is_owner })),
    } : null,
  };
}
