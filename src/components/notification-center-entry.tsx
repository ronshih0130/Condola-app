import Link from "next/link";
import { centerCopy } from "@/i18n/lanes/notification-center";
import type { Locale } from "@/i18n";
import { centerSessionAdmission, centerVendorAdmission } from "@/server/notification-center";
import type { Session } from "@/server/types";

export async function NotificationCenterEntry({ session }: { session: Session }) {
  if (session.kind !== "staff" && session.kind !== "tenant" && session.kind !== "owner") return null;
  const state=await centerSessionAdmission(session);
  if (state === "disabled" || state === "denied") return null;
  const portal = session.kind === "staff" ? "m" : session.kind === "tenant" ? "t" : "o";
  const copy=centerCopy(session.locale);
  return <p>{state==="busy" ? <span role="status" data-testid="notification-entry-busy">{copy.busy} </span> : null}<Link className="btn" data-testid="notification-center-entry" href={`/${portal}/notifications`}>{state==="busy" ? copy.retry : copy.title}</Link></p>;
}

export async function VendorNotificationCenterEntry({ token, locale }: { token: string; locale: Locale }) {
  const state=await centerVendorAdmission(token);
  if (state === "disabled" || state === "denied") return null;
  const copy=centerCopy(locale);
  return <p>{state==="busy" ? <span role="status" data-testid="notification-entry-busy">{copy.busy} </span> : null}<Link className="btn" prefetch={false} data-testid="notification-center-entry" href={`/v/${encodeURIComponent(token)}/notifications`}>{state==="busy" ? copy.retry : copy.title}</Link></p>;
}
