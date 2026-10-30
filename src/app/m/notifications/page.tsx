import { notFound } from "next/navigation";
import { NotificationCenter } from "@/components/notification-center";
import { requireCurrentConsent } from "@/server/consent-gate";
import { markCenterRead } from "@/server/notification-center-actions";
import { centerSessionEnabled, centerSessionItems } from "@/server/notification-center";
import { getSession } from "@/server/session";

export const dynamic="force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<{cursor?:string}>}) {
  const session=await getSession();
  await requireCurrentConsent(session,"page");
  if (session.kind!=="staff" || !await centerSessionEnabled(session)) notFound();
  const query=await searchParams;
  let items;
  try {items=await centerSessionItems(session,null,query.cursor);} catch {notFound();}
  return <NotificationCenter page={items} locale={session.locale} mark={markCenterRead}/>;
}
