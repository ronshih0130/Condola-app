import type { PermKey } from "./perms";

export const SETUP_STEPS = [
  { id: "company", key: "es_setup_company", perm: "settings.edit" },
  { id: "unit", key: "es_UNIT_action", perm: "props.edit" },
  { id: "invite", key: "es_TEN_action", perm: "leases.edit" }, // = B-040 invite permission (staffInvitePage)
  { id: "joined", key: "es_setup_joined", perm: "props.edit" },
] as const satisfies readonly { id: string; key: string; perm: PermKey }[];
export type SetupDone = readonly [boolean, boolean, boolean, boolean];
export function firstIncompleteStep(done: SetupDone): 0 | 1 | 2 | 3 | 4 {
  const index = done.findIndex(value => !value);
  return (index === -1 ? 4 : index) as 0 | 1 | 2 | 3 | 4;
}
export function setupChecklist(done: SetupDone, completedAt: string | null, can: (key: PermKey) => boolean) {
  const steps = SETUP_STEPS.flatMap((step, index) => can(step.perm) ? [{ ...step, index, done: done[index] }] : []);
  return { steps, completed: steps.filter(step => step.done).length, total: steps.length, completedAt };
}
export function readCompletedAt(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const progress = (settings as Record<string, unknown>).onboarding_progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  const value = (progress as Record<string, unknown>).completed_at;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
