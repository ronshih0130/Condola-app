import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { StaffInvitePanel } from "@/components/staff-invite/panel";
import "@/components/staff-invite/panel.css";
import { staffInviteCopy } from "@/i18n/staff-invite";
import { staffRoomInvitePage } from "@/server/b040-staff-ui";
import { requireCurrentConsent } from "@/server/consent-gate";
import { FlowError } from "@/server/errors";
import { portalInviteOrigin } from "@/server/portal-invite";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

/** B-102 INV-ROOM (MGT-147): one room's own invite, with the unit invite's screens. brand_v3 only (404 otherwise). */
export default async function RoomInvitePage({ params }: { params: Promise<{ roomId: string; view?: string[] }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const { roomId, view = [] } = await params;
  let page;
  try { page = await staffRoomInvitePage(session, roomId, view); }
  catch (error) {
    if (error instanceof FlowError && ["errors.notFound", "errors.forbidden"].includes(error.key)) notFound();
    const c = staffInviteCopy(session.locale);
    return <main className="staff-invite"><meta name="referrer" content="no-referrer" /><p role="alert">{c.error}</p><Link href="/m/units" prefetch={false}>{c.units}</Link></main>;
  }
  const h = await headers();
  const origin = portalInviteOrigin(`${h.get("x-forwarded-proto") || "http"}://${h.get("host") || "localhost"}`);
  return <StaffInvitePanel {...page} origin={origin} />;
}
