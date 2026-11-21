import React from "react";
import { notFound, redirect } from "next/navigation";
import { depositTopupView } from "../../../server/mf3-deposit-topup";
import type { Session } from "../../../server/types";
import { TopupError, TopupReadView, TopupStaffView } from "./topup";

/**
 * MO-TOPUP page body for the three apps. Outside the approved frames nothing renders: brand_v3 or
 * `deposit_settlement` OFF, or no sent settlement owing a top-up, is a 404; a staff role without
 * pay.record goes to the existing no-permission page; a tenant or owner of another lease gets a 404.
 */
export async function TopupPage({ session, leaseId, retryHref }: { session: Session; leaseId: string; retryHref: string }) {
  const read = await depositTopupView(session, leaseId);
  if (read.state === "forbidden" && session.kind === "staff") redirect("/m/noperm?need=pay.record");
  if (read.state === "unavailable") return <TopupError locale={session.locale} retryHref={retryHref} />;
  if (read.state !== "ready") return notFound();
  if (session.kind === "staff") return <TopupStaffView view={read.view} locale={session.locale} />;
  return <TopupReadView view={read.view} locale={session.locale} kind={session.kind} />;
}
