import { notFound } from "next/navigation";
import { NotificationCenter, NotificationCenterBusy } from "@/components/notification-center";
import { markVendorCenterRead } from "@/server/notification-center-actions";
import { CenterBusyError, CenterDeniedError, centerVendorAdmission, centerVendorItems } from "@/server/notification-center";
import { requestPrefs } from "@/server/session";
import { isUuid } from "@/server/repair-rules";

export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{token:string}>;searchParams:Promise<{cursor?:string}>}) {
  const {token}=await params;
  const prefs=await requestPrefs();
  const query=await searchParams;
  if(query.cursor && !isUuid(query.cursor)) notFound();
  const base=`/v/${encodeURIComponent(token)}/notifications`;
  const retryHref=query.cursor ? `${base}?cursor=${encodeURIComponent(query.cursor)}` : base;
  const admission=await centerVendorAdmission(token);
  if(admission==="busy") return <div style={{maxWidth:560,margin:"24px auto"}}><NotificationCenterBusy locale={prefs.locale} retryHref={retryHref}/></div>;
  if(admission!=="enabled") notFound();
  let items;
  try {items=await centerVendorItems(token,null,query.cursor);} catch(error) {
    if(error instanceof CenterBusyError) return <div style={{maxWidth:560,margin:"24px auto"}}><NotificationCenterBusy locale={prefs.locale} retryHref={retryHref}/></div>;
    if(error instanceof CenterDeniedError) notFound(); throw error;
  }
  return <div style={{maxWidth:560,margin:"24px auto"}}><NotificationCenter page={items} locale={prefs.locale} mark={markVendorCenterRead.bind(null,token)}/></div>;
}
