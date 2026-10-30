import { notFound } from "next/navigation";
import { NotificationCenter } from "@/components/notification-center";
import { markVendorCenterRead } from "@/server/notification-center-actions";
import { centerVendorEnabled, centerVendorItems } from "@/server/notification-center";
import { requestPrefs } from "@/server/session";

export const dynamic="force-dynamic";
export default async function Page({params,searchParams}:{params:Promise<{token:string}>;searchParams:Promise<{cursor?:string}>}) {
  const {token}=await params;
  if (!await centerVendorEnabled(token)) notFound();
  const query=await searchParams;
  let items;
  try {items=await centerVendorItems(token,null,query.cursor);} catch {notFound();}
  const prefs=await requestPrefs();
  return <div style={{maxWidth:560,margin:"24px auto"}}><NotificationCenter page={items} locale={prefs.locale} mark={markVendorCenterRead.bind(null,token)}/></div>;
}
