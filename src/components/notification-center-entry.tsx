import Link from "next/link";
import { centerCopy } from "@/i18n/lanes/notification-center";
import type { Locale } from "@/i18n";
import { centerSessionEnabled, centerVendorEnabled } from "@/server/notification-center";
import type { Session } from "@/server/types";

export async function NotificationCenterEntry({ session }: { session: Session }) {
  if (session.kind !== "staff" && session.kind !== "tenant" && session.kind !== "owner") return null;
  if (!await centerSessionEnabled(session)) return null;
  const portal = session.kind === "staff" ? "m" : session.kind === "tenant" ? "t" : "o";
  return <p><Link className="btn" data-testid="notification-center-entry" href={`/${portal}/notifications`}>{centerCopy(session.locale).title}</Link></p>;
}

export async function VendorNotificationCenterEntry({ token, locale }: { token: string; locale: Locale }) {
  if (!await centerVendorEnabled(token)) return null;
  return <p><Link className="btn" prefetch={false} data-testid="notification-center-entry" href={`/v/${encodeURIComponent(token)}/notifications`}>{centerCopy(locale).title}</Link></p>;
}
