import { randomUUID } from "node:crypto";
import { portalResendControl } from "@/server/portal-resend";
import type { Session } from "@/server/types";
import { PortalResendControl } from "./portal-resend-control";

export async function PortalResendEntry({ session, contactId, kind, leaseId }: {
  session: Session; contactId: string; kind: "owner" | "tenant"; leaseId?: string;
}) {
  const invite = await portalResendControl(session, contactId, kind, leaseId);
  return invite ? <PortalResendControl key={invite.id} sourceId={invite.id} requestId={randomUUID()} company={invite.company} audience={kind} /> : null;
}
