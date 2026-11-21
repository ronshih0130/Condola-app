import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { StaffInvitePanel } from "@/components/staff-invite/panel";
import "@/components/staff-invite/panel.css";
import { staffInviteCopy } from "@/i18n/staff-invite";
import { staffInvitePage } from "@/server/b040-staff-ui";
import { requireCurrentConsent } from "@/server/consent-gate";
import { FlowError } from "@/server/errors";
import { portalInviteOrigin } from "@/server/portal-invite";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function InvitePage({ params }: { params: Promise<{ unitId: string; view?: string[] }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const { unitId, view = [] } = await params;
  let page;
  try { page = await staffInvitePage(session, unitId, view); }
  catch (error) {
    if (error instanceof FlowError && ["errors.notFound", "errors.forbidden"].includes(error.key)) notFound();
    const c = staffInviteCopy(session.locale);
    return <main className="staff-invite"><meta name="referrer" content="no-referrer" /><p role="alert">{c.error}</p><Link href="/m/units" prefetch={false}>{c.units}</Link></main>;
  }
  const h = await headers();
  const origin = portalInviteOrigin(`${h.get("x-forwarded-proto") || "http"}://${h.get("host") || "localhost"}`);
  return <StaffInvitePanel {...page} origin={origin} />;
}
