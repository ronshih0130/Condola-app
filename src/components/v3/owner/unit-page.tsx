import React from "react";
import { notFound } from "next/navigation";
import { ownerUnit } from "../../../server/b092-owner-unit";
import type { Session } from "../../../server/types";
import { OwnerUnitError, OwnerUnitNoPerm, OwnerUnitView } from "./unit";
import { ownerUnitHref } from "./units";

/**
 * RO-UNIT body (OWN-33-AC2/AC4). Another owner's, an unknown or an unauthorised space is B1-NOPERM (403) in place;
 * a vacant space is a 404 (no vacant design yet); a failed read is the O-STATES error with a retry to this URL.
 */
export async function OwnerUnitPage({ session, unitId, roomId }: { session: Session; unitId: string; roomId: unknown }) {
  const result = await ownerUnit(session, unitId, roomId);
  if (result.state === "off") notFound();
  if (result.state === "forbidden") return <OwnerUnitNoPerm locale={session.locale} />;
  if (result.state !== "ready") {
    const retry = typeof roomId === "string" || roomId === null ? ownerUnitHref({ unitId, roomId }) : "/o";
    return <OwnerUnitError locale={session.locale} retryHref={retry} />;
  }
  if (result.unit.vacant) notFound();
  return <OwnerUnitView unit={result.unit} locale={session.locale} />;
}
