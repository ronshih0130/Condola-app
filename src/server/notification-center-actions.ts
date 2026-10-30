"use server";
import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "./consent-gate";
import { centerSessionItems, centerVendorItems } from "./notification-center";
import { getSession } from "./session";

export async function markCenterRead(form:FormData) {
  const session=await getSession();
  await requireCurrentConsent(session,"page");
  const id=form.get("recipientId");
  if (typeof id!=="string") throw new Error("Notification unavailable");
  const rows=await centerSessionItems(session,id);
  if (rows.items.length!==1) throw new Error("Notification unavailable");
  revalidatePath(session.kind === "staff" ? "/m/notifications" : session.kind === "tenant" ? "/t/notifications" : "/o/notifications");
}
export async function markVendorCenterRead(token:string,form:FormData) {
  const id=form.get("recipientId");
  if (typeof id!=="string") throw new Error("Notification unavailable");
  const rows=await centerVendorItems(token,id);
  if (rows.items.length!==1) throw new Error("Notification unavailable");
  revalidatePath("/v/[token]/notifications", "page");
}
