/** Calendar-only reminder decisions. The caller supplies one trusted instant and
 * current, transactionally rechecked lease and invoice state. */
export type ReminderCandidate = {
  leaseStatus: string;
  terminatedOn: string | null;
  invoiceStatus: string;
  balanceMinor: number;
  hasRent: boolean;
  dueDate: string;
  timeZone: string;
};
export type ReminderSchedule = { due: readonly number[]; overdue: readonly number[] };
export type ScheduledReminder = { kind: "rent_due" | "rent_overdue"; localDate: string; occurrenceKey: string };

export function localReminderDate(at: Date, timeZone: string): string {
  if (!Number.isFinite(at.getTime()) || !timeZone) throw new Error("Reminder date unavailable");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = get("year"), month = get("month"), day = get("day");
  if (!year || !month || !day) throw new Error("Reminder date unavailable");
  return `${year}-${month}-${day}`;
}

function dayNumber(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Reminder date unavailable");
  const epoch = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) throw new Error("Reminder date unavailable");
  return epoch / 86_400_000;
}

export function reminderEligible(candidate: ReminderCandidate): boolean {
  return candidate.leaseStatus === "active" && candidate.terminatedOn === null &&
    ["open", "partially_paid"].includes(candidate.invoiceStatus) && candidate.hasRent &&
    Number.isSafeInteger(candidate.balanceMinor) && candidate.balanceMinor > 0;
}

export function planScheduledReminder(candidate: ReminderCandidate, schedule: ReminderSchedule, at: Date): ScheduledReminder[] {
  if (!reminderEligible(candidate)) return [];
  for (const offset of [...schedule.due, ...schedule.overdue]) {
    if (!Number.isSafeInteger(offset) || offset < -32768 || offset > 32767) throw new Error("Reminder schedule unavailable");
  }
  if (schedule.due.some((offset) => offset > 0) || schedule.overdue.some((offset) => offset <= 0)) throw new Error("Reminder schedule unavailable");
  const localDate = localReminderDate(at, candidate.timeZone);
  const offset = dayNumber(localDate) - dayNumber(candidate.dueDate);
  const kind = offset <= 0 && schedule.due.includes(offset) ? "rent_due" :
    offset > 0 && schedule.overdue.includes(offset) ? "rent_overdue" : null;
  return kind ? [{ kind, localDate, occurrenceKey: `${candidate.dueDate}:${offset}` }] : [];
}
