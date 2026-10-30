import Link from "next/link";
import { notFound } from "next/navigation";
import { reminderCopy } from "@/i18n/lanes/reminders";
import { requireCurrentConsent } from "@/server/consent-gate";
import { actionTenantDuePreference } from "@/server/reminder-actions";
import { isUuid } from "@/server/repair-rules";
import { getSession } from "@/server/session";
import { tenantDuePreference } from "@/server/tenant-reminder-preferences";

export const dynamic="force-dynamic";
export default async function TenantReminderPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{saved?:string;error?:string}>}) {
  await requireCurrentConsent(undefined,"page");
  const {id}=await params, query=await searchParams, session=await getSession();
  if (!isUuid(id)) notFound();
  const enabled=await tenantDuePreference(session,id);
  if (enabled === null) notFound();
  const copy=reminderCopy(session.locale);
  return <div><h1>{copy.tenantTitle}</h1><p>{copy.tenantDescription}</p><p>{copy.scope}</p>
    {query.saved ? <p role="status">{copy.saved}</p> : null}{query.error ? <p role="alert">{copy.unavailable}</p> : null}
    <p data-testid="tenant-due-preference">{enabled ? copy.tenantOn : copy.tenantOff}</p>
    <form action={actionTenantDuePreference}><input type="hidden" name="leaseId" value={id}/><input type="hidden" name="enabled" value={enabled ? "false" : "true"}/>
      <button type="submit" data-testid="tenant-due-toggle">{enabled ? copy.turnOff : copy.turnOn}</button></form>
    <p><Link href="/t">{copy.tenantBack}</Link></p>
  </div>;
}
