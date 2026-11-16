import React from "react";
import { ownerDecidedList, ownerDecidedTicket, parseCursor } from "../../../../server/b093-owner-decided";
import type { Session } from "../../../../server/types";
import { DecidedError, DecidedListView, DecidedNoPerm, DecidedTicketView, decidedPageHref, decidedTicketHref } from "./decided";

/** RO-DECIDED list (OWN-35-AC1/AC3). An unreadable `?after=` falls back to the first page. */
export async function DecidedListPage({ session, after }: { session: Session; after: unknown }) {
  const cursor = parseCursor(after) ?? undefined;
  const result = await ownerDecidedList(session, { after: cursor });
  if (result.state === "forbidden") return <DecidedNoPerm locale={session.locale} />;
  if (result.state !== "ready") return <DecidedError locale={session.locale} retryHref={decidedPageHref(cursor)} />;
  return <DecidedListView locale={session.locale} calendar={session.calendar} rows={result.rows} next={result.next} />;
}

/** RO-DECIDED read-only view (OWN-35-AC2/AC3): another owner's or company's ticket is B1-NOPERM. */
export async function DecidedTicketPage({ session, ticketId }: { session: Session; ticketId: string }) {
  const result = await ownerDecidedTicket(session, ticketId);
  if (result.state === "forbidden") return <DecidedNoPerm locale={session.locale} />;
  if (result.state !== "ready") return <DecidedError locale={session.locale} retryHref={decidedTicketHref(ticketId)} />;
  return <DecidedTicketView locale={session.locale} calendar={session.calendar} detail={result.detail} />;
}
