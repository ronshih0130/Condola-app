import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { RoomInviteList } from "@/components/staff-invite/room-invites";
import "@/components/staff-invite/panel.css";
import { brandV3RoomInvitesCopy } from "@/i18n/lanes/brand-v3-room-invites";
import { staffAllRoomInvites } from "@/server/b102-room-invites";
import { requireCurrentConsent } from "@/server/consent-gate";
import { FlowError } from "@/server/errors";
import { portalInviteOrigin } from "@/server/portal-invite";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

/** B-102 / FE-ROOMINV (MGT-147-AC2): 「一次邀請全部房間」 for one by_room unit. brand_v3 only (404 otherwise). */
export default async function RoomInvitesPage({ params }: { params: Promise<{ unitId: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const { unitId } = await params;
  let list;
  try { list = await staffAllRoomInvites(session, unitId); }
  catch (error) {
    if (error instanceof FlowError && ["errors.notFound", "errors.forbidden"].includes(error.key)) notFound();
    const c = brandV3RoomInvitesCopy(session.locale);
    return <main className="staff-invite"><meta name="referrer" content="no-referrer" /><p role="alert">{c.error}</p><a href={`/m/units/${encodeURIComponent(unitId)}/room-invites`}>{c.retry}</a></main>;
  }
  const h = await headers();
  const origin = portalInviteOrigin(`${h.get("x-forwarded-proto") || "http"}://${h.get("host") || "localhost"}`);
  return <main><meta name="referrer" content="no-referrer" /><RoomInviteList locale={session.locale} place={list.unitLabel} origin={origin} rooms={list.rooms} /></main>;
}
