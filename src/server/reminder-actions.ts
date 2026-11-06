"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";

import { redirect } from "next/navigation";
import { requireCurrentConsent } from "./consent-gate";
import { queueManualReminder } from "./manual-reminders";
import { captureManualReminders } from "./local-reminder-capture";
import { isUuid } from "./repair-rules";
import { getSession } from "./session";
import { saveTenantDuePreference } from "./tenant-reminder-preferences";

export async function actionQueueManualReminder(data: FormData) {
  await requireCurrentConsent();
  const session=await guardEffectiveSession(await getSession(), "tenants.contact");
  const lease=String(data.get("leaseId") ?? ""), invoice=String(data.get("invoiceId") ?? ""), request=String(data.get("requestId") ?? "");
  if (!isUuid(lease) || !isUuid(invoice) || !isUuid(request)) redirect("/m/rent");
  let event: string;
  try { event=await queueManualReminder(session,lease,invoice,request); }
  catch { redirect(`/m/rent/remind/${lease}?error=unavailable`); }
  try { await captureManualReminders(session,lease,event); } catch { /* Remains queued for an explicit retry. */ }
  redirect(`/m/rent/remind/${lease}?event=${event}`);
}

export async function actionRetryLocalReminder(data: FormData) {
  await requireCurrentConsent();
  const session=await guardEffectiveSession(await getSession(), "tenants.contact");
  const lease=String(data.get("leaseId") ?? ""), event=String(data.get("eventId") ?? "");
  if (!isUuid(lease) || !isUuid(event)) redirect("/m/rent");
  try { await captureManualReminders(session,lease,event); }
  catch { redirect(`/m/rent/remind/${lease}?error=unavailable`); }
  redirect(`/m/rent/remind/${lease}?event=${event}`);
}

export async function actionTenantDuePreference(data:FormData) {
  await requireCurrentConsent();
  const session=await guardEffectiveSession(await getSession(), null), lease=String(data.get("leaseId") ?? ""), value=String(data.get("enabled") ?? "");
  if (!isUuid(lease) || !["true","false"].includes(value)) redirect("/t");
  try { await saveTenantDuePreference(session,lease,value === "true"); }
  catch { redirect(`/t/reminders/${lease}?error=unavailable`); }
  redirect(`/t/reminders/${lease}?saved=1`);
}
