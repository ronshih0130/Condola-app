/**
 * Trial length is undecided: either calendar months or a day count.
 * Callers pass the parameter. This module does not choose 3 months or 90 days.
 */

export type TrialLength =
  | { unit: "calendar-months"; count: number }
  | { unit: "days"; count: number };

export function parseTrialLength(unit: string | undefined, count: string | undefined): TrialLength {
  if (unit !== "calendar-months" && unit !== "days") {
    throw new Error("QA_TRIAL_UNIT must be calendar-months or days");
  }
  if (!count || !/^[1-9]\d*$/.test(count)) {
    throw new Error("QA_TRIAL_COUNT must be a positive integer");
  }
  return { unit, count: Number(count) };
}

export function readTrialLength(env: NodeJS.ProcessEnv = process.env): TrialLength {
  return parseTrialLength(env.QA_TRIAL_UNIT, env.QA_TRIAL_COUNT);
}

/** Paid plans use the supplied length. Free has no trial. */
export function trialOffer(plan: string, length: TrialLength): TrialLength | { unit: "none"; count: 0 } {
  if (plan === "free") return { unit: "none", count: 0 };
  return length;
}

export function trialLabel(length: TrialLength): string {
  if (length.unit === "calendar-months") return `前 ${length.count} 個月免費`;
  return `前 ${length.count} 天免費`;
}
