"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "./consent-gate";
import { CenterBusyError, centerSessionItems, centerVendorItems } from "./notification-center";
import { getSession } from "./session";
import type { MarkState } from "@/components/notification-mark-form";

export async function markCenterRead(_state:MarkState,form:FormData):Promise<MarkState> {
  await requireCurrentConsent();
  const session=await guardEffectiveSession(await getSession(), null);
  const id=form.get("recipientId");
  if (typeof id!=="string") throw new Error("Notification unavailable");
  try {
    const rows=await centerSessionItems(session,id);
    if (rows.items.length!==1) throw new Error("Notification unavailable");
  } catch(error) {if(error instanceof CenterBusyError) return {status:"busy"}; throw error;}
  revalidatePath(session.kind === "staff" ? "/m/notifications" : session.kind === "tenant" ? "/t/notifications" : "/o/notifications");
  return {status:"done"};
}
export async function markVendorCenterRead(token:string,_state:MarkState,form:FormData):Promise<MarkState> {
  const id=form.get("recipientId");
  if (typeof id!=="string") throw new Error("Notification unavailable");
  try {
    const rows=await centerVendorItems(token,id);
    if (rows.items.length!==1) throw new Error("Notification unavailable");
  } catch(error) {if(error instanceof CenterBusyError) return {status:"busy"}; throw error;}
  revalidatePath("/v/[token]/notifications", "page");
  return {status:"done"};
}
