/** Over-4-unit edit limit. Lengths come from TRIAL_MODE and the caller's month count, not a fixed trial. */

export const TRIAL_MODES = ["calendar_months", "days90"] as const;
export type TrialMode = (typeof TRIAL_MODES)[number];

/** One definition of the days90 mode. SQL reads platform_settings.trial_days, which ships as this same length. */
export const DAYS90 = 90;

export type LimitPhase = "open" | "trial" | "grace" | "locked";
export type BillingCycle = "month" | "year";
export type UnitMutation = "unit" | "lease" | "payment_record" | "payment_reverse";

const PAID = new Set(["standard", "pro", "business"]);

export function trialMode(raw = process.env.TRIAL_MODE): TrialMode {
  return raw?.trim() === "days90" ? "days90" : "calendar_months";
}

/** UTC calendar months, or the days90 length. `months` is ignored in days90 mode. */
export function trialEnd(start: Date, months: number, mode: TrialMode = trialMode()): Date {
  const end = new Date(start.getTime());
  if (mode === "days90") {
    end.setUTCDate(end.getUTCDate() + DAYS90);
    return end;
  }
  const day = end.getUTCDate();
  end.setUTCMonth(end.getUTCMonth() + months);
  if (end.getUTCDate() < day) end.setUTCDate(0);
  return end;
}

export function limitPhase(input: {
  environment: "live" | "sandbox";
  tier: string | null;
  trialUntil: string | null;
  now: Date;
  spaceCount: number;
  freeUnits?: number;
  graceDays?: number;
}): LimitPhase {
  const free = input.freeUnits ?? 4;
  const graceDays = input.graceDays ?? 30;
  if (input.environment === "sandbox") return "open";
  if (input.tier && PAID.has(input.tier)) return "open";
  if (input.spaceCount <= free) return "open";
  if (!input.trialUntil) return "open";
  const trial = new Date(input.trialUntil);
  if (Number.isNaN(trial.getTime())) return "open";
  if (input.now.getTime() < trial.getTime()) return "trial";
  const graceEnd = trial.getTime() + graceDays * 24 * 60 * 60 * 1000;
  if (input.now.getTime() < graceEnd) return "grace";
  return "locked";
}

export function graceDaysLeft(trialUntil: string, now: Date, graceDays = 30) {
  const trial = new Date(trialUntil);
  if (Number.isNaN(trial.getTime())) return 0;
  const end = trial.getTime() + graceDays * 24 * 60 * 60 * 1000;
  const left = end - now.getTime();
  if (left <= 0) return 0;
  return Math.ceil(left / (24 * 60 * 60 * 1000));
}

/** An empty pick means the earliest-created spaces. A saved pick replaces that default. */
export function keptSpaceIds(
  spaces: { id: string; createdAt: string }[],
  picked: string[] | null,
  free = 4,
): string[] {
  const known = new Set(spaces.map((space) => space.id));
  const explicit = (picked ?? []).filter((id) => known.has(id)).slice(0, free);
  if (explicit.length > 0) return explicit;
  return [...spaces]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, free)
    .map((space) => space.id);
}

/** Payments stay allowed on a read-only unit. Unit and lease edits do not. */
export function mutationAllowed(mutation: UnitMutation, editable: boolean) {
  if (mutation === "payment_record" || mutation === "payment_reverse") return true;
  return editable;
}

export function periodEndOn(today: string, cycle: BillingCycle): string {
  const [year, month, day] = today.split("-").map(Number);
  if (cycle === "year") {
    const end = new Date(Date.UTC(year + 1, month - 1, day));
    end.setUTCDate(end.getUTCDate() - 1);
    return end.toISOString().slice(0, 10);
  }
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function dayAfter(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * A count change is stored as pending until the current period ends.
 * The first observation, when there is no period yet, becomes the billed count.
 */
export function applyUnitCount(input: {
  active: number;
  billed: number | null;
  pending: number | null;
  periodEnd: string | null;
  today: string;
  cycle: BillingCycle;
}): { billed: number; pending: number | null; periodEnd: string } {
  const cycle = input.cycle === "year" ? "year" : "month";
  if (input.periodEnd == null || input.today > input.periodEnd) {
    const rolled = input.periodEnd != null && input.today > input.periodEnd;
    const billed = rolled ? (input.pending ?? input.active) : input.active;
    return {
      billed,
      pending: billed === input.active ? null : input.active,
      periodEnd: periodEndOn(input.today, cycle),
    };
  }
  const billed = input.billed ?? input.active;
  return {
    billed,
    pending: input.active === billed ? null : input.active,
    periodEnd: input.periodEnd,
  };
}
