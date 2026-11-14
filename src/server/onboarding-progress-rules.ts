import type { PermKey } from "./perms";

/**
 * Every invite destination needs both keys: B-040 M4 (`/m/units/{id}/invite`: route props.view +
 * loader leases.edit), `/m/units`, `/m/leases`, lease detail (route props.view) and
 * `/m/leases/new` (route leases.edit + loader listTenants props.view). Spec §3.2 「邀請租客＝B-040
 * 邀請權限」; spec §4: only people who see 邀請租客 get 租客加入.
 */
export const INVITE_PERMS = ["leases.edit", "props.view"] as const satisfies readonly PermKey[];
export const canInvite = (can: (key: PermKey) => boolean) => INVITE_PERMS.every(key => can(key));

export const SETUP_STEPS = [
  { id: "company", key: "es_setup_company", perms: ["settings.edit"] },
  { id: "unit", key: "es_UNIT_action", perms: ["props.edit"] },
  { id: "invite", key: "es_TEN_action", perms: INVITE_PERMS },
  { id: "joined", key: "es_setup_joined", perms: INVITE_PERMS },
] as const satisfies readonly { id: string; key: string; perms: readonly PermKey[] }[];
export type SetupDone = readonly [boolean, boolean, boolean, boolean];
export function firstIncompleteStep(done: SetupDone): 0 | 1 | 2 | 3 | 4 {
  const index = done.findIndex(value => !value);
  return (index === -1 ? 4 : index) as 0 | 1 | 2 | 3 | 4;
}
export function setupChecklist(done: SetupDone, completedAt: string | null, can: (key: PermKey) => boolean) {
  const steps = SETUP_STEPS.flatMap((step, index) => step.perms.every(key => can(key)) ? [{ ...step, index, done: done[index] }] : []);
  return { steps, completed: steps.filter(step => step.done).length, total: steps.length, completedAt };
}
export function readCompletedAt(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const progress = (settings as Record<string, unknown>).onboarding_progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
  const value = (progress as Record<string, unknown>).completed_at;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
