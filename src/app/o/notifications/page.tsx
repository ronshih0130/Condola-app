import { notFound } from "next/navigation";
import { NotificationCenter, NotificationCenterBusy } from "@/components/notification-center";
import { requireCurrentConsent } from "@/server/consent-gate";
import { markCenterRead } from "@/server/notification-center-actions";
import { CenterBusyError, CenterDeniedError, centerSessionAdmission, centerSessionItems } from "@/server/notification-center";
import { getSession } from "@/server/session";
import { isUuid } from "@/server/repair-rules";

export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<{cursor?:string}>}) {
  await requireCurrentConsent(undefined,"page");
  const session=await getSession();
  if (session.kind!=="owner") notFound();
  const query=await searchParams;
  if(query.cursor && !isUuid(query.cursor)) notFound();
  const retryHref=query.cursor ? `/o/notifications?cursor=${encodeURIComponent(query.cursor)}` : "/o/notifications";
  const admission=await centerSessionAdmission(session);
  if(admission==="busy") return <NotificationCenterBusy locale={session.locale} retryHref={retryHref}/>;
  if(admission!=="enabled") notFound();
  let items;
  try {items=await centerSessionItems(session,null,query.cursor);} catch(error) {
    if(error instanceof CenterBusyError) return <NotificationCenterBusy locale={session.locale} retryHref={retryHref}/>;
    if(error instanceof CenterDeniedError) notFound(); throw error;
  }
  return <NotificationCenter page={items} locale={session.locale} mark={markCenterRead}/>;
}
