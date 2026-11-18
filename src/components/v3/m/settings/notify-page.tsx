import React, { Suspense } from "react";
import { PageHeader } from "../../../ui";
import { brandV3NotifyCopy } from "../../../../i18n/lanes/brand-v3-r5-notify";
import { notifySettingsRead } from "../../../../server/b073-notify-settings";
import type { Session } from "../../../../server/types";
import { NOTIFY_CSS_HREF, NotifyError, NotifyLayout, NotifyLoading } from "./notify";
import { NotifySwitches } from "./notify-switches";

/** R5-NOTIFY block bodies (brand_v3 only; the page renders NotifyLoading while this reads). */
export async function NotifySection({ session }: { session: Session }) {
  const read = await notifySettingsRead(session);
  // The layout admits only sessions with personal reminders; a forbidden read (authority changed mid-request) shows nothing.
  if (read.state === "forbidden") return null;
  if (read.state !== "ready") return <NotifyError locale={session.locale} />;
  return <NotifyLayout locale={session.locale}
    mine={<NotifySwitches locale={session.locale} block="me" toggles={read.me} />}
    tenant={read.tenant ? <NotifySwitches locale={session.locale} block="tenant" toggles={read.tenant} /> : null} />;
}

/** /m/notify under brand_v3: its own stylesheet, the approved lead, then the blocks. */
export function NotifyV3Page({ session }: { session: Session }) {
  return <>
    <link rel="stylesheet" href={NOTIFY_CSS_HREF} />
    <PageHeader title={brandV3NotifyCopy(session.locale).lead} />
    <Suspense fallback={<NotifyLoading locale={session.locale} />}><NotifySection session={session} /></Suspense>
  </>;
}
