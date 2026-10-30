export const onboardingGroups = ["tenant", "owner", "team"] as const;
export type OnboardingGroup = typeof onboardingGroups[number];
export type OnboardingChoices = Record<OnboardingGroup, boolean>;
export type OnboardingPolicy = { version: 1; required: OnboardingChoices; actor: string; decided_at: string };

export function readOnboardingPolicy(value: unknown): OnboardingPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.actor !== "string" || !row.actor || typeof row.decided_at !== "string" || !Number.isFinite(Date.parse(row.decided_at))) return null;
  if (!row.required || typeof row.required !== "object" || Array.isArray(row.required)) return null;
  const required = row.required as Record<string, unknown>;
  if (!onboardingGroups.every((group) => typeof required[group] === "boolean")) return null;
  return row as OnboardingPolicy;
}

export function groupState(required: boolean, total: number, ready: number): "skipped" | "incomplete" | "complete" {
  return !required ? "skipped" : total > 0 && total === ready ? "complete" : "incomplete";
}
