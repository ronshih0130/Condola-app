import React from "react";
import { ownerViewRead } from "../../../../server/b073-owner-view";
import type { Session } from "../../../../server/types";
import { OwnerViewError, OwnerViewLayout } from "./owner-view";
import { OwnerViewSwitches } from "./owner-view-switches";

/** R5-OWNVIEW block body (brand_v3 only; the route renders OwnerViewLoading while this reads). */
export async function OwnerViewSection({ session }: { session: Session }) {
  const read = await ownerViewRead(session);
  // The route already requires settings.edit; a forbidden read here (authority changed mid-request) shows nothing.
  if (read.state === "forbidden") return null;
  if (read.state !== "ready") return <OwnerViewError locale={session.locale} />;
  return <OwnerViewLayout locale={session.locale} company={read.company}>
    <OwnerViewSwitches locale={session.locale} privacy={read.privacy} />
  </OwnerViewLayout>;
}
