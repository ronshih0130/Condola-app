import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { requireCurrentConsent } from "@/server/consent-gate";
import { moneyLabel } from "@/server/format";
import { manualReminderInvoices, manualRemindersEnabled, manualReminderStatus } from "@/server/manual-reminders";
import { actionQueueManualReminder, actionRetryLocalReminder } from "@/server/reminder-actions";
import { isUuid } from "@/server/repair-rules";
import { getSession } from "@/server/session";
import { reminderCopy } from "@/i18n/lanes/reminders";

export const dynamic="force-dynamic";
export default async function ReminderPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{event?:string;error?:string}>}) {
  await requireCurrentConsent(undefined,"page");
  const {id}=await params, query=await searchParams, session=await getSession();
  if (!isUuid(id) || !await manualRemindersEnabled(session)) notFound();
  const copy=reminderCopy(session.locale), invoices=await manualReminderInvoices(session,id);
  const status=query.event && isUuid(query.event) ? await manualReminderStatus(session,id,query.event) : null;
  return <div><h1>{copy.title}</h1><p>{copy.scope}</p>
    {query.error ? <p role="alert">{copy.unavailable}</p> : null}
    {status ? <div><p data-testid="reminder-result">{copy.queued}: {status.queued}; {copy.claimed}: {status.claimed}; {copy.captured}: {status.captured}; {copy.failed}: {status.failed}</p>
      {Number(status.queued)+Number(status.claimed)+Number(status.failed)>0 ? <form action={actionRetryLocalReminder}><input type="hidden" name="leaseId" value={id}/><input type="hidden" name="eventId" value={query.event}/><button type="submit">{copy.retry}</button></form> : null}</div> : null}
    {invoices.length ? invoices.map((invoice)=><form key={invoice.id} action={actionQueueManualReminder}>
      <input type="hidden" name="leaseId" value={id}/><input type="hidden" name="invoiceId" value={invoice.id}/><input type="hidden" name="requestId" value={randomUUID()}/>
      <p>{invoice.due_date} · {moneyLabel(Number(invoice.balance),invoice.currency,session.locale)}</p>
      <button type="submit" data-testid="queue-reminder">{copy.queue}</button>
    </form>) : <p>{copy.empty}</p>}
    <p><Link href="/m/rent">{copy.back}</Link></p>
  </div>;
}
