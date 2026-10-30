import Link from "next/link";
import { handoverCopy } from "@/i18n/handover";
import { readHandover } from "@/server/handover";
import type { Session } from "@/server/types";

/** The same current-session gateway used by the destination authorizes this entry. */
export async function HandoverEntry({ session, leaseId }: { session: Session; leaseId: string }) {
  if (session.kind !== "staff" && session.kind !== "tenant") return null;
  try { await readHandover(session, leaseId); } catch { return null; }
  const portal = session.kind === "staff" ? "m" : "t";
  return <p><Link className="btn" data-testid="handover-entry" href={`/${portal}/handover/${leaseId}`}>{handoverCopy(session.locale).title}</Link></p>;
}
